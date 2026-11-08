// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";

export const GUARD_PROTOCOL_VERSION = 1;

export const GUARD_API_PREFIX = "/api/guard/v1";
export const GUARD_CONSOLE_API_PREFIX = "/api/console/guard";
export const GUARD_CONSOLE_PATH = "/guard";
export const GUARD_ASSETS_PREFIX = "/assets/guard";

export const GUARD_REQUEST_KIND = "guard" as const;

export const GUARD_SYNC_DOORS = {
  enrol: `${GUARD_API_PREFIX}/enrol`,
  preflight: (deviceId: string) => `${GUARD_API_PREFIX}/preflight/${deviceId}`,
  ruledownload: (deviceId: string) => `${GUARD_API_PREFIX}/ruledownload/${deviceId}`,
  eventupload: (deviceId: string) => `${GUARD_API_PREFIX}/eventupload/${deviceId}`,
  postflight: (deviceId: string) => `${GUARD_API_PREFIX}/postflight/${deviceId}`,
  requests: (deviceId: string) => `${GUARD_API_PREFIX}/requests/${deviceId}`,
} as const;

export const GUARD_AGENT_PROXY_PORT = 9470;
export const GUARD_AGENT_LOCAL_PORT = 9471;
export const GUARD_AGENT_TRANSPARENT_PORT = 9472;
export const GUARD_AGENT_LOCAL_HOST = "guard.vibtra.local";
export const GUARD_AGENT_LOCAL_PATHS = {
  blocked: (eventId: string) => `/blocked/${eventId}`,
  status: "/status",
  events: "/events",
  ca: "/ca.pem",
  healthz: "/healthz",
  requestAccess: (eventId: string) => `/blocked/${eventId}/request`,
} as const;
export const GUARD_DECISION_HEADER = "x-vibtra-guard";
export const GUARD_BLOCKED_CODE = "GUARD_BLOCKED";

export const GUARD_DEVICE_ID = z.string().regex(/^gdev_[0-9a-f]{16}$/);
export const GUARD_EVENT_ID = z.string().regex(/^gev_[0-9a-f]{16}$/);
export const GUARD_SERVICE_RULE_ID = z.string().regex(/^gsr_[0-9a-f]{8,16}$/);
export const GUARD_CONTENT_RULE_ID = z.string().regex(/^gcr_[0-9a-f]{8,16}$/);
export const GUARD_RULE_ID = z.string().regex(/^g[sc]r_[0-9a-f]{8,16}$/);
export const GUARD_SERVICE_ID = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const GUARD_KEY_ID = z.string().regex(/^gk_[0-9a-f]{8,16}$/);

export const GUARD_SNIPPET_MAX = 80;
export const GUARD_EVENT_UPLOAD_MAX = 500;
export const GUARD_SYNC_INTERVAL_DEFAULT_S = 60;
export const GUARD_QUIET_AFTER_MINUTES_DEFAULT = 24 * 60;
export const GUARD_LATE_AFTER_MINUTES = [3, 15] as const;
export const GUARD_LATE_AFTER_MINUTES_DEFAULT = GUARD_LATE_AFTER_MINUTES[0];
export const GUARD_ENROL_LINK_HOURS_DEFAULT = 24;
export const GUARD_ENROL_LINK_HOURS_MAX = 7 * 24;
export const GUARD_GRANT_DEFAULT_DAYS = 7;
export const GUARD_GRANT_MAX_DAYS = 90;
