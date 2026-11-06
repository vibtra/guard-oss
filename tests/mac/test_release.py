# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import ast
import datetime as dt
import functools
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
REPO = Path(__file__).resolve().parents[2]
MAC = REPO / 'guard' / 'mac'
RELEASE = MAC / 'release.py'
PROJECT = MAC / 'VibtraGuard.xcodeproj' / 'project.pbxproj'
TEAM = 'ZZ9EXAMPLE'
APP_ID = 'app.vibtra.guard'
EXT_ID = APP_ID + '.extension'
AGENT_ID = APP_ID + '.agent'
sys.path.insert(0, str(MAC / 'tools'))
import identity as guard_identity

GO = shutil.which('go')
FIXTURES = tempfile.TemporaryDirectory(prefix='guard-agent-fixtures.')


@functools.cache
def fixture_agent(tags=''):
    """A real Go program standing in for the agent, so `go version -m` reads real build info."""
    if GO is None:
        raise AssertionError('no go on PATH: the release tests build small Go fixture binaries')
    source = Path(FIXTURES.name) / 'src'
    source.mkdir(exist_ok=True)
    (source / 'go.mod').write_text('module example.invalid/agent\n\ngo 1.22\n')
    (source / 'main.go').write_text('package main\n\nfunc main() {}\n')
    out = Path(FIXTURES.name) / ('agent-' + (tags or 'plain'))
    env = {**os.environ, 'CGO_ENABLED': '0', 'GOFLAGS': ''}
    subprocess.run([GO, 'build', '-trimpath', *(['-tags', tags] if tags else []), '-o', str(out), '.'], cwd=source, env=env,
                   check=True, capture_output=True, timeout=300)
    return out


def agent_binary():
    env = os.environ.get('VIBTRA_GUARD_AGENT_BIN')
    if env and os.access(env, os.X_OK):
        return Path(env)
    built = REPO / 'guard' / 'agent-go' / 'build' / 'vibtra-guard'
    if not os.access(built, os.X_OK):
        raise AssertionError('no agent binary: run zsh tests/mac/run.sh or zsh guard/agent-go/build.sh')
    return built


def bundle_phase():
    model = json.loads(subprocess.run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', str(PROJECT)],
                                      check=True, capture_output=True).stdout)
    objects = model['objects']
    for value in objects.values():
        if value.get('isa') == 'PBXShellScriptBuildPhase' and value.get('name') == 'Bundle the agent':
            return value['shellScript']
    raise AssertionError('the generated project has no "Bundle the agent" phase')


def signing_identifier(path):
    result = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=2', str(path)], capture_output=True, text=True)
    for line in (result.stdout + result.stderr).splitlines():
        if line.startswith('Identifier='):
            return line.split('=', 1)[1]
    return None


class Tools:
    def __init__(self, root):
        self.bin = root / 'bin'
        self.bin.mkdir()
        self.calls = root / 'tool-calls.log'
        for name in ('go', 'xcodegen', 'xcodebuild'):
            stub = self.bin / name
            stub.write_text('#!/bin/sh\nprintf "%s %s\\n" "' + name + '" "$*" >> "' + str(self.calls) + '"\nexit 0\n')
            stub.chmod(0o700)

    def called(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []


class ReleaseCommandTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-release-it.')
        self.root = Path(self.tmp.name).resolve()
        self.tools = Tools(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def release(self, *args, path=None):
        env = {'PATH': path if path is not None else str(self.tools.bin), 'HOME': os.environ.get('HOME', str(self.root)),
               'TMPDIR': str(self.root)}
        return subprocess.run([sys.executable, str(RELEASE), *args], env=env, capture_output=True, text=True, timeout=120)

    def report(self, result):
        start = result.stdout.index('{')
        return json.loads(result.stdout[start:])

    def test_preflight_runs_every_check_and_names_only_founder_items(self):
        stray = self.root / 'app.provisionprofile'
        stray.write_bytes(b'not a profile')
        result = self.release('preflight', '--team', TEAM, '--app-profile', str(stray))
        self.assertEqual(result.returncode, 1, result.stderr)
        report = self.report(result)
        names = [check['check'] for check in report['checks']]
        for name in ('team', 'developer-id-identity', 'app-profile', 'extension-profile', 'release-entitlements', 'architecture',
                     'minimum-macos', 'tool:go', 'tool:xcodegen', 'tool:xcodebuild', 'tool:notarytool', 'tool:stapler', 'notary-credentials'):
            self.assertIn(name, names)
        self.assertEqual(report['status'], 'developer-id-preflight-blocked')
        self.assertEqual(report['blockedOnFounder'], ['developer-id-identity', 'app-profile', 'extension-profile'])
        for code in ('team', 'release-entitlements', 'architecture', 'minimum-macos', 'tool:go', 'tool:xcodegen', 'tool:xcodebuild'):
            self.assertNotIn(code, report['blockedOnCode'], 'the repository itself is release-ready: ' + code)
        self.assertEqual(report['minimumMacOS'], '14.0')
        self.assertEqual(report['architecture'], 'arm64')
        self.assertFalse(report['notarizationCredentialsChecked'])
        actions = report['founderActions']
        self.assertEqual(len(actions), 4)
        self.assertIn('Developer ID Application certificate for team ' + TEAM, actions[0])
        self.assertIn('for ' + APP_ID + ' containing', actions[1])
        self.assertIn('com.apple.developer.system-extension.install=true', actions[1])
        self.assertIn('keychain-access-groups=' + TEAM + '.* (or ' + TEAM + '.' + APP_ID + '.ca)', actions[1])
        self.assertNotIn('keychain-access-groups', actions[2], 'only the app keeps the CA key')
        self.assertIn('for ' + EXT_ID + ' containing', actions[2])
        self.assertIn('notarytool store-credentials', actions[3])
        self.assertIn('Release not ready. Founder must provision:', result.stderr)
        self.assertEqual(self.tools.called(), [], 'preflight builds nothing')

    def test_preflight_separates_missing_build_tools_from_founder_items(self):
        empty = self.root / 'empty-path'
        empty.mkdir()
        result = self.release('preflight', '--team', TEAM, path=str(empty))
        self.assertEqual(result.returncode, 1)
        report = self.report(result)
        self.assertEqual(report['blockedOnCode'][:3], ['tool:go', 'tool:xcodegen', 'tool:xcodebuild'])
        self.assertEqual(report['blockedOnFounder'], ['developer-id-identity', 'app-profile', 'extension-profile'])
        self.assertTrue(result.stderr.startswith('Failing checks that are not founder items: tool:go, tool:xcodegen, tool:xcodebuild'), result.stderr)

    def test_build_without_a_developer_id_identity_stops_before_anything_is_built(self):
        out = self.root / 'release-out'
        result = self.release('build', '--team', TEAM, '--out', str(out))
        self.assertEqual(result.returncode, 1)
        self.assertIn('Release refused: No valid Developer ID Application identity for this team; Apple Development/ad-hoc signing is not accepted',
                      result.stderr)
        self.assertFalse(out.exists(), 'no output directory, no unsigned fallback')
        self.assertEqual(self.tools.called(), [], 'go, xcodegen and xcodebuild never ran')

    def test_bad_arguments_are_refused(self):
        missing = self.release('build', '--team', TEAM)
        self.assertEqual(missing.returncode, 2)
        self.assertIn('--out is required for build', missing.stderr)
        team = self.release('build', '--team', 'not-a-team', '--out', str(self.root / 'x'))
        self.assertEqual(team.returncode, 1)
        self.assertIn('Release refused: Invalid team identifier', team.stderr)
        report = self.report(self.release('preflight', '--team', 'not-a-team'))
        self.assertIn('team', report['blockedOnCode'])


class BundleAgentPhaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-phase-it.')
        self.root = Path(self.tmp.name).resolve()
        self.script = self.root / 'phase.sh'
        self.script.write_text(bundle_phase())
        self.products = self.root / 'products'
        (self.products / 'VibtraGuard.app' / 'Contents' / 'MacOS').mkdir(parents=True)
        self.agent = self.root / 'vibtra-guard'
        self.agent.write_bytes(agent_binary().read_bytes())
        self.agent.chmod(0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def run_phase(self, configuration, allowed, identity, script=None, agent=None, signing_id=AGENT_ID):
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'CONFIGURATION': configuration, 'CODE_SIGNING_ALLOWED': allowed,
               'GUARD_AGENT_SIGNING_ID': signing_id,
               'EXPANDED_CODE_SIGN_IDENTITY': identity, 'VIBTRA_GUARD_AGENT_BIN': str(agent or self.agent),
               'TARGET_BUILD_DIR': str(self.products), 'EXECUTABLE_FOLDER_PATH': 'VibtraGuard.app/Contents/MacOS',
               'UNLOCALIZED_RESOURCES_FOLDER_PATH': 'VibtraGuard.app/Contents/Resources', 'SRCROOT': str(MAC)}
        return subprocess.run(['/bin/zsh', str(script or self.script)], env=env, capture_output=True, text=True, timeout=120)

    @property
    def bundled(self):
        return self.products / 'VibtraGuard.app' / 'Contents' / 'MacOS' / 'vibtra-guard'

    def test_debug_builds_bundle_and_sign_the_real_agent_with_its_own_identity(self):
        for allowed, identity in (('NO', ''), ('YES', '-')):
            with self.subTest(allowed=allowed):
                result = self.run_phase('Debug', allowed, identity)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('bundled the agent from', result.stdout)
                self.assertEqual(signing_identifier(self.bundled), AGENT_ID)
                verify = subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(self.bundled)], capture_output=True, text=True)
                self.assertEqual(verify.returncode, 0, verify.stderr)
                notices = self.products / 'VibtraGuard.app' / 'Contents' / 'Resources' / 'GuardNotices'
                self.assertEqual(sorted(p.name for p in notices.iterdir()), ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'])
                ran = subprocess.run([str(self.bundled), '--help'], capture_output=True, text=True, timeout=30)
                self.assertIn('vibtra-guard', ran.stdout, 'the bundled copy still runs')

    def test_release_never_signs_ad_hoc(self):
        for allowed, identity in (('NO', ''), ('YES', '-'), ('YES', '')):
            with self.subTest(allowed=allowed, identity=identity):
                if self.bundled.exists():
                    self.bundled.unlink()
                result = self.run_phase('Release', allowed, identity)
                self.assertEqual(result.returncode, 1)
                self.assertIn('error: Release requires a real Developer ID signing identity; no ad-hoc fallback', result.stdout)
                self.assertNotIn('bundled the agent', result.stdout)
                self.assertNotEqual(signing_identifier(self.bundled), AGENT_ID, 'nothing re-signed the copy')

    def test_release_signs_with_a_secure_timestamp_and_debug_without_one(self):
        capture = self.root / 'codesign-args'
        stub = self.root / 'codesign-stub'
        stub.write_text('#!/bin/zsh\nprint -rl -- "$@" > "' + str(capture) + '"\nexit ${STUB_EXIT:-0}\n')
        stub.chmod(0o700)
        script = self.root / 'phase-stubbed.sh'
        script.write_text(bundle_phase().replace('/usr/bin/codesign', str(stub)))
        identity = 'A' * 40
        for configuration, stamp, absent in (('Release', '--timestamp', '--timestamp=none'), ('Debug', '--timestamp=none', '--timestamp')):
            with self.subTest(configuration=configuration):
                result = self.run_phase(configuration, 'YES', identity, script=script)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                args = capture.read_text().splitlines()
                self.assertIn(stamp, args)
                self.assertNotIn(absent, args)
                self.assertEqual(args[args.index('--sign') + 1], identity)
                self.assertEqual(args[args.index('--identifier') + 1], AGENT_ID)
                self.assertEqual(args[args.index('--options') + 1], 'runtime')

    def test_the_agent_is_signed_with_the_configured_identifier_and_never_without_one(self):
        result = self.run_phase('Debug', 'NO', '', signing_id='com.example.guard.agent')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(signing_identifier(self.bundled), 'com.example.guard.agent')
        self.bundled.unlink()
        missing = self.run_phase('Debug', 'NO', '', signing_id='')
        self.assertEqual(missing.returncode, 1)
        self.assertIn('error: GUARD_AGENT_SIGNING_ID is not set', missing.stdout)
        self.assertFalse(self.bundled.exists())

    def test_a_missing_agent_or_a_failed_signature_fails_the_build(self):
        missing = self.run_phase('Debug', 'NO', '', agent=self.root / 'absent')
        self.assertEqual(missing.returncode, 1)
        self.assertIn('error: Vibtra Guard agent not found at', missing.stdout)
        self.assertFalse(self.bundled.exists())
        stub = self.root / 'codesign-fails'
        stub.write_text('#!/bin/zsh\nexit 42\n')
        stub.chmod(0o700)
        script = self.root / 'phase-failing.sh'
        script.write_text(bundle_phase().replace('/usr/bin/codesign', str(stub)))
        for configuration in ('Debug', 'Release'):
            with self.subTest(configuration=configuration):
                failed = self.run_phase(configuration, 'YES', 'A' * 40, script=script)
                self.assertEqual(failed.returncode, 42)
                self.assertNotIn('bundled the agent', failed.stdout)


CERT = b'made-up Developer ID Application certificate'
IDENTITY = hashlib.sha1(CERT).hexdigest().upper()
APP_UUID = 'AAAAAAAA-0000-4000-8000-000000000001'
EXT_UUID = 'AAAAAAAA-0000-4000-8000-000000000002'
DEVELOPER_ID = 'Developer ID Application: Example Org (' + TEAM + ')'
REPLACED_TOOLS = ('security', 'codesign', 'lipo', 'xcrun')
KNOWN_TOOL_PATHS = {'/usr/bin/' + tool for tool in REPLACED_TOOLS + ('ditto',)}
CREDENTIALS = {'APPLE_APP_SPECIFIC_PASSWORD': 'made-up-app-password', 'APPLE_API_KEY': '/made/up/AuthKey_EXAMPLE.p8',
               'OPENAI_API_KEY': 'sk-test-FAKE-not-a-key'}
SIGNED_DETAIL = ('Identifier=app.vibtra.guard\n'
                 'CodeDirectory v=20500 size=512 flags=0x10000(runtime) hashes=3+7 location=embedded\n'
                 'Authority=' + DEVELOPER_ID + '\n'
                 'Authority=Developer ID Certification Authority\n'
                 'Authority=Apple Root CA\n'
                 'Timestamp=Oct 26, 2026 at 10:00:00\n'
                 'TeamIdentifier=' + TEAM + '\n')
STUB = '''import json
import os
import pathlib
import plistlib
import sys

args = sys.argv[1:]
root = pathlib.Path(ROOT)
scenario = json.loads((root / 'scenario.json').read_text())
with open(root / 'calls.jsonl', 'a') as calls:
    calls.write(json.dumps({'tool': TOOL, 'args': args, 'env': dict(os.environ)}) + '\\n')


def flag(name):
    return args[args.index(name) + 1]


def bundle_id(bundle):
    return plistlib.loads((pathlib.Path(bundle) / 'Contents' / 'Info.plist').read_bytes())['CFBundleIdentifier']


if TOOL == 'security' and args[:1] == ['find-identity']:
    sys.stdout.write(scenario['identities'])
elif TOOL == 'security' and args[:2] == ['cms', '-D']:
    sys.stdout.buffer.write(pathlib.Path(flag('-i')).read_bytes())
elif TOOL == 'xcrun' and args[:1] == ['--find']:
    print('/Applications/Xcode.app/Contents/Developer/usr/bin/' + args[1])
elif TOOL == 'codesign' and '--verify' in args:
    sys.exit(scenario.get('verifyExit', 0))
elif TOOL == 'codesign' and '--entitlements' in args:
    granted = plistlib.loads(pathlib.Path(scenario['entitlements'][bundle_id(args[-1])]).read_bytes())
    granted.update(scenario.get('extraEntitlements', {}))
    sys.stdout.buffer.write(plistlib.dumps(granted))
elif TOOL == 'codesign' and '-d' in args:
    sys.stderr.write(scenario['detail'])
elif TOOL == 'lipo':
    print(scenario.get('arch', 'arm64'))
elif TOOL == 'go' and args[:2] == ['version', '-m']:
    os.execv(scenario['go'], [scenario['go'], *args])
elif TOOL == 'go':
    pathlib.Path(flag('-o')).write_bytes(pathlib.Path(scenario['agent']).read_bytes())
elif TOOL == 'xcodegen':
    pass
elif TOOL == 'xcodebuild':
    if scenario.get('xcodebuildExit'):
        sys.exit(scenario['xcodebuildExit'])
    settings = dict(arg.split('=', 1) for arg in args if '=' in arg and not arg.startswith('-'))
    app = pathlib.Path(settings['SYMROOT']) / 'Release' / 'VibtraGuard.app'
    extension = app / 'Contents' / 'Library' / 'SystemExtensions' / 'app.vibtra.guard.extension.systemextension'
    for bundle, identifier, executable in ((app, 'app.vibtra.guard', 'VibtraGuard'),
                                           (extension, 'app.vibtra.guard.extension', 'app.vibtra.guard.extension')):
        (bundle / 'Contents' / 'MacOS').mkdir(parents=True, exist_ok=True)
        (bundle / 'Contents' / 'MacOS' / executable).write_bytes(b'made-up executable')
        (bundle / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': identifier, 'CFBundleExecutable': executable}))
        (bundle / 'Contents' / 'embedded.provisionprofile').write_bytes(pathlib.Path(scenario['embedded'][identifier]).read_bytes())
    (app / 'Contents' / 'MacOS' / 'vibtra-guard').write_bytes(pathlib.Path(os.environ['VIBTRA_GUARD_AGENT_BIN']).read_bytes())
else:
    sys.exit(64)
'''


def absolute_paths(source):
    return {node.value for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Constant) and isinstance(node.value, (str, bytes)) and node.value[:1] in ('/', b'/')}


def stubbed_copy(source, bin_dir):
    for tool in REPLACED_TOOLS:
        source = source.replace(f"'/usr/bin/{tool}'", repr(str(bin_dir / tool)))
    return source


def identities(*rows):
    lines = [f'  {number}) {digest} "{name}"' for number, (digest, name) in enumerate(rows, 1)]
    return '\n'.join(lines + [f'     {len(rows)} valid identities found']) + '\n'


def entitlements_file(bundle_id):
    target = 'VibtraGuard' if bundle_id == APP_ID else 'VibtraGuardExtension'
    return MAC / target / (target + '.entitlements')


def built_entitlements(bundle_id, team=TEAM, app_id=APP_ID, ext_id=EXT_ID):
    source = plistlib.loads(entitlements_file(bundle_id).read_bytes())
    return guard_identity.expand(source, guard_identity.derive(team, app_id, ext_id))


class SignedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-signed-release-it.')
        self.root = Path(self.tmp.name).resolve()
        mac = self.root / 'guard' / 'mac'
        for relative in ('project.yml', 'Config/Identity.xcconfig', 'tools/identity.py', 'VibtraGuard/VibtraGuard.entitlements',
                         'VibtraGuardExtension/VibtraGuardExtension.entitlements'):
            (mac / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(MAC / relative, mac / relative)
        (self.root / 'guard' / 'agent-go').mkdir()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for tool in ('go', 'xcodegen', 'xcodebuild') + REPLACED_TOOLS:
            stub = self.bin / tool
            stub.write_text(f'#!{sys.executable}\nTOOL = {tool!r}\nROOT = {str(self.root)!r}\n' + STUB)
            stub.chmod(0o700)
        source = RELEASE.read_text()
        self.assertEqual(absolute_paths(source), KNOWN_TOOL_PATHS,
                         'every absolute path in release.py is a tool replaced here or harmless (ditto)')
        copy = stubbed_copy(source, self.bin)
        self.assertEqual(absolute_paths(copy), {'/usr/bin/ditto'} | {str(self.bin / tool) for tool in REPLACED_TOOLS},
                         'the copy reaches no real tool except ditto')
        self.script = mac / 'release.py'
        self.script.write_text(copy)
        self.home = self.root / 'home'
        self.profiles = self.home / 'Library' / 'Developer' / 'Xcode' / 'UserData' / 'Provisioning Profiles'
        self.profiles.mkdir(parents=True)
        self.app_profile = self.install('app.provisionprofile', self.profile(APP_ID, APP_UUID))
        self.ext_profile = self.install('extension.provisionprofile', self.profile(EXT_ID, EXT_UUID))
        self.scenario = {
            'identities': identities(('C' * 40, 'Apple Development: Example Person (' + TEAM + ')'), (IDENTITY, DEVELOPER_ID)),
            'detail': SIGNED_DETAIL,
            'entitlements': {bundle_id: str(self.built(bundle_id)) for bundle_id in (APP_ID, EXT_ID)},
            'embedded': {APP_ID: str(self.app_profile), EXT_ID: str(self.ext_profile)},
            'go': GO, 'agent': str(fixture_agent()),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def built(self, bundle_id):
        path = self.root / (bundle_id + '.built.entitlements')
        path.write_bytes(plistlib.dumps(built_entitlements(bundle_id)))
        return path

    def profile(self, bundle_id, uuid, changes=None, entitlements=None):
        granted = built_entitlements(bundle_id)
        granted.update({'com.apple.developer.team-identifier': TEAM, 'com.apple.application-identifier': TEAM + '.' + bundle_id,
                        'keychain-access-groups': [TEAM + '.*']})
        granted.update(entitlements or {})
        granted = {name: value for name, value in granted.items() if value is not None}
        document = {'ExpirationDate': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30)).replace(tzinfo=None),
                    'ProvisionsAllDevices': True, 'Platform': ['OSX'], 'TeamIdentifier': [TEAM], 'UUID': uuid,
                    'Entitlements': granted, 'DeveloperCertificates': [CERT]}
        document.update(changes or {})
        return document

    def install(self, name, document, directory=None):
        path = (directory or self.profiles) / name
        path.write_bytes(document if isinstance(document, bytes) else plistlib.dumps(document))
        return path

    def release(self, *args, scenario=None):
        (self.root / 'scenario.json').write_text(json.dumps(scenario or self.scenario))
        calls = self.root / 'calls.jsonl'
        if calls.exists():
            calls.unlink()
        env = {'PATH': str(self.bin), 'HOME': str(self.home), 'TMPDIR': str(self.root), **CREDENTIALS}
        return subprocess.run([sys.executable, str(self.script), *args], env=env, capture_output=True, text=True, timeout=120)

    def signed(self, action, *args, app_profile=None, scenario=None):
        return self.release(action, '--team', TEAM, '--app-profile', str(app_profile or self.app_profile),
                            '--extension-profile', str(self.ext_profile), *args, scenario=scenario)

    def calls(self, *tools):
        path = self.root / 'calls.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [row for row in rows if not tools or row['tool'] in tools]

    def report(self, result):
        return json.loads(result.stdout[result.stdout.index('{'):])

    def check(self, report, name):
        return next(check for check in report['checks'] if check['check'] == name)

    def test_preflight_follows_the_configured_identity_and_refuses_a_bad_one(self):
        local = self.script.parent / 'Config' / 'Identity.local.xcconfig'
        local.write_text('GUARD_APP_ID = com.example.guard\nGUARD_EXTENSION_ID = com.example.guard.filter\n')
        result = self.release('preflight', '--team', TEAM)
        report = self.report(result)
        app, ext = report['founderActions'][:2]
        self.assertIn('for com.example.guard containing', app)
        self.assertIn('com.apple.security.application-groups=' + TEAM + '.com.example.guard', app)
        self.assertIn('(or ' + TEAM + '.com.example.guard.ca)', app)
        self.assertIn('for com.example.guard.filter containing', ext)
        self.assertNotIn('app.vibtra.guard', json.dumps(report))
        default_team = self.report(self.release('preflight'))
        self.assertEqual(self.check(default_team, 'team')['detail'], 'P2UU927A6W', 'the configured team is the default')
        local.write_text('GUARD_APP_ID = com.example/guard\n')
        bad = self.release('preflight', '--team', TEAM)
        self.assertEqual(bad.returncode, 1)
        self.assertIn('Release refused: GUARD_APP_ID must be a reverse-DNS bundle identifier', bad.stderr)

    def test_identity_selection_refuses_development_other_team_and_ambiguous_identities(self):
        development = ('C' * 40, 'Apple Development: Example Person (' + TEAM + ')')
        other_team = (IDENTITY, 'Developer ID Application: Example Org (OTHER12345)')
        mine = (IDENTITY, DEVELOPER_ID)
        second = ('D' * 40, DEVELOPER_ID)
        none = 'No valid Developer ID Application identity for this team; Apple Development/ad-hoc signing is not accepted'
        cases = [
            ('development only', [development], (), 'fail', none),
            ('another team', [other_team], (), 'fail', none),
            ('two Developer ID', [mine, second], (), 'fail', 'Multiple Developer ID Application identities; select one using --identity SHA1'),
            ('two, one chosen', [mine, second], ('--identity', IDENTITY.lower()), 'pass', 'Developer ID Application identity ' + IDENTITY),
            ('a development one chosen', [development, mine], ('--identity', 'C' * 40), 'fail',
             'Requested identity is not a valid Developer ID Application identity for this team'),
            ('one among others', [development, mine], (), 'pass', 'Developer ID Application identity ' + IDENTITY),
        ]
        for label, rows, extra, status, detail in cases:
            with self.subTest(label):
                result = self.signed('preflight', *extra, scenario=dict(self.scenario, identities=identities(*rows)))
                report = self.report(result)
                self.assertEqual(self.check(report, 'developer-id-identity'), {'check': 'developer-id-identity', 'status': status, 'detail': detail})
                if status == 'fail':
                    self.assertEqual(result.returncode, 1)
                    self.assertIn('developer-id-identity', report['blockedOnFounder'])
                    self.assertEqual(self.check(report, 'app-profile')['detail'], 'Cannot validate the profile without a Developer ID Application identity')
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(report['status'], 'developer-id-preflight-passed')

    def test_profiles_are_refused_unless_developer_id_for_this_app_team_and_certificate(self):
        result = self.signed('preflight')
        report = self.report(result)
        self.assertEqual(self.check(report, 'app-profile')['detail'], 'profile ' + APP_UUID)
        self.assertEqual(self.check(report, 'extension-profile')['detail'], 'profile ' + EXT_UUID)
        devices = 'Developer ID all-device profile required; development/device profiles are refused'
        team_or_platform = 'Provisioning profile team or platform mismatch'
        identity = 'Provisioning application identity/debug entitlement mismatch'
        unauthorized = 'Provisioning profile does not authorize requested release entitlements'
        outside = self.root / 'Downloads'
        outside.mkdir()
        cases = [
            ('device-limited', {'ProvisionsAllDevices': False}, None, devices),
            ('device list', {'ProvisionedDevices': ['00000000-EXAMPLE-DEVICE']}, None, devices),
            ('another team', {'TeamIdentifier': ['OTHER12345']}, None, team_or_platform),
            ('iOS profile', {'Platform': ['iOS']}, None, team_or_platform),
            ('expired', {'ExpirationDate': dt.datetime(2020, 1, 1)}, None, 'Provisioning profile expired'),
            ('another certificate', {'DeveloperCertificates': [b'made-up other certificate']}, None,
             'Selected signing certificate is absent from provisioning profile'),
            ('malformed UUID', {'UUID': '-' * 36}, None, 'Invalid provisioning profile UUID'),
            ('debuggable', None, {'get-task-allow': True}, identity),
            ('wildcard app id', None, {'com.apple.application-identifier': TEAM + '.*'}, identity),
            ('wrong Network Extension type', None, {'com.apple.developer.networking.networkextension': ['content-filter-provider']}, unauthorized),
            ('wrong app group', None, {'com.apple.security.application-groups': ['group.example.other']}, unauthorized),
            ('another team\'s wildcard app group', None, {'com.apple.security.application-groups': ['OTHER12345.*']}, unauthorized),
            ('bare wildcard app group', None, {'com.apple.security.application-groups': ['*']}, unauthorized),
        ]
        for label, changes, entitlements, detail in cases:
            with self.subTest(label):
                path = self.install('changed.provisionprofile', self.profile(APP_ID, APP_UUID, changes, entitlements))
                report = self.report(self.signed('preflight', app_profile=path))
                self.assertEqual(self.check(report, 'app-profile'), {'check': 'app-profile', 'status': 'fail', 'detail': detail})
                self.assertEqual(self.check(report, 'extension-profile')['status'], 'pass')
                self.assertEqual(report['status'], 'developer-id-preflight-blocked')
        for label, path, detail in (
            ('not installed', self.install('app.provisionprofile', self.profile(APP_ID, APP_UUID), outside),
             'No installed Developer ID profile for app.vibtra.guard was given'),
            ('not a profile', self.install('garbage.provisionprofile', b'made-up bytes, not a property list'),
             'Provisioning profile could not be decoded'),
        ):
            with self.subTest(label):
                report = self.report(self.signed('preflight', app_profile=path))
                self.assertEqual(self.check(report, 'app-profile'), {'check': 'app-profile', 'status': 'fail', 'detail': detail})

    def test_preflight_passes_when_the_identity_profiles_and_tools_are_provisioned(self):
        result = self.signed('preflight')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, '')
        report = self.report(result)
        self.assertEqual(report['status'], 'developer-id-preflight-passed')
        self.assertEqual(report['blockedOnFounder'] + report['blockedOnCode'], [])
        self.assertEqual(len(report['founderActions']), 1, 'notarization credentials stay a founder item')
        self.assertIn('notarytool store-credentials', report['founderActions'][0])
        self.assertEqual(self.check(report, 'tool:notarytool')['detail'], '/Applications/Xcode.app/Contents/Developer/usr/bin/notarytool')
        self.assertEqual(self.check(report, 'tool:go')['detail'], str(self.bin / 'go'))
        self.assertEqual(self.calls('go', 'xcodegen', 'xcodebuild', 'codesign'), [], 'preflight builds and signs nothing')

    def test_preflight_accepts_apple_s_team_wildcard_app_group(self):
        wildcard = {'com.apple.security.application-groups': [TEAM + '.*']}
        app = self.install('app-wildcard.provisionprofile', self.profile(APP_ID, APP_UUID, None, wildcard))
        self.ext_profile = self.install('ext-wildcard.provisionprofile', self.profile(EXT_ID, EXT_UUID, None, wildcard))
        result = self.signed('preflight', app_profile=app)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = self.report(result)
        self.assertEqual(self.check(report, 'app-profile')['status'], 'pass')
        self.assertEqual(self.check(report, 'extension-profile')['status'], 'pass')
        self.assertEqual(report['status'], 'developer-id-preflight-passed')

    def test_the_app_profile_must_allow_the_ca_keychain_shelf(self):
        shelf = TEAM + '.' + APP_ID + '.ca'
        refused = (f'Provisioning profile does not allow keychain-access-groups {shelf}, the shelf that keeps the CA key in the '
                   f'Secure Enclave; the app profile must list keychain-access-groups {TEAM}.* or {shelf}')
        cases = [
            ('team wildcard', [TEAM + '.*'], 'pass'),
            ('exact shelf', ['OTHER12345.*', shelf], 'pass'),
            ('no keychain groups', None, 'fail'),
            ('empty list', [], 'fail'),
            ('another team\'s wildcard', ['OTHER12345.*'], 'fail'),
            ('bare wildcard', ['*'], 'fail'),
            ('the app group, not the shelf', [TEAM + '.' + APP_ID], 'fail'),
            ('another app\'s shelf', [TEAM + '.com.example.other.ca'], 'fail'),
            ('the shelf of another team', ['OTHER12345.' + APP_ID + '.ca'], 'fail'),
            ('a string, not a list', TEAM + '.*', 'fail'),
        ]
        for label, groups, status in cases:
            with self.subTest(label):
                path = self.install('keychain.provisionprofile', self.profile(APP_ID, APP_UUID, None, {'keychain-access-groups': groups}))
                result = self.signed('preflight', app_profile=path)
                report = self.report(result)
                detail = 'profile ' + APP_UUID if status == 'pass' else refused
                self.assertEqual(self.check(report, 'app-profile'), {'check': 'app-profile', 'status': status, 'detail': detail})
                self.assertEqual(result.returncode, 0 if status == 'pass' else 1, result.stderr)
                if status == 'fail':
                    self.assertEqual(report['blockedOnFounder'], ['app-profile'])
                    self.assertIn('keychain-access-groups=' + TEAM + '.* (or ' + shelf + ')', result.stderr)
        self.ext_profile = self.install('ext-no-keychain.provisionprofile',
                                        self.profile(EXT_ID, EXT_UUID, None, {'keychain-access-groups': None}))
        self.assertEqual(self.check(self.report(self.signed('preflight')), 'extension-profile')['status'], 'pass',
                         'the extension does not use the shelf')

    def test_a_guard_test_agent_is_refused_before_it_is_signed_off(self):
        refused = ('Release refused: The agent was built with -tags guard_test, a test build that honours test-only signer overrides; '
                   'build it without guard_test (check go env GOFLAGS)\n')
        unreadable = self.root / 'not-go'
        unreadable.write_bytes(b'made-up agent binary, not a Go program')
        cases = [
            ('guard_test', fixture_agent('guard_test'), refused),
            ('guard_test among other tags', fixture_agent('netgo,guard_test'), refused),
            ('no Go build info', unreadable,
             'Release refused: Cannot read the agent\'s Go build info (go version -m); an agent of unknown build is not shipped\n'),
        ]
        for number, (label, agent, message) in enumerate(cases):
            with self.subTest(label):
                out = self.root / f'out-{number}'
                result = self.signed('build', '--out', str(out), scenario=dict(self.scenario, agent=str(agent)))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, message)
                self.assertEqual(self.calls('go')[-1]['args'], ['version', '-m', str(out / 'products/Release/VibtraGuard.app/Contents/MacOS/vibtra-guard')],
                                 'the bundled agent, the one that ships, is checked')
                self.assertNotIn('vibtra-guard', [Path(call['args'][-1]).name for call in self.calls('codesign', 'lipo')])
                for absent in ('VibtraGuard-arm64.zip', 'VibtraGuard-arm64.zip.sha256', 'release-report.json'):
                    self.assertFalse((out / absent).exists(), absent)

    def test_an_agent_without_guard_test_ships(self):
        for number, tags in enumerate(('', 'netgo,guard_testing')):
            with self.subTest(tags=tags):
                out = self.root / f'out-{number}'
                result = self.signed('build', '--out', str(out), scenario=dict(self.scenario, agent=str(fixture_agent(tags))))
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((out / 'release-report.json').exists())

    def test_build_with_an_identity_but_no_installed_profiles_builds_nothing(self):
        outside = self.root / 'Downloads'
        outside.mkdir()
        stray = self.install('app.provisionprofile', self.profile(APP_ID, APP_UUID), outside)
        for label, profiles in (('no profiles', ()), ('not installed', ('--app-profile', str(stray), '--extension-profile', str(self.ext_profile)))):
            with self.subTest(label):
                out = self.root / ('out-' + label.replace(' ', '-'))
                result = self.release('build', '--team', TEAM, *profiles, '--out', str(out))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, 'Release refused: Both Developer ID profiles must already be installed in a standard Xcode profile directory\n')
                self.assertEqual([call['args'][0] for call in self.calls('security')], ['find-identity'])
                self.assertEqual(self.calls('go', 'xcodegen', 'xcodebuild'), [])
                self.assertFalse(out.exists())

    def test_a_failed_signed_build_has_no_unsigned_fallback_and_targets_arm64_only(self):
        out = self.root / 'release-out'
        result = self.signed('build', '--out', str(out), scenario=dict(self.scenario, xcodebuildExit=65))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, 'Release refused: xcodebuild failed (exit 65); no fallback attempted\n')
        built = self.calls('go', 'xcodegen', 'xcodebuild', 'codesign', 'lipo')
        self.assertEqual([call['tool'] for call in built], ['go', 'xcodegen', 'xcodebuild'], 'one signed attempt, no unsigned retry, nothing verified')
        go, _, xcodebuild = built
        self.assertEqual((go['env'].get('GOOS'), go['env'].get('GOARCH'), go['env'].get('CGO_ENABLED')), ('darwin', 'arm64', '0'))
        self.assertIn('-trimpath', go['args'])
        self.assertIn('-mod=readonly', go['args'])
        args = xcodebuild['args']
        for expected in ('Release', 'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=' + IDENTITY, 'DEVELOPMENT_TEAM=' + TEAM,
                         'ENABLE_HARDENED_RUNTIME=YES', 'OTHER_CODE_SIGN_FLAGS=--timestamp', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO',
                         'GUARD_APP_PROFILE_UUID=' + APP_UUID, 'GUARD_EXTENSION_PROFILE_UUID=' + EXT_UUID):
            self.assertIn(expected, args)
        self.assertNotIn('-arch', args)
        self.assertNotIn('-allowProvisioningUpdates', args)
        self.assertFalse(any(arg.startswith('CODE_SIGNING_ALLOWED') for arg in args))
        self.assertEqual(xcodebuild['env'].get('VIBTRA_GUARD_AGENT_BIN'), str(out / 'vibtra-guard-arm64'))
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((out / 'xcodebuild.log').stat().st_mode), 0o600)
        for absent in ('VibtraGuard-arm64.zip', 'VibtraGuard-arm64.zip.sha256', 'release-report.json'):
            self.assertFalse((out / absent).exists(), absent)

    def test_the_build_environment_drops_notarization_and_api_credentials(self):
        result = self.signed('build', '--out', str(self.root / 'release-out'))
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual({call['tool'] for call in calls}, {'security', 'go', 'xcodegen', 'xcodebuild', 'codesign', 'lipo'})
        for call in calls:
            self.assertEqual(call['env'].get('HOME'), str(self.home), call['tool'])
            for name in CREDENTIALS:
                self.assertNotIn(name, call['env'], call['tool'] + ' saw ' + name)

    def test_a_verified_build_records_its_checksum_report_and_minimum_macos(self):
        out = self.root / 'release-out'
        result = self.signed('build', '--out', str(out))
        self.assertEqual(result.returncode, 0, result.stderr)
        archive = out / 'VibtraGuard-arm64.zip'
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        report = self.report(result)
        self.assertEqual(report, {'status': 'developer-id-prepared-not-notarized', 'architecture': 'arm64', 'minimumMacOS': '14.0',
                                  'team': TEAM, 'notarized': False, 'installed': False, 'archive': archive.name,
                                  'archiveSha256': digest, 'checksumFile': archive.name + '.sha256'})
        self.assertEqual(json.loads((out / 'release-report.json').read_text()), report)
        self.assertEqual(stat.S_IMODE((out / 'release-report.json').stat().st_mode), 0o600)
        self.assertEqual((out / (archive.name + '.sha256')).read_text(), digest + '  ' + archive.name + '\n')
        checked = subprocess.run(['/usr/bin/shasum', '-a', '256', '-c', archive.name + '.sha256'], cwd=out, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        listing = subprocess.run(['/usr/bin/zipinfo', '-1', str(archive)], capture_output=True, text=True).stdout.splitlines()
        self.assertIn('VibtraGuard.app/Contents/MacOS/vibtra-guard', listing)
        self.assertIn('VibtraGuard.app/Contents/Library/SystemExtensions/app.vibtra.guard.extension.systemextension/Contents/Info.plist', listing)
        requirement = f'=anchor apple generic and certificate leaf = H"{IDENTITY}" and certificate leaf[subject.OU] = "{TEAM}"'
        verified = [call['args'] for call in self.calls('codesign') if '--verify' in call['args']]
        self.assertEqual([Path(args[-1]).name for args in verified], ['app.vibtra.guard.extension.systemextension', 'VibtraGuard.app', 'vibtra-guard'])
        for args in verified:
            self.assertIn('--strict', args)
            self.assertEqual(args[args.index('-R') + 1], requirement)
        self.assertEqual([Path(call['args'][-1]).name for call in self.calls('lipo')], ['app.vibtra.guard.extension', 'VibtraGuard', 'vibtra-guard'])

    def test_verification_refuses_a_build_without_timestamp_runtime_team_arm64_or_its_profile(self):
        renewed = self.install('app-renewed.provisionprofile', self.profile(APP_ID, 'AAAAAAAA-0000-4000-8000-000000000003'))
        stamp = 'Built component lacks a secure timestamp or hardened runtime'
        team = 'Built component is not signed with the required Developer ID team'
        refusals = [
            ('no timestamp', {'detail': SIGNED_DETAIL.replace('Timestamp=', 'Signed Time=')}, stamp),
            ('timestamp none', {'detail': re.sub(r'Timestamp=.*', 'Timestamp=none', SIGNED_DETAIL)}, stamp),
            ('no hardened runtime', {'detail': SIGNED_DETAIL.replace('(runtime)', '(adhoc)')}, stamp),
            ('development certificate', {'detail': SIGNED_DETAIL.replace('Authority=Developer ID Application:', 'Authority=Apple Development:')}, team),
            ('another team', {'detail': SIGNED_DETAIL.replace('TeamIdentifier=' + TEAM, 'TeamIdentifier=OTHER12345')}, team),
            ('universal binary', {'arch': 'x86_64 arm64'}, 'Built component is not the explicit arm64 release target'),
            ('signature rejected', {'verifyExit': 3}, 'codesign failed (exit 3); no fallback attempted'),
            ('debug entitlement', {'extraEntitlements': {'com.apple.security.get-task-allow': True}},
             'Built release has an unexpected debug/security exception'),
            ('entitlement dropped', {'extraEntitlements': {'com.apple.developer.system-extension.install': False}},
             'Built entitlements do not match release source'),
            ('another embedded profile', {'embedded': {APP_ID: str(renewed), EXT_ID: str(self.ext_profile)}},
             'Built bundle embeds a different provisioning profile'),
        ]
        for number, (label, change, message) in enumerate(refusals):
            with self.subTest(label):
                out = self.root / f'out-{number}'
                result = self.signed('build', '--out', str(out), scenario=dict(self.scenario, **change))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stderr, 'Release refused: ' + message + '\n')
                self.assertTrue((out / 'products' / 'Release' / 'VibtraGuard.app').is_dir(), 'the refusal came after the build')
                for absent in ('VibtraGuard-arm64.zip', 'VibtraGuard-arm64.zip.sha256', 'release-report.json'):
                    self.assertFalse((out / absent).exists(), absent)


if __name__ == '__main__':
    unittest.main()
