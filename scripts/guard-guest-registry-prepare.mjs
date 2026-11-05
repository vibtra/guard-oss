// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import { parseArgs } from 'node:util';
import { prepareGateway } from './lib/guard-guest-gateway.mjs';
const { values } = parseArgs({ options: { out: { type: 'string' }, host: { type: 'string' }, interface: { type: 'string' } } });
if (!values.out || !values.host) throw new Error('Required: --out NEW_PRIVATE_DIRECTORY --host NAT_BRIDGE_IP --interface bridgeN');
prepareGateway(values.out, values.host, values.interface);
console.log('Prepared two-day test TLS material in the private output directory. No listener, enrollment token, or trust change was created.');
