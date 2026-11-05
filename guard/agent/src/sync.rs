// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::agent::{Agent, AskState, BlockInfo};
use crate::bundle::{verify_bundle, verify_catalogue};
use crate::config::{self, DeviceFile};
use crate::contract::{self, doors, PROTOCOL};
use crate::events::now_iso;
use crate::types::*;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub enum SyncError {
    NotEnrolled,
    Revoked(String),
    KeyMismatch { pinned: String, server: String },
    Api { status: u16, code: String, message: String },
    Network(String),
    Other(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::NotEnrolled => write!(f, "not enrolled"),
            SyncError::Revoked(code) => write!(f, "this device was revoked ({code}); enrol it again"),
            SyncError::KeyMismatch { pinned, server } => write!(f, "the registry signs with {server} but this device pinned {pinned}; enrol it again"),
            SyncError::Api { status, code, message } => write!(f, "registry answered {status} {code}: {message}"),
            SyncError::Network(e) => write!(f, "network: {e}"),
            SyncError::Other(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for SyncError {}

fn url_of(base: &str, path: &str) -> String {
    format!("{}{}", base.trim_end_matches('/'), path)
}

fn chain(e: reqwest::Error) -> String {
    let e = e.without_url();
    let mut out = e.to_string();
    let mut src = std::error::Error::source(&e);
    while let Some(s) = src {
        out.push_str(": ");
        out.push_str(&s.to_string());
        src = s.source();
    }
    out
}

async fn send<R: DeserializeOwned>(
    http: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<R, SyncError> {
    let mut req = http.request(method, url).header("accept", "application/json");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(b);
    }
    let res = req.send().await.map_err(|e| SyncError::Network(chain(e)))?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(|e| SyncError::Network(chain(e)))?;
    if !(200..300).contains(&status) {
        let err: ApiError = serde_json::from_slice(&bytes).unwrap_or(ApiError { code: format!("HTTP_{status}"), message: String::new() });
        if err.code == "GUARD_DEVICE_REVOKED" || err.code == "GUARD_DEVICE_UNKNOWN" {
            return Err(SyncError::Revoked(err.code));
        }
        return Err(SyncError::Api { status, code: err.code, message: err.message.chars().take(200).collect() });
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| SyncError::Other(format!("the registry's answer to {} did not parse: {e}", url.rsplit('/').nth(1).unwrap_or("?"))))
}

struct Ctx {
    base: String,
    token: String,
    device: DeviceFile,
}

fn ctx(agent: &Agent) -> Result<Ctx, SyncError> {
    let device = agent.device().ok_or(SyncError::NotEnrolled)?;
    if device.revoked {
        return Err(SyncError::Revoked("GUARD_DEVICE_REVOKED".into()));
    }
    let token = agent.token().ok_or(SyncError::NotEnrolled)?;
    Ok(Ctx { base: device.server.base_url.clone(), token, device })
}

async fn post<R: DeserializeOwned, B: Serialize>(agent: &Agent, path: &str, body: &B) -> Result<R, SyncError> {
    let c = ctx(agent)?;
    let body = serde_json::to_value(body).map_err(|e| SyncError::Other(e.to_string()))?;
    let r = send(&agent.http, reqwest::Method::POST, &url_of(&c.base, path), Some(&c.token), Some(&body)).await;
    if let Err(SyncError::Revoked(code)) = &r {
        mark_revoked(agent, code);
    }
    r
}

async fn get<R: DeserializeOwned>(agent: &Agent, path: &str) -> Result<R, SyncError> {
    let c = ctx(agent)?;
    let r = send(&agent.http, reqwest::Method::GET, &url_of(&c.base, path), Some(&c.token), None).await;
    if let Err(SyncError::Revoked(code)) = &r {
        mark_revoked(agent, code);
    }
    r
}

pub fn mark_revoked(agent: &Agent, code: &str) {
    let mut guard = agent.device.write().unwrap();
    if let Some(d) = guard.as_mut() {
        if !d.revoked {
            d.revoked = true;
            d.revoked_at = Some(now_iso());
            let _ = config::save_device(&agent.paths, d);
            tracing::warn!(code, "the registry revoked this device: enforcement stopped, nothing is decrypted until it is enrolled again");
        }
    }
    drop(guard);
    *agent.bundle.write().unwrap() = None;
    agent.emit("synced", json!({ "ok": false, "revoked": true, "at": now_iso() }));
}

pub async fn enrol(agent: &Arc<Agent>, server: &str, enrol_token: &str) -> anyhow::Result<DeviceFile> {
    anyhow::ensure!(enrol_token.starts_with("genr_") && enrol_token.len() == 37, "an enrol token is genr_ followed by 32 hex characters");
    let body = serde_json::to_value(EnrolRequest {
        protocol: PROTOCOL,
        enrol_token: enrol_token.to_string(),
        device: agent.facts.clone(),
        ca: agent.ca.facts.clone(),
    })?;
    let res: EnrolResponse = send(&agent.http, reqwest::Method::POST, &url_of(server, &doors::enrol()), None, Some(&body))
        .await
        .map_err(|e| anyhow::anyhow!("enrol failed: {e}"))?;
    let base = server.trim_end_matches('/').to_string();
    if res.server.base_url.trim_end_matches('/') != base {
        tracing::info!(enrolled_with = %base, registry_says = %res.server.base_url, "syncing with the address this device enrolled through");
    }
    let device = DeviceFile {
        device_id: res.device_id,
        org_id: res.org_id,
        org_handle: res.org_handle,
        org_name: res.org_name,
        person: res.person,
        server: ServerFacts { base_url: base, sync_interval_seconds: res.server.sync_interval_seconds, batch_size: res.server.batch_size },
        signing: res.signing,
        client_mode: res.client_mode,
        enrolled_at: now_iso(),
        revoked: false,
        revoked_at: None,
    };
    config::save_token(&agent.paths, &res.device_token)?;
    config::save_device(&agent.paths, &device)?;
    let _ = std::fs::remove_file(agent.paths.bundle());
    let _ = std::fs::remove_file(agent.paths.catalogue());
    *agent.device.write().unwrap() = Some(device.clone());
    *agent.token.write().unwrap() = Some(res.device_token);
    *agent.bundle.write().unwrap() = None;
    *agent.sync_state.lock().unwrap() = config::StateFile::default();
    tracing::info!(device = %device.device_id, org = %device.org_handle, key = %device.signing.key_id, "enrolled");
    Ok(device)
}

pub fn reload_enrolment(agent: &Agent) {
    let on_disk = config::load_device(&agent.paths).ok().flatten();
    let token = config::load_token(&agent.paths).ok().flatten();
    let changed = {
        let held = agent.device.read().unwrap();
        match (&*held, &on_disk) {
            (Some(a), Some(b)) => a.device_id != b.device_id || a.revoked != b.revoked || a.signing.key_id != b.signing.key_id,
            (None, Some(_)) => true,
            _ => false,
        }
    };
    if changed {
        *agent.device.write().unwrap() = on_disk;
        *agent.token.write().unwrap() = token;
        *agent.bundle.write().unwrap() = None;
        agent.load_stored_documents();
        tracing::info!("picked up a new enrolment from disk");
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub client_mode: String,
    pub bundle_version: Option<u64>,
    pub bundle_digest: Option<String>,
    pub catalogue_version: String,
    pub bundle_updated: bool,
    pub catalogue_updated: bool,
    pub verify_failure: Option<String>,
    pub events_uploaded: usize,
    pub events_rejected: usize,
    pub next_sync_in_seconds: u64,
}

pub async fn sync_once(agent: &Arc<Agent>) -> Result<SyncReport, SyncError> {
    let result = cycle(agent).await;
    {
        let mut s = agent.sync_state.lock().unwrap();
        s.last_sync_at = Some(now_iso());
        s.last_sync_ok = Some(result.is_ok());
        s.last_error = result.as_ref().err().map(|e| e.to_string());
        s.signing_key_mismatch = Some(matches!(result, Err(SyncError::KeyMismatch { .. })));
    }
    agent.save_state();
    match &result {
        Ok(r) => {
            agent.emit("synced", json!({ "ok": true, "at": now_iso(), "bundleVersion": r.bundle_version, "catalogueVersion": r.catalogue_version, "clientMode": r.client_mode, "eventsUploaded": r.events_uploaded }));
            tracing::info!(bundle = ?r.bundle_version, catalogue = %r.catalogue_version, mode = %r.client_mode, uploaded = r.events_uploaded, "synced");
        }
        Err(SyncError::NotEnrolled) => {}
        Err(e) => {
            agent.emit("synced", json!({ "ok": false, "at": now_iso(), "error": e.to_string() }));
            tracing::warn!(error = %e, "sync failed");
        }
    }
    if result.is_ok() {
        let _ = refresh_asks(agent).await;
    }
    result
}

async fn cycle(agent: &Arc<Agent>) -> Result<SyncReport, SyncError> {
    let c = ctx(agent)?;
    let held = agent.bundle.read().unwrap().clone();
    let cat = agent.matcher();
    let held_cat_version = (cat.source == "signed").then(|| cat.matcher.catalogue.version.clone());
    let pending = agent.queue.len().await as u64;
    let pre = PreflightRequest {
        protocol: PROTOCOL,
        device: agent.facts.clone(),
        ca: agent.ca.facts.clone(),
        client_mode: agent.client_mode(),
        bundle_version: held.as_ref().map(|b| b.bundle.bundle_version),
        catalogue_version: held_cat_version.clone(),
        signing_key_id: Some(c.device.signing.key_id.clone()),
        request_clean_sync: held.is_none(),
        pending_events: pending,
        health: Some(Health {
            ca_trusted: agent.ca_trusted(),
            proxy_listening: Some(agent.proxy_listening.load(std::sync::atomic::Ordering::Relaxed)),
            extension_active: None,
            uptime_seconds: Some(agent.started.elapsed().as_secs()),
        }),
    };
    let pf: PreflightResponse = post(agent, &doors::preflight(&c.device.device_id), &pre).await?;
    {
        let mut g = agent.device.write().unwrap();
        if let Some(d) = g.as_mut() {
            d.client_mode = pf.client_mode;
            d.server.sync_interval_seconds = pf.sync_interval_seconds;
            d.server.batch_size = pf.batch_size.clamp(1, contract::EVENT_UPLOAD_MAX);
            let _ = config::save_device(&agent.paths, d);
        }
    }
    let mut report = SyncReport { client_mode: pf.client_mode.as_str().to_string(), ..Default::default() };
    let key_mismatch = pf.signing_key_id != c.device.signing.key_id;

    if !key_mismatch && (pf.rules_changed || pf.catalogue_changed || pf.clean_sync || held.is_none() || held_cat_version.is_none()) {
        let req = RuleDownloadRequest {
            protocol: PROTOCOL,
            bundle_version: if pf.clean_sync { None } else { held.as_ref().map(|b| b.bundle.bundle_version) },
            catalogue_version: if pf.clean_sync { None } else { held_cat_version.clone() },
        };
        let rd: RuleDownloadResponse = post(agent, &doors::ruledownload(&c.device.device_id), &req).await?;
        if let Some(raw) = rd.catalogue {
            match verify_catalogue(&raw, &c.device.signing.public_key_pem, &c.device.signing.key_id) {
                Ok(v) => {
                    let _ = config::write_json(&agent.paths.catalogue(), &raw, 0o600);
                    agent.set_catalogue(v.catalogue, v.digest);
                    report.catalogue_updated = true;
                }
                Err(e) => {
                    tracing::warn!(reason = %e, "the downloaded catalogue does not verify; keeping the last good one");
                    report.verify_failure = Some(format!("catalogue: {e}"));
                }
            }
        }
        if let Some(raw) = rd.bundle {
            match verify_bundle(&raw, &c.device.signing.public_key_pem, &c.device.signing.key_id, Some(&c.device.device_id)) {
                Ok(v) => {
                    let _ = config::write_json(&agent.paths.bundle(), &raw, 0o600);
                    *agent.bundle.write().unwrap() = Some(Arc::new(v));
                    report.bundle_updated = true;
                }
                Err(e) => {
                    tracing::warn!(reason = %e, "the downloaded bundle does not verify; keeping the last good one");
                    report.verify_failure = Some(format!("bundle: {e}"));
                }
            }
        }
    }

    let batch_size = agent.device().map(|d| d.server.batch_size).unwrap_or(100).clamp(1, contract::EVENT_UPLOAD_MAX);
    for _ in 0..50 {
        let batch = agent.queue.peek(batch_size).await;
        if batch.is_empty() {
            break;
        }
        let ids: HashSet<String> = batch.iter().map(|e| e.event_id.clone()).collect();
        let up: EventUploadResponse = post(agent, &doors::eventupload(&c.device.device_id), &EventUploadRequest { protocol: PROTOCOL, events: batch }).await?;
        for r in &up.rejected {
            tracing::warn!(event = %r.event_id, reason = %r.reason, "the registry rejected an event; dropping it");
        }
        report.events_uploaded += up.accepted as usize;
        report.events_rejected += up.rejected.len();
        agent.queue.remove(&ids).await.map_err(|e| SyncError::Other(e.to_string()))?;
        if ids.len() < batch_size {
            break;
        }
    }

    if key_mismatch {
        return Err(SyncError::KeyMismatch { pinned: c.device.signing.key_id.clone(), server: pf.signing_key_id });
    }

    let now_bundle = agent.bundle.read().unwrap().clone();
    let cat = agent.matcher();
    let received = now_bundle.as_ref().map(|b| b.bundle.rule_count()).unwrap_or(0);
    let post_body = PostflightRequest {
        protocol: PROTOCOL,
        bundle_version: now_bundle.as_ref().map(|b| b.bundle.bundle_version).unwrap_or(0),
        catalogue_version: cat.matcher.catalogue.version.clone(),
        rules_received: received,
        rules_processed: received,
        client_mode: now_bundle.as_ref().map(|b| b.bundle.client_mode).unwrap_or(pf.client_mode),
        bundle_digest: now_bundle.as_ref().map(|b| b.digest.clone()),
    };
    let done: PostflightResponse = post(agent, &doors::postflight(&c.device.device_id), &post_body).await?;
    report.bundle_version = now_bundle.as_ref().map(|b| b.bundle.bundle_version);
    report.bundle_digest = now_bundle.as_ref().map(|b| b.digest.clone());
    report.catalogue_version = cat.matcher.catalogue.version.clone();
    report.next_sync_in_seconds = done.next_sync_in_seconds.max(10);
    Ok(report)
}

pub fn next_wait(result: &Result<SyncReport, SyncError>, failures: u32, interval: u64, sync_every: Option<u64>) -> (u64, u32) {
    match result {
        Ok(r) => (sync_every.unwrap_or(r.next_sync_in_seconds), 0),
        Err(SyncError::NotEnrolled) => (15, failures),
        Err(SyncError::Revoked(_)) => (60, failures),
        Err(_) => {
            let failures = failures.saturating_add(1);
            let base = sync_every.unwrap_or(interval);
            ((base.saturating_mul(1u64 << failures.min(10))).min(contract::SYNC_BACKOFF_MAX_S), failures)
        }
    }
}

pub async fn wait_or_wake(agent: &Agent, secs: u64) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => false,
        _ = agent.sync_now.notified() => true,
    }
}

pub async fn run_loop(agent: Arc<Agent>) {
    let mut failures: u32 = 0;
    loop {
        if !agent.enrolled() {
            reload_enrolment(&agent);
        }
        let interval = agent.device().map(|d| d.server.sync_interval_seconds).unwrap_or(contract::SYNC_INTERVAL_DEFAULT_S).max(10);
        let result = sync_once(&agent).await;
        let (wait, f) = next_wait(&result, failures, interval, agent.sync_every);
        failures = f;
        wait_or_wake(&agent, wait).await;
    }
}

pub async fn file_ask(agent: &Arc<Agent>, info: &BlockInfo, note: Option<String>) -> Result<AskResponse, SyncError> {
    let c = ctx(agent)?;
    let body = AskBody {
        service_id: info.service_id.clone(),
        rule_id: if info.rule_kind == "content" { info.rule_id.clone() } else { None },
        match_type: info.match_type.clone(),
        event_id: Some(info.event_id.clone()),
        app: info.app.clone().map(|a| a.chars().take(120).collect()),
        note: note.map(|n| n.trim().chars().take(280).collect::<String>()).filter(|n| !n.is_empty()),
    };
    let res: AskResponse = post(agent, &doors::requests(&c.device.device_id), &body).await?;
    agent
        .asks
        .lock()
        .unwrap()
        .insert(info.event_id.clone(), AskState { view: res.request.clone(), checked: Instant::now(), announced: res.request.status != "pending" });
    agent.record_followup(info, "requested", Some(res.request.request_id.chars().take(60).collect())).await;
    agent.sync_now.notify_one();
    Ok(res)
}

pub async fn refresh_asks(agent: &Arc<Agent>) -> Result<(), SyncError> {
    let any_pending = agent.asks.lock().unwrap().values().any(|a| a.view.status == "pending" || !a.announced);
    if !any_pending {
        return Ok(());
    }
    let c = ctx(agent)?;
    let list: AsksResponse = get(agent, &doors::requests(&c.device.device_id)).await?;
    let mut approved = false;
    let mut announcements = Vec::new();
    {
        let mut asks = agent.asks.lock().unwrap();
        for (event_id, state) in asks.iter_mut() {
            if let Some(v) = list.requests.iter().find(|r| r.request_id == state.view.request_id) {
                state.view = v.clone();
                state.checked = Instant::now();
                if v.status != "pending" && !state.announced {
                    state.announced = true;
                    approved |= v.status == "approved";
                    announcements.push(json!({ "eventId": event_id, "requestId": v.request_id, "status": v.status, "grantExpiresAt": v.grant_expires_at, "decisionNote": v.decision_note }));
                }
            }
        }
    }
    for a in announcements {
        agent.emit("ask-decided", a);
    }
    if approved {
        agent.sync_now.notify_one();
    }
    Ok(())
}
