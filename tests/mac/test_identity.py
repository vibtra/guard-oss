# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
MAC = REPO / 'guard' / 'mac'
TOOLS = MAC / 'tools'
PROFILE_TOOL = TOOLS / 'mdm-profile.py'
IDENTITY_TOOL = TOOLS / 'identity.py'
PROJECT = MAC / 'VibtraGuard.xcodeproj' / 'project.pbxproj'
CUSTOM = {'GUARD_TEAM_ID': 'ZZ9EXAMPLE', 'GUARD_APP_ID': 'com.example.guard', 'GUARD_EXTENSION_ID': 'com.example.guard.filter'}
DEFAULT = {'GUARD_TEAM_ID': 'P2UU927A6W', 'GUARD_APP_ID': 'app.vibtra.guard', 'GUARD_EXTENSION_ID': 'app.vibtra.guard.extension'}


def clean_env(**extra):
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'DEVELOPER_DIR') if key in os.environ}
    env.update(extra)
    return env


def agent_binary():
    env = os.environ.get('VIBTRA_GUARD_AGENT_BIN')
    if env and os.access(env, os.X_OK):
        return Path(env)
    built = REPO / 'guard' / 'agent-go' / 'build' / 'vibtra-guard'
    if not os.access(built, os.X_OK):
        raise AssertionError('no agent binary: run zsh tests/mac/run.sh or zsh guard/agent-go/build.sh')
    return built


def signing_identifier(path):
    result = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=2', str(path)], capture_output=True, text=True)
    for line in (result.stdout + result.stderr).splitlines():
        if line.startswith('Identifier='):
            return line.split('=', 1)[1]
    return None


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-mdm-it.')
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def generate(self, *args, env=None, name='guard.mobileconfig'):
        out = self.root / name
        result = subprocess.run([sys.executable, str(PROFILE_TOOL), '--out', str(out), *args], env=clean_env(**(env or {})),
                                capture_output=True, text=True, timeout=60)
        return result, out

    def payloads(self, profile):
        return {payload['PayloadType']: payload for payload in profile['PayloadContent']}

    def assert_profile(self, out, team, app_id, ext_id):
        lint = subprocess.run(['/usr/bin/plutil', '-lint', str(out)], capture_output=True, text=True)
        self.assertEqual(lint.returncode, 0, lint.stdout + lint.stderr)
        profile = plistlib.loads(out.read_bytes())
        self.assertEqual(profile['PayloadType'], 'Configuration')
        self.assertEqual(profile['PayloadScope'], 'System')
        self.assertEqual(profile['PayloadIdentifier'], app_id + '.mdm')
        payloads = self.payloads(profile)
        self.assertEqual(sorted(payloads), ['com.apple.notificationsettings', 'com.apple.system-extension-policy', 'com.apple.webcontent-filter'])
        extensions = payloads['com.apple.system-extension-policy']
        self.assertEqual(extensions['AllowedSystemExtensions'], {team: [ext_id]})
        self.assertEqual(extensions['AllowedSystemExtensionTypes'], {team: ['NetworkExtension']})
        self.assertNotIn('RemovableSystemExtensions', extensions)
        self.assertNotIn('AllowUserOverrides', extensions, 'the profile never changes approval of other extensions')
        content = payloads['com.apple.webcontent-filter']
        self.assertEqual((content['FilterType'], content['PluginBundleID'], content['FilterDataProviderBundleIdentifier']), ('Plugin', app_id, ext_id))
        self.assertEqual((content['FilterSockets'], content['FilterPackets'], content['FilterGrade']), (True, False, 'firewall'),
                         'the same filter the app saves: sockets only (ExtensionController.turnOn)')
        requirement = content['FilterDataProviderDesignatedRequirement']
        self.assertIn('identifier "' + ext_id + '"', requirement)
        self.assertIn('certificate leaf[subject.OU] = "' + team + '"', requirement)
        compiled = subprocess.run(['/usr/bin/csreq', '-r', '=' + requirement, '-t'], capture_output=True, text=True)
        self.assertEqual(compiled.returncode, 0, compiled.stderr)
        self.assertIn('leaf[subject.OU] = ' + team, compiled.stdout)
        notices = payloads['com.apple.notificationsettings']['NotificationSettings']
        self.assertEqual([(n['BundleIdentifier'], n['NotificationsEnabled']) for n in notices], [(app_id, True)])
        uuids = [profile['PayloadUUID']] + [p['PayloadUUID'] for p in profile['PayloadContent']]
        self.assertEqual(len(set(uuids)), 4)
        identifiers = [p['PayloadIdentifier'] for p in profile['PayloadContent']]
        self.assertTrue(all(i.startswith(app_id + '.mdm.') for i in identifiers))
        self.assertEqual(len(set(identifiers)), 3)
        return profile

    def test_writes_a_valid_profile_with_the_exact_identifiers_given(self):
        result, out = self.generate('--team', CUSTOM['GUARD_TEAM_ID'], '--app-id', CUSTOM['GUARD_APP_ID'],
                                    '--extension-id', CUSTOM['GUARD_EXTENSION_ID'], '--organization', 'Example Corp')
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = self.assert_profile(out, *CUSTOM.values())
        self.assertEqual(profile['PayloadOrganization'], 'Example Corp')
        self.assertNotIn('P2UU927A6W', out.read_text())
        self.assertNotIn('app.vibtra.guard', out.read_text())
        again, second = self.generate('--team', CUSTOM['GUARD_TEAM_ID'], '--app-id', CUSTOM['GUARD_APP_ID'],
                                      '--extension-id', CUSTOM['GUARD_EXTENSION_ID'], '--organization', 'Example Corp', name='again.mobileconfig')
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(out.read_bytes(), second.read_bytes(), 'the same inputs give the same profile, so an MDM sees no change')

    def test_defaults_to_the_configured_identity_and_honours_the_environment(self):
        result, out = self.generate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_profile(out, *DEFAULT.values())
        result, out = self.generate(env=CUSTOM, name='env.mobileconfig')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_profile(out, *CUSTOM.values())

    def test_allow_removal_lists_the_extension_as_removable(self):
        result, out = self.generate('--allow-removal')
        self.assertEqual(result.returncode, 0, result.stderr)
        extensions = self.payloads(plistlib.loads(out.read_bytes()))['com.apple.system-extension-policy']
        self.assertEqual(extensions['RemovableSystemExtensions'], {DEFAULT['GUARD_TEAM_ID']: [DEFAULT['GUARD_EXTENSION_ID']]})

    def test_bad_identifiers_or_an_existing_file_write_nothing(self):
        for args in (('--team', 'p2uu927a6w'), ('--team', 'ZZ9EXAMPLE"'), ('--app-id', 'guard'), ('--extension-id', 'a"b.c'),
                     ('--app-id', 'com.example.guard', '--extension-id', 'com.example.guard')):
            with self.subTest(args=args):
                result, out = self.generate(*args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertFalse(out.exists())
        existing = self.root / 'guard.mobileconfig'
        existing.write_text('keep')
        result, _ = self.generate()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(existing.read_text(), 'keep')


class IdentityToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-identity-it.')
        self.mac = Path(self.tmp.name).resolve() / 'mac'
        (self.mac / 'tools').mkdir(parents=True)
        (self.mac / 'Config').mkdir()
        shutil.copyfile(MAC / 'Config' / 'Identity.xcconfig', self.mac / 'Config' / 'Identity.xcconfig')
        shutil.copyfile(IDENTITY_TOOL, self.mac / 'tools' / 'identity.py')

    def tearDown(self):
        self.tmp.cleanup()

    def resolve(self, env=None):
        return subprocess.run([sys.executable, str(self.mac / 'tools' / 'identity.py'), '--format', 'shell'], env=clean_env(**(env or {})),
                              capture_output=True, text=True, timeout=60)

    def test_local_file_then_environment_override_the_defaults_and_derive_the_rest(self):
        self.assertIn("GUARD_APP_GROUP=P2UU927A6W.app.vibtra.guard", self.resolve().stdout)
        (self.mac / 'Config' / 'Identity.local.xcconfig').write_text('GUARD_TEAM_ID = ZZ9EXAMPLE\nGUARD_APP_ID = com.example.guard\n')
        out = self.resolve().stdout.splitlines()
        self.assertIn('GUARD_APP_GROUP=ZZ9EXAMPLE.com.example.guard', out)
        self.assertIn('GUARD_EXTENSION_ID=app.vibtra.guard.extension', out)
        out = self.resolve({'GUARD_EXTENSION_ID': 'com.example.guard.filter'}).stdout.splitlines()
        for line in ('GUARD_TEAM_ID=ZZ9EXAMPLE', 'GUARD_APP_ID=com.example.guard', 'GUARD_EXTENSION_ID=com.example.guard.filter',
                     'GUARD_EXTENSION_MACH_SERVICE=ZZ9EXAMPLE.com.example.guard.filter.xpc', 'GUARD_AGENT_SIGNING_ID=com.example.guard.agent'):
            self.assertIn(line, out)

    def test_values_that_could_escape_a_plist_requirement_or_path_are_refused(self):
        for env in ({'GUARD_TEAM_ID': 'ZZ9EXAMPL"'}, {'GUARD_APP_ID': 'com.example/../x'}, {'GUARD_APP_ID': '$(HOME).x'},
                    {'GUARD_EXTENSION_ID': 'com.example.guard filter'}):
            with self.subTest(env=env):
                result = self.resolve(env)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, '')


class NonDefaultBuildTests(unittest.TestCase):
    def test_an_unsigned_build_with_other_identifiers_carries_them_everywhere(self):
        if shutil.which('xcodegen') is None:
            raise AssertionError('xcodegen is required (brew install xcodegen)')
        project_before = PROJECT.read_bytes()
        local = MAC / 'Config' / 'Identity.local.xcconfig'
        self.assertFalse(local.exists(), 'remove guard/mac/Config/Identity.local.xcconfig before running this test')
        env = clean_env(VIBTRA_GUARD_AGENT_BIN=str(agent_binary()), **CUSTOM)
        result = subprocess.run(['/bin/zsh', str(MAC / 'build.sh'), '--unsigned'], env=env, capture_output=True, text=True, timeout=1800)
        self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr[-2000:])
        self.assertIn('identity: team ZZ9EXAMPLE, app com.example.guard, extension com.example.guard.filter', result.stdout)
        self.assertEqual(PROJECT.read_bytes(), project_before, 'other identifiers never change the generated project (no xcodegen drift)')
        self.assertFalse(local.exists(), 'build.sh puts Config/Identity.local.xcconfig back as it found it')
        app = MAC / 'build' / 'Debug' / 'VibtraGuard.app'
        ext = app / 'Contents' / 'Library' / 'SystemExtensions' / 'com.example.guard.filter.systemextension'
        self.assertEqual(sorted(p.name for p in ext.parent.iterdir()), [ext.name])
        app_info = plistlib.loads((app / 'Contents' / 'Info.plist').read_bytes())
        ext_info = plistlib.loads((ext / 'Contents' / 'Info.plist').read_bytes())
        expected = {'GuardTeamID': 'ZZ9EXAMPLE', 'GuardAppBundleID': 'com.example.guard', 'GuardExtensionBundleID': 'com.example.guard.filter',
                    'GuardAppGroup': 'ZZ9EXAMPLE.com.example.guard', 'GuardExtensionMachService': 'ZZ9EXAMPLE.com.example.guard.filter.xpc',
                    'GuardAgentSigningID': 'com.example.guard.agent'}
        for info in (app_info, ext_info):
            self.assertEqual({key: info.get(key) for key in expected}, expected)
        self.assertEqual(app_info['CFBundleIdentifier'], 'com.example.guard')
        self.assertEqual(app_info['CFBundleURLTypes'][0]['CFBundleURLName'], 'com.example.guard.enrol')
        self.assertEqual(ext_info['CFBundleIdentifier'], 'com.example.guard.filter')
        self.assertEqual(ext_info['CFBundleExecutable'], 'com.example.guard.filter')
        self.assertEqual(ext_info['NetworkExtension']['NEMachServiceName'], 'ZZ9EXAMPLE.com.example.guard.filter.xpc')
        self.assertEqual(signing_identifier(app / 'Contents' / 'MacOS' / 'vibtra-guard'), 'com.example.guard.agent')
        profile_out = Path(tempfile.mkdtemp(prefix='guard-mdm-build.')) / 'guard.mobileconfig'
        try:
            made = subprocess.run([sys.executable, str(PROFILE_TOOL), '--out', str(profile_out)], env=clean_env(**CUSTOM),
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(made.returncode, 0, made.stderr)
            payloads = {p['PayloadType']: p for p in plistlib.loads(profile_out.read_bytes())['PayloadContent']}
            self.assertEqual(payloads['com.apple.system-extension-policy']['AllowedSystemExtensions'],
                             {app_info['GuardTeamID']: [ext_info['CFBundleIdentifier']]})
            self.assertEqual(payloads['com.apple.webcontent-filter']['PluginBundleID'], app_info['CFBundleIdentifier'])
            self.assertEqual(payloads['com.apple.webcontent-filter']['FilterDataProviderBundleIdentifier'], ext_info['CFBundleIdentifier'])
            self.assertEqual(payloads['com.apple.notificationsettings']['NotificationSettings'][0]['BundleIdentifier'], app_info['CFBundleIdentifier'])
        finally:
            shutil.rmtree(profile_out.parent)


if __name__ == '__main__':
    unittest.main()
