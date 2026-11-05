#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
"""Resolve the Mac client's identity: the team and bundle identifiers it is built and signed under.

Config/Identity.xcconfig holds the defaults. Config/Identity.local.xcconfig (git-ignored, included by
Identity.xcconfig) sets this checkout's own identity. GUARD_TEAM_ID, GUARD_APP_ID and GUARD_EXTENSION_ID in the
environment override both for one build: build.sh writes them to Config/Identity.local.xcconfig for that build and
puts the file back after. The app group, the extension's Mach service and the agent's signing identifier are derived
the same way project.yml derives them for Xcode.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import sys

MAC = Path(__file__).resolve().parents[1]
XCCONFIG = MAC / 'Config' / 'Identity.xcconfig'
LOCAL = 'Identity.local.xcconfig'
INPUTS = ('GUARD_TEAM_ID', 'GUARD_APP_ID', 'GUARD_EXTENSION_ID')
TEAM = re.compile(r'[A-Z0-9]{10}')
BUNDLE_ID = re.compile(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+')


class IdentityError(Exception):
    pass


def settings(path):
    values = {}
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('#include'):
            continue
        name, sep, value = line.partition('=')
        if not sep:
            raise IdentityError(f'{Path(path).name}: not a NAME = VALUE line: {line}')
        values[name.strip()] = value.strip()
    return values


def defaults(path=XCCONFIG):
    path = Path(path)
    values = settings(path)
    local = path.with_name(LOCAL)
    if local.is_file():
        values.update({name: value for name, value in settings(local).items() if name in INPUTS and value})
    missing = [name for name in INPUTS if not values.get(name)]
    if missing:
        raise IdentityError(f'{Path(path).name} lacks ' + ', '.join(missing))
    return {name: values[name] for name in INPUTS}


def derive(team, app_id, extension_id):
    if not TEAM.fullmatch(team or ''):
        raise IdentityError('GUARD_TEAM_ID must be a 10-character Apple team identifier (A-Z, 0-9)')
    for name, value in (('GUARD_APP_ID', app_id), ('GUARD_EXTENSION_ID', extension_id)):
        if not BUNDLE_ID.fullmatch(value or '') or len(value) > 155:
            raise IdentityError(f'{name} must be a reverse-DNS bundle identifier (letters, digits, hyphens, dots)')
    if app_id == extension_id:
        raise IdentityError('GUARD_APP_ID and GUARD_EXTENSION_ID must differ')
    return {
        'GUARD_TEAM_ID': team,
        'GUARD_APP_ID': app_id,
        'GUARD_EXTENSION_ID': extension_id,
        'GUARD_APP_GROUP': team + '.' + app_id,
        'GUARD_EXTENSION_MACH_SERVICE': team + '.' + extension_id + '.xpc',
        'GUARD_AGENT_SIGNING_ID': app_id + '.agent',
    }


def resolve(env=None, path=XCCONFIG):
    env = os.environ if env is None else env
    values = defaults(path)
    for name in INPUTS:
        if env.get(name):
            values[name] = env[name]
    return derive(values['GUARD_TEAM_ID'], values['GUARD_APP_ID'], values['GUARD_EXTENSION_ID'])


def expand(value, identity):
    if isinstance(value, str):
        return re.sub(r'\$\((GUARD_[A-Z_]+)\)', lambda m: identity[m.group(1)], value)
    if isinstance(value, list):
        return [expand(item, identity) for item in value]
    if isinstance(value, dict):
        return {key: expand(item, identity) for key, item in value.items()}
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--format', choices=('json', 'shell', 'xcconfig'), default='json')
    args = parser.parse_args()
    try:
        identity = resolve()
    except IdentityError as error:
        parser.exit(2, 'identity: ' + str(error) + '\n')
    if args.format == 'json':
        print(json.dumps(identity, indent=2))
    elif args.format == 'shell':
        print('\n'.join(f'{name}={shlex.quote(value)}' for name, value in identity.items()))
    else:
        print('\n'.join(f'{name} = {identity[name]}' for name in INPUTS))


if __name__ == '__main__':
    sys.exit(main())
