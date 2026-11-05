#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
"""Write a device-management profile (.mobileconfig) that pre-approves one Guard build on managed Macs.

The identifiers come from tools/identity.py (Config/Identity.xcconfig, Config/Identity.local.xcconfig, GUARD_*
variables) or from --team, --app-id and --extension-id. The profile holds three payloads from Apple's Device
Management reference: com.apple.system-extension-policy (allow the extension), com.apple.webcontent-filter (the content
filter the app turns on) and com.apple.notificationsettings (block notices). Upload it unsigned to Jamf Pro, Kandji or
Intune; the MDM signs and delivers it. System extension policy is honoured only from an MDM with user-approved or
automated enrolment, not from a profile a person installs by hand.
"""
import argparse
import plistlib
import sys
import uuid

sys.dont_write_bytecode = True
import identity as guard_identity

NAMESPACE = uuid.UUID('6f1c2f5e-55c8-4bf7-9f0e-2a4e0d6b8c11')


def designated_requirement(bundle_id, team):
    return ('anchor apple generic and identifier "' + bundle_id + '" and (certificate leaf[field.1.2.840.113635.100.6.1.9] exists'
            ' or certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
            ' and certificate leaf[subject.OU] = "' + team + '")')


def payload_uuid(*parts):
    return str(uuid.uuid5(NAMESPACE, '/'.join(parts))).upper()


def build_profile(identity, organization, allow_removal=False):
    team = identity['GUARD_TEAM_ID']
    app_id = identity['GUARD_APP_ID']
    ext_id = identity['GUARD_EXTENSION_ID']
    root = app_id + '.mdm'

    def payload(kind, name, body):
        entry = {'PayloadType': kind, 'PayloadVersion': 1, 'PayloadIdentifier': root + '.' + name,
                 'PayloadUUID': payload_uuid(team, app_id, ext_id, kind), 'PayloadDisplayName': 'Vibtra Guard: ' + name}
        entry.update(body)
        return entry

    extensions = {'AllowedSystemExtensions': {team: [ext_id]},
                  'AllowedSystemExtensionTypes': {team: ['NetworkExtension']}}
    if allow_removal:
        extensions['RemovableSystemExtensions'] = {team: [ext_id]}
    content = [
        payload('com.apple.system-extension-policy', 'system-extension', extensions),
        payload('com.apple.webcontent-filter', 'content-filter', {
            'FilterType': 'Plugin', 'UserDefinedName': 'Vibtra Guard', 'PluginBundleID': app_id,
            'FilterSockets': True, 'FilterPackets': False, 'FilterGrade': 'firewall',
            'FilterDataProviderBundleIdentifier': ext_id,
            'FilterDataProviderDesignatedRequirement': designated_requirement(ext_id, team)}),
        payload('com.apple.notificationsettings', 'notifications', {'NotificationSettings': [{
            'BundleIdentifier': app_id, 'NotificationsEnabled': True, 'AlertType': 1, 'ShowInNotificationCenter': True,
            'ShowInLockScreen': True, 'BadgesEnabled': False, 'SoundsEnabled': False, 'CriticalAlertEnabled': False}]}),
    ]
    return {
        'PayloadType': 'Configuration', 'PayloadVersion': 1, 'PayloadScope': 'System',
        'PayloadIdentifier': root, 'PayloadUUID': payload_uuid(team, app_id, ext_id, 'Configuration'),
        'PayloadDisplayName': 'Vibtra Guard (' + team + ')', 'PayloadOrganization': organization,
        'PayloadDescription': 'Allows the Vibtra Guard network extension ' + ext_id + ' from team ' + team
                              + ', its content filter, and its block notices.',
        'PayloadContent': content,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--team', help='Apple team ID that signs the build (default: the configured identity)')
    parser.add_argument('--app-id', help='App bundle ID (default: the configured identity)')
    parser.add_argument('--extension-id', help='System extension bundle ID (default: the configured identity)')
    parser.add_argument('--organization', default='Vibtra Guard', help='Shown as the profile organisation')
    parser.add_argument('--allow-removal', action='store_true',
                        help='Let people remove the extension without an administrator (RemovableSystemExtensions)')
    parser.add_argument('--out', required=True, help='Where to write the .mobileconfig; an existing file is not replaced')
    args = parser.parse_args()
    try:
        configured = guard_identity.resolve()
        identity = guard_identity.derive(args.team or configured['GUARD_TEAM_ID'], args.app_id or configured['GUARD_APP_ID'],
                                         args.extension_id or configured['GUARD_EXTENSION_ID'])
    except guard_identity.IdentityError as error:
        parser.exit(2, 'mdm-profile: ' + str(error) + '\n')
    if not args.organization.strip() or len(args.organization) > 200:
        parser.exit(2, 'mdm-profile: --organization must be 1 to 200 characters\n')
    data = plistlib.dumps(build_profile(identity, args.organization.strip(), args.allow_removal), sort_keys=True)
    try:
        with open(args.out, 'xb') as handle:
            handle.write(data)
    except FileExistsError:
        parser.exit(1, 'mdm-profile: ' + args.out + ' exists; choose a new path\n')
    print('wrote ' + args.out + ' for team ' + identity['GUARD_TEAM_ID'] + ', app ' + identity['GUARD_APP_ID']
          + ', extension ' + identity['GUARD_EXTENSION_ID'])


if __name__ == '__main__':
    sys.exit(main())
