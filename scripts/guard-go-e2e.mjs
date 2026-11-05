import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { startGuardBed } from '../apps/registry/test/guard-bed.ts';
import { GUARD_STARTER_CONTENT_RULES } from '../packages/guard-contract/src/index.ts';
import { consoleSession, consoleWrite, consoleGet } from '../apps/registry/test/helpers/console.ts';
const temp = mkdtempSync(path.join(os.tmpdir(), 'guard-go-e2e-'));
const bin = path.join(temp, 'vibtra-guard');
const out = process.env.GUARD_GO_E2E_OUT;
const env = { ...process.env, VIBTRA_GUARD_DIR: path.join(temp, 'agent') };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = new Set();
const launch = (command, args, options) => { const child = spawn(command, args, options); children.add(child); child.once('exit', () => children.delete(child)); return child; };
const stop = async child => { if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return; await new Promise(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); }); };
const command = (command, args, options) => new Promise((resolve, reject) => { let stderr = ''; const child = launch(command, args, options); child.stderr?.on('data', b => stderr += b); const timer = setTimeout(() => child.kill('SIGKILL'), 180000); child.once('error', e => { clearTimeout(timer); reject(e); }); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${args[0]} failed (${code}): ${stderr.slice(0, 500)}`)); }); });
const cli = args => command(bin, args, { env, stdio: ['ignore', 'ignore', 'pipe'] });
const listen = (server, port = 0) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); }); });
const close = server => !server?.listening ? Promise.resolve() : new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
let demo, agent, gateway, mock, proxy, local, registryPort;
const results = [];
let originRequests = 0;
const step = async (name, fn) => { await fn(); results.push({ name, passed: true }); console.log('[guard-go-e2e] PASS ' + name); };
const write = async (method, p, body) => consoleWrite(demo.registry, method, p, await consoleSession(demo.registry, demo.people.bo.cookie), body);
const proxied = body => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: proxy, path: 'http://chatgpt.com/backend-api/conversation', method: 'POST', headers: { 'content-type': 'application/json', host: 'chatgpt.com' } }, res => { let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) })); }); r.setTimeout(5000, () => r.destroy(new Error('proxy timeout'))); r.on('error', reject); r.end(JSON.stringify({ messages: [{ content: { parts: [body] } }] })); });
const visit = host => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port: proxy, path: `http://${host}/`, method: 'GET', headers: { host, accept: 'application/json' } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); }); r.setTimeout(5000, () => r.destroy(new Error('proxy timeout'))); r.on('error', reject); r.end(); });
const serviceRule = { ruleId: 'gsr_0000b4b4', serviceId: 'deepseek', audience: { kind: 'org' }, action: 'block', enabled: true };
const serviceRuleUploaded = async action => { await cli(['sync']); const d = JSON.parse(disk('device.json'));
    const rows = JSON.parse((await consoleGet(demo.registry, `/guard/activity?deviceId=${d.deviceId}&serviceId=deepseek&limit=200`, demo.people.ada.cookie)).body).rows;
    assert.ok(rows.some(r => r.action === action && r.ruleKind === 'service' && r.ruleId === serviceRule.ruleId), `service-rule ${action} event absent from registry activity`);
    assert.ok(!queue().some(e => e.serviceId === 'deepseek'), 'service-rule event still queued');
    const overview = JSON.parse((await consoleGet(demo.registry, '/guard/overview?days=7', demo.people.ada.cookie)).body);
    assert.ok(overview.services.some(s => s.serviceId === 'deepseek'), 'service-rule event absent from overview services');
    return overview; };
const disk = name => readFileSync(path.join(env.VIBTRA_GUARD_DIR, name), 'utf8');
const queue = () => disk('events.jsonl').trim().split('\n').filter(Boolean).map(JSON.parse);
async function startAgent() {
  agent = launch(bin, ['run', '--proxy', '127.0.0.1:0', '--local', '127.0.0.1:0', '--upstream-map', `chatgpt.com=${demo.urls.mockAi},chat.deepseek.com=${demo.urls.mockAi}`, '--sync-every', '1'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise((resolve, reject) => {
    let log = ''; const timer = setTimeout(() => reject(new Error('daemon startup timeout')), 10000);
    const exited = () => { clearTimeout(timer); reject(new Error('daemon exited before listening')); };
    agent.once('exit', exited); agent.once('error', reject);
    agent.stderr.on('data', b => { log = (log + b).slice(-4096); const match = log.match(/proxy http:\/\/127\.0\.0\.1:(\d+) · local pages http:\/\/127\.0\.0\.1:(\d+)/); if (match) { proxy = Number(match[1]); local = Number(match[2]); clearTimeout(timer); agent.removeListener('exit', exited); resolve(); } });
  });
  assert.equal((await fetch(`http://127.0.0.1:${local}/healthz`)).status, 200);
}
try {
    await command('go', ['build', '-o', bin, '.'], { cwd: path.resolve('guard/agent-go'), stdio: ['ignore', 'ignore', 'pipe'] });
    demo = await startGuardBed('go-e2e.example', { dataDir: path.join(temp, 'registry') });
    mock = http.createServer((req, res) => { originRequests++; req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    const mockPort = await listen(mock);
    gateway = http.createServer(async (req, res) => { try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const reply = await demo.registry.app.inject({ method: req.method, url: req.url, headers: req.headers, payload: Buffer.concat(chunks) }); res.writeHead(reply.statusCode, reply.headers); res.end(reply.rawPayload); } catch { res.writeHead(500); res.end(); } });
    registryPort = await listen(gateway);
    demo.urls = { registry: `http://127.0.0.1:${registryPort}`, mockAi: `http://127.0.0.1:${mockPort}` };
    assert.equal((await write('PUT', '/guard/settings', { clientMode: 'enforce' })).statusCode, 200);
    assert.equal((await write('PUT', '/guard/rules', { baseVersion: 0, document: { defaultAction: 'allow', serviceRules: [serviceRule], contentRules: GUARD_STARTER_CONTENT_RULES.map(rule => ({ ...rule, services: '*', audience: { kind: 'org' }, enabled: true })) } })).statusCode, 200);
    await step('enrol and activate registry-signed policy', async () => { const response = await write('POST', '/guard/devices/enrol-links', { personEmail: demo.people.ada.email, note: 'Disposable Go integration' }); assert.equal(response.statusCode, 201); await cli(['enrol', '--server', demo.urls.registry, '--token', JSON.parse(response.body).token]); assert.ok(JSON.parse(disk('device.json')).signing.publicKeyPem); assert.ok(disk('bundle.json').length); });
    await startAgent();
    await step('offline daemon restart retains signed policy, identity, CA and queued events', async () => {
        await close(gateway);
        await assert.rejects(fetch(demo.urls.registry), 'registry transport must be unavailable');
        const beforeOrigin = originRequests;
        const first = await proxied('My TFN is 123 456 782'); assert.equal(first.status, 403);
        await stop(agent);
        const identity = disk('device.json'), cert = disk('ca.pem'), key = disk('ca.key');
        const ids = queue().map(e => e.eventId); assert.ok(ids.includes(first.body.eventId));
        await startAgent();
        assert.equal(disk('device.json'), identity); assert.equal(disk('ca.pem'), cert); assert.equal(disk('ca.key'), key);
        for (const id of ids) assert.ok(queue().some(e => e.eventId === id));
        const retry = await proxied('My TFN is 123 456 782'); assert.equal(retry.status, 403); assert.equal(retry.body.code, 'GUARD_BLOCKED');
        assert.equal(originRequests, beforeOrigin, 'offline blocked requests reached mock origin');
        await listen(gateway, registryPort);
        await cli(['sync']);
        const device = JSON.parse(disk('device.json'));
        const activity = JSON.parse((await consoleGet(demo.registry, `/guard/activity?deviceId=${device.deviceId}&limit=200`, demo.people.ada.cookie)).body).rows;
        for (const id of [...ids, retry.body.eventId]) { assert.ok(activity.some(e => e.eventId === id), 'offline event absent from registry'); assert.ok(!queue().some(e => e.eventId === id), 'acknowledged event remains queued'); }
    });
    let block, requestId;
    await step('TFN is blocked with metadata-only activity', async () => { const beforeOrigin = originRequests; block = await proxied('My TFN is 123 456 782'); assert.equal(originRequests, beforeOrigin, 'blocked request reached mock origin'); assert.equal(block.status, 403); assert.equal(block.body.code, 'GUARD_BLOCKED'); assert.ok(block.body.ruleId); const activity = await fetch(`http://127.0.0.1:${local}/activity`).then(r => r.json()); assert.ok(activity.events.some(e => e.matchType === 'au-tfn')); assert.ok(!JSON.stringify(activity).includes('123 456 782')); });
    await step('request access reaches the policy desk', async () => { const res = await fetch(`http://127.0.0.1:${local}/blocked/${block.body.eventId}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'Synthetic integration test' }) }); const json = await res.json(); assert.equal(res.status, 200, JSON.stringify(json)); requestId = json.request.requestId; assert.ok(requestId); });
    await step('approval sync applies a scoped exception and retry passes', async () => { const res = await write('POST', `/policy-requests/${requestId}/approve`, { grant: { days: 7 } }); assert.equal(res.statusCode, 200, res.body); await cli(['sync']); for (let i = 0; i < 40; i++) {
        const retry = await proxied('My TFN is 123 456 782');
        if (retry.status === 200) { assert.ok(originRequests > 0, 'allowed request never reached mock origin'); return; }
        await sleep(150);
    } assert.fail('approved grant never became active'); });
    await step('events upload through strict registry schema', async () => { await cli(['sync']); const d = JSON.parse(readFileSync(path.join(env.VIBTRA_GUARD_DIR, 'device.json'), 'utf8')); const res = await consoleGet(demo.registry, `/guard/activity?deviceId=${d.deviceId}&limit=200`, demo.people.ada.cookie); const rows = JSON.parse(res.body).rows; for (const action of ['blocked', 'requested', 'allowed'])
        assert.ok(rows.some(r => r.action === action), `missing ${action}`); assert.ok(!JSON.stringify(rows).includes('123 456 782')); });
    await step('enforce: service-rule block uploads and shows in activity and overview', async () => { const beforeOrigin = originRequests; const res = await visit('chat.deepseek.com'); assert.equal(res.status, 403); assert.equal(originRequests, beforeOrigin, 'blocked service reached mock origin');
        const overview = await serviceRuleUploaded('blocked'); assert.ok(overview.topBlocks.some(b => b.ruleId === serviceRule.ruleId && b.kind === 'service'), 'service rule absent from overview top blocks'); });
    await step('monitor records a block without refusing the request', async () => { const res = await write('PUT', '/guard/settings', { clientMode: 'monitor' }); assert.equal(res.statusCode, 200, res.body); await cli(['sync']); for (let i = 0; i < 40; i++) {
        const retry = await proxied('Payment card 4242 4242 4242 4242');
        if (retry.status === 200 && retry.headers['x-vibtra-guard']?.startsWith('would-block'))
            return;
        await sleep(150);
    } assert.fail('monitor mode not applied'); });
    await step('monitor: service-rule would-block uploads and shows in activity and overview', async () => { const res = await visit('chat.deepseek.com'); assert.equal(res.status, 200); assert.ok(res.headers['x-vibtra-guard']?.startsWith('would-block'), 'monitor did not mark the service rule'); await serviceRuleUploaded('observed'); });
    await step('revocation stops decryption and enforcement', async () => { const d = JSON.parse(readFileSync(path.join(env.VIBTRA_GUARD_DIR, 'device.json'), 'utf8')); const res = await write('POST', `/guard/devices/${d.deviceId}/revoke`, {}); assert.equal(res.statusCode, 200, res.body); await cli(['sync']).catch(() => { }); for (let i = 0; i < 40; i++) {
        const status = await fetch(`http://127.0.0.1:${local}/status`).then(r => r.json());
        if (status.revoked) {
            assert.equal(status.enrolled, false);
            assert.equal(status.bundleVersion, undefined);
            return;
        }
        ;
        await sleep(150);
    } assert.fail('revocation not applied'); });
    await step('revoked daemon restart remains revoked while registry is offline', async () => {
        await close(gateway); await assert.rejects(fetch(demo.urls.registry)); await stop(agent); const cert = disk('ca.pem');
        await startAgent(); const status = await fetch(`http://127.0.0.1:${local}/status`).then(r => r.json());
        assert.equal(status.revoked, true); assert.equal(status.enrolled, false); assert.equal(status.bundleVersion, undefined); assert.equal(disk('ca.pem'), cert);
    });
    if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), implementation: 'Go/uTLS', results }, null, 2) + '\n', { mode: 0o600 });
} finally {
    for (const child of children) await stop(child);
    try { await close(gateway); } finally {
        try { await close(mock); } finally {
            try { if (demo) await demo.registry.app.close(); }
            finally { rmSync(temp, { recursive: true, force: true }); }
        }
    }
}
