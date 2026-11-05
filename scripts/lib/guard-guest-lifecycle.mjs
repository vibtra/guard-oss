// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import assert from 'node:assert/strict';
import { X509Certificate, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { read, startGuardBed, write } from '../../apps/registry/test/guard-bed.ts';
import { applyGuestSourcePolicy } from './guard-guest-policy.mjs';
import { createGateway, listenGateway, validateBinding } from './guard-guest-gateway.mjs';

const defaults = {
  createRegistry: dataDir => startGuardBed('isolated-guest.example', { dataDir }),
  applyPolicy: (bed, source) => applyGuestSourcePolicy({ ...source, write: (method, route, body) => write(bed.registry, bed.people.ada, method, route, body) }),
  mint: bed => write(bed.registry, bed.people.ada, 'POST', '/guard/devices/enrol-links', { personEmail: bed.people.ada.email, note: 'Explicit isolated guest acceptance session' }),
  admin: (bed, method, route, body) => (method === 'GET' ? read(bed.registry, bed.people.ada, route) : write(bed.registry, bed.people.ada, method, route, body)),
};

const ADMIN_DOORS = [
  ['GET', /^\/guard\/(rules|devices|services|settings|overview)$/], ['GET', /^\/guard\/activity(\?[\w=&%.-]*)?$/],
  ['PUT', /^\/guard\/(rules|settings)$/], ['PUT', /^\/guard\/services\/[a-z0-9-]+$/], ['POST', /^\/guard\/devices\/enrol-links$/],
];
export function createAdminChannel({ secret, call }) {
  const expected = Buffer.from(`Bearer ${secret}`);
  return http.createServer(async (req, res) => {
    const send = (status, json) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(json)); };
    const given = Buffer.from(req.headers.authorization ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return send(401, { error: 'unauthorized' });
    if (!ADMIN_DOORS.some(([method, route]) => method === req.method && route.test(req.url ?? ''))) return send(404, { error: 'not an admin door' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1 << 20) return send(413, { error: 'too large' }); }
    try { const result = await call(req.method, req.url, raw ? JSON.parse(raw) : undefined); send(result.status, result.json); }
    catch { send(400, { error: 'bad request' }); }
  });
}

export async function startGuestRegistry(options, dependencies = {}) {
  assert.equal(options.guestReady, true, 'Explicit guest-ready activation is required');
  validateBinding(options.host, options.interfaceName);
  const out = path.resolve(options.out);
  const info = lstatSync(out);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && info.uid === process.getuid(), 'Prepared output must be a private directory owned by this user');
  const read = name => readFileSync(path.join(out, name));
  const prepared = JSON.parse(read('preparation.json'));
  assert.equal(prepared.host, options.host, 'Prepared TLS host differs');
  assert.equal(prepared.interfaceName, options.interfaceName ?? null, 'Prepared bridge differs');
  const cert = read('server.pem');
  const certificate = new X509Certificate(cert);
  assert.equal(certificate.checkIP(options.host), options.host, 'TLS certificate IP mismatch');
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(), 'Prepared TLS certificate is not currently valid');
  const keyInfo = lstatSync(path.join(out, 'server.key'));
  assert.ok(keyInfo.isFile() && !keyInfo.isSymbolicLink() && (keyInfo.mode & 0o077) === 0, 'Server key must be private');
  const key = read('server.key');
  const sourceRead = name => JSON.parse(readFileSync(path.join(options.sourceProfile, name), 'utf8'));
  const source = { sourceDevice: sourceRead('device.json'), sourceBundle: sourceRead('bundle.json'), sourceCatalogue: sourceRead('catalogue.json') };
  const runtime = path.join(out, 'session');
  mkdirSync(runtime, { mode: 0o700 });
  const deps = { ...defaults, ...dependencies };
  let bed, server, admin, closing;
  const close = () => closing ??= (async () => {
    try {
      for (const listener of [server, admin]) if (listener?.listening) await new Promise(resolve => { listener.closeAllConnections(); listener.close(resolve); });
    } finally {
      try { if (bed) await bed.registry.app.close(); }
      finally { rmSync(runtime, { recursive: true, force: true }); }
    }
  })();
  try {
    bed = await deps.createRegistry(path.join(runtime, 'registry'));
    await deps.applyPolicy(bed, source);
    server = createGateway({ key, cert, inject: request => bed.registry.app.inject(request) });
    const port = await listenGateway(server, options);
    const link = await deps.mint(bed);
    assert.equal(link.status, 201, 'Fresh enrollment creation failed');
    assert.match(link.json.token, /^genr_[a-f0-9]{32}$/, 'Fresh enrollment format invalid');
    const endpoint = `https://${options.host}:${port}`;
    writeFileSync(path.join(runtime, 'enrollment.json'), JSON.stringify({ server: endpoint, token: link.json.token, command: ['vibtra-guard', 'enrol', '--server', endpoint, '--token', link.json.token] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(path.join(runtime, 'status.json'), JSON.stringify({ status: 'awaiting-guest-enrollment', endpoint, guestTrustVerified: false, hostPolicyChanged: false }) + '\n', { mode: 0o600, flag: 'wx' });
    let adminUrl;
    if (options.adminPort !== undefined) {
      const secret = randomBytes(24).toString('hex');
      admin = createAdminChannel({ secret, call: (method, route, body) => deps.admin(bed, method, route, body) });
      await new Promise((resolve, reject) => { admin.once('error', reject); admin.listen(options.adminPort, '127.0.0.1', resolve); });
      adminUrl = `http://127.0.0.1:${admin.address().port}`;
      writeFileSync(path.join(runtime, 'admin.json'), JSON.stringify({ url: adminUrl, authorization: `Bearer ${secret}` }) + '\n', { mode: 0o600, flag: 'wx' });
    }
    return { endpoint, adminUrl, close };
  } catch (error) { await close(); throw error; }
}

export async function runGuestRegistry(options, { start = startGuestRegistry, signals = process, log = console.log } = {}) {
  let requested = false, wake;
  const stop = () => { requested = true; wake?.(); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  let session;
  try {
    session = await start(options);
    if (!requested) {
      log('Guest test registry active. Enrollment instructions exist only in the private session/enrollment.json file.');
      await new Promise(resolve => { wake = resolve; if (requested) resolve(); });
    }
  } finally {
    try { if (session) await session.close(); }
    finally { signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop); }
  }
}
