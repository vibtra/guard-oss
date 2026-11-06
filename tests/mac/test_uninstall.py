# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
MAC = REPO / 'guard' / 'mac'
SCRIPT = MAC / 'uninstall-guard.sh'
PROJECT = MAC / 'VibtraGuard.xcodeproj' / 'project.pbxproj'

RECORD = '#!/bin/zsh\nIFS=$\'\\t\'\nprint -r -- "NAME$IFS$*" >> "$GUARD_TEST_CALLS"\n'
STUBS = {
    'pkill': RECORD + 'exit 0\n',
    'launchctl': RECORD + 'exit 0\n',
    'osascript': RECORD + 'exit 0\n',
    'defaults': RECORD + 'exit 0\n',
    'systemextensionsctl': RECORD + 'print -r -- "${GUARD_TEST_SYSEXT:-}"\nexit 0\n',
    'security': RECORD + 'if [[ $1 == find-certificate ]]; then cat "$GUARD_TEST_KEYCHAIN_PEMS"; fi\nexit 0\n',
    'openssl': RECORD + 'exec /usr/bin/openssl "$@"\n',
    'plutil': RECORD + 'exec /usr/bin/plutil "$@"\n',
}
READ_ONLY = ('openssl', 'plutil', 'systemextensionsctl')


def agent_binary():
    env = os.environ.get('VIBTRA_GUARD_AGENT_BIN')
    if env and os.access(env, os.X_OK):
        return Path(env)
    built = REPO / 'guard' / 'agent-go' / 'build' / 'vibtra-guard'
    if not os.access(built, os.X_OK):
        raise AssertionError('no agent binary: run zsh tests/mac/run.sh or zsh guard/agent-go/build.sh')
    return built


def fingerprint(cert):
    out = subprocess.run(['/usr/bin/openssl', 'x509', '-in', str(cert), '-noout', '-fingerprint', '-sha1'],
                         check=True, capture_output=True, text=True).stdout
    return out.split('=', 1)[1].strip().replace(':', '').upper()


def make_cert(directory, name, subject):
    key, cert = directory / (name + '.key'), directory / (name + '.pem')
    subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', subject,
                    '-keyout', str(key), '-out', str(cert)], check=True, capture_output=True)
    return cert, fingerprint(cert)


class Fixture:
    def __init__(self, root):
        self.root = root
        self.home = root / 'home'
        self.lib = self.home / 'Library'
        self.tools = root / 'tools'
        self.calls = root / 'calls.log'
        self.certs = root / 'certs'
        for path in (self.tools, self.certs, root / 'tmp'):
            path.mkdir(parents=True)
        for name, body in STUBS.items():
            stub = self.tools / name
            stub.write_text(body.replace('NAME', name, 1))
            stub.chmod(0o700)

        self.data = self.lib / 'Application Support/Vibtra Guard'
        trusted = root / 'security-trusted'
        trusted.write_text('#!/bin/sh\nexit 0\n')
        trusted.chmod(0o700)
        export = subprocess.run([str(agent_binary()), '--data-dir', str(self.data), 'ca', 'export'],
                                env={'PATH': '/usr/bin:/bin', 'HOME': str(self.home), 'VIBTRA_GUARD_DIR': str(self.data),
                                     'VIBTRA_GUARD_CA_SIGNER_SOCK': os.environ.get('VIBTRA_GUARD_CA_SIGNER_SOCK', ''),
                                     'VIBTRA_GUARD_SECURITY_BIN': str(trusted)},
                                capture_output=True, text=True, timeout=60)
        if export.returncode != 0 or 'BEGIN CERTIFICATE' not in export.stdout:
            raise AssertionError('the agent did not create its certificate: ' + export.stderr)
        self.guard_pem = self.data / 'ca.pem'
        self.guard_sha1 = fingerprint(self.guard_pem)
        self.old_pem, self.old_sha1 = make_cert(self.certs, 'old', '/CN=Vibtra Guard local CA (old-host)/O=Vibtra Guard')
        self.rust_pem, self.rust_sha1 = make_cert(self.certs, 'rust', '/CN=Vibtra Guard CA (rust-host)/O=Vibtra Guard')
        self.rust_lookalike_pem, self.rust_lookalike_sha1 = make_cert(self.certs, 'rust-lookalike', '/CN=Vibtra Guard CA (y)/O=Someone Else')
        self.corp_pem, self.corp_sha1 = make_cert(self.certs, 'corp', '/CN=Example Inspection Root/O=Example Corp')
        self.lookalike_pem, self.lookalike_sha1 = make_cert(self.certs, 'lookalike', '/CN=Vibtra Guard local CA (x)/O=Someone Else')
        self.keychain_pems = root / 'keychain.pem'
        self.keychain_pems.write_text(''.join(p.read_text() for p in (self.guard_pem, self.old_pem, self.rust_pem, self.corp_pem,
                                                                    self.lookalike_pem, self.rust_lookalike_pem)))

        (self.data / 'device.json').write_text(json.dumps({'deviceId': 'gdev_0123456789abcdef', 'orgHandle': 'example-org'}))
        (self.data / 'guard-ca-bundle.pem').write_text('fixture bundle')
        (self.lib / 'Keychains').mkdir()
        (self.lib / 'Keychains/login.keychain-db').write_bytes(b'fixture keychain, never opened')
        self.guard_owned = [self.data, self.lib / 'Logs/Vibtra Guard', self.lib / 'Group Containers/P2UU927A6W.app.vibtra.guard',
                            self.lib / 'Caches/app.vibtra.guard', self.lib / 'HTTPStorages/app.vibtra.guard',
                            self.lib / 'Saved Application State/app.vibtra.guard.savedState']
        for path in self.guard_owned[1:]:
            path.mkdir(parents=True)
            (path / 'file').write_text('guard')
        (self.lib / 'Preferences').mkdir()
        (self.lib / 'Preferences/app.vibtra.guard.plist').write_bytes(plistlib.dumps({'k': 1}))
        (self.lib / 'LaunchAgents').mkdir()
        self.guard_plist = self.lib / 'LaunchAgents/app.vibtra.guard.agent.plist'
        self.guard_plist.write_bytes(plistlib.dumps({'Label': 'app.vibtra.guard.agent'}))
        self.unrelated = [self.lib / 'LaunchAgents/com.example.other.plist', self.lib / 'Application Support/Other/state',
                          self.lib / 'Preferences/com.example.other.plist', self.lib / 'Caches/com.example.other/file']
        for path in self.unrelated:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('unrelated')
        self.zshrc = self.home / '.zshrc'
        self.zshrc.write_text("export PATH=/opt/bin:$PATH\nexport SSL_CERT_FILE='%s/guard-ca-bundle.pem'\n" % self.data)
        self.app = root / 'Applications/VibtraGuard.app'
        (self.app / 'Contents/MacOS').mkdir(parents=True)
        (self.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'app.vibtra.guard',
                                                                       'CFBundleExecutable': 'VibtraGuard'}))
        app_stub = self.app / 'Contents/MacOS/VibtraGuard'
        app_stub.write_text(RECORD.replace('NAME', 'app', 1) + 'exit ${GUARD_TEST_APP_EXIT:-0}\n')
        app_stub.chmod(0o700)

    def run(self, *args, stdin='', sysext='', env=None, script=SCRIPT):
        environment = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.home), 'TMPDIR': str(self.root / 'tmp'),
                       'GUARD_UNINSTALL_TOOLS': str(self.tools), 'GUARD_TEST_CALLS': str(self.calls),
                       'GUARD_TEST_KEYCHAIN_PEMS': str(self.keychain_pems), 'GUARD_TEST_SYSEXT': sysext}
        environment.update(env or {})
        if self.calls.exists():
            self.calls.unlink()
        return subprocess.run(['/bin/zsh', str(script), '--app', str(self.app), *args], input=stdin, env=environment,
                              capture_output=True, text=True, timeout=60)

    def call_lines(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def tree(self):
        return sorted(str(p.relative_to(self.root)) for p in self.root.rglob('*')
                      if 'tmp' not in p.relative_to(self.root).parts[:1] and p.name != 'calls.log')


class UninstallScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-uninstall-it.')
        self.f = Fixture(Path(self.tmp.name).resolve())

    def tearDown(self):
        self.tmp.cleanup()

    def assert_calls_stay_in_fixture(self):
        for line in self.f.call_lines():
            for arg in line.split('\t')[1:]:
                if arg.startswith('/'):
                    self.assertTrue(arg.startswith(str(self.f.root)), 'call left the fixture: ' + line)

    def test_dry_run_prints_every_action_and_changes_nothing(self):
        before = self.f.tree()
        zshrc = self.f.zshrc.read_text()
        result = self.f.run('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.f.tree(), before)
        self.assertEqual(self.f.zshrc.read_text(), zshrc)
        for line in self.f.call_lines():
            self.assertTrue(line.split('\t')[0] in READ_ONLY or line.startswith('security\tfind-certificate'), 'dry run ran ' + line)
        out = result.stdout
        for expected in ('+ ' + str(self.f.tools / 'pkill') + ' -x VibtraGuard', '-x vibtra-guard', 'launchctl bootout gui/',
                         str(self.f.guard_plist), 'remove-trusted-cert', 'delete-certificate -Z ' + self.f.guard_sha1,
                         'delete-certificate -Z ' + self.f.old_sha1, 'delete-certificate -Z ' + self.f.rust_sha1, 'osascript', 'rm -rf',
                         "Application Support/Vibtra Guard'", 'defaults delete app.vibtra.guard', 'revokes it in the Guard web dashboard',
                         'gdev_0123456789abcdef', str(self.f.zshrc), 'Dry run finished. Nothing was changed.'):
            self.assertIn(expected, out)
        for other in (self.f.corp_sha1, self.f.lookalike_sha1, self.f.rust_lookalike_sha1):
            self.assertNotIn(other, out)
        self.assert_calls_stay_in_fixture()

    def test_removes_only_guard_owned_items_including_the_agents_real_certificate(self):
        result = self.f.run('--yes')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in self.f.guard_owned + [self.f.guard_plist, self.f.lib / 'Preferences/app.vibtra.guard.plist']:
            self.assertFalse(path.exists(), path)
        for path in self.f.unrelated + [self.f.lib / 'Keychains/login.keychain-db']:
            self.assertTrue(path.exists(), path)
        self.assertIn('guard-ca-bundle.pem', self.f.zshrc.read_text(), 'shell profiles are never edited')
        calls = self.f.call_lines()
        deletes = [c for c in calls if c.startswith('security\tdelete-certificate')]
        self.assertEqual(sorted(c.split('\t')[3] for c in deletes), sorted([self.f.guard_sha1, self.f.old_sha1, self.f.rust_sha1]),
                         'the certificate the real agent generated is recognised and removed')
        for c in deletes:
            self.assertEqual(c.split('\t')[2], '-Z')
            self.assertEqual(c.split('\t')[4], str(self.f.lib / 'Keychains/login.keychain-db'))
        self.assertIn('security\tfind-certificate\t-a\t-c\tVibtra Guard\t-p\t' + str(self.f.lib / 'Keychains/login.keychain-db'), calls)
        self.assertEqual(len([c for c in calls if c.startswith('security\tremove-trusted-cert')]), 3)
        self.assertFalse(any(x in '\n'.join(calls) for x in (self.f.corp_sha1, self.f.lookalike_sha1, self.f.rust_lookalike_sha1)))
        self.assertIn('pkill\t-x\tVibtraGuard', calls)
        self.assertIn('pkill\t-x\tvibtra-guard', calls)
        self.assertEqual([c for c in calls if c.startswith('launchctl')], ['launchctl\tbootout\tgui/%d\t%s' % (os.getuid(), self.f.guard_plist)])
        trash = [c for c in calls if c.startswith('osascript')]
        self.assertEqual(len(trash), 1)
        self.assertTrue(trash[0].endswith('\t' + str(self.f.app)))
        self.assertIn('defaults\tdelete\tapp.vibtra.guard', calls)
        self.assertIn('Vibtra Guard was removed.', result.stdout)
        self.assert_calls_stay_in_fixture()

    def test_earlier_certificates_and_a_legacy_key_file_are_untrusted_and_removed(self):
        stale, stale_sha1 = make_cert(self.f.certs, 'stale', '/CN=Vibtra Guard local CA (this-mac)/O=Vibtra Guard')
        kept = self.f.data / ('ca-stale-%s.pem' % stale_sha1[:12].lower())
        kept.write_text(stale.read_text())
        legacy_key = self.f.data / 'ca.key'
        legacy_key.write_text('placeholder for a pre-Secure-Enclave key file\n')
        result = self.f.run('--yes')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.f.call_lines()
        self.assertIn('security\tremove-trusted-cert\t' + str(kept), calls)
        self.assertNotIn('security\tdelete-certificate\t-Z\t' + stale_sha1 + '\t' + str(self.f.lib / 'Keychains/login.keychain-db'), calls,
                         'a certificate that is not in the keychain is only untrusted')
        self.assertFalse(kept.exists())
        self.assertFalse(legacy_key.exists())
        self.assertIn('cannot delete the Guard certificate\'s key from the Secure Enclave', result.stdout)

    def test_from_app_leaves_app_and_extension_to_the_app(self):
        result = self.f.run('--yes', '--from-app')
        self.assertEqual(result.returncode, 0, result.stdout)
        calls = self.f.call_lines()
        self.assertNotIn('pkill\t-x\tVibtraGuard', calls)
        self.assertIn('pkill\t-x\tvibtra-guard', calls)
        self.assertFalse(any(c.startswith('osascript') for c in calls))
        self.assertTrue(self.f.app.exists())
        self.assertFalse(self.f.data.exists())
        self.assertNotIn('Secure Enclave', result.stdout, 'Remove Guard in the app already deleted the key')

    def test_another_app_at_the_path_is_left_alone(self):
        (self.f.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': 'com.example.other'}))
        result = self.f.run('--yes')
        self.assertFalse(any(c.startswith('osascript') for c in self.f.call_lines()))
        self.assertIn('is not the Vibtra Guard app', result.stdout)

    def test_pending_extension_removal_asks_for_restart(self):
        listing = '*\t*\tP2UU927A6W\tapp.vibtra.guard.extension (0.1.0/29)\tVibtra Guard\t[terminated waiting to uninstall on reboot]'
        result = self.f.run('--yes', sysext=listing)
        self.assertIn('Restart this Mac to finish removing the network extension.', result.stdout)

    def test_declining_or_unsafe_environment_changes_nothing(self):
        before = self.f.tree()
        result = self.f.run(stdin='n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('Nothing was changed.', result.stdout)
        self.assertEqual(self.f.tree(), before)
        for unsafe in (str(self.f.home), '/', 'relative/dir'):
            result = self.f.run('--yes', env={'VIBTRA_GUARD_DIR': unsafe})
            self.assertEqual(result.returncode, 2, unsafe)
            self.assertEqual(self.f.tree(), before)
        self.assertEqual(self.f.call_lines(), [])

    def test_failed_step_is_reported(self):
        (self.f.tools / 'defaults').write_text(RECORD.replace('NAME', 'defaults', 1) + 'exit 5\n')
        result = self.f.run('--yes')
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not complete', result.stdout)

    def custom_items(self):
        lib = self.f.lib
        items = [lib / 'Group Containers/ZZ9EXAMPLE.com.example.guard', lib / 'Caches/com.example.guard',
                 lib / 'HTTPStorages/com.example.guard', lib / 'Saved Application State/com.example.guard.savedState']
        for path in items:
            path.mkdir(parents=True)
            (path / 'file').write_text('guard')
        (lib / 'Preferences/com.example.guard.plist').write_bytes(plistlib.dumps({'k': 1}))
        return items + [lib / 'Preferences/com.example.guard.plist']

    def test_the_bundled_copy_removes_the_build_named_in_its_own_info_plist(self):
        custom = self.custom_items()
        (self.f.app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': 'com.example.guard', 'CFBundleExecutable': 'VibtraGuard', 'GuardTeamID': 'ZZ9EXAMPLE', 'GuardAppBundleID': 'com.example.guard',
            'GuardExtensionBundleID': 'com.example.guard.filter'}))
        resources = self.f.app / 'Contents/Resources'
        resources.mkdir()
        bundled = resources / 'uninstall-guard.sh'
        bundled.write_text(SCRIPT.read_text())
        listing = '*\t*\tZZ9EXAMPLE\tcom.example.guard.filter (0.1.0/29)\tVibtra Guard\t[terminated waiting to uninstall on reboot]'
        result = self.f.run('--yes', script=bundled, sysext=listing)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for path in custom:
            self.assertFalse(path.exists(), path)
        for path in (self.f.lib / 'Group Containers/P2UU927A6W.app.vibtra.guard', self.f.lib / 'Caches/app.vibtra.guard',
                     self.f.lib / 'Preferences/app.vibtra.guard.plist'):
            self.assertTrue(path.exists(), 'another build\'s files are left alone: %s' % path)
        calls = self.f.call_lines()
        self.assertIn('defaults\tdelete\tcom.example.guard', calls)
        self.assertNotIn('defaults\tdelete\tapp.vibtra.guard', calls)
        self.assertEqual(len([c for c in calls if c.startswith('osascript')]), 1, 'the app at --app is this build, so it is trashed')
        self.assertIn('Restart this Mac to finish removing the network extension.', result.stdout)

    def test_environment_names_the_build_when_run_from_the_repository(self):
        custom = self.custom_items()
        env = {'GUARD_TEAM_ID': 'ZZ9EXAMPLE', 'GUARD_APP_ID': 'com.example.guard', 'GUARD_EXTENSION_ID': 'com.example.guard.filter'}
        result = self.f.run('--yes', env=env)
        for path in custom:
            self.assertFalse(path.exists(), path)
        self.assertTrue((self.f.lib / 'Caches/app.vibtra.guard').exists())
        self.assertFalse(any(c.startswith('osascript') for c in self.f.call_lines()))
        self.assertIn('is not the Vibtra Guard app (com.example.guard)', result.stdout)

    def test_an_unknown_or_unsafe_identity_changes_nothing(self):
        before = self.f.tree()
        for env in ({'GUARD_APP_ID': '*'}, {'GUARD_APP_ID': '../..'}, {'GUARD_TEAM_ID': 'p2uu927a6w'}, {'GUARD_EXTENSION_ID': 'a b.c'}):
            with self.subTest(env=env):
                result = self.f.run('--yes', env=env)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('Could not tell which Guard build this is', result.stderr)
                self.assertEqual(self.f.tree(), before)
                self.assertEqual(self.f.call_lines(), [])
        resources = self.f.app / 'Contents/Resources'
        resources.mkdir()
        bundled = resources / 'uninstall-guard.sh'
        bundled.write_text(SCRIPT.read_text())
        before = self.f.tree()
        result = self.f.run('--yes', script=bundled)
        self.assertEqual(result.returncode, 2, 'an app without identity keys is never guessed at')
        self.assertEqual(self.f.tree(), before)

    def test_unrelated_networking_trust_and_keychain_items_are_never_touched(self):
        result = self.f.run('--yes', sysext='*\t*\tP2UU927A6W\tapp.vibtra.guard.extension (1.0/1)\tGuard\t[terminated waiting to uninstall on reboot]')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Restart this Mac to finish removing the network extension.', result.stdout)
        allowed = {'pkill', 'launchctl', 'app', 'osascript', 'defaults', 'systemextensionsctl', 'security', 'openssl', 'plutil'}
        calls = self.f.call_lines()
        self.assertEqual({c.split('\t')[0] for c in calls} - allowed, set())
        security = sorted({c.split('\t')[1] for c in calls if c.startswith('security\t')})
        self.assertEqual(security, ['delete-certificate', 'find-certificate', 'remove-trusted-cert'])
        source = SCRIPT.read_text()
        for word in ('networksetup', 'scutil', 'pfctl', '/sbin/route', 'profiles remove', 'add-trusted-cert', 'generic-password',
                     'internet-password', 'delete-keychain', 'kextunload', 'sudo '):
            self.assertNotIn(word, source.replace('not with sudo.', ''), word)
        for path in self.f.unrelated + [self.f.lib / 'Keychains/login.keychain-db']:
            self.assertTrue(path.exists(), path)

    def test_the_generated_app_target_copies_the_script_into_its_resources(self):
        model = json.loads(subprocess.run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', str(PROJECT)],
                                          check=True, capture_output=True).stdout)
        objects = model['objects']
        app = next(v for v in objects.values() if v.get('isa') == 'PBXNativeTarget' and v.get('name') == 'VibtraGuard')
        resources = [objects[p] for p in app['buildPhases'] if objects[p]['isa'] == 'PBXResourcesBuildPhase']
        names = [objects[objects[f]['fileRef']].get('path') for phase in resources for f in phase.get('files', [])]
        self.assertIn('uninstall-guard.sh', names, 'Remove Guard runs Contents/Resources/uninstall-guard.sh')
        self.assertTrue(os.access(SCRIPT, os.R_OK))


    def test_from_terminal_the_app_removes_its_extension_before_it_is_trashed(self):
        result = self.f.run('--yes', env={'GUARD_TEST_APP_EXIT': '3'})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.f.call_lines()
        names = [c.split('\t')[0] for c in calls]
        self.assertIn('app\t--remove-extension', calls)
        self.assertLess(names.index('app'), names.index('osascript'), 'the extension is removed while the app still exists')
        self.assertIn('macOS removes the extension at the next restart.', result.stdout)
        self.assertIn('Restart this Mac to finish removing the network extension.', result.stdout)

    def test_a_refused_extension_removal_is_reported(self):
        result = self.f.run('--yes', env={'GUARD_TEST_APP_EXIT': '1'})
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('(the app could not remove the extension)', result.stdout)
        self.assertNotIn('Vibtra Guard was removed.', result.stdout)

    def test_an_extension_still_active_is_never_reported_as_removed(self):
        listing = '*\t*\tP2UU927A6W\tapp.vibtra.guard.extension (0.1.0/29)\tGuard\t[activated enabled]'
        result = self.f.run('--yes', sysext=listing)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('The network extension is still active, so Vibtra Guard was not fully removed.', result.stdout)
        self.assertNotIn('Vibtra Guard was removed', result.stdout)

    def test_the_dry_run_does_not_start_the_app(self):
        result = self.f.run('--dry-run', sysext='*\t*\tP2UU927A6W\tapp.vibtra.guard.extension (0.1.0/29)\tGuard\t[activated enabled]')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('VibtraGuard --remove-extension', result.stdout)
        self.assertFalse(any(c.startswith('app\t') for c in self.f.call_lines()))


if __name__ == '__main__':
    unittest.main()
