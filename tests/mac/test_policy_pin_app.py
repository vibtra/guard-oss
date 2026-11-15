# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
PUBLIC_KEY = '''-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7j92i2nYScH7UroGairBJRBuDuay
g1cTGm8DPIoQ0eRNtl2y5x2OBnfhgRFLOD4UR0jax0+QVV14zLf/TnUE0Q==
-----END PUBLIC KEY-----
'''
IDENTITY = {'deviceId': 'gdev_0123456789abcdef', 'orgId': 'org_example', 'signing': {'keyId': 'gk_0123abcd', 'alg': 'ES256', 'publicKeyPem': PUBLIC_KEY}}
DEVICE = {**IDENTITY, 'server': {'baseUrl': 'http://127.0.0.1:9', 'syncIntervalSeconds': 60, 'batchSize': 100}, 'clientMode': 'enforce',
          'enrolledAt': '2026-10-24T00:00:00.000Z', 'revoked': False}
PIN = base64.b64encode(json.dumps({**IDENTITY, 'source': 'enrolment', 'pinnedAt': '2026-10-24T00:00:00.000Z'}).encode()).decode()
APP = r'''
import base64, os, socket, sys, threading, time
path, mode, pin = sys.argv[1:]
listener = socket.socket(socket.AF_UNIX)
listener.bind(path)
listener.listen(8)
print('up', flush=True)

def serve(conn):
    lines = conn.makefile('rb')
    nonce = base64.b64encode(os.urandom(32)).decode()
    conn.sendall(('nonce %s\n' % nonce).encode())
    if lines.readline() != ('hello %s\n' % nonce).encode():
        return conn.close()
    conn.sendall(b'ready\n')
    for line in lines:
        if line != b'pin-get\n':
            conn.sendall(b'err bad-request\n')
            continue
        reply = ('ok %s\n' % pin).encode()
        if mode == 'reply-from-child':
            child = os.fork()
            if child == 0:
                os.write(conn.fileno(), reply)
                os._exit(0)
            os.waitpid(child, 0)
            time.sleep(30)
            return conn.close()
        conn.sendall(reply)
    conn.close()

while True:
    conn, _ = listener.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
'''


def build(out, tags=()):
    args = ['go', 'build', '-o', out] + (['-tags', ','.join(tags)] if tags else []) + ['.']
    subprocess.run(args, cwd=ROOT / 'guard/agent-go', env={**os.environ, 'CGO_ENABLED': '0'}, check=True, timeout=600)
    return out


class PolicyPinAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix='guard-pin-')
        cls.test_agent = os.environ.get('VIBTRA_GUARD_AGENT_BIN') or build(os.path.join(cls.dir, 'vibtra-guard-test'), ['guard_test'])
        cls.plain_agent = build(os.path.join(cls.dir, 'vibtra-guard'))
        cls.security = os.path.join(cls.dir, 'security')
        Path(cls.security).write_text('#!/bin/sh\nexit 0\n')
        os.chmod(cls.security, 0o700)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.case = tempfile.mkdtemp(prefix='c-', dir=self.dir)
        self.profile = os.path.join(self.case, 'profile')
        os.mkdir(self.profile, 0o700)
        Path(self.profile, 'device.json').write_text(json.dumps(DEVICE))
        self.socket = os.path.join(self.case, 'app.sock')
        self.app = None

    def tearDown(self):
        if self.app:
            self.app.kill()
            self.app.wait()
            self.app.stdout.close()

    def start_app(self, mode='serve'):
        self.app = subprocess.Popen([sys.executable, '-W', 'ignore::DeprecationWarning', '-c', APP, self.socket, mode, PIN], stdout=subprocess.PIPE, text=True)
        self.assertEqual(self.app.stdout.readline(), 'up\n')
        signature = subprocess.run(['codesign', '-d', '--verbose=3', str(self.app.pid)], capture_output=True, text=True, check=True).stderr
        cdhash = next(line.split('=', 1)[1] for line in signature.splitlines() if line.startswith('CDHash='))
        return 'cdhash H"%s"' % cdhash

    def policy_key(self, agent, requirement=None):
        env = {**os.environ, 'VIBTRA_GUARD_CA_SIGNER_SOCK': self.socket, 'VIBTRA_GUARD_SECURITY_BIN': self.security, 'VIBTRA_GUARD_TEST_APP_REQUIREMENT': requirement or ''}
        result = subprocess.run([agent, '--data-dir', self.profile, 'status', '--local', '127.0.0.1:9'], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['policyKey']

    def test_the_pin_served_by_the_app_the_requirement_names_is_used(self):
        requirement = self.start_app()
        self.assertEqual(self.policy_key(self.test_agent, requirement), {'store': 'keychain', 'pinned': 'enrolment'})

    def test_another_process_on_the_socket_is_refused_and_nothing_is_pinned(self):
        self.start_app()
        self.assertEqual(self.policy_key(self.test_agent, 'cdhash H"%s"' % ('0' * 40)), {'store': 'keychain', 'reason': 'policy-key-unavailable'})
        self.assertFalse(Path(self.profile, 'policy-pin.json').exists(), 'a refused app never falls back to the unprotected file')

    def test_a_reply_written_by_a_child_of_the_checked_process_is_refused(self):
        requirement = self.start_app('reply-from-child')
        self.assertEqual(self.policy_key(self.test_agent, requirement), {'store': 'keychain', 'reason': 'policy-key-unavailable'})

    def test_a_build_without_a_team_signature_uses_the_unprotected_file(self):
        self.assertEqual(self.policy_key(self.plain_agent), {'store': 'unprotected', 'pinned': 'first-use'})
        self.assertEqual(json.loads(Path(self.profile, 'policy-pin.json').read_text())['signing'], IDENTITY['signing'])

    def test_an_ad_hoc_signature_naming_the_guard_agent_is_still_unprotected(self):
        claimed = os.path.join(self.case, 'vibtra-guard')
        shutil.copy(self.plain_agent, claimed)
        subprocess.run(['codesign', '-f', '-s', '-', '-i', 'app.vibtra.guard.agent', claimed], capture_output=True, check=True)
        self.assertEqual(self.policy_key(claimed), {'store': 'unprotected', 'pinned': 'first-use'})


if __name__ == '__main__':
    unittest.main()
