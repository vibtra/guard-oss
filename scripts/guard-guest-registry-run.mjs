// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import { parseArgs } from 'node:util';
import { runGuestRegistry } from './lib/guard-guest-lifecycle.mjs';
try {
  const { values } = parseArgs({ options: { 'guest-ready': { type: 'boolean' }, out: { type: 'string' }, host: { type: 'string' }, interface: { type: 'string' }, port: { type: 'string' }, 'source-profile': { type: 'string' }, 'admin-port': { type: 'string' } } });
  if (!values['guest-ready'] || !values.out || !values.host || !values.interface || !values['source-profile'] || !values.port || values.host === '127.0.0.1') throw new Error('Explicit guest activation options required');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Explicit unprivileged port required');
  const adminPort = values['admin-port'] === undefined ? undefined : Number(values['admin-port']);
  if (adminPort !== undefined && (!Number.isInteger(adminPort) || adminPort < 1024 || adminPort > 65535)) throw new Error('Explicit unprivileged admin port required');
  await runGuestRegistry({ guestReady: true, out: values.out, host: values.host, interfaceName: values.interface, port, sourceProfile: values['source-profile'], adminPort });
} catch {
  console.error('Guest registry refused or stopped after a startup failure. Check readiness, private preparation, valid certificates, source signatures, bridge address and free port. No fallback was attempted.');
  process.exitCode = 1;
}
