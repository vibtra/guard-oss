// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function allowedGuardRoute(method, url) {
  if (method === 'POST' && url === '/api/guard/v1/enrol') return true;
  return (method === 'POST' && /^\/api\/guard\/v1\/(preflight|ruledownload|eventupload|postflight|requests)\/gdev_[a-f0-9]{16}$/.test(url)) ||
    (method === 'GET' && /^\/api\/guard\/v1\/requests\/gdev_[a-f0-9]{16}$/.test(url));
}

export function validateBinding(host, interfaceName, interfaces = os.networkInterfaces()) {
  assert.equal(net.isIP(host), 4, 'Use one explicit IPv4 address');
  if (host === '127.0.0.1') return;
  assert.match(interfaceName ?? '', /^bridge[0-9]+$/, 'Guest transport requires an explicit NAT bridge interface');
  assert.ok(/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host), 'Only private NAT addresses are accepted');
  assert.ok(interfaces[interfaceName]?.some(row => row.address === host && !row.internal), 'Address must belong to the selected local NAT bridge');
}

export function prepareGateway(directory, host, interfaceName) {
  validateBinding(host, interfaceName);
  const out = path.resolve(directory);
  mkdirSync(out, { mode: 0o700 });
  const file = name => path.join(out, name);
  const openssl = args => execFileSync('/usr/bin/openssl', args, { stdio: 'pipe' });
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Guard isolated guest registry test CA', '-keyout', file('ca.key'), '-out', file('ca.pem'), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Guard isolated guest registry', '-keyout', file('server.key'), '-out', file('server.csr')]);
  writeFileSync(file('server.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${host}\n`, { mode: 0o600 });
  openssl(['x509', '-req', '-days', '2', '-in', file('server.csr'), '-CA', file('ca.pem'), '-CAkey', file('ca.key'), '-CAcreateserial', '-extfile', file('server.ext'), '-out', file('server.pem')]);
  for (const name of ['ca.key', 'ca.pem', 'ca.srl', 'server.key', 'server.csr', 'server.ext', 'server.pem']) chmodSync(file(name), 0o600);
  writeFileSync(file('preparation.json'), JSON.stringify({ status: 'prepared-not-listening-not-enrolled', host, interfaceName: interfaceName ?? null, expiresInDays: 2, guestTrustApproved: false }, null, 2) + '\n', { mode: 0o600 });
  return { key: readFileSync(file('server.key')), cert: readFileSync(file('server.pem')), ca: readFileSync(file('ca.pem')) };
}

export function createGateway({ key, cert, inject }) {
  assert.equal(typeof inject, 'function');
  const server = https.createServer({ key, cert, minVersion: 'TLSv1.2', requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    const refuse = code => { res.writeHead(code, { 'content-type': 'application/json', 'connection': 'close' }); res.end('{"code":"TEST_GATEWAY_REFUSED"}'); };
    if (!allowedGuardRoute(req.method, req.url)) { refuse(404); req.resume(); return; }
    if (req.headers['content-encoding'] || (req.headers['content-length'] && Number(req.headers['content-length']) > 1024 * 1024)) { refuse(413); req.resume(); return; }
    try {
      const parts = []; let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 1024 * 1024) { refuse(413); return; }
        parts.push(part);
      }
      const headers = { accept: 'application/json' };
      for (const name of ['authorization', 'content-type']) if (req.headers[name]) headers[name] = req.headers[name];
      const reply = await inject({ method: req.method, url: req.url, headers, payload: Buffer.concat(parts) });
      res.writeHead(reply.statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(reply.body);
    } catch { if (!res.headersSent) refuse(502); else res.destroy(); }
  });
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  return server;
}

export async function listenGateway(server, { host, interfaceName, port }) {
  validateBinding(host, interfaceName);
  assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server.address().port;
}
