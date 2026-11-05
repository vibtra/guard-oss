// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/guard-contract/package.json', import.meta.url));
const { z } = require('zod');
const nonempty = z.string().min(1).max(1500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().startsWith(value));
const evidence = z.object({
  path: z.string().regex(/^(guard|docs|planning)\/[a-zA-Z0-9_./-]+$/).refine(value => !value.split('/').some(part => part === '..' || part === '.' || part === '')),
  kind: z.enum(['source', 'capture', 'report']), date,
  clientVersion: z.string().min(1).max(100).nullable(), guardBuild: z.number().int().positive().nullable(), claim: nonempty,
}).strict();
const pathMatcher = z.object({kind: z.enum(['exact', 'segments', 'unknown']), value: z.string().max(500).nullable()}).strict().superRefine((item, ctx) => {
  const fail = message => ctx.addIssue({ code: 'custom', message });
  if (item.kind === 'unknown') { if (item.value !== null) fail('Unknown path must be null, never a wildcard'); return; }
  if (!item.value || !/^\/[A-Za-z0-9/_.{}-]+$/.test(item.value) || item.value.includes('//')) { fail('Concrete pathname required; no query, fragment, percent encoding or wildcard'); return; }
  const parts = item.value.slice(1).split('/');
  if (parts.some(part => ['', '.', '..', '_'].includes(part))) fail('Empty, traversal and redacted segments are forbidden');
  if (parts.some(part => /[{}]/.test(part) && !(item.kind === 'segments' && part === '{id}'))) fail('Only whole {id} segment placeholders are supported');
  if (item.kind === 'segments' && !parts.includes('{id}')) fail('Segment matcher must contain a whole {id} placeholder');
});
export const coverageEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]+$/),
  surface: z.enum(['claude-web','claude-macos','chatgpt-web','chatgpt-macos']), action: z.literal('text-chat-send'),
  host: z.enum(['claude.ai','chatgpt.com','chat.openai.com']), method: z.enum(['POST','GET']).nullable(), pathMatcher,
  transport: z.enum(['http-json','http-form','websocket','unary-protobuf','connect-protobuf','unknown']),
  identityRequirement: z.object({kind: z.enum(['verified-browser','verified-native']), allowlist: z.array(z.object({signingId:z.string().regex(/^[A-Za-z0-9.-]+$/),teamId:z.string().regex(/^[A-Z0-9]{10}$/)}).strict()).max(20), selectedSurfaceProofRequired:z.boolean()}).strict(),
  validation: z.object({status:z.enum(['candidate','verified','untested','unsupported']),contentDLP:z.enum(['observed-separately','not-proven']),reason:nonempty}).strict(),
  evidence: z.array(evidence).min(1).max(20),
}).strict().superRefine((entry,ctx) => {
  const expected = entry.surface.endsWith('-web') ? 'verified-browser' : 'verified-native';
  if (entry.identityRequirement.kind !== expected) ctx.addIssue({code:'custom',message:'Surface and identity kind disagree'});
  const ids = entry.identityRequirement.allowlist.map(pair => `${pair.teamId}/${pair.signingId}`);
  if (new Set(ids).size !== ids.length) ctx.addIssue({code:'custom',message:'Duplicate identity pair'});
  if (entry.surface.startsWith('claude') !== (entry.host === 'claude.ai')) ctx.addIssue({code:'custom',message:'Surface and host disagree'});
  if ((entry.method === 'GET') !== (entry.transport === 'websocket') && entry.method !== null) ctx.addIssue({code:'custom',message:'GET is only a WebSocket handshake; WebSocket routes are GET'});
  if (entry.validation.status === 'verified' && !entry.evidence.some(item => item.kind === 'capture' && item.clientVersion !== null && item.guardBuild !== null)) ctx.addIssue({code:'custom',message:'Verified entry needs a live capture with client and Guard builds'});
});
export const coverageManifestSchema = z.object({schemaVersion:z.literal(1),generatedAt:date,entries:z.array(coverageEntrySchema).min(4).max(100)}).strict().superRefine((manifest,ctx) => {
  if (new Set(manifest.entries.map(entry=>entry.id)).size !== manifest.entries.length) ctx.addIssue({code:'custom',message:'Duplicate entry ID'});
  for (const surface of ['claude-web','claude-macos','chatgpt-web','chatgpt-macos']) if (!manifest.entries.some(entry=>entry.surface===surface)) ctx.addIssue({code:'custom',message:`Missing surface ${surface}`});
});
export function isExecutableCandidate(entry, experimentalOptIn = false) {
  return experimentalOptIn === true && ['candidate','verified'].includes(entry.validation.status) && entry.pathMatcher.kind !== 'unknown' && entry.method !== null && entry.transport !== 'unknown' && entry.identityRequirement.allowlist.length > 0 && !entry.identityRequirement.selectedSurfaceProofRequired;
}
