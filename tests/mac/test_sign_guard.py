# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
import base64
import datetime as dt
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_release as release_tests

REPO = Path(__file__).resolve().parents[2]
MAC = REPO / 'guard' / 'mac'
WIZARD = MAC / 'tools' / 'sign-guard.py'
TEMPLATE = MAC / 'templates' / 're-sign-guard.yml'
TEAM = 'AB12CD34EF'
OTHER_TEAM = 'ZZ9OTHER00'
APP_ID = 'com.example.guard'
EXT_ID = APP_ID + '.extension'
KEY_ID = 'K3Y1D00001'
ISSUER = '57246542-96fe-1a63-e053-0824d011072a'
TAG = 'guard-v9.9.9'
CERT = b'made-up Developer ID Application certificate for the wizard'
IDENTITY = hashlib.sha1(CERT).hexdigest().upper()
DEVELOPER_ID = 'Developer ID Application: Example Org (' + TEAM + ')'
PROFILE_DIR = Path('Library') / 'Developer' / 'Xcode' / 'UserData' / 'Provisioning Profiles'
SUBMISSION = '2efe2717-52ef-43a5-96dc-0797e4ca1041'
sys.path.insert(0, str(MAC / 'tools'))
import identity as guard_identity

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
elif TOOL == 'xcrun' and args[:2] == ['notarytool', 'submit']:
    print(json.dumps({'id': scenario['submission'], 'status': scenario.get('notaryStatus', 'Accepted'), 'message': 'Processing complete'}))
elif TOOL == 'xcrun' and args[:2] == ['notarytool', 'log']:
    pathlib.Path(args[-1]).write_text(json.dumps({'status': scenario.get('notaryStatus', 'Accepted'), 'issues': None}))
elif TOOL == 'xcrun' and args[:1] == ['stapler']:
    print('The staple and validate action worked!')
elif TOOL == 'spctl':
    sys.stderr.write(args[-1] + ': accepted\\nsource=Notarized Developer ID\\n')
elif TOOL == 'codesign' and '--verify' in args:
    pass
elif TOOL == 'codesign' and '--entitlements' in args:
    sys.stdout.buffer.write(pathlib.Path(scenario['entitlements'][bundle_id(args[-1])]).read_bytes())
elif TOOL == 'codesign' and '-d' in args:
    sys.stderr.write(scenario['detail'])
elif TOOL == 'lipo':
    print('arm64')
elif TOOL == 'go' and args[:2] == ['version', '-m']:
    os.execv(scenario['go'], [scenario['go'], *args])
elif TOOL == 'go':
    pathlib.Path(flag('-o')).write_bytes(pathlib.Path(scenario['agent']).read_bytes())
elif TOOL == 'xcodegen':
    pass
elif TOOL == 'xcodebuild':
    settings = dict(arg.split('=', 1) for arg in args if '=' in arg and not arg.startswith('-'))
    profiles = pathlib.Path(os.environ['HOME']) / 'Library/Developer/Xcode/UserData/Provisioning Profiles'
    app = pathlib.Path(settings['SYMROOT']) / 'Release' / 'VibtraGuard.app'
    extension = app / 'Contents' / 'Library' / 'SystemExtensions' / (scenario['ext'] + '.systemextension')
    for bundle, identifier, executable, uuid in ((app, scenario['app'], 'VibtraGuard', settings['GUARD_APP_PROFILE_UUID']),
                                                 (extension, scenario['ext'], scenario['ext'], settings['GUARD_EXTENSION_PROFILE_UUID'])):
        (bundle / 'Contents' / 'MacOS').mkdir(parents=True, exist_ok=True)
        (bundle / 'Contents' / 'MacOS' / executable).write_bytes(b'made-up executable')
        (bundle / 'Contents' / 'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier': identifier, 'CFBundleExecutable': executable}))
        (bundle / 'Contents' / 'embedded.provisionprofile').write_bytes((profiles / (uuid + '.provisionprofile')).read_bytes())
    (app / 'Contents' / 'MacOS' / 'vibtra-guard').write_bytes(pathlib.Path(os.environ['VIBTRA_GUARD_AGENT_BIN']).read_bytes())
else:
    sys.exit(64)
'''


def built_entitlements(bundle_id):
    target = 'VibtraGuard' if bundle_id == APP_ID else 'VibtraGuardExtension'
    source = plistlib.loads((MAC / target / (target + '.entitlements')).read_bytes())
    return guard_identity.expand(source, guard_identity.derive(TEAM, APP_ID, EXT_ID))


class FakeAppStoreConnect:
    def __init__(self):
        self.requests = []
        self.seed = TEAM
        self.bundles = {}
        self.capabilities = []
        self.profiles = {}
        self.issued = 0
        self.profile_changes = {}
        self.certificates = [
            {'type': 'certificates', 'id': 'CERTOTHER1', 'attributes': {'certificateType': 'DEVELOPER_ID_APPLICATION',
                                                                       'certificateContent': base64.b64encode(b'another certificate').decode()}},
            {'type': 'certificates', 'id': 'CERTGUARD1', 'attributes': {'certificateType': 'DEVELOPER_ID_APPLICATION',
                                                                       'certificateContent': base64.b64encode(CERT).decode()}},
        ]
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=None):
                raw = json.dumps(body).encode() if body is not None else b''
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def handle_any(self):
                url = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(url.query))
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                fake.requests.append({'method': self.command, 'path': url.path, 'query': query, 'body': body,
                                      'auth': self.headers.get('Authorization', '')})
                if not self.headers.get('Authorization', '').startswith('Bearer '):
                    return self.reply(401, {'errors': [{'detail': 'no token'}]})
                status, response = fake.route(self.command, url.path, query, body)
                self.reply(status, response)

            do_GET = do_POST = do_DELETE = handle_any

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}'

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def add_bundle(self, identifier, capabilities=(), platform='MAC_OS', seed=None):
        bundle = 'BUNDLE' + str(len(self.bundles) + 1)
        self.bundles[bundle] = {'identifier': identifier, 'name': 'Guard ' + identifier, 'platform': platform, 'seedId': seed or self.seed}
        self.capabilities += [(bundle, capability) for capability in capabilities]
        return bundle

    def profile_document(self, identifier, uuid):
        granted = built_entitlements(identifier)
        granted.update({'com.apple.developer.team-identifier': TEAM, 'com.apple.application-identifier': TEAM + '.' + identifier,
                        'keychain-access-groups': [TEAM + '.*']})
        granted.update(self.profile_changes.get(identifier, {}))
        return {'ExpirationDate': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=365)).replace(tzinfo=None),
                'ProvisionsAllDevices': True, 'Platform': ['OSX'], 'TeamIdentifier': [TEAM], 'UUID': uuid,
                'Entitlements': granted, 'DeveloperCertificates': [CERT]}

    def add_profile(self, bundle, name, state='ACTIVE'):
        self.issued += 1
        number = self.issued
        uuid = f'BBBBBBBB-0000-4000-8000-{number:012d}'
        content = plistlib.dumps(self.profile_document(self.bundles[bundle]['identifier'], uuid))
        profile = 'PROFILE' + str(number)
        self.profiles[profile] = {'name': name, 'profileType': 'MAC_APP_DIRECT', 'profileState': state, 'uuid': uuid,
                                  'profileContent': base64.b64encode(content).decode(), 'bundle': bundle}
        return profile

    def route(self, method, path, query, body):
        if method == 'GET' and path == '/v1/bundleIds':
            rows = [{'type': 'bundleIds', 'id': key, 'attributes': value} for key, value in self.bundles.items()
                    if value['identifier'].startswith(query['filter[identifier]'])]
            return 200, {'data': rows}
        if method == 'POST' and path == '/v1/bundleIds':
            attributes = body['data']['attributes']
            bundle = self.add_bundle(attributes['identifier'], platform=attributes['platform'])
            return 201, {'data': {'type': 'bundleIds', 'id': bundle, 'attributes': self.bundles[bundle]}}
        match = re.fullmatch(r'/v1/bundleIds/([A-Z0-9]+)/bundleIdCapabilities', path)
        if method == 'GET' and match:
            rows = [{'type': 'bundleIdCapabilities', 'id': f'{bundle}_{kind}', 'attributes': {'capabilityType': kind}}
                    for bundle, kind in self.capabilities if bundle == match.group(1)]
            return 200, {'data': rows}
        if method == 'POST' and path == '/v1/bundleIdCapabilities':
            bundle = body['data']['relationships']['bundleId']['data']['id']
            kind = body['data']['attributes']['capabilityType']
            self.capabilities.append((bundle, kind))
            for profile in self.profiles.values():
                if profile['bundle'] == bundle:
                    profile['profileState'] = 'INVALID'
            return 201, {'data': {'type': 'bundleIdCapabilities', 'id': f'{bundle}_{kind}', 'attributes': {'capabilityType': kind}}}
        if method == 'GET' and path == '/v1/certificates':
            kinds = query['filter[certificateType]'].split(',')
            return 200, {'data': [row for row in self.certificates if row['attributes']['certificateType'] in kinds]}
        if method == 'GET' and path == '/v1/profiles':
            rows = [{'type': 'profiles', 'id': key, 'attributes': value} for key, value in self.profiles.items()
                    if value['name'] == query['filter[name]'] and value['profileType'] == query['filter[profileType]']]
            return 200, {'data': rows}
        if method == 'POST' and path == '/v1/profiles':
            data = body['data']
            if data['relationships']['certificates']['data'] != [{'type': 'certificates', 'id': 'CERTGUARD1'}]:
                return 409, {'errors': [{'detail': 'wrong certificate'}]}
            profile = self.add_profile(data['relationships']['bundleId']['data']['id'], data['attributes']['name'])
            return 201, {'data': {'type': 'profiles', 'id': profile, 'attributes': self.profiles[profile]}}
        match = re.fullmatch(r'/v1/profiles/([A-Z0-9]+)', path)
        if method == 'DELETE' and match:
            self.profiles.pop(match.group(1))
            return 204, None
        return 404, {'errors': [{'detail': 'no route'}]}

    def calls(self):
        return [(request['method'], request['path']) for request in self.requests]


def openssl(*args, data=None):
    return subprocess.run(['/usr/bin/openssl', *args], input=data, capture_output=True, check=True).stdout


def raw_to_der(raw):
    def integer(value):
        value = value.lstrip(b'\0') or b'\0'
        if value[0] & 0x80:
            value = b'\0' + value
        return b'\x02' + bytes([len(value)]) + value
    body = integer(raw[:32]) + integer(raw[32:])
    return b'\x30' + bytes([len(body)]) + body


def unb64url(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


class SignGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='guard-sign-it.')
        self.root = Path(self.tmp.name).resolve()
        self.checkout = self.root / 'checkout'
        mac = self.checkout / 'guard' / 'mac'
        for relative in ('project.yml', 'Config/Identity.xcconfig', 'tools/identity.py', 'tools/mdm-profile.py', 'tools/sign-guard.py',
                         'VibtraGuard/VibtraGuard.entitlements', 'VibtraGuardExtension/VibtraGuardExtension.entitlements', '.gitignore'):
            (mac / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(MAC / relative, mac / relative)
        (self.checkout / 'guard' / 'agent-go').mkdir()
        (self.checkout / 'guard' / 'agent-go' / 'go.mod').write_text('module example\n')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for tool in ('go', 'xcodegen', 'xcodebuild', 'spctl') + release_tests.REPLACED_TOOLS:
            stub = self.bin / tool
            stub.write_text(f'#!{sys.executable}\nTOOL = {tool!r}\nROOT = {str(self.root)!r}\n' + STUB)
            stub.chmod(0o700)
        (mac / 'release.py').write_text(release_tests.stubbed_copy((MAC / 'release.py').read_text(), self.bin))
        self.wizard = mac / 'tools' / 'sign-guard.py'
        self.git('init', '-q')
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'release')
        self.git('tag', TAG)
        self.home = self.root / 'home'
        self.home.mkdir()
        self.key = self.root / 'keys' / f'AuthKey_{KEY_ID}.p8'
        self.key.parent.mkdir()
        openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', str(self.key))
        self.key.chmod(0o600)
        self.key_body = ''.join(line for line in self.key.read_text().splitlines() if not line.startswith('-----'))
        self.public = self.root / 'keys' / 'public.pem'
        self.public.write_bytes(openssl('pkey', '-in', str(self.key), '-pubout'))
        self.out = self.root / 'release'
        self.api = FakeAppStoreConnect()
        self.addCleanup(self.api.close)
        entitlements = {}
        for bundle_id in (APP_ID, EXT_ID):
            path = self.root / (bundle_id + '.built.entitlements')
            path.write_bytes(plistlib.dumps(built_entitlements(bundle_id)))
            entitlements[bundle_id] = str(path)
        self.scenario = {
            'identities': release_tests.identities(('C' * 40, 'Apple Development: Example Person (' + TEAM + ')'), (IDENTITY, DEVELOPER_ID)),
            'detail': release_tests.SIGNED_DETAIL.replace(release_tests.TEAM, TEAM),
            'entitlements': entitlements, 'app': APP_ID, 'ext': EXT_ID, 'submission': SUBMISSION,
            'go': release_tests.GO, 'agent': str(release_tests.fixture_agent()),
        }

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        subprocess.run(['/usr/bin/git', '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false',
                        '-c', 'tag.gpgsign=false', '-C', str(self.checkout), *args], check=True, capture_output=True,
                       env={'PATH': '/usr/bin:/bin', 'HOME': str(self.root)})

    def sign(self, *extra, scenario=None, key=None, team=TEAM, out=None):
        (self.root / 'scenario.json').write_text(json.dumps(scenario or self.scenario))
        args = ['--team', team, '--bundle-prefix', APP_ID, '--key-id', KEY_ID, '--issuer-id', ISSUER,
                '--key-file', str(key or self.key), '--tag', TAG, '--out', str(out or self.out), '--organization', 'Example Org', *extra]
        env = {'PATH': f'{self.bin}:/usr/bin:/bin', 'HOME': str(self.home), 'TMPDIR': str(self.root),
               'GUARD_SIGN_API_URL': self.api.url, 'VIBTRA_GUARD_AGENT_BIN': str(self.root / 'unused')}
        return subprocess.run([sys.executable, str(self.wizard), *args], env=env, capture_output=True, text=True, timeout=180)

    def calls(self, *tools):
        path = self.root / 'calls.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [row for row in rows if not tools or row['tool'] in tools]

    def sequence(self):
        out = []
        for call in self.calls():
            args = call['args']
            if call['tool'] == 'xcrun' and args[0] in ('notarytool', 'stapler'):
                out.append(' '.join(args[:2]))
            elif call['tool'] in ('security', 'xcrun'):
                out.append(call['tool'] + ' ' + args[0])
            else:
                out.append(call['tool'])
        return out

    def assert_no_secrets(self, result):
        tokens = {request['auth'].split(' ', 1)[1] for request in self.api.requests if request['auth'].startswith('Bearer ')}
        secrets = [self.key_body] + [line for line in self.key_body.splitlines()] + sorted(tokens)
        texts = {'stdout': result.stdout, 'stderr': result.stderr}
        for base in (self.out, self.home, self.checkout):
            if base.exists():
                for path in base.rglob('*'):
                    if path.is_file() and '.git' not in path.parts:
                        texts[str(path)] = path.read_bytes().decode('utf-8', errors='replace')
        for call in self.calls():
            texts['call ' + call['tool']] = json.dumps(call)
        for secret in secrets:
            for where, text in texts.items():
                self.assertNotIn(secret, text, f'a secret reached {where}')
        for call in self.calls():
            self.assertNotIn('GUARD_SIGN_API_URL', call['env'], call['tool'])

    def test_a_full_run_registers_profiles_builds_notarizes_and_writes_the_release(self):
        result = self.sign()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.api.calls(), [
            ('GET', '/v1/certificates'),
            ('GET', '/v1/bundleIds'), ('POST', '/v1/bundleIds'), ('GET', '/v1/bundleIds/BUNDLE1/bundleIdCapabilities'),
            ('POST', '/v1/bundleIdCapabilities'), ('POST', '/v1/bundleIdCapabilities'), ('POST', '/v1/bundleIdCapabilities'),
            ('GET', '/v1/bundleIds'), ('POST', '/v1/bundleIds'), ('GET', '/v1/bundleIds/BUNDLE2/bundleIdCapabilities'),
            ('POST', '/v1/bundleIdCapabilities'), ('POST', '/v1/bundleIdCapabilities'),
            ('GET', '/v1/profiles'), ('POST', '/v1/profiles'), ('GET', '/v1/profiles'), ('POST', '/v1/profiles'),
        ])
        posts = [request['body']['data'] for request in self.api.requests if request['method'] == 'POST']
        self.assertEqual([post['attributes'] for post in posts if post['type'] == 'bundleIds'],
                         [{'identifier': APP_ID, 'name': 'Guard ' + APP_ID, 'platform': 'MAC_OS'},
                          {'identifier': EXT_ID, 'name': 'Guard ' + EXT_ID, 'platform': 'MAC_OS'}])
        self.assertEqual([(post['relationships']['bundleId']['data']['id'], post['attributes']['capabilityType'])
                          for post in posts if post['type'] == 'bundleIdCapabilities'],
                         [('BUNDLE1', 'NETWORK_EXTENSIONS'), ('BUNDLE1', 'SYSTEM_EXTENSION_INSTALL'), ('BUNDLE1', 'APP_GROUPS'),
                          ('BUNDLE2', 'NETWORK_EXTENSIONS'), ('BUNDLE2', 'APP_GROUPS')])
        profiles = [post for post in posts if post['type'] == 'profiles']
        self.assertEqual([post['attributes']['profileType'] for post in profiles], ['MAC_APP_DIRECT', 'MAC_APP_DIRECT'])
        self.assertEqual([post['relationships']['bundleId']['data']['id'] for post in profiles], ['BUNDLE1', 'BUNDLE2'])
        self.assertEqual(self.api.requests[0]['query']['filter[certificateType]'], 'DEVELOPER_ID_APPLICATION,DEVELOPER_ID_APPLICATION_G2')
        installed = sorted(path.name for path in (self.home / PROFILE_DIR).iterdir())
        self.assertEqual(installed, [profile['uuid'] + '.provisionprofile' for profile in self.api.profiles.values()])

        self.assertEqual(self.sequence(), [
            'security find-identity',
            'security find-identity', 'security cms', 'security cms', 'xcrun --find', 'xcrun --find',
            'security find-identity', 'security cms', 'security cms', 'go', 'xcodegen', 'xcodebuild',
            'codesign', 'codesign', 'lipo', 'codesign', 'security cms', 'codesign', 'codesign', 'lipo', 'codesign', 'security cms',
            'go', 'codesign', 'codesign', 'lipo',
            'notarytool submit', 'notarytool log', 'stapler staple', 'stapler validate', 'spctl',
        ])
        submit = next(call['args'] for call in self.calls('xcrun') if call['args'][:2] == ['notarytool', 'submit'])
        self.assertEqual(submit[2], str(self.out / 'build' / 'VibtraGuard-arm64.zip'))
        for flag, value in (('--key', str(self.key)), ('--key-id', KEY_ID), ('--issuer', ISSUER)):
            self.assertEqual(submit[submit.index(flag) + 1], value)
        self.assertIn('--wait', submit)
        xcodebuild = self.calls('xcodebuild')[0]['args']
        self.assertIn('CODE_SIGN_IDENTITY=' + IDENTITY, xcodebuild)
        self.assertIn('DEVELOPMENT_TEAM=' + TEAM, xcodebuild)
        app_app = self.root / 'release' / 'build' / 'products' / 'Release' / 'VibtraGuard.app'
        self.assertEqual([call['args'][-1] for call in self.calls('xcrun') if call['args'][0] == 'stapler'], [str(app_app)] * 2)

        archive = self.out / f'Guard-{TAG}-{TEAM}-arm64.zip'
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        self.assertEqual((self.out / (archive.name + '.sha256')).read_text(), f'{digest}  {archive.name}\n')
        checked = subprocess.run(['/usr/bin/shasum', '-a', '256', '-c', archive.name + '.sha256'], cwd=self.out, capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        listing = subprocess.run(['/usr/bin/zipinfo', '-1', str(archive)], capture_output=True, text=True).stdout.splitlines()
        self.assertIn(f'VibtraGuard.app/Contents/Library/SystemExtensions/{EXT_ID}.systemextension/Contents/Info.plist', listing)
        mobileconfig = plistlib.loads((self.out / (APP_ID + '.mobileconfig')).read_bytes())
        payloads = {payload['PayloadType']: payload for payload in mobileconfig['PayloadContent']}
        self.assertEqual(payloads['com.apple.system-extension-policy']['AllowedSystemExtensions'], {TEAM: [EXT_ID]})
        self.assertEqual(payloads['com.apple.webcontent-filter']['PluginBundleID'], APP_ID)
        report = json.loads((self.out / 'signing-report.json').read_text())
        self.assertEqual({key: report[key] for key in ('status', 'tag', 'team', 'appId', 'extensionId', 'identity', 'archiveSha256')},
                         {'status': 'notarized', 'tag': TAG, 'team': TEAM, 'appId': APP_ID, 'extensionId': EXT_ID,
                          'identity': IDENTITY, 'archiveSha256': digest})
        self.assertEqual(report['profiles'], {APP_ID: 'created', EXT_ID: 'created'})
        self.assertEqual(report['notarization']['status'], 'Accepted')
        self.assertFalse((self.checkout / 'guard' / 'mac' / 'Config' / 'Identity.local.xcconfig').exists(),
                         'the build identity is put back')
        self.assert_no_secrets(result)

    def test_every_request_carries_an_es256_token_signed_by_the_key(self):
        result = self.sign()
        self.assertEqual(result.returncode, 0, result.stderr)
        tokens = {request['auth'] for request in self.api.requests}
        self.assertEqual(len(tokens), 1, 'one token is reused while it is valid')
        header, payload, signature = tokens.pop().split(' ', 1)[1].split('.')
        self.assertEqual(json.loads(unb64url(header)), {'alg': 'ES256', 'kid': KEY_ID, 'typ': 'JWT'})
        claims = json.loads(unb64url(payload))
        self.assertEqual((claims['iss'], claims['aud']), (ISSUER, 'appstoreconnect-v1'))
        self.assertLessEqual(claims['exp'] - claims['iat'], 1200)
        der = self.root / 'signature.der'
        der.write_bytes(raw_to_der(unb64url(signature)))
        verified = subprocess.run(['/usr/bin/openssl', 'dgst', '-sha256', '-verify', str(self.public), '-signature', str(der)],
                                  input=(header + '.' + payload).encode(), capture_output=True)
        self.assertEqual(verified.returncode, 0, verified.stdout + verified.stderr)

    def test_dry_run_prints_the_plan_and_calls_nothing(self):
        result = self.sign('--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        for expected in (f'tag {TAG}', 'security find-identity', '/v1/bundleIds', 'SYSTEM_EXTENSION_INSTALL', 'MAC_APP_DIRECT',
                         'release.py build', 'notarytool submit', 'stapler', f'Guard-{TAG}-{TEAM}-arm64.zip', APP_ID + '.mobileconfig',
                         'Dry run: nothing was called and nothing was written.'):
            self.assertIn(expected, result.stdout)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.out.exists())
        self.assertFalse((self.home / 'Library').exists())
        self.assertNotIn(self.key_body, result.stdout)

    def test_a_missing_or_mismatched_key_is_refused_before_anything_runs(self):
        other = self.root / 'keys' / 'AuthKey_OTHERKEY01.p8'
        shutil.copyfile(self.key, other)
        not_a_key = self.root / 'keys' / 'notes.p8'
        not_a_key.write_text('hello\n')
        for label, key, words in (('missing', self.root / 'keys' / f'AuthKey_{KEY_ID}-gone.p8', 'Users and Access, Integrations'),
                                  ('other key', other, 'is the key OTHERKEY01, not --key-id ' + KEY_ID),
                                  ('not a key', not_a_key, 'is not an App Store Connect API key')):
            with self.subTest(label):
                result = self.sign(key=key)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(words, result.stderr)
                self.assertIn('\nfix: ', result.stderr)
                self.assertEqual(self.api.requests, [])
                self.assertEqual(self.calls(), [])
                self.assertFalse(self.out.exists())
                self.assertNotIn(self.key_body, result.stdout + result.stderr)

    def test_a_keychain_identity_of_another_team_is_refused_before_apple_is_called(self):
        scenario = dict(self.scenario, identities=release_tests.identities(
            (IDENTITY, 'Developer ID Application: Someone Else (' + OTHER_TEAM + ')')))
        result = self.sign(scenario=scenario)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(f'No Developer ID Application identity for team {TEAM} in this keychain (found team {OTHER_TEAM})', result.stderr)
        self.assertIn('fix: The Account Holder of team ' + TEAM, result.stderr)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.sequence(), ['security find-identity'])
        result = self.sign('--identity', IDENTITY, scenario=scenario, out=self.root / 'release-2')
        self.assertEqual(result.returncode, 2)
        self.assertIn('belongs to another team, not ' + TEAM, result.stderr)
        self.assertEqual(self.api.requests, [])

    def test_an_api_key_from_another_team_changes_nothing_in_that_account(self):
        self.api.certificates = [row for row in self.api.certificates if row['id'] != 'CERTGUARD1']
        result = self.sign()
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(f'certificate {IDENTITY} is not in the App Store Connect account of this API key', result.stderr)
        self.assertIn('fix: Use an API key from team ' + TEAM, result.stderr)
        self.assertEqual(self.api.calls(), [('GET', '/v1/certificates')])
        self.assertEqual(self.calls('go', 'xcodebuild', 'xcrun'), [])

        self.api.certificates.append({'type': 'certificates', 'id': 'CERTGUARD1', 'attributes': {
            'certificateType': 'DEVELOPER_ID_APPLICATION_G2', 'certificateContent': base64.b64encode(CERT).decode()}})
        self.api.add_bundle(APP_ID, seed=OTHER_TEAM)
        self.api.requests.clear()
        result = self.sign(out=self.root / 'release-2')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(f'The API key belongs to team {OTHER_TEAM}, not {TEAM}', result.stderr)
        self.assertEqual([call for call in self.api.calls() if call[0] != 'GET'], [], 'nothing is created in the other account')

    def test_a_profile_without_the_system_extension_values_stops_with_manual_steps(self):
        self.api.profile_changes[EXT_ID] = {'com.apple.developer.networking.networkextension': ['content-filter-provider', 'app-proxy-provider']}
        result = self.sign()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('The provisioning profiles failed the release checks: extension-profile:', result.stderr)
        self.assertIn('fix: The API made profiles release.py cannot use. Make the two profiles by hand', result.stderr)
        for words in ('Developer ID under Distribution', 'App ID: ' + APP_ID, 'App ID ' + EXT_ID, 'SHA-1 ' + IDENTITY,
                      'TeamIdentifier ' + TEAM, 'content-filter-provider-systemextension', '--app-profile and --extension-profile'):
            self.assertIn(words, result.stderr)
        self.assertEqual(self.calls('go', 'xcodegen', 'xcodebuild'), [])
        self.assertEqual([call for call in self.calls('xcrun') if call['args'][0] != '--find'], [])
        self.assertFalse((self.checkout / 'guard' / 'mac' / 'Config' / 'Identity.local.xcconfig').exists())
        self.assert_no_secrets(result)

    def test_an_app_profile_without_the_ca_keychain_shelf_stops_with_the_setting_to_add(self):
        self.api.profile_changes[APP_ID] = {'keychain-access-groups': [OTHER_TEAM + '.*']}
        result = self.sign()
        self.assertEqual(result.returncode, 1, result.stderr)
        shelf = f'{TEAM}.{APP_ID}.ca'
        self.assertIn(f'The provisioning profiles failed the release checks: app-profile: Provisioning profile does not allow '
                      f'keychain-access-groups {shelf}', result.stderr)
        self.assertIn(f'7. The {APP_ID} profile must also list {TEAM}.* (or {shelf}) under keychain-access-groups', result.stderr)
        self.assertEqual(self.calls('go', 'xcodegen', 'xcodebuild'), [])
        self.assert_no_secrets(result)

    def test_a_guard_test_agent_is_never_notarized(self):
        result = self.sign(scenario=dict(self.scenario, agent=str(release_tests.fixture_agent('guard_test'))))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('sign-guard: release.py build refused: The agent was built with -tags guard_test, a test build that honours '
                      'test-only signer overrides; build it without guard_test (check go env GOFLAGS)\n', result.stderr)
        self.assertEqual([call for call in self.calls('xcrun') if call['args'][0] != '--find'], [])
        self.assertEqual(self.calls('spctl'), [])
        self.assertEqual(list(self.out.glob('Guard-*.zip')), [])
        self.assertFalse((self.checkout / 'guard' / 'mac' / 'Config' / 'Identity.local.xcconfig').exists())
        self.assert_no_secrets(result)

    def test_profiles_made_by_hand_skip_the_api_and_are_checked_the_same_way(self):
        bundle_app = self.api.add_bundle(APP_ID)
        bundle_ext = self.api.add_bundle(EXT_ID)
        directory = self.home / PROFILE_DIR
        directory.mkdir(parents=True)
        paths = []
        for bundle in (bundle_app, bundle_ext):
            profile = self.api.profiles[self.api.add_profile(bundle, 'by hand')]
            path = directory / (profile['uuid'] + '.provisionprofile')
            path.write_bytes(base64.b64decode(profile['profileContent']))
            paths.append(path)
        stray = self.root / 'Downloads' / paths[0].name
        stray.parent.mkdir()
        shutil.copyfile(paths[0], stray)
        result = self.sign('--app-profile', str(stray), '--extension-profile', str(paths[1]))
        self.assertEqual(result.returncode, 2)
        self.assertIn('is not an installed profile', result.stderr)
        self.assertEqual(self.calls(), [])
        result = self.sign('--app-profile', str(paths[0]), '--extension-profile', str(paths[1]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(json.loads((self.out / 'signing-report.json').read_text())['profiles'], {APP_ID: 'manual', EXT_ID: 'manual'})
        swapped = self.sign('--app-profile', str(paths[1]), '--extension-profile', str(paths[0]), out=self.root / 'release-2')
        self.assertEqual(swapped.returncode, 1)
        self.assertIn('fix: Check the profiles you passed. Make the two profiles by hand', swapped.stderr)

    def test_a_second_run_reuses_registrations_and_active_profiles(self):
        self.assertEqual(self.sign().returncode, 0)
        first = {key: value['uuid'] for key, value in self.api.profiles.items()}
        self.api.requests.clear()
        result = self.sign(out=self.root / 'release-2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call for call in self.api.calls() if call[0] != 'GET'], [])
        self.assertEqual({key: value['uuid'] for key, value in self.api.profiles.items()}, first)
        self.assertEqual(json.loads((self.root / 'release-2' / 'signing-report.json').read_text())['profiles'],
                         {APP_ID: 'reused', EXT_ID: 'reused'})
        self.api.requests.clear()
        result = self.sign('--new-profiles', out=self.root / 'release-3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call for call in self.api.calls() if call[0] != 'GET'],
                         [('DELETE', '/v1/profiles/PROFILE1'), ('POST', '/v1/profiles'), ('DELETE', '/v1/profiles/PROFILE2'), ('POST', '/v1/profiles')])

    def test_an_invalid_profile_is_replaced(self):
        bundle = self.api.add_bundle(APP_ID, ('NETWORK_EXTENSIONS', 'SYSTEM_EXTENSION_INSTALL', 'APP_GROUPS'))
        self.api.add_profile(bundle, f'Guard {APP_ID} Developer ID CERTGUARD1', state='INVALID')
        result = self.sign()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(('DELETE', '/v1/profiles/PROFILE1'), self.api.calls())
        self.assertNotIn('PROFILE1', self.api.profiles)

    def test_a_rejected_notarization_ships_nothing(self):
        result = self.sign(scenario=dict(self.scenario, notaryStatus='Invalid'))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(f'Apple did not accept the submission {SUBMISSION}: Invalid', result.stderr)
        self.assertIn('fix: Read notary-log.json', result.stderr)
        self.assertTrue((self.out / 'notary-log.json').is_file())
        self.assertEqual(json.loads((self.out / 'notarization.json').read_text())['status'], 'Invalid')
        self.assertEqual([call['args'][0] for call in self.calls('xcrun') if call['args'][0] == 'stapler'], [])
        self.assertEqual(self.calls('spctl'), [])
        self.assertEqual(list(self.out.glob('Guard-*.zip')), [])
        self.assert_no_secrets(result)

    def test_only_a_clean_checkout_of_the_tag_is_built(self):
        (self.checkout / 'guard' / 'mac' / 'project.yml').write_text('changed\n')
        result = self.sign()
        self.assertEqual(result.returncode, 2)
        self.assertIn(f'This checkout of {TAG} has local changes', result.stderr)
        self.git('commit', '-q', '-am', 'after the tag')
        result = self.sign(out=self.root / 'release-2')
        self.assertEqual(result.returncode, 2)
        self.assertIn(f'This checkout is not at {TAG}', result.stderr)
        self.assertIn(f'fix: Check out the release first: git fetch --tags && git checkout {TAG}', result.stderr)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.calls(), [])

    def test_the_api_url_override_only_reaches_this_mac_or_https(self):
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.home), 'GUARD_SIGN_API_URL': 'http://example.invalid'}
        result = subprocess.run([sys.executable, str(self.wizard), '--team', TEAM, '--bundle-prefix', APP_ID, '--key-id', KEY_ID,
                                 '--issuer-id', ISSUER, '--key-file', str(self.key), '--tag', TAG, '--out', str(self.out), '--dry-run'],
                                env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn('GUARD_SIGN_API_URL must be an https URL', result.stderr)


class TemplateTests(unittest.TestCase):
    def test_the_re_sign_template_only_uses_flags_the_wizard_accepts_and_cleans_up(self):
        text = TEMPLATE.read_text()
        helped = subprocess.run([sys.executable, str(WIZARD), '--help'], capture_output=True, text=True, check=True).stdout
        accepted = set(re.findall(r'(--[a-z][a-z-]+)', helped.split('Example:')[0]))
        invocation = text[text.index('sign-guard.py'):]
        invocation = invocation[:invocation.index('\n\n') if '\n\n' in invocation else len(invocation)]
        used = set(re.findall(r'(--[a-z][a-z-]+)', invocation))
        self.assertTrue({'--team', '--bundle-prefix', '--key-id', '--issuer-id', '--key-file', '--tag', '--out'} <= used, used)
        self.assertEqual(used - accepted, set())
        self.assertIn('runs-on: macos-', text)
        self.assertIn('if: always()', text)
        self.assertIn('security delete-keychain', text)
        for secret in ('APPLE_API_KEY_P8', 'DEVELOPER_ID_P12', 'DEVELOPER_ID_P12_PASSWORD'):
            self.assertIn('secrets.' + secret, text)
        self.assertNotRegex(text, r'echo[^\n]*secrets\.', 'secrets are never echoed')
        self.assertNotIn('set -x', text)
        for line in re.findall(r'uses: (\S+)', text):
            self.assertRegex(line, r'@[0-9a-f]{40}$', 'actions are pinned to a commit')


if __name__ == '__main__':
    unittest.main()
