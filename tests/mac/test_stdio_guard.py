# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
STDIO = ('stdin', 'stdout', 'stderr')


@unittest.skipUnless(sys.platform == 'darwin', 'the stdio guard is darwin-only')
class StdioGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp(prefix='guard-stdio-')
        cls.agent = os.path.join(cls.dir, 'vibtra-guard')
        subprocess.run(['go', 'build', '-o', cls.agent, '.'], cwd=ROOT / 'guard/agent-go', env={**os.environ, 'CGO_ENABLED': '0'}, check=True, timeout=600)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def run_with_named_peer(self, fd):
        listener = socket.socket(socket.AF_UNIX)
        listener.bind(os.path.join(self.dir, 'named-%d.sock' % fd))
        listener.listen(1)
        client = socket.socket(socket.AF_UNIX)
        client.connect(listener.getsockname())
        accepted, _ = listener.accept()
        stdio = dict.fromkeys(STDIO, subprocess.DEVNULL)
        stdio[STDIO[fd]] = client
        code = subprocess.run([self.agent, '--version'], timeout=30, **stdio).returncode
        client.close()
        accepted.settimeout(1)
        received = accepted.recv(1)
        accepted.close()
        listener.close()
        return code, received

    def test_named_peer_on_stdin_exits_2_and_writes_nothing(self):
        self.assertEqual(self.run_with_named_peer(0), (2, b''))

    def test_named_peer_on_stdout_exits_2_and_writes_nothing(self):
        self.assertEqual(self.run_with_named_peer(1), (2, b''))

    def test_named_peer_on_stderr_exits_2_and_writes_nothing(self):
        self.assertEqual(self.run_with_named_peer(2), (2, b''))

    def test_tcp_socket_on_stderr_exits_2_and_writes_nothing(self):
        listener = socket.create_server(('127.0.0.1', 0))
        client = socket.create_connection(listener.getsockname())
        accepted, _ = listener.accept()
        code = subprocess.run([self.agent, '--version'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=client, timeout=30).returncode
        client.close()
        accepted.settimeout(1)
        received = accepted.recv(1)
        accepted.close()
        listener.close()
        self.assertEqual((code, received), (2, b''))

    def test_socketpair_runs_normally(self):
        ours, theirs = socket.socketpair()
        code = subprocess.run([self.agent, '--version'], stdin=theirs, stdout=theirs, stderr=theirs, timeout=30).returncode
        theirs.close()
        ours.settimeout(5)
        self.assertEqual(code, 0)
        self.assertIn(b'vibtra-guard', ours.recv(4096))
        ours.close()

    def test_pipes_run_normally(self):
        result = subprocess.run([self.agent, '--version'], stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'vibtra-guard', result.stdout)


if __name__ == '__main__':
    unittest.main()
