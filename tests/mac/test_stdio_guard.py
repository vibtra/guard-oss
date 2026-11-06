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

    def run_with_socket(self, fd):
        ours, theirs = socket.socketpair()
        stdio = {'stdin': subprocess.DEVNULL, 'stdout': subprocess.DEVNULL, 'stderr': subprocess.DEVNULL}
        stdio['stdin' if fd == 0 else 'stderr'] = theirs
        code = subprocess.run([self.agent, '--version'], timeout=30, **stdio).returncode
        theirs.close()
        ours.settimeout(1)
        received = ours.recv(1)
        ours.close()
        return code, received

    def test_socket_stderr_exits_2_and_writes_nothing(self):
        self.assertEqual(self.run_with_socket(2), (2, b''))

    def test_socket_stdin_exits_2_and_writes_nothing(self):
        self.assertEqual(self.run_with_socket(0), (2, b''))

    def test_pipes_run_normally(self):
        result = subprocess.run([self.agent, '--version'], stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.assertIn(b'vibtra-guard', result.stdout)


if __name__ == '__main__':
    unittest.main()
