// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Allow,
    Block,
    Ask,
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Action::Allow => "allow",
            Action::Block => "block",
            Action::Ask => "ask",
        }
    }
    pub fn rank(self) -> u8 {
        match self {
            Action::Allow => 0,
            Action::Ask => 1,
            Action::Block => 2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientMode {
    Monitor,
    Enforce,
}

impl ClientMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ClientMode::Monitor => "monitor",
            ClientMode::Enforce => "enforce",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub service_id: String,
    pub name: String,
    pub vendor: String,
    pub category: String,
    pub domains: Vec<String>,
    #[serde(default)]
    pub bundle_ids: Vec<String>,
    #[serde(default)]
    pub cli_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_action: Option<Action>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub custom: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    pub version: String,
    pub generated_at: String,
    pub services: Vec<Service>,
}

fn ten() -> usize {
    10
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Detector {
    #[serde(rename = "au-tfn")]
    AuTfn {
        #[serde(default, rename = "requireContext", skip_serializing_if = "std::ops::Not::not")]
        require_context: bool,
    },
    #[serde(rename = "au-abn")]
    AuAbn,
    #[serde(rename = "au-acn")]
    AuAcn {
        #[serde(default, rename = "requireContext", skip_serializing_if = "std::ops::Not::not")]
        require_context: bool,
    },
    #[serde(rename = "au-medicare")]
    AuMedicare {
        #[serde(default, rename = "requireContext", skip_serializing_if = "std::ops::Not::not")]
        require_context: bool,
    },
    #[serde(rename = "card-number")]
    CardNumber,
    #[serde(rename = "secret")]
    Secret {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rules: Option<Vec<String>>,
    },
    #[serde(rename = "email-bulk")]
    EmailBulk {
        #[serde(default = "ten")]
        threshold: usize,
    },
    #[serde(rename = "phone-bulk")]
    PhoneBulk {
        #[serde(default = "ten")]
        threshold: usize,
    },
    #[serde(rename = "keyword")]
    Keyword {
        keywords: Vec<String>,
        #[serde(default, rename = "wholeWord")]
        whole_word: bool,
    },
    #[serde(rename = "file-type")]
    FileType { extensions: Vec<String> },
}

impl Detector {
    pub fn kind(&self) -> &'static str {
        match self {
            Detector::AuTfn { .. } => "au-tfn",
            Detector::AuAbn => "au-abn",
            Detector::AuAcn { .. } => "au-acn",
            Detector::AuMedicare { .. } => "au-medicare",
            Detector::CardNumber => "card-number",
            Detector::Secret { .. } => "secret",
            Detector::EmailBulk { .. } => "email-bulk",
            Detector::PhoneBulk { .. } => "phone-bulk",
            Detector::Keyword { .. } => "keyword",
            Detector::FileType { .. } => "file-type",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub user_id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDecision {
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RuleServices {
    Ids(Vec<String>),
    All(String),
}

impl RuleServices {
    pub fn applies_to(&self, service_id: &str) -> bool {
        match self {
            RuleServices::All(s) => s == "*",
            RuleServices::Ids(ids) => ids.iter().any(|i| i == service_id),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRule {
    pub rule_id: String,
    pub name: String,
    pub detector: Detector,
    pub services: RuleServices,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exception {
    pub grant_id: String,
    pub scope: String,
    pub service_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRedirect {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleSettings {
    pub requests_enabled: bool,
    pub workspace_redirect: WorkspaceRedirect,
    pub snippet_policy: String,
    pub snippet_max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub protocol: u32,
    pub org_id: String,
    pub device_id: String,
    pub bundle_version: u64,
    pub catalogue_version: String,
    pub generated_at: String,
    pub person: Person,
    pub client_mode: ClientMode,
    pub default_action: Action,
    pub services: BTreeMap<String, ServiceDecision>,
    pub content_rules: Vec<ContentRule>,
    pub exceptions: Vec<Exception>,
    pub settings: BundleSettings,
}

impl Bundle {
    pub fn rule_count(&self) -> u64 {
        (self.services.len() + self.content_rules.len() + self.exceptions.len()) as u64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub key_id: String,
    pub alg: String,
    pub jws: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignaturePayload {
    pub kind: String,
    pub key_id: String,
    pub iat: u64,
    pub org_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub version: serde_json::Value,
    pub digest: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EventApp {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

impl EventApp {
    pub fn is_empty(&self) -> bool {
        self.bundle_id.is_none() && self.name.is_none() && self.cli.is_none() && self.pid.is_none()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub event_id: String,
    pub occurred_at: String,
    pub kind: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<EventApp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFacts {
    pub hostname: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_identifier: Option<String>,
    pub os_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_build: Option<String>,
    pub agent_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaFacts {
    pub fingerprint_sha256: String,
    pub subject: String,
    pub not_after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolRequest {
    pub protocol: u32,
    pub enrol_token: String,
    pub device: DeviceFacts,
    pub ca: CaFacts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFacts {
    pub base_url: String,
    pub sync_interval_seconds: u64,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningKey {
    pub key_id: String,
    pub alg: String,
    pub public_key_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolResponse {
    pub device_id: String,
    pub device_token: String,
    pub org_id: String,
    pub org_handle: String,
    pub org_name: String,
    pub person: Person,
    pub server: ServerFacts,
    pub signing: SigningKey,
    pub client_mode: ClientMode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_trusted: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_listening: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension_active: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightRequest {
    pub protocol: u32,
    pub device: DeviceFacts,
    pub ca: CaFacts,
    pub client_mode: ClientMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalogue_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_key_id: Option<String>,
    pub request_clean_sync: bool,
    pub pending_events: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<Health>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResponse {
    pub client_mode: ClientMode,
    pub sync_interval_seconds: u64,
    pub batch_size: usize,
    pub clean_sync: bool,
    pub bundle_version: u64,
    pub catalogue_version: String,
    pub rules_changed: bool,
    pub catalogue_changed: bool,
    pub signing_key_id: String,
    pub person: Person,
    pub server_time: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleDownloadRequest {
    pub protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_version: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalogue_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleDownloadResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalogue: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventUploadRequest {
    pub protocol: u32,
    pub events: Vec<Event>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejected {
    pub event_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventUploadResponse {
    pub accepted: u64,
    pub rejected: Vec<Rejected>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostflightRequest {
    pub protocol: u32,
    pub bundle_version: u64,
    pub catalogue_version: String,
    pub rules_received: u64,
    pub rules_processed: u64,
    pub client_mode: ClientMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostflightResponse {
    pub ok: bool,
    pub next_sync_in_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AskBody {
    pub service_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskView {
    pub request_id: String,
    pub kind: String,
    pub status: String,
    pub subject: serde_json::Value,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grant_expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskResponse {
    pub request: AskView,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsksResponse {
    pub requests: Vec<AskView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    #[serde(default)]
    pub message: String,
}
