// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

pub const PROTOCOL: u32 = 1;
pub const API_PREFIX: &str = "/api/guard/v1";

pub mod doors {
    use super::API_PREFIX;
    pub fn enrol() -> String {
        format!("{API_PREFIX}/enrol")
    }
    pub fn preflight(device_id: &str) -> String {
        format!("{API_PREFIX}/preflight/{device_id}")
    }
    pub fn ruledownload(device_id: &str) -> String {
        format!("{API_PREFIX}/ruledownload/{device_id}")
    }
    pub fn eventupload(device_id: &str) -> String {
        format!("{API_PREFIX}/eventupload/{device_id}")
    }
    pub fn postflight(device_id: &str) -> String {
        format!("{API_PREFIX}/postflight/{device_id}")
    }
    pub fn requests(device_id: &str) -> String {
        format!("{API_PREFIX}/requests/{device_id}")
    }
}

pub const PROXY_PORT: u16 = 9470;
pub const LOCAL_PORT: u16 = 9471;
pub const TRANSPARENT_PORT: u16 = 9472;
pub const LOCAL_HOST: &str = "guard.vibtra.local";

pub mod local_paths {
    pub const STATUS: &str = "/status";
    pub const EVENTS: &str = "/events";
    pub const CA: &str = "/ca.pem";
    pub const HEALTHZ: &str = "/healthz";
    pub fn blocked(event_id: &str) -> String {
        format!("/blocked/{event_id}")
    }
    pub fn request_access(event_id: &str) -> String {
        format!("/blocked/{event_id}/request")
    }
}

pub const DECISION_HEADER: &str = "x-vibtra-guard";
pub const BLOCKED_CODE: &str = "GUARD_BLOCKED";
pub const SIGNATURE_TYP: &str = "vibtra-guard+jwt";

pub const SNIPPET_MAX: usize = 80;
pub const EVENT_UPLOAD_MAX: usize = 500;
pub const SYNC_INTERVAL_DEFAULT_S: u64 = 60;
pub const SYNC_BACKOFF_MAX_S: u64 = 600;
pub const INSPECT_MAX_BYTES: usize = 4 * 1024 * 1024;

pub const SECRET_RULE_IDS: [&str; 15] = [
    "aws-access-token",
    "github-pat",
    "github-fine-grained-pat",
    "github-app-token",
    "openai-api-key",
    "anthropic-api-key",
    "slack-token",
    "stripe-access-token",
    "gcp-api-key",
    "gcp-oauth-token",
    "gcp-client-secret",
    "slack-webhook-url",
    "private-key",
    "jwt",
    "sendgrid-api-token",
];

pub const CATALOGUE_SEED_VERSION: &str = "2026-10-17";

pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub const CONTRACT_JSON: &str = include_str!("../tests/fixtures/contract.json");
