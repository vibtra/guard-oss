#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
"""Prepare an arm64 Developer ID Guard release; never notarize or install it.

Profiles must already be installed in Xcode's standard profile directories.
No credentials are accepted on this command line. No unsigned fallback exists.
`preflight` runs every check and lists exactly what the founder must provision.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE / 'tools'))
import identity as guard_identity

try:
    CONFIGURED = guard_identity.resolve(env={})
except (guard_identity.IdentityError, OSError) as error:
    sys.exit('Release refused: ' + str(error))
TEAM = CONFIGURED['GUARD_TEAM_ID']
APP_ID = CONFIGURED['GUARD_APP_ID']
EXT_ID = CONFIGURED['GUARD_EXTENSION_ID']
IDS = (APP_ID, EXT_ID)


class ReleaseError(Exception):
    pass


def clean_env():
    names = ('PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'DEVELOPER_DIR', 'GOCACHE', 'GOMODCACHE', 'GOPATH')
    return {key: os.environ[key] for key in names if key in os.environ}


def run(args, *, cwd=HERE, env=None, log=None, timeout=60):
    try:
        result = subprocess.run(args, cwd=cwd, env=env or clean_env(), capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReleaseError(f'{Path(args[0]).name} could not complete') from None
    if log:
        with open(log, 'xb') as handle:
            os.chmod(log, 0o600)
            handle.write(result.stdout + result.stderr)
    if result.returncode:
        raise ReleaseError(f'{Path(args[0]).name} failed (exit {result.returncode}); no fallback attempted')
    return result.stdout, result.stderr


def select_identity(output, team, requested=None):
    identities = []
    for digest, name in re.findall(r'\b([A-Fa-f0-9]{40}) "([^"\n]+)"', output):
        if name.startswith('Developer ID Application: ') and name.endswith('(' + team + ')'):
            identities.append(digest.upper())
    identities = sorted(set(identities))
    if requested:
        if not re.fullmatch(r'[A-Fa-f0-9]{40}', requested) or requested.upper() not in identities:
            raise ReleaseError('Requested identity is not a valid Developer ID Application identity for this team')
        return requested.upper()
    if not identities:
        raise ReleaseError('No valid Developer ID Application identity for this team; Apple Development/ad-hoc signing is not accepted')
    if len(identities) != 1:
        raise ReleaseError('Multiple Developer ID Application identities; select one using --identity SHA1')
    return identities[0]


def requested_entitlements(bundle_id, team):
    target = 'VibtraGuard' if bundle_id == APP_ID else 'VibtraGuardExtension'
    source = plistlib.loads((HERE / target / (target + '.entitlements')).read_bytes())
    try:
        return guard_identity.expand(source, guard_identity.derive(team, APP_ID, EXT_ID))
    except guard_identity.IdentityError:
        raise ReleaseError('Invalid team identifier') from None


def validate_profile(profile, bundle_id, team, identity, requested, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    if not isinstance(profile, dict):
        raise ReleaseError('Invalid provisioning document')
    expiry = profile.get('ExpirationDate')
    if not isinstance(expiry, dt.datetime):
        raise ReleaseError('Provisioning profile lacks expiry')
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=dt.timezone.utc)
    if expiry <= now:
        raise ReleaseError('Provisioning profile expired')
    if profile.get('ProvisionsAllDevices') is not True or profile.get('ProvisionedDevices'):
        raise ReleaseError('Developer ID all-device profile required; development/device profiles are refused')
    platforms = profile.get('Platform')
    if profile.get('TeamIdentifier') != [team] or not isinstance(platforms, list) or not all(isinstance(x, str) for x in platforms) or not set(platforms) & {'OSX', 'macOS'}:
        raise ReleaseError('Provisioning profile team or platform mismatch')
    uuid = profile.get('UUID', '')
    if not isinstance(uuid, str) or not re.fullmatch(r'[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}', uuid):
        raise ReleaseError('Invalid provisioning profile UUID')
    ent = profile.get('Entitlements')
    if not isinstance(ent, dict) or ent.get('com.apple.developer.team-identifier') != team:
        raise ReleaseError('Provisioning entitlement team mismatch')
    app_identifier = ent.get('com.apple.application-identifier', ent.get('application-identifier'))
    if app_identifier != team + '.' + bundle_id or ent.get('get-task-allow') or ent.get('com.apple.security.get-task-allow'):
        raise ReleaseError('Provisioning application identity/debug entitlement mismatch')
    for name, value in requested.items():
        if name.startswith('com.apple.developer.') or name == 'com.apple.security.application-groups':
            allowed = ent.get(name)
            if isinstance(value, list):
                if not isinstance(allowed, list) or not all(profile_allows(item, allowed, team) for item in value):
                    raise ReleaseError('Provisioning profile does not authorize requested release entitlements')
            elif allowed != value:
                raise ReleaseError('Provisioning profile does not authorize requested release entitlements')
    certs = profile.get('DeveloperCertificates', [])
    if not isinstance(certs, list):
        raise ReleaseError('Invalid provisioning certificate list')
    if not any(isinstance(cert, bytes) and hashlib.sha1(cert).hexdigest().upper() == identity for cert in certs):
        raise ReleaseError('Selected signing certificate is absent from provisioning profile')
    return uuid


def profile_allows(item, allowed, team):
    """Developer ID profiles grant app groups as the team wildcard TEAM.*; only this team's wildcard counts."""
    return item in allowed or (team + '.*' in allowed and item.startswith(team + '.'))


def read_profile(path):
    if not path.is_file() or path.stat().st_size > 1024 * 1024:
        raise ReleaseError('Provisioning profile is missing or oversized')
    raw, _ = run(['/usr/bin/security', 'cms', '-D', '-i', str(path)])
    if len(raw) > 4 * 1024 * 1024:
        raise ReleaseError('Decoded provisioning profile exceeds limit')
    try:
        return plistlib.loads(raw)
    except Exception:
        raise ReleaseError('Provisioning profile could not be decoded') from None


def profile_is_installed(path):
    home = Path.home()
    roots = (home / 'Library/Developer/Xcode/UserData/Provisioning Profiles', home / 'Library/MobileDevice/Provisioning Profiles')
    return any(path.resolve().parent == root.resolve() for root in roots)


def minimum_macos():
    """The deployment target every target builds for (project.yml MACOSX_DEPLOYMENT_TARGET)."""
    found = set(re.findall(r'MACOSX_DEPLOYMENT_TARGET:\s*"?([0-9.]+)"?', (HERE / 'project.yml').read_text()))
    if len(found) != 1:
        raise ReleaseError('project.yml must declare exactly one MACOSX_DEPLOYMENT_TARGET')
    return found.pop()


def release_arch():
    spec = (HERE / 'project.yml').read_text()
    release = spec.split('    Release:\n', 1)[1] if '    Release:\n' in spec else ''
    match = re.search(r'^\s+ARCHS:\s*(\S+)', release, re.M)
    return match.group(1) if match else None


def founder_actions(team):
    """Exactly what must exist before `build`: nothing here is created or downloaded by this script."""
    def capabilities(bundle_id):
        ent = requested_entitlements(bundle_id, team if re.fullmatch(r'[A-Z0-9]{10}', team) else TEAM)
        out = []
        for name, value in sorted(ent.items()):
            if name.startswith('com.apple.developer.') or name == 'com.apple.security.application-groups':
                out.append(name + '=' + (','.join(value) if isinstance(value, list) else str(value).lower()))
        return '; '.join(out)
    return [
        f'Developer ID Application certificate for team {team}, with its private key in this Mac\'s login keychain '
        f'(developer.apple.com > Certificates; the Account Holder creates it). Check: security find-identity -v -p codesigning '
        f'lists "Developer ID Application: <name> ({team})".',
        f'Developer ID provisioning profile (macOS, all devices) for {APP_ID} containing that certificate and '
        f'authorizing: {capabilities(APP_ID)}. Install it in ~/Library/Developer/Xcode/UserData/Provisioning Profiles '
        f'and pass it with --app-profile.',
        f'Developer ID provisioning profile (macOS, all devices) for {EXT_ID} containing that certificate and '
        f'authorizing: {capabilities(EXT_ID)}. Install it in the same directory and pass it with --extension-profile.',
        f'notarytool credentials stored in the keychain under a profile name, for example: xcrun notarytool store-credentials '
        f'<profile-name> --apple-id <apple-id> --team-id {team} (it asks for an app-specific password), or an App Store '
        f'Connect API key. release.py never reads them; RELEASE.md uses the profile name after a successful build.',
    ]


def preflight_report(args):
    """Every preflight check, not just the first failure. Missing Apple-issued items are founder items."""
    checks = []

    def check(name, fn):
        try:
            detail = fn()
            checks.append({'check': name, 'status': 'pass', 'detail': detail})
            return True
        except ReleaseError as error:
            checks.append({'check': name, 'status': 'fail', 'detail': str(error)})
            return False

    def team():
        if not re.fullmatch(r'[A-Z0-9]{10}', args.team):
            raise ReleaseError('Invalid team identifier')
        return args.team
    check('team', team)
    identity = None

    def find_identity():
        nonlocal identity
        stdout, _ = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'])
        identity = select_identity(stdout.decode('utf-8', errors='replace'), args.team, args.identity)
        return 'Developer ID Application identity ' + identity
    founder = {'developer-id-identity': not check('developer-id-identity', find_identity)}
    profiles = {}
    for name, bundle_id, path in (('app-profile', APP_ID, args.app_profile), ('extension-profile', EXT_ID, args.extension_profile)):
        def profile(bundle_id=bundle_id, path=path):
            if path is None or not profile_is_installed(path):
                raise ReleaseError(f'No installed Developer ID profile for {bundle_id} was given')
            if identity is None:
                raise ReleaseError('Cannot validate the profile without a Developer ID Application identity')
            profiles[bundle_id] = validate_profile(read_profile(path), bundle_id, args.team, identity, requested_entitlements(bundle_id, args.team))
            return 'profile ' + profiles[bundle_id]
        founder[name] = not check(name, profile)

    def entitlements():
        for bundle_id in IDS:
            ent = requested_entitlements(bundle_id, args.team)
            values = ent.get('com.apple.developer.networking.networkextension', [])
            if sorted(values) != ['app-proxy-provider-systemextension', 'content-filter-provider-systemextension']:
                raise ReleaseError(f'{bundle_id} release entitlements lack the -systemextension Network Extension values')
        if requested_entitlements(APP_ID, args.team).get('com.apple.developer.system-extension.install') is not True:
            raise ReleaseError('The app release entitlements lack system-extension installation')
        return 'release entitlements declared for app and extension'
    check('release-entitlements', entitlements)

    def arch():
        if release_arch() != 'arm64':
            raise ReleaseError('project.yml Release must build ARCHS: arm64 only')
        return 'arm64'
    check('architecture', arch)
    check('minimum-macos', lambda: 'macOS ' + minimum_macos())
    for tool in ('go', 'xcodegen', 'xcodebuild'):
        def found(tool=tool):
            if shutil.which(tool) is None:
                raise ReleaseError(f'Required build tool unavailable: {tool}')
            return shutil.which(tool)
        check('tool:' + tool, found)
    for tool in ('notarytool', 'stapler'):
        def xcrun(tool=tool):
            out, _ = run(['/usr/bin/xcrun', '--find', tool])
            return out.decode().strip()
        check('tool:' + tool, xcrun)
    checks.append({'check': 'notary-credentials', 'status': 'not-checked',
                   'detail': 'release.py never reads notarization credentials; the founder stores them (founderActions)'})
    actions = founder_actions(args.team)
    needed = [actions[0]] if founder['developer-id-identity'] else []
    needed += [actions[1]] if founder['app-profile'] else []
    needed += [actions[2]] if founder['extension-profile'] else []
    needed.append(actions[3])
    failing = [c['check'] for c in checks if c['status'] == 'fail']
    founder_checks = {'developer-id-identity', 'app-profile', 'extension-profile'}
    return {
        'status': 'developer-id-preflight-passed' if not failing else 'developer-id-preflight-blocked',
        'architecture': 'arm64', 'minimumMacOS': minimum_macos() if not any(c == 'minimum-macos' for c in failing) else None,
        'checks': checks,
        'blockedOnFounder': [c for c in failing if c in founder_checks],
        'blockedOnCode': [c for c in failing if c not in founder_checks],
        'founderActions': needed,
        'notarizationCredentialsChecked': False,
    }


def preflight(args):
    if not re.fullmatch(r'[A-Z0-9]{10}', args.team):
        raise ReleaseError('Invalid team identifier')
    stdout, _ = run(['/usr/bin/security', 'find-identity', '-v', '-p', 'codesigning'])
    identity = select_identity(stdout.decode('utf-8', errors='replace'), args.team, args.identity)
    profiles = {}
    for bundle_id, path in ((APP_ID, args.app_profile), (EXT_ID, args.extension_profile)):
        if path is None or not profile_is_installed(path):
            raise ReleaseError('Both Developer ID profiles must already be installed in a standard Xcode profile directory')
        profiles[bundle_id] = validate_profile(read_profile(path), bundle_id, args.team, identity, requested_entitlements(bundle_id, args.team))
    for tool in ('go', 'xcodegen', 'xcodebuild'):
        if shutil.which(tool) is None:
            raise ReleaseError(f'Required build tool unavailable: {tool}')
    return identity, profiles


def verify_signed_component(path, executable, team, identity):
    requirement = '=anchor apple generic and certificate leaf = H"' + identity + '" and certificate leaf[subject.OU] = "' + team + '"'
    run(['/usr/bin/codesign', '--verify', '--strict', '-R', requirement, str(path)])
    stdout, stderr = run(['/usr/bin/codesign', '-d', '--verbose=4', str(path)])
    detail = (stdout + stderr).decode('utf-8', errors='replace')
    if not re.search(r'^Authority=Developer ID Application:', detail, re.M) or f'TeamIdentifier={team}\n' not in detail + '\n':
        raise ReleaseError('Built component is not signed with the required Developer ID team')
    stamp = re.search(r'^Timestamp=(.+)$', detail, re.M)
    if not stamp or stamp.group(1).strip().lower() in ('none', 'not set', 'not available') or not re.search(r'\bflags=0x[A-Fa-f0-9]+\([^)]*\bruntime\b', detail, re.M):
        raise ReleaseError('Built component lacks a secure timestamp or hardened runtime')
    arch, _ = run(['/usr/bin/lipo', '-archs', str(executable)])
    if arch.decode().strip() != 'arm64':
        raise ReleaseError('Built component is not the explicit arm64 release target')


def verify_app(app, args, identity, profiles):
    extension = app / 'Contents/Library/SystemExtensions' / (EXT_ID + '.systemextension')
    agent = app / 'Contents/MacOS/vibtra-guard'
    for bundle_id, bundle in ((EXT_ID, extension), (APP_ID, app)):
        try:
            info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        except Exception:
            raise ReleaseError('Built bundle lacks a readable Info.plist') from None
        name = info.get('CFBundleExecutable', '')
        if info.get('CFBundleIdentifier') != bundle_id or not name or Path(name).name != name:
            raise ReleaseError('Built bundle identity/executable mismatch')
        verify_signed_component(bundle, bundle / 'Contents/MacOS' / name, args.team, identity)
        raw, _ = run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(bundle)])
        try:
            actual = plistlib.loads(raw)
        except Exception:
            raise ReleaseError('Built entitlements unavailable') from None
        for key, value in requested_entitlements(bundle_id, args.team).items():
            if actual.get(key, False if value is False else None) != value:
                raise ReleaseError('Built entitlements do not match release source')
        for key in ('get-task-allow', 'com.apple.security.get-task-allow', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.cs.allow-unsigned-executable-memory'):
            if actual.get(key):
                raise ReleaseError('Built release has an unexpected debug/security exception')
        profile = read_profile(bundle / 'Contents/embedded.provisionprofile')
        uuid = validate_profile(profile, bundle_id, args.team, identity, requested_entitlements(bundle_id, args.team))
        if uuid != profiles[bundle_id]:
            raise ReleaseError('Built bundle embeds a different provisioning profile')
    verify_signed_component(agent, agent, args.team, identity)


def build(args, identity, profiles):
    if args.out.is_symlink():
        raise ReleaseError("Release output must not be a symlink")
    output = args.out.resolve()
    if output.exists():
        raise ReleaseError('Release output must be a new directory; existing artifacts are not overwritten')
    output.mkdir(mode=0o700, parents=False)
    binary = output / 'vibtra-guard-arm64'
    env = clean_env()
    env.update(GOOS='darwin', GOARCH='arm64', CGO_ENABLED='0')
    run(['go', 'build', '-mod=readonly', '-trimpath', '-o', str(binary), '.'], cwd=HERE.parent / 'agent-go', env=env, log=output / 'go-build.log', timeout=600)
    run(['xcodegen', 'generate', '--spec', str(HERE / 'project.yml'), '--project', str(HERE)], log=output / 'xcodegen.log')
    env = clean_env()
    env['VIBTRA_GUARD_AGENT_BIN'] = str(binary)
    command = ['xcodebuild', '-project', str(HERE / 'VibtraGuard.xcodeproj'), '-scheme', 'VibtraGuard', '-configuration', 'Release', '-destination', 'generic/platform=macOS',
               'CODE_SIGN_STYLE=Manual', 'CODE_SIGN_IDENTITY=' + identity, 'DEVELOPMENT_TEAM=' + args.team, 'GUARD_TEAM_ID=' + args.team, 'ENABLE_HARDENED_RUNTIME=YES', 'OTHER_CODE_SIGN_FLAGS=--timestamp', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO', 'CODE_SIGN_INJECT_BASE_ENTITLEMENTS=NO',
               'GUARD_APP_PROFILE_UUID=' + profiles[APP_ID], 'GUARD_EXTENSION_PROFILE_UUID=' + profiles[EXT_ID], 'SYMROOT=' + str(output / 'products'), 'OBJROOT=' + str(output / 'objects'), 'build']
    run(command, env=env, log=output / 'xcodebuild.log', timeout=1800)
    app = output / 'products/Release/VibtraGuard.app'
    verify_app(app, args, identity, profiles)
    archive = output / 'VibtraGuard-arm64.zip'
    run(['/usr/bin/ditto', '-c', '-k', '--keepParent', str(app), str(archive)], log=output / 'package.log', timeout=300)
    digest = hashlib.sha256()
    with archive.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    with open(output / (archive.name + '.sha256'), 'x') as handle:
        handle.write(f'{digest.hexdigest()}  {archive.name}\n')
    report = {'status': 'developer-id-prepared-not-notarized', 'architecture': 'arm64', 'minimumMacOS': minimum_macos(), 'team': args.team, 'notarized': False, 'installed': False,
              'archive': archive.name, 'archiveSha256': digest.hexdigest(), 'checksumFile': archive.name + '.sha256'}
    with open(output / 'release-report.json', 'x') as handle:
        os.chmod(handle.name, 0o600)
        json.dump(report, handle, indent=2)
        handle.write('\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('preflight', 'build'))
    parser.add_argument('--team', default=TEAM)
    parser.add_argument('--identity', help='Optional exact Developer ID identity SHA1 (public identifier, never a private key)')
    parser.add_argument('--app-profile', type=Path, help='Already-installed Developer ID app .provisionprofile')
    parser.add_argument('--extension-profile', type=Path, help='Already-installed Developer ID extension .provisionprofile')
    parser.add_argument('--out', type=Path, help='New output directory; required for build')
    args = parser.parse_args()
    if args.action == 'build' and args.out is None:
        parser.error('--out is required for build')
    try:
        if args.action == 'preflight':
            report = preflight_report(args)
            print(json.dumps(report, indent=2))
            if report['blockedOnCode'] or report['blockedOnFounder']:
                lines = ['Release not ready. Founder must provision:'] + ['  - ' + a for a in report['founderActions']]
                if report['blockedOnCode']:
                    lines.insert(0, 'Failing checks that are not founder items: ' + ', '.join(report['blockedOnCode']))
                parser.exit(1, '\n'.join(lines) + '\n')
            return
        identity, profiles = preflight(args)
        report = build(args, identity, profiles)
        print(json.dumps(report, indent=2))
    except ReleaseError as error:
        parser.exit(1, 'Release refused: ' + str(error) + '\n')
    except OSError:
        parser.exit(1, 'Release refused: local artifact/profile I/O failed; no fallback attempted\n')


if __name__ == '__main__':
    main()
