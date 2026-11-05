#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
"""Sign, notarize and package a tagged Guard release under your own Apple team.

One command takes a checkout of a Guard release tag to a notarized, stapled ZIP, its SHA-256 and the
device-management profile, all under your team ID and bundle IDs:

  1. checks the checkout is exactly the release tag, the API key file and the Developer ID Application identity
     in this Mac's keychain;
  2. finds that certificate in the API key's App Store Connect account (so a key from another team changes nothing),
     registers the app and extension bundle IDs and enables Network Extensions, System Extension and App Groups;
  3. creates (or reuses) the two Developer ID provisioning profiles through the API and installs them;
  4. checks the profiles with release.py preflight, then builds and signs with release.py build;
  5. notarizes the ZIP with notarytool using the same API key, staples the app and checks it with Gatekeeper;
  6. writes the final ZIP, its .sha256 and a .mobileconfig made by mdm-profile.py.
"""
import argparse
import base64
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
MAC = HERE.parent
REPO = MAC.parents[1]
sys.path.insert(0, str(HERE))
import identity as guard_identity

API = 'https://api.appstoreconnect.apple.com'
API_OVERRIDE = 'GUARD_SIGN_API_URL'
OPENSSL = '/usr/bin/openssl'
DITTO = '/usr/bin/ditto'
PROFILE_TYPE = 'MAC_APP_DIRECT'
CERTIFICATE_TYPES = ('DEVELOPER_ID_APPLICATION', 'DEVELOPER_ID_APPLICATION_G2')
PROFILE_DIR = Path('Library') / 'Developer' / 'Xcode' / 'UserData' / 'Provisioning Profiles'
KEY_ID = re.compile(r'[A-Z0-9]{10}')
ISSUER_ID = re.compile(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
SHA1 = re.compile(r'[A-Fa-f0-9]{40}')
TAG = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}')
UUID = re.compile(r'[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}')
TOKEN_LIFETIME = 1200
SYSTEM_EXTENSION_VALUES = ('content-filter-provider-systemextension', 'app-proxy-provider-systemextension')
ENV_NAMES = ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'DEVELOPER_DIR', 'GOCACHE', 'GOMODCACHE', 'GOPATH')

API_FINDINGS = '''App Store Connect API findings (checked 28 Oct 2026 against Apple's API reference):
  - POST /v1/profiles accepts profileType MAC_APP_DIRECT, which is a Developer ID profile for a Mac app. fastlane
    match/sigh create Developer ID profiles the same way (type developer_id).
  - POST /v1/bundleIdCapabilities accepts NETWORK_EXTENSIONS, SYSTEM_EXTENSION_INSTALL and APP_GROUPS.
  - The API cannot choose which Network Extension values a profile carries. Apple decides, and Developer ID profiles
    are expected to carry the -systemextension values Guard needs. This wizard therefore checks each profile it
    gets (release.py preflight) and stops with manual steps if a value is missing.
  - The API cannot create a Developer ID Application certificate for you here: only the Account Holder can, and the
    private key must already be in this Mac's keychain. The wizard finds that certificate in your account by its
    SHA-1.'''

MANUAL_PROFILES = '''Make the two profiles by hand, then run this command again with --app-profile and --extension-profile:
  1. Open developer.apple.com/account, then Certificates, Identifiers & Profiles, then Profiles, then +.
  2. Choose Developer ID under Distribution, then Mac, then Continue.
  3. App ID: {app}. Certificate: Developer ID Application, SHA-1 {sha1}. Name it, Generate, Download.
  4. Do the same for App ID {extension}.
  5. Move both files into ~/Library/Developer/Xcode/UserData/Provisioning Profiles/.
  6. Check each one: security cms -D -i <file> | plutil -p -
     It must list TeamIdentifier {team}, and under com.apple.developer.networking.networkextension both
     content-filter-provider-systemextension and app-proxy-provider-systemextension.
     If a value is missing, open the App ID under Identifiers and turn on Network Extensions (and System
     Extension for {app}), save, then edit the profile, Save and download it again.'''

EPILOG = '''Example:
  python3 guard/mac/tools/sign-guard.py --team AB12CD34EF --bundle-prefix com.acme.guard \\
    --key-id 2X9R4HXF34 --issuer-id 57246542-96fe-1a63-e053-0824d011072a --key-file ~/keys/AuthKey_2X9R4HXF34.p8 \\
    --tag guard-v0.2.0 --out ~/guard-release --organization "Acme"

The extension is <bundle prefix>.extension. The API key needs the Admin role. Its .p8 file is only read: by openssl to
sign each App Store Connect request and by notarytool. It is never copied, printed or written to a log.
--dry-run prints the plan and calls nothing.

''' + API_FINDINGS + '''

If the API cannot make usable profiles:
''' + MANUAL_PROFILES.format(app='<bundle prefix>', extension='<bundle prefix>.extension', sha1='<your identity>',
                             team='<team>') + '''

Precedent: Fleet's fleetctl package --sign-identity --notarize signs and notarizes a customer-built agent with the
customer's own identity in one command; this wizard does the same for Guard.'''


class SignError(Exception):
    def __init__(self, problem, fix, code=1):
        super().__init__(problem)
        self.problem = problem
        self.fix = fix
        self.code = code


def clean_env():
    return {name: os.environ[name] for name in ENV_NAMES if name in os.environ}


class Runner:
    def __init__(self, logs):
        self.logs = logs

    def run(self, args, step, *, fix, timeout=120, input=None):
        try:
            result = subprocess.run(args, env=clean_env(), capture_output=True, timeout=timeout, input=input, check=False)
        except FileNotFoundError:
            raise SignError(f'{Path(args[0]).name} is not installed', fix) from None
        except subprocess.TimeoutExpired:
            raise SignError(f'{Path(args[0]).name} did not finish within {timeout} seconds', fix) from None
        if self.logs is not None:
            path = self.logs / (step + '.log')
            with open(path, 'ab') as handle:
                os.chmod(path, 0o600)
                handle.write(result.stdout + result.stderr)
        if result.returncode:
            raise SignError(f'{step} failed (exit {result.returncode})', fix)
        return result.stdout.decode('utf-8', errors='replace')


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()


def der_signature_to_raw(der):
    if len(der) < 8 or der[0] != 0x30:
        raise ValueError('not a DER signature')
    index = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b''
    for _ in range(2):
        if der[index] != 0x02:
            raise ValueError('not a DER integer')
        length = der[index + 1]
        value = der[index + 2:index + 2 + length].lstrip(b'\0')
        index += 2 + length
        if len(value) > 32:
            raise ValueError('not a P-256 signature')
        out += value.rjust(32, b'\0')
    return out


def api_base():
    base = os.environ.get(API_OVERRIDE) or API
    parsed = urllib.parse.urlsplit(base)
    loopback = False
    try:
        loopback = parsed.hostname == 'localhost' or ipaddress.ip_address(parsed.hostname or '').is_loopback
    except ValueError:
        loopback = False
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and loopback):
        raise SignError(f'{API_OVERRIDE} must be an https URL (or http on this Mac only)', f'Unset {API_OVERRIDE}', 2)
    return base.rstrip('/')


class AppStoreConnect:
    def __init__(self, base, key_id, issuer_id, key_file):
        self.base = base
        self.key_id = key_id
        self.issuer_id = issuer_id
        self.key_file = key_file
        self.token = None
        self.issued = 0

    def bearer(self):
        now = int(time.time())
        if self.token and now - self.issued < TOKEN_LIFETIME - 120:
            return self.token
        header = b64url(json.dumps({'alg': 'ES256', 'kid': self.key_id, 'typ': 'JWT'}, separators=(',', ':')).encode())
        claims = {'iss': self.issuer_id, 'iat': now, 'exp': now + TOKEN_LIFETIME, 'aud': 'appstoreconnect-v1'}
        payload = b64url(json.dumps(claims, separators=(',', ':')).encode())
        signing_input = (header + '.' + payload).encode()
        try:
            result = subprocess.run([OPENSSL, 'dgst', '-sha256', '-sign', str(self.key_file)], input=signing_input,
                                    capture_output=True, env=clean_env(), timeout=30, check=False)
            if result.returncode:
                raise ValueError('openssl refused the key')
            raw = der_signature_to_raw(result.stdout)
        except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
            raise SignError('The API key file could not sign an App Store Connect request',
                            'Pass the .p8 file App Store Connect gave you, unchanged (it starts with '
                            '-----BEGIN PRIVATE KEY-----)', 2) from None
        self.token = header + '.' + payload + '.' + b64url(raw)
        self.issued = now
        return self.token

    def request(self, method, path, query=None, body=None):
        url = self.base + path + ('?' + urllib.parse.urlencode(query) if query else '')
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header('Authorization', 'Bearer ' + self.bearer())
        request.add_header('Accept', 'application/json')
        if data is not None:
            request.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
        except urllib.error.HTTPError as error:
            raise self.refusal(method, path, error.code, error.read()) from None
        except (urllib.error.URLError, OSError):
            raise SignError(f'App Store Connect could not be reached ({method} {path})',
                            'Check this Mac can reach api.appstoreconnect.apple.com, then run again') from None
        return json.loads(raw) if raw else {}

    def refusal(self, method, path, status, raw):
        try:
            details = '; '.join(str(item.get('detail') or item.get('title')) for item in json.loads(raw).get('errors', []))
        except (ValueError, AttributeError):
            details = ''
        problem = f'App Store Connect refused {method} {path} (HTTP {status})' + (': ' + details[:300] if details else '')
        fixes = {
            401: 'Check --key-id and --issuer-id against Users and Access, Integrations, App Store Connect API, and that '
                 'the key is not revoked',
            403: 'Use an API key with the Admin role; other roles cannot register bundle IDs or create profiles',
            409: 'The request conflicts with your account: a bundle ID registered by another team, or a capability '
                 'Apple refuses. Choose another --bundle-prefix, or make the profiles by hand (see --help)',
        }
        return SignError(problem, fixes.get(status, 'Run again; if it repeats, make the profiles by hand (see --help)'))

    def get(self, path, query=None):
        return self.request('GET', path, query)

    def post(self, path, body):
        return self.request('POST', path, body=body)

    def delete(self, path):
        return self.request('DELETE', path)


def read_key(path, key_id):
    if not path.is_file():
        raise SignError(f'No App Store Connect API key at {path}',
                        'Create one in App Store Connect, Users and Access, Integrations, App Store Connect API (Admin '
                        'role), download the AuthKey_<key ID>.p8 file once and pass its path with --key-file', 2)
    name = re.fullmatch(r'AuthKey_([A-Z0-9]+)\.p8', path.name)
    if name and name.group(1) != key_id:
        raise SignError(f'{path.name} is the key {name.group(1)}, not --key-id {key_id}',
                        f'Pass the key ID that matches the file, or the file AuthKey_{key_id}.p8', 2)
    with open(path, 'rb') as handle:
        head = handle.read(64)
    if not head.startswith(b'-----BEGIN PRIVATE KEY-----'):
        raise SignError(f'{path} is not an App Store Connect API key',
                        'Pass the .p8 file App Store Connect gave you, unchanged', 2)


def keychain_identity(runner, team, requested):
    listing = runner.run(['security', 'find-identity', '-v', '-p', 'codesigning'], 'keychain',
                         fix='Run on a Mac with Xcode command line tools installed')
    rows = [(digest.upper(), name) for digest, name in re.findall(r'\b([A-Fa-f0-9]{40}) "([^"\n]+)"', listing)]
    developer_id = [(digest, name) for digest, name in rows if name.startswith('Developer ID Application: ')]
    if requested:
        chosen = [(d, n) for d, n in developer_id if d == requested.upper() or n == requested]
        if not chosen:
            raise SignError(f'No Developer ID Application identity "{requested}" in this keychain',
                            'List them with: security find-identity -v -p codesigning. Import the certificate and its '
                            'private key (.p12) into the login keychain, then pass its SHA-1 with --identity', 2)
        digest, name = chosen[0]
        if not name.endswith('(' + team + ')'):
            raise SignError(f'The identity "{name}" belongs to another team, not {team}',
                            f'Pass the Developer ID Application identity of team {team}, or pass that team with --team', 2)
        return digest, name
    ours = [(d, n) for d, n in developer_id if n.endswith('(' + team + ')')]
    if not ours:
        others = sorted({n.rsplit('(', 1)[-1].rstrip(')') for _, n in developer_id})
        problem = f'No Developer ID Application identity for team {team} in this keychain'
        if others:
            problem += ' (found team ' + ', '.join(others) + ')'
        raise SignError(problem, f'The Account Holder of team {team} creates a Developer ID Application certificate in '
                        'Certificates, Identifiers & Profiles; import it with its private key into the login keychain', 2)
    if len(set(ours)) > 1:
        raise SignError(f'Several Developer ID Application identities for team {team}',
                        'Choose one with --identity <SHA-1> (security find-identity -v -p codesigning lists them)', 2)
    return ours[0]


def check_tag(runner, tag):
    fix = f'Check out the release first: git fetch --tags && git checkout {tag}'
    head = runner.run(['git', '-C', str(REPO), 'rev-parse', 'HEAD'], 'git', fix=fix).strip()
    try:
        tagged = runner.run(['git', '-C', str(REPO), 'rev-parse', '--verify', 'refs/tags/' + tag + '^{commit}'], 'git', fix=fix).strip()
    except SignError:
        raise SignError(f'This checkout has no tag {tag}', fix, 2) from None
    if head != tagged:
        raise SignError(f'This checkout is not at {tag}', fix, 2)
    if runner.run(['git', '-C', str(REPO), 'status', '--porcelain', '--untracked-files=no'], 'git', fix=fix).strip():
        raise SignError(f'This checkout of {tag} has local changes', 'Build from a clean checkout: git stash, or a fresh clone', 2)
    return head


def ensure_bundle_id(api, identifier, team):
    rows = api.get('/v1/bundleIds', {'filter[identifier]': identifier, 'limit': '200'}).get('data', [])
    found = [row for row in rows if row.get('attributes', {}).get('identifier') == identifier]
    if found:
        row, created = found[0], False
    else:
        body = {'data': {'type': 'bundleIds', 'attributes': {'identifier': identifier, 'name': 'Guard ' + identifier, 'platform': 'MAC_OS'}}}
        row, created = api.post('/v1/bundleIds', body)['data'], True
    attributes = row.get('attributes', {})
    seed = attributes.get('seedId')
    if seed and seed != team:
        raise SignError(f'The API key belongs to team {seed}, not {team}',
                        f'Use an API key from team {team}\'s App Store Connect account, or pass --team {seed}', 2)
    if attributes.get('platform') not in ('MAC_OS', 'UNIVERSAL'):
        raise SignError(f'{identifier} is registered for {attributes.get("platform")}, not macOS',
                        'Choose another --bundle-prefix, or change the identifier\'s platform in Identifiers', 2)
    return row['id'], created


def ensure_capabilities(api, bundle, wanted):
    rows = api.get(f'/v1/bundleIds/{bundle}/bundleIdCapabilities').get('data', [])
    have = {row.get('attributes', {}).get('capabilityType') for row in rows}
    added = []
    for capability in wanted:
        if capability in have:
            continue
        api.post('/v1/bundleIdCapabilities', {'data': {'type': 'bundleIdCapabilities', 'attributes': {'capabilityType': capability},
                                                       'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bundle}}}}})
        added.append(capability)
    return added


def find_certificate(api, digest, team):
    rows = api.get('/v1/certificates', {'filter[certificateType]': ','.join(CERTIFICATE_TYPES), 'limit': '200'}).get('data', [])
    for row in rows:
        try:
            content = base64.b64decode(row.get('attributes', {}).get('certificateContent') or '', validate=True)
        except ValueError:
            continue
        if hashlib.sha1(content).hexdigest().upper() == digest:
            return row['id']
    raise SignError(f'The Developer ID Application certificate {digest} is not in the App Store Connect account of this API key',
                    f'Use an API key from team {team}, or a Developer ID Application certificate that has not been revoked', 2)


def ensure_profile(api, bundle, identifier, certificate, force_new):
    name = f'Guard {identifier} Developer ID {certificate}'[:100]
    rows = api.get('/v1/profiles', {'filter[name]': name, 'filter[profileType]': PROFILE_TYPE, 'limit': '20'}).get('data', [])
    for row in rows:
        if row.get('attributes', {}).get('profileState') == 'ACTIVE' and not force_new:
            return row, 'reused'
        api.delete('/v1/profiles/' + row['id'])
    body = {'data': {'type': 'profiles', 'attributes': {'name': name, 'profileType': PROFILE_TYPE},
                     'relationships': {'bundleId': {'data': {'type': 'bundleIds', 'id': bundle}},
                                       'certificates': {'data': [{'type': 'certificates', 'id': certificate}]}}}}
    return api.post('/v1/profiles', body)['data'], 'created'


def install_profile(row, identifier):
    attributes = row.get('attributes', {})
    uuid = attributes.get('uuid', '')
    try:
        content = base64.b64decode(attributes.get('profileContent') or '', validate=True)
    except ValueError:
        content = b''
    if not UUID.fullmatch(uuid or '') or not content:
        raise SignError(f'App Store Connect returned no usable profile for {identifier}', 'Make the profiles by hand (see --help)')
    directory = Path.home() / PROFILE_DIR
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (uuid + '.provisionprofile')
    if not path.exists() or path.read_bytes() != content:
        path.write_bytes(content)
    return path


def write_identity(identity):
    path = MAC / 'Config' / 'Identity.local.xcconfig'
    previous = path.read_bytes() if path.exists() else None
    path.write_text(''.join(f'{name} = {identity[name]}\n' for name in guard_identity.INPUTS))
    return path, previous


def restore_identity(path, previous):
    if previous is None:
        path.unlink(missing_ok=True)
    else:
        path.write_bytes(previous)


def preflight(runner, args, digest, app_profile, extension_profile, manual):
    command = [sys.executable, str(MAC / 'release.py'), 'preflight', '--team', args.team, '--identity', digest,
               '--app-profile', str(app_profile), '--extension-profile', str(extension_profile)]
    try:
        runner.run(command, 'preflight', fix='')
        return
    except SignError:
        pass
    log = (runner.logs / 'preflight.log').read_text(errors='replace')
    try:
        report = json.loads(log[log.index('{'):log.rindex('}') + 1])
    except ValueError:
        raise SignError('release.py preflight failed', 'Read logs/preflight.log in the output directory') from None
    failing = [check for check in report.get('checks', []) if check.get('status') == 'fail']
    summary = '; '.join(f'{check["check"]}: {check["detail"]}' for check in failing)
    if any(check['check'] in ('app-profile', 'extension-profile') for check in failing):
        steps = MANUAL_PROFILES.format(app=args.app_id, extension=args.extension_id, sha1=digest, team=args.team)
        lead = 'Check the profiles you passed. ' if manual else 'The API made profiles release.py cannot use. '
        raise SignError('The provisioning profiles failed the release checks: ' + summary, lead + steps)
    raise SignError('release.py preflight failed: ' + summary,
                    'Install what the failing checks name (Xcode, xcodegen, Go), then run again')


def notarize(runner, args, archive, out):
    key = ['--key', str(args.key_file), '--key-id', args.key_id, '--issuer', args.issuer_id]
    fix = 'Check the API key can notarize (Admin or Developer role) and this Mac can reach Apple, then run again'
    output = runner.run(['xcrun', 'notarytool', 'submit', str(archive), *key, '--wait', '--timeout', '2h', '--output-format', 'json'],
                        'notarize', fix=fix, timeout=3 * 3600)
    try:
        result = json.loads(output[output.index('{'):output.rindex('}') + 1])
    except ValueError:
        raise SignError('notarytool gave no result', 'Read logs/notarize.log in the output directory') from None
    submission = result.get('id', '')
    record = {'id': submission, 'status': result.get('status'), 'message': result.get('message')}
    (out / 'notarization.json').write_text(json.dumps(record, indent=2) + '\n')
    if re.fullmatch(r'[A-Za-z0-9-]{1,64}', submission or ''):
        try:
            runner.run(['xcrun', 'notarytool', 'log', submission, *key, str(out / 'notary-log.json')], 'notary-log', fix=fix)
        except SignError:
            pass
    if result.get('status') != 'Accepted':
        raise SignError(f'Apple did not accept the submission {submission}: {result.get("status")}',
                        'Read notary-log.json in the output directory, fix what it names and run again with a new --out directory')
    return record


def plan_lines(args):
    key = f'--key {args.key_file} --key-id {args.key_id} --issuer {args.issuer_id}'
    out = args.out
    lines = [
        f'Plan for {args.tag}: team {args.team}, app {args.app_id}, extension {args.extension_id}',
        f'  1. Check the checkout is exactly tag {args.tag} with no local changes (git rev-parse, git status).',
        '  2. Find the Developer ID Application identity of team ' + args.team + ' (security find-identity -v -p codesigning).',
    ]
    if args.app_profile:
        lines += [f'  3. Use the profiles you made: {args.app_profile} and {args.extension_profile}. App Store Connect is not called.']
    else:
        lines += [
            f'  3. App Store Connect API at {api_base()}, key {args.key_id} (ES256 token signed by openssl from the key file):',
            '     GET /v1/certificates (DEVELOPER_ID_APPLICATION, _G2): your certificate must be in this key\'s team, else stop',
            f'     GET/POST /v1/bundleIds for {args.app_id} and {args.extension_id} (platform MAC_OS)',
            f'     POST /v1/bundleIdCapabilities: NETWORK_EXTENSIONS, SYSTEM_EXTENSION_INSTALL, APP_GROUPS for {args.app_id};'
            f' NETWORK_EXTENSIONS, APP_GROUPS for {args.extension_id}',
            f'     GET/POST /v1/profiles: one {PROFILE_TYPE} (Developer ID) profile per bundle ID, installed in ~/{PROFILE_DIR}',
        ]
    lines += [
        f'  4. Write guard/mac/Config/Identity.local.xcconfig for this build (put back afterwards); release.py preflight, then '
        f'release.py build --out {out / "build"}',
        f'  5. xcrun notarytool submit {out / "build" / "VibtraGuard-arm64.zip"} {key} --wait; xcrun notarytool log',
        '     xcrun stapler staple and validate; spctl --assess --type execute',
        f'  6. Write {out / archive_name(args)}, {out / (archive_name(args) + ".sha256")}, '
        f'{out / (args.app_id + ".mobileconfig")} and {out / "signing-report.json"}',
        'Dry run: nothing was called and nothing was written.',
    ]
    return lines


def archive_name(args):
    return f'Guard-{args.tag}-{args.team}-arm64.zip'


def parse(argv):
    parser = argparse.ArgumentParser(prog='sign-guard.py', description=__doc__, epilog=EPILOG,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--team', required=True, help='Your Apple team ID (10 characters, Membership details)')
    parser.add_argument('--bundle-prefix', required=True,
                        help='App bundle ID, e.g. com.acme.guard; the extension is <prefix>.extension')
    parser.add_argument('--key-id', required=True, help='App Store Connect API key ID')
    parser.add_argument('--issuer-id', required=True, help='App Store Connect API issuer ID')
    parser.add_argument('--key-file', required=True, type=Path, help='Path to the AuthKey_<key ID>.p8 file (only read)')
    parser.add_argument('--identity', help='Developer ID Application identity: its SHA-1 or full name. Default: the only one for --team')
    parser.add_argument('--tag', required=True, help='Guard release tag this checkout is at, e.g. guard-v0.2.0')
    parser.add_argument('--out', required=True, type=Path, help='New directory for the release files')
    parser.add_argument('--organization', default='Guard', help='Organisation name shown in the .mobileconfig')
    parser.add_argument('--app-profile', type=Path, help='Developer ID profile you made by hand for the app (skips the API)')
    parser.add_argument('--extension-profile', type=Path, help='Developer ID profile you made by hand for the extension')
    parser.add_argument('--new-profiles', action='store_true', help='Replace this wizard\'s existing profiles with new ones')
    parser.add_argument('--dry-run', action='store_true', help='Print the plan; call nothing, write nothing')
    args = parser.parse_args(argv)
    if bool(args.app_profile) != bool(args.extension_profile):
        parser.error('pass both --app-profile and --extension-profile, or neither')
    return parser, args


def validate(args):
    args.app_id = args.bundle_prefix
    args.extension_id = args.bundle_prefix + '.extension'
    try:
        args.identity_values = guard_identity.derive(args.team, args.app_id, args.extension_id)
    except guard_identity.IdentityError as error:
        fix = '--team is the 10 characters in Membership details; --bundle-prefix is reverse DNS, e.g. com.acme.guard'
        raise SignError(str(error).replace('GUARD_TEAM_ID', '--team').replace('GUARD_APP_ID', '--bundle-prefix')
                        .replace('GUARD_EXTENSION_ID', '--bundle-prefix'), fix, 2) from None
    if not KEY_ID.fullmatch(args.key_id):
        raise SignError('--key-id must be the 10-character key ID', 'Copy it from Users and Access, Integrations, App Store Connect API', 2)
    if not ISSUER_ID.fullmatch(args.issuer_id):
        raise SignError('--issuer-id must be the issuer UUID', 'Copy it from the top of Users and Access, Integrations, App Store Connect API', 2)
    if not TAG.fullmatch(args.tag):
        raise SignError('--tag must be a release tag name (letters, digits, dot, dash, underscore)', 'Pass the tag, e.g. guard-v0.2.0', 2)
    if args.identity and not (SHA1.fullmatch(args.identity) or args.identity.startswith('Developer ID Application: ')):
        raise SignError('--identity must be a SHA-1 or a "Developer ID Application: ..." name',
                        'List them with: security find-identity -v -p codesigning', 2)
    args.key_file = args.key_file.expanduser().absolute()
    args.out = args.out.expanduser().absolute()
    if args.out.exists() or args.out.is_symlink():
        raise SignError(f'{args.out} already exists', 'Pass a new directory with --out; nothing is overwritten', 2)
    if args.out.resolve().is_relative_to(REPO.resolve()):
        raise SignError('--out is inside the checkout', 'Pass a directory outside the Guard checkout', 2)
    read_key(args.key_file, args.key_id)
    for name in ('app_profile', 'extension_profile'):
        path = getattr(args, name)
        if path is not None:
            path = path.expanduser().absolute()
            setattr(args, name, path)
            if path.parent.resolve() != (Path.home() / PROFILE_DIR).resolve() or not path.is_file():
                raise SignError(f'{path} is not an installed profile', f'Move it into ~/{PROFILE_DIR}/ and pass that path', 2)


def sign(args):
    args.out.mkdir(mode=0o700, parents=True)
    logs = args.out / 'logs'
    logs.mkdir(mode=0o700)
    runner = Runner(logs)
    step = lambda text: print('==> ' + text, flush=True)
    step(f'Checking the checkout is {args.tag}')
    commit = check_tag(runner, args.tag)
    step('Finding the Developer ID Application identity')
    digest, name = keychain_identity(runner, args.team, args.identity)
    print('    ' + name + ' ' + digest)
    report = {'status': 'signing', 'tag': args.tag, 'commit': commit, 'team': args.team, 'appId': args.app_id,
              'extensionId': args.extension_id, 'identity': digest, 'profiles': {}}
    if args.app_profile:
        app_profile, extension_profile = args.app_profile, args.extension_profile
        report['profiles'] = {args.app_id: 'manual', args.extension_id: 'manual'}
    else:
        api = AppStoreConnect(api_base(), args.key_id, args.issuer_id, args.key_file)
        wanted = {args.app_id: ('NETWORK_EXTENSIONS', 'SYSTEM_EXTENSION_INSTALL', 'APP_GROUPS'),
                  args.extension_id: ('NETWORK_EXTENSIONS', 'APP_GROUPS')}
        step('Finding your certificate in App Store Connect')
        certificate = find_certificate(api, digest, args.team)
        bundles = {}
        for identifier, capabilities in wanted.items():
            step(f'Registering {identifier}')
            bundles[identifier], created = ensure_bundle_id(api, identifier, args.team)
            added = ensure_capabilities(api, bundles[identifier], capabilities)
            print(f'    {"registered" if created else "already registered"}; capabilities added: {", ".join(added) or "none"}')
        paths = {}
        for identifier in wanted:
            step(f'Developer ID profile for {identifier}')
            row, how = ensure_profile(api, bundles[identifier], identifier, certificate, args.new_profiles)
            paths[identifier] = install_profile(row, identifier)
            report['profiles'][identifier] = how
            print(f'    {how} {paths[identifier].name}')
        app_profile, extension_profile = paths[args.app_id], paths[args.extension_id]
    path, previous = write_identity(args.identity_values)
    try:
        step('Checking the profiles and tools (release.py preflight)')
        preflight(runner, args, digest, app_profile, extension_profile, bool(args.app_profile))
        step('Building and signing (release.py build)')
        build = args.out / 'build'
        runner.run([sys.executable, str(MAC / 'release.py'), 'build', '--team', args.team, '--identity', digest,
                    '--app-profile', str(app_profile), '--extension-profile', str(extension_profile), '--out', str(build)],
                   'build', fix='Read logs/build.log and build/*.log in the output directory', timeout=3600)
    finally:
        restore_identity(path, previous)
    app = build / 'products' / 'Release' / 'VibtraGuard.app'
    step('Notarizing (notarytool, this can take several minutes)')
    report['notarization'] = notarize(runner, args, build / 'VibtraGuard-arm64.zip', args.out)
    step('Stapling and checking with Gatekeeper')
    runner.run(['xcrun', 'stapler', 'staple', str(app)], 'staple', fix='Run again in a few minutes; Apple publishes the ticket after acceptance')
    runner.run(['xcrun', 'stapler', 'validate', str(app)], 'staple', fix='Run again in a few minutes')
    runner.run(['spctl', '--assess', '--type', 'execute', '--verbose=2', str(app)], 'gatekeeper',
               fix='Read logs/gatekeeper.log; the app must be Developer ID signed, notarized and stapled')
    step('Packaging')
    archive = args.out / archive_name(args)
    runner.run([DITTO, '-c', '-k', '--keepParent', str(app), str(archive)], 'package', fix='Check the disk has space')
    digest_hex = hashlib.sha256(archive.read_bytes()).hexdigest()
    (args.out / (archive.name + '.sha256')).write_text(f'{digest_hex}  {archive.name}\n')
    mobileconfig = args.out / (args.app_id + '.mobileconfig')
    runner.run([sys.executable, str(HERE / 'mdm-profile.py'), '--team', args.team, '--app-id', args.app_id,
                '--extension-id', args.extension_id, '--organization', args.organization, '--out', str(mobileconfig)],
               'mobileconfig', fix='Check --organization is 1 to 200 characters')
    report.update(status='notarized', archive=archive.name, archiveSha256=digest_hex, checksumFile=archive.name + '.sha256',
                  mobileconfig=mobileconfig.name, finished=dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'))
    (args.out / 'signing-report.json').write_text(json.dumps(report, indent=2) + '\n')
    step('Done')
    for path in (archive, args.out / report['checksumFile'], mobileconfig):
        print('    ' + str(path))
    return report


def main(argv=None):
    parser, args = parse(argv)
    try:
        validate(args)
        if args.dry_run:
            print('\n'.join(plan_lines(args)))
            return 0
        sign(args)
        return 0
    except SignError as error:
        sys.stderr.write(f'sign-guard: {error.problem}\nfix: {error.fix}\n')
        return error.code


if __name__ == '__main__':
    sys.exit(main())
