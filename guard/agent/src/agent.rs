// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::bundle::{verify_bundle, verify_catalogue, VerifiedBundle};
use crate::ca::Ca;
use crate::catalogue::{seed_catalogue, Matcher};
use crate::config::{self, DeviceFile, Paths, StateFile};
use crate::contract;
use crate::detect::snippet_label;
use crate::engine::{decide_request, explain, FlowSource, RequestFacts, Verdict, VerdictKind};
use crate::events::{iso, mint_event_id, now_iso, EventQueue};
use crate::types::{Action, AskView, ClientMode, DeviceFacts, Event, EventApp};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use time::OffsetDateTime;
use tokio::sync::{broadcast, Notify};
use tokio::task::JoinHandle;

#[derive(Debug, Clone)]
pub struct Options {
    pub data_dir: Option<PathBuf>,
    pub proxy: SocketAddr,
    pub local: SocketAddr,
    pub transparent: Option<SocketAddr>,
    pub upstream_map: Vec<(String, url::Url)>,
    pub upstream_ca: Option<PathBuf>,
    pub sync_every: Option<u64>,
    pub sync: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            data_dir: None,
            proxy: SocketAddr::from(([127, 0, 0, 1], contract::PROXY_PORT)),
            local: SocketAddr::from(([127, 0, 0, 1], contract::LOCAL_PORT)),
            transparent: None,
            upstream_map: Vec::new(),
            upstream_ca: None,
            sync_every: None,
            sync: true,
        }
    }
}

pub fn parse_upstream_map(spec: &str) -> Result<Vec<(String, url::Url)>> {
    let mut out = Vec::new();
    for item in spec.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let (host, target) = item.split_once('=').with_context(|| format!("--upstream-map entry `{item}` is not host=url"))?;
        let url = url::Url::parse(target.trim()).with_context(|| format!("--upstream-map target `{target}`"))?;
        anyhow::ensure!(url.scheme() == "http" || url.scheme() == "https", "--upstream-map target must be http:// or https://");
        out.push((crate::catalogue::normalise_host(host.trim()), url));
    }
    Ok(out)
}

pub struct CatalogueState {
    pub matcher: Matcher,
    pub source: &'static str,
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInfo {
    pub event_id: String,
    pub occurred_at: String,
    pub service_id: String,
    pub service_name: String,
    pub host: String,
    pub action: Action,
    pub rule_id: Option<String>,
    pub rule_name: Option<String>,
    pub rule_kind: String,
    pub match_type: Option<String>,
    pub match_count: Option<u64>,
    pub example: Option<String>,
    pub note: Option<String>,
    pub app: Option<String>,
    pub requests_enabled: bool,
    pub workspace: Option<String>,
    pub enforced: bool,
}

#[derive(Debug, Clone)]
pub struct Decision {
    pub verdict: Verdict,
    pub event_id: Option<String>,
    pub refuse: bool,
    pub header: String,
    pub info: Option<BlockInfo>,
}

#[derive(Debug, Clone)]
pub struct Sse {
    pub event: &'static str,
    pub data: String,
}

#[derive(Default)]
struct Today {
    day: String,
    counts: HashMap<String, u64>,
}

pub struct AskState {
    pub view: AskView,
    pub checked: Instant,
    pub announced: bool,
}

pub struct Agent {
    pub paths: Paths,
    pub ca: Ca,
    pub facts: DeviceFacts,
    pub device: RwLock<Option<DeviceFile>>,
    pub token: RwLock<Option<String>>,
    pub bundle: RwLock<Option<Arc<VerifiedBundle>>>,
    pub catalogue: RwLock<Arc<CatalogueState>>,
    pub queue: EventQueue,
    recent: Mutex<(VecDeque<String>, HashMap<String, BlockInfo>)>,
    activity: Mutex<VecDeque<Value>>,
    pub asks: Mutex<HashMap<String, AskState>>,
    pub bus: broadcast::Sender<Sse>,
    today: Mutex<Today>,
    pub sync_now: Notify,
    pub sync_state: Mutex<StateFile>,
    pub local_base: RwLock<String>,
    pub proxy_addr: RwLock<Option<SocketAddr>>,
    pub upstream_map: HashMap<String, url::Url>,
    pub upstream_roots: Vec<rustls::pki_types::CertificateDer<'static>>,
    pub started: Instant,
    pub proxy_listening: AtomicBool,
    ca_trusted: Mutex<Option<(Option<bool>, Instant)>>,
    dedupe: Mutex<HashMap<String, (String, Instant)>>,
    pub sync_every: Option<u64>,
    pub http: reqwest::Client,
}

pub const RECENT_MAX: usize = 1000;

impl Agent {
    pub fn open(opts: &Options) -> Result<Arc<Agent>> {
        crate::init_crypto();
        let paths = Paths::resolve(opts.data_dir.as_deref());
        paths.ensure()?;
        let facts = crate::facts::collect();
        let ca = Ca::load_or_create(&paths, &facts.hostname)?;
        let device = config::load_device(&paths)?;
        let token = config::load_token(&paths)?;
        let mut upstream_roots = Vec::new();
        if let Some(p) = &opts.upstream_ca {
            let pem = std::fs::read(p).with_context(|| format!("reading {}", p.display()))?;
            for c in rustls_pemfile::certs(&mut pem.as_slice()) {
                upstream_roots.push(c?);
            }
        }
        let http =
            reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(30)).user_agent(format!("vibtra-guard/{}", contract::AGENT_VERSION)).build()?;
        let (bus, _) = broadcast::channel(256);
        let state: StateFile = config::read_json(&paths.state()).ok().flatten().unwrap_or_default();
        let agent = Agent {
            queue: EventQueue::new(paths.events()),
            paths,
            ca,
            facts,
            device: RwLock::new(device),
            token: RwLock::new(token),
            bundle: RwLock::new(None),
            catalogue: RwLock::new(Arc::new(CatalogueState { matcher: Matcher::new(seed_catalogue()), source: "seed", digest: None })),
            recent: Mutex::new((VecDeque::new(), HashMap::new())),
            activity: Mutex::new(VecDeque::new()),
            asks: Mutex::new(HashMap::new()),
            bus,
            today: Mutex::new(Today::default()),
            sync_now: Notify::new(),
            sync_state: Mutex::new(state),
            local_base: RwLock::new(format!("http://{}", opts.local)),
            proxy_addr: RwLock::new(None),
            upstream_map: opts.upstream_map.iter().cloned().collect(),
            upstream_roots,
            started: Instant::now(),
            proxy_listening: AtomicBool::new(false),
            ca_trusted: Mutex::new(None),
            dedupe: Mutex::new(HashMap::new()),
            sync_every: opts.sync_every,
            http,
        };
        agent.load_stored_documents();
        Ok(Arc::new(agent))
    }

    pub fn load_stored_documents(&self) {
        let Some(device) = self.device() else { return };
        if let Ok(Some(raw)) = config::read_json::<Value>(&self.paths.catalogue()) {
            match verify_catalogue(&raw, &device.signing.public_key_pem, &device.signing.key_id) {
                Ok(v) => self.set_catalogue(v.catalogue, v.digest),
                Err(e) => tracing::warn!(reason = %e, "stored catalogue does not verify; using the seed until the next sync"),
            }
        }
        if let Ok(Some(raw)) = config::read_json::<Value>(&self.paths.bundle()) {
            match verify_bundle(&raw, &device.signing.public_key_pem, &device.signing.key_id, Some(&device.device_id)) {
                Ok(v) => *self.bundle.write().unwrap() = Some(Arc::new(v)),
                Err(e) => tracing::warn!(reason = %e, "stored bundle does not verify; not enforcing until the next sync"),
            }
        }
    }

    pub fn set_catalogue(&self, catalogue: crate::types::Catalogue, digest: String) {
        *self.catalogue.write().unwrap() = Arc::new(CatalogueState { matcher: Matcher::new(catalogue), source: "signed", digest: Some(digest) });
    }

    pub fn device(&self) -> Option<DeviceFile> {
        self.device.read().unwrap().clone()
    }

    pub fn token(&self) -> Option<String> {
        self.token.read().unwrap().clone()
    }

    pub fn enrolled(&self) -> bool {
        self.device().is_some_and(|d| !d.revoked) && self.token().is_some()
    }

    pub fn active_bundle(&self) -> Option<Arc<VerifiedBundle>> {
        if !self.enrolled() {
            return None;
        }
        self.bundle.read().unwrap().clone()
    }

    pub fn matcher(&self) -> Arc<CatalogueState> {
        self.catalogue.read().unwrap().clone()
    }

    pub fn should_intercept(&self, host: &str) -> bool {
        self.active_bundle().is_some() && self.matcher().matcher.is_intercepted_host(host)
    }

    pub fn local_base(&self) -> String {
        self.local_base.read().unwrap().clone()
    }

    pub fn emit(&self, event: &'static str, data: Value) {
        let _ = self.bus.send(Sse { event, data: data.to_string() });
    }

    fn count(&self, action: &str) {
        let mut t = self.today.lock().unwrap();
        let day = iso(OffsetDateTime::now_utc())[..10].to_string();
        if t.day != day {
            t.day = day;
            t.counts.clear();
        }
        *t.counts.entry(action.to_string()).or_default() += 1;
    }

    pub fn today_counts(&self) -> HashMap<String, u64> {
        let t = self.today.lock().unwrap();
        let day = iso(OffsetDateTime::now_utc())[..10].to_string();
        if t.day == day {
            t.counts.clone()
        } else {
            HashMap::new()
        }
    }

    pub async fn record(&self, event: &Event, extra: Value) {
        if let Err(e) = self.queue.append(event).await {
            tracing::warn!(error = %e, "could not queue an event");
        }
        self.count(&event.action);
        let mut row = serde_json::to_value(event).unwrap_or(Value::Null);
        if let (Value::Object(row), Value::Object(extra)) = (&mut row, extra) {
            row.extend(extra);
        }
        {
            let mut activity = self.activity.lock().unwrap();
            activity.push_front(row.clone());
            activity.truncate(300);
        }
        self.emit("decision", row);
        tracing::info!(event = %event.event_id, kind = %event.kind, action = %event.action, service = event.service_id.as_deref().unwrap_or("-"), rule = event.rule_id.as_deref().unwrap_or("-"), match_type = event.match_type.as_deref().unwrap_or("-"), "decision");
    }

    pub fn remember(&self, info: BlockInfo) {
        let mut g = self.recent.lock().unwrap();
        let (order, map) = &mut *g;
        if !map.contains_key(&info.event_id) {
            order.push_back(info.event_id.clone());
        }
        map.insert(info.event_id.clone(), info);
        while order.len() > RECENT_MAX {
            if let Some(old) = order.pop_front() {
                map.remove(&old);
            }
        }
    }

    pub fn recalled(&self, event_id: &str) -> Option<BlockInfo> {
        self.recent.lock().unwrap().1.get(event_id).cloned()
    }

    fn dedupe(&self, key: String, window: Duration) -> Option<String> {
        let mut g = self.dedupe.lock().unwrap();
        let now = Instant::now();
        g.retain(|_, (_, at)| now.duration_since(*at) < Duration::from_secs(600));
        match g.get(&key) {
            Some((id, at)) if now.duration_since(*at) < window => Some(id.clone()),
            _ => None,
        }
    }

    fn remember_dedupe(&self, key: String, id: String) {
        self.dedupe.lock().unwrap().insert(key, (id, Instant::now()));
    }

    #[doc(hidden)]
    pub fn age_dedupe(&self, by: Duration) {
        for (_, at) in self.dedupe.lock().unwrap().values_mut() {
            if let Some(earlier) = at.checked_sub(by) {
                *at = earlier;
            }
        }
    }

    pub async fn decide(&self, req: RequestMeta<'_>) -> Option<Decision> {
        self.decide_with_inspection(req, None).await
    }

    pub async fn decide_with_inspection(&self, req: RequestMeta<'_>, inspection: Option<crate::prompt::Inspection>) -> Option<Decision> {
        let bundle = self.active_bundle()?;
        let cat = self.matcher();
        let now = OffsetDateTime::now_utc();
        let facts = RequestFacts {
            host: req.host,
            bundle_id: req.app.bundle_id.as_deref(),
            cli_name: req.app.cli.as_deref(),
            text: req.text,
            filenames: req.filenames, joined: req.joined,
        };
        let verdict = decide_request(&bundle.bundle, &cat.matcher, &facts, now);
        if !verdict.intercepted {
            return None;
        }
        let b = &bundle.bundle;
        let service = verdict.service.clone().expect("intercepted has a service");
        let flow = verdict.flow.clone().expect("intercepted has a flow");
        let mut ev = Event {
            event_id: mint_event_id(),
            occurred_at: now_iso(),
            kind: "flow".into(),
            action: "observed".into(),
            service_id: Some(service.service_id.clone()),
            host: Some(crate::catalogue::normalise_host(req.host)),
            port: req.port,
            method: req.method.filter(|m| (3..=10).contains(&m.len()) && m.bytes().all(|c| c.is_ascii_uppercase())).map(str::to_string),
            path_hint: req.path.map(path_hint),
            app: (!req.app.is_empty()).then(|| req.app.clone()),
            bundle_version: Some(b.bundle_version),
            bytes: req.bytes,
            ..Default::default()
        };
        let mut info: Option<BlockInfo> = None;
        let mut rule_name: Option<String> = None;
        let mut example: Option<String> = None;
        let mut content_event = false;
        match verdict.verdict {
            VerdictKind::Blocked | VerdictKind::Asked if verdict.content.is_none() => {
                ev.action = if verdict.verdict == VerdictKind::Blocked { "blocked" } else { "asked" }.into();
                ev.rule_id = flow.rule_id.clone();
                ev.rule_kind = Some(if flow.source == FlowSource::Rule { "service" } else { "default" }.into());
            }
            VerdictKind::Blocked | VerdictKind::Asked => {
                let c = verdict.content.as_ref().unwrap();
                let d = c.decided().unwrap();
                content_event = true;
                ev.kind = "content".into();
                ev.action = if verdict.verdict == VerdictKind::Blocked { "blocked" } else { "asked" }.into();
                ev.rule_id = Some(d.rule.rule_id.clone());
                ev.rule_kind = Some("content".into());
                ev.match_type = Some(d.m.kind.clone());
                ev.match_count = Some(d.m.count as u64);
                rule_name = Some(d.rule.name.clone());
                example = d.m.examples.first().cloned();
            }
            VerdictKind::Allowed => {
                let c = verdict.content.as_ref();
                let fired = c.and_then(|c| c.matches.iter().find(|m| !m.excepted).or_else(|| c.matches.first()));
                if let Some(m) = fired {
                    content_event = true;
                    ev.kind = "content".into();
                    ev.action = "allowed".into();
                    ev.rule_id = Some(m.rule.rule_id.clone());
                    ev.rule_kind = Some(if m.excepted { "exception" } else { "content" }.into());
                    ev.match_type = Some(m.m.kind.clone());
                    ev.match_count = Some(m.m.count as u64);
                    rule_name = Some(m.rule.name.clone());
                    example = m.m.examples.first().cloned();
                } else {
                    match flow.source {
                        FlowSource::Exception => {
                            ev.action = "allowed".into();
                            ev.rule_kind = Some("exception".into());
                        }
                        FlowSource::Rule => {
                            ev.action = "allowed".into();
                            ev.rule_kind = Some("service".into());
                            ev.rule_id = flow.rule_id.clone();
                        }
                        FlowSource::Default => {
                            ev.action = "observed".into();
                            ev.rule_kind = Some("default".into());
                        }
                    }
                }
            }
            VerdictKind::NotIntercepted => return None,
        }
        if content_event && b.settings.snippet_policy == "redacted" {
            if let (Some(kind), Some(ex)) = (&ev.match_type, &example) {
                let s = format!("{} {}", snippet_label(kind), ex);
                ev.snippet = Some(s.chars().take(contract::SNIPPET_MAX).collect());
            }
        }
        let refusing = matches!(verdict.verdict, VerdictKind::Blocked | VerdictKind::Asked);
        if refusing && !verdict.enforced {
            ev.reason = Some("monitor".into());
        } else if req.bytes.is_some_and(|n| n > contract::INSPECT_MAX_BYTES as u64) {
            ev.reason = Some("uninspected".into());
        }
        let mut event_id = ev.event_id.clone();
        let mut fresh = true;
        if !content_event {
            let quiet_method = matches!(ev.method.as_deref(), Some("GET" | "HEAD" | "OPTIONS"));
            let key = format!(
                "{}|{}|{}|{}|{}|{}|{}",
                ev.service_id.as_deref().unwrap_or(""),
                ev.action,
                ev.rule_id.as_deref().unwrap_or(""),
                if quiet_method { "GET" } else { ev.method.as_deref().unwrap_or("") },
                if quiet_method { "" } else { ev.path_hint.as_deref().unwrap_or("") },
                inspection.as_ref().map(|i| i.state).unwrap_or(""),
                inspection.as_ref().and_then(|i| i.reason).unwrap_or("")
            );
            let window = if quiet_method && !refusing { Duration::from_secs(300) } else { Duration::from_secs(60) };
            if let Some(id) = self.dedupe(key.clone(), window) {
                event_id = id;
                fresh = false;
            } else {
                self.remember_dedupe(key, event_id.clone());
            }
        }
        if refusing {
            let action = if verdict.verdict == VerdictKind::Blocked { Action::Block } else { Action::Ask };
            let note = match &verdict.content {
                Some(c) => c.decided().and_then(|d| d.rule.note.clone()),
                None => flow.note.clone(),
            };
            let bi = BlockInfo {
                event_id: event_id.clone(),
                occurred_at: ev.occurred_at.clone(),
                service_id: service.service_id.clone(),
                service_name: service.name.clone(),
                host: ev.host.clone().unwrap_or_default(),
                action,
                rule_id: ev.rule_id.clone(),
                rule_name: rule_name.clone(),
                rule_kind: ev.rule_kind.clone().unwrap_or_default(),
                match_type: ev.match_type.clone(),
                match_count: ev.match_count,
                example: example.clone(),
                note,
                app: req.app.name.clone().or(req.app.cli.clone()).or(req.app.bundle_id.clone()),
                requests_enabled: b.settings.requests_enabled,
                workspace: b.settings.workspace_redirect.enabled.then(|| b.settings.workspace_redirect.url.clone()).flatten(),
                enforced: verdict.enforced,
            };
            if fresh || self.recalled(&event_id).is_none() {
                self.remember(bi.clone());
            }
            info = Some(bi);
        }
        if fresh {
            let mut extra = json!({ "serviceName": service.name, "ruleName": rule_name, "enforced": verdict.enforced, "explanation": explain(&verdict) });
            if let Some(inspection) = inspection {
                extra["inspection"] = serde_json::to_value(inspection).unwrap_or_default();
            }
            if info.is_some() {
                extra["requestsEnabled"] = json!(b.settings.requests_enabled);
                extra["workspace"] = json!({ "enabled": b.settings.workspace_redirect.enabled, "url": b.settings.workspace_redirect.url });
            }
            self.record(&ev, extra).await;
        }
        let header = match verdict.verdict {
            VerdictKind::Blocked | VerdictKind::Asked if verdict.enforced => format!("blocked; event={event_id}"),
            VerdictKind::Blocked | VerdictKind::Asked => format!("would-block; event={event_id}"),
            _ if ev.action == "observed" => "observed".to_string(),
            _ => {
                let grant = verdict
                    .flow
                    .as_ref()
                    .filter(|f| f.source == FlowSource::Exception)
                    .and_then(|f| f.grant_id.clone())
                    .or_else(|| verdict.content.as_ref().and_then(|c| c.matches.iter().find(|m| m.excepted).and_then(|m| m.grant_id.clone())));
                match grant {
                    Some(g) => format!("allowed; grant={g}"),
                    None => "allowed".to_string(),
                }
            }
        };
        Some(Decision { refuse: refusing && verdict.enforced, verdict, event_id: Some(event_id), header, info })
    }

    pub async fn record_followup(&self, info: &BlockInfo, action: &str, request_id: Option<String>) {
        let bundle_version = self.active_bundle().map(|b| b.bundle.bundle_version);
        let ev = Event {
            event_id: mint_event_id(),
            occurred_at: now_iso(),
            kind: if info.rule_kind == "content" { "content" } else { "flow" }.into(),
            action: action.into(),
            service_id: Some(info.service_id.clone()),
            host: Some(info.host.clone()),
            rule_id: info.rule_id.clone(),
            rule_kind: Some(info.rule_kind.clone()).filter(|s| !s.is_empty()),
            match_type: info.match_type.clone(),
            request_id,
            bundle_version,
            ..Default::default()
        };
        self.record(&ev, json!({ "serviceName": info.service_name, "ruleName": info.rule_name, "causedBy": info.event_id })).await;
    }

    pub fn ca_trusted(&self) -> Option<bool> {
        let mut g = self.ca_trusted.lock().unwrap();
        if let Some((v, at)) = *g {
            if at.elapsed() < Duration::from_secs(60) {
                return v;
            }
        }
        let v = crate::ca::is_trusted(&self.paths);
        *g = Some((v, Instant::now()));
        v
    }

    pub fn activity_json(&self) -> Value {
        json!({ "events": self.activity.lock().unwrap().iter().cloned().collect::<Vec<_>>(), "limit": 300 })
    }

    pub fn policy_json(&self) -> Value {
        let Some(bundle) = self.active_bundle() else { return json!({ "available": false, "services": [], "contentRules": [] }) };
        let cat = self.matcher();
        let now = OffsetDateTime::now_utc();
        let services: Vec<Value> = cat
            .matcher
            .catalogue
            .services
            .iter()
            .filter(|s| s.enabled)
            .map(|s| {
                let decision = crate::engine::decide_flow(&bundle.bundle, &s.service_id, now);
                json!({ "id": s.service_id, "name": s.name, "action": decision.action, "note": decision.note, "source": decision.source })
            })
            .collect();
        let rules: Vec<Value> = bundle
            .bundle
            .content_rules
            .iter()
            .map(|r| {
                let names: Vec<&str> =
                    cat.matcher.catalogue.services.iter().filter(|s| s.enabled && r.services.applies_to(&s.service_id)).map(|s| s.name.as_str()).collect();
                json!({ "id": r.rule_id, "name": r.name, "detector": r.detector.kind(), "action": r.action, "note": r.note, "serviceNames": names })
            })
            .collect();
        json!({ "available": true, "mode": bundle.bundle.client_mode, "bundleVersion": bundle.bundle.bundle_version,
            "services": services, "contentRules": rules })
    }

    pub async fn status_json(&self) -> Value {
        let device = self.device();
        let bundle = self.bundle.read().unwrap().clone();
        let cat = self.matcher();
        let state = self.sync_state.lock().unwrap().clone();
        let queued = self.queue.len().await;
        let enrolled = self.enrolled();
        json!({
            "enrolled": enrolled,
            "state": if device.as_ref().is_some_and(|d| d.revoked) { "revoked" } else if !enrolled { "not enrolled" } else if bundle.is_none() { "waiting for rules" } else { "enforcing" },
            "agentVersion": contract::AGENT_VERSION,
            "deviceId": device.as_ref().map(|d| d.device_id.clone()),
            "org": device.as_ref().map(|d| json!({ "orgId": d.org_id, "handle": d.org_handle, "name": d.org_name })),
            "person": device.as_ref().map(|d| json!({ "userId": d.person.user_id, "email": d.person.email, "name": d.person.name })),
            "server": device.as_ref().map(|d| d.server.base_url.clone()),
            "revoked": device.as_ref().is_some_and(|d| d.revoked),
            "clientMode": bundle.as_ref().map(|b| b.bundle.client_mode.as_str()).or(device.as_ref().map(|d| d.client_mode.as_str())),
            "bundleVersion": bundle.as_ref().map(|b| b.bundle.bundle_version),
            "bundleDigest": bundle.as_ref().map(|b| b.digest.clone()),
            "catalogueVersion": cat.matcher.catalogue.version,
            "catalogueSource": cat.source,
            "lastSync": { "at": state.last_sync_at, "ok": state.last_sync_ok, "error": state.last_error },
            "signingKeyMismatch": state.signing_key_mismatch.unwrap_or(false),
            "queuedEvents": queued,
            "today": self.today_counts(),
            "ca": { "subject": self.ca.facts.subject, "fingerprintSha256": self.ca.facts.fingerprint_sha256, "notAfter": self.ca.facts.not_after, "spkiSha256": self.ca.spki_sha256_b64 },
            "caTrusted": self.ca_trusted(),
            "proxyListening": self.proxy_listening.load(Ordering::Relaxed),
            "proxy": self.proxy_addr.read().unwrap().map(|a| a.to_string()),
            "local": self.local_base(),
            "uptimeSeconds": self.started.elapsed().as_secs(),
            "settings": bundle.as_ref().map(|b| json!({
                "requestsEnabled": b.bundle.settings.requests_enabled,
                "workspaceRedirect": { "enabled": b.bundle.settings.workspace_redirect.enabled, "url": b.bundle.settings.workspace_redirect.url },
            })),
        })
    }

    pub fn client_mode(&self) -> ClientMode {
        self.active_bundle().map(|b| b.bundle.client_mode).or(self.device().map(|d| d.client_mode)).unwrap_or(ClientMode::Monitor)
    }

    pub fn save_state(&self) {
        let s = self.sync_state.lock().unwrap().clone();
        let _ = config::write_json(&self.paths.state(), &s, 0o600);
    }

    pub fn ask_for(&self, event_id: &str) -> Option<AskView> {
        self.asks.lock().unwrap().get(event_id).map(|a| a.view.clone())
    }

    pub fn excepted_now(&self, info: &BlockInfo) -> bool {
        let Some(b) = self.active_bundle() else { return false };
        b.bundle
            .exceptions
            .iter()
            .any(|e| e.service_id == info.service_id && (e.rule_id.is_none() || (info.rule_kind == "content" && e.rule_id == info.rule_id)))
    }
}

#[derive(Debug, Clone, Default)]
pub struct RequestMeta<'a> {
    pub host: &'a str,
    pub port: Option<u16>,
    pub method: Option<&'a str>,
    pub path: Option<&'a str>,
    pub app: EventApp,
    pub text: &'a str,
    pub filenames: &'a [String],
    pub joined: &'a [String],
    pub bytes: Option<u64>,
}

pub fn path_hint(path: &str) -> String {
    let p = path.split(['?', '#']).next().unwrap_or("");
    let first = p.trim_start_matches('/').split('/').next().unwrap_or("");
    let hint = format!("/{first}");
    hint.chars().take(40).collect()
}

pub struct Running {
    pub agent: Arc<Agent>,
    pub proxy_addr: SocketAddr,
    pub local_addr: SocketAddr,
    pub transparent_addr: Option<SocketAddr>,
    tasks: Vec<JoinHandle<()>>,
}

impl Running {
    pub fn stop(&mut self) {
        self.agent.proxy_listening.store(false, Ordering::Relaxed);
        for t in self.tasks.drain(..) {
            t.abort();
        }
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

fn mtime(p: &std::path::Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

async fn watch_data_dir(agent: Arc<Agent>) {
    let files = |a: &Agent| [mtime(&a.paths.device()), mtime(&a.paths.token()), mtime(&a.paths.bundle()), mtime(&a.paths.catalogue())];
    let mut seen = files(&agent);
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let now = files(&agent);
        if now == seen {
            continue;
        }
        seen = now;
        crate::sync::reload_enrolment(&agent);
        if agent.enrolled() {
            agent.load_stored_documents();
        }
    }
}

pub async fn start(opts: Options) -> Result<Running> {
    let agent = Agent::open(&opts)?;
    let proxy_listener = tokio::net::TcpListener::bind(opts.proxy).await.with_context(|| format!("binding the proxy on {}", opts.proxy))?;
    let proxy_addr = proxy_listener.local_addr()?;
    let local_listener = tokio::net::TcpListener::bind(opts.local).await.with_context(|| format!("binding the local pages on {}", opts.local))?;
    let local_addr = local_listener.local_addr()?;
    *agent.local_base.write().unwrap() = format!("http://{local_addr}");
    *agent.proxy_addr.write().unwrap() = Some(proxy_addr);
    let mut tasks = Vec::new();
    tasks.push(crate::proxy::spawn(agent.clone(), proxy_listener)?);
    agent.proxy_listening.store(true, Ordering::Relaxed);
    tasks.push(crate::local::spawn(agent.clone(), local_listener));
    let mut transparent_addr = None;
    if let Some(t) = opts.transparent {
        let l = tokio::net::TcpListener::bind(t).await.with_context(|| format!("binding the transparent listener on {t}"))?;
        transparent_addr = Some(l.local_addr()?);
        tasks.push(crate::transparent::spawn(agent.clone(), l, proxy_addr));
    }
    if opts.sync {
        let a = agent.clone();
        tasks.push(tokio::spawn(async move { crate::sync::run_loop(a).await }));
    }
    tasks.push(tokio::spawn(watch_data_dir(agent.clone())));
    tracing::info!(proxy = %proxy_addr, local = %local_addr, transparent = ?transparent_addr, enrolled = agent.enrolled(), "vibtra-guard running");
    Ok(Running { agent, proxy_addr, local_addr, transparent_addr, tasks })
}
