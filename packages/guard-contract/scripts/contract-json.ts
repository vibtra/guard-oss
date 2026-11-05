// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import {
  GUARD_AGENT_LOCAL_HOST,
  GUARD_AGENT_LOCAL_PATHS,
  GUARD_AGENT_LOCAL_PORT,
  GUARD_AGENT_PROXY_PORT,
  GUARD_AGENT_TRANSPARENT_PORT,
  GUARD_API_PREFIX,
  GUARD_BLOCKED_CODE,
  GUARD_CATALOGUE_SEED_VERSION,
  GUARD_DECISION_HEADER,
  GUARD_EVENT_UPLOAD_MAX,
  GUARD_PROTOCOL_VERSION,
  GUARD_SECRET_RULE_IDS,
  GUARD_SIGNATURE_TYP,
  GUARD_SNIPPET_MAX,
  GUARD_SYNC_DOORS,
  GUARD_SYNC_INTERVAL_DEFAULT_S,
  seedCatalogue,
} from "../src/index.js";

const out = {
  protocol: GUARD_PROTOCOL_VERSION,
  apiPrefix: GUARD_API_PREFIX,
  doors: {
    enrol: GUARD_SYNC_DOORS.enrol,
    preflight: GUARD_SYNC_DOORS.preflight("{deviceId}"),
    ruledownload: GUARD_SYNC_DOORS.ruledownload("{deviceId}"),
    eventupload: GUARD_SYNC_DOORS.eventupload("{deviceId}"),
    postflight: GUARD_SYNC_DOORS.postflight("{deviceId}"),
    requests: GUARD_SYNC_DOORS.requests("{deviceId}"),
  },
  agent: {
    proxyPort: GUARD_AGENT_PROXY_PORT,
    localPort: GUARD_AGENT_LOCAL_PORT,
    transparentPort: GUARD_AGENT_TRANSPARENT_PORT,
    localHost: GUARD_AGENT_LOCAL_HOST,
    localPaths: { ...GUARD_AGENT_LOCAL_PATHS, blocked: GUARD_AGENT_LOCAL_PATHS.blocked("{eventId}"), requestAccess: GUARD_AGENT_LOCAL_PATHS.requestAccess("{eventId}") },
    decisionHeader: GUARD_DECISION_HEADER,
    blockedCode: GUARD_BLOCKED_CODE,
  },
  limits: { snippetMax: GUARD_SNIPPET_MAX, eventUploadMax: GUARD_EVENT_UPLOAD_MAX, syncIntervalDefaultS: GUARD_SYNC_INTERVAL_DEFAULT_S },
  signatureTyp: GUARD_SIGNATURE_TYP,
  secretRuleIds: GUARD_SECRET_RULE_IDS,
  catalogueSeedVersion: GUARD_CATALOGUE_SEED_VERSION,
  catalogue: seedCatalogue(),
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
