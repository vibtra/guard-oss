// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import assert from 'node:assert/strict';
import { digestOf, verifyGuardBundle, verifyGuardCatalogue } from '../../packages/guard-contract/src/signing.ts';
export async function applyGuestSourcePolicy({ sourceDevice, sourceBundle, sourceCatalogue, write }) {
  assert.ok(verifyGuardBundle(sourceBundle, sourceDevice.signing.publicKeyPem, sourceDevice.signing.keyId, sourceDevice.deviceId).ok, 'Source policy signature failed');
  assert.ok(verifyGuardCatalogue(sourceCatalogue, sourceDevice.signing.publicKeyPem, sourceDevice.signing.keyId).ok, 'Source catalogue signature failed');
  assert.equal(sourceDevice.orgId, sourceBundle.bundle.orgId);
  assert.equal(sourceBundle.bundle.catalogueVersion, sourceCatalogue.catalogue.version);
  const codex = sourceCatalogue.catalogue.services.find(service => service.serviceId === 'openai-codex');
  assert.ok(codex, 'Source Codex catalogue row missing');
  const put = async (route, body) => { const result = await write('PUT', route, body); assert.equal(result.status, 200, `Fresh test registry rejected ${route}`); return result.json; };
  await put('/guard/rules', { baseVersion: 0, document: { defaultAction: sourceBundle.bundle.defaultAction, serviceRules: [], contentRules: sourceBundle.bundle.contentRules.map(rule => ({ ...rule, audience: { kind: 'org' }, enabled: true })) } });
  await put('/guard/settings', { clientMode: 'enforce' });
  await put('/guard/services/openai-codex', { enabled: true, defaultAction: 'allow' });
  return { contentRulesDigest: digestOf(sourceBundle.bundle.contentRules), codex };
}
