// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
#![allow(dead_code)]

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use vibtra_guard_agent::bundle::{public_key_pem, sign_document, SignSpec};

pub const TEST_KEY: [u8; 32] = [7u8; 32];
pub const TEST_KEY_ID: &str = "gk_0000feed";
pub const DEVICE_ID: &str = "gdev_00000000000000aa";
pub const ENROL_TOKEN: &str = "genr_0123456789abcdef0123456789abcdef";
pub const DEVICE_TOKEN: &str = "gdt_0123456789abcdef0123456789abcdef0123456789abcdef";

pub fn temp_dir(name: &str) -> PathBuf {
    let root = std::env::var_os("VIBTRA_GUARD_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let d = root.join(format!("vibtra-guard-test-{name}-{}-{}", std::process::id(), rand_suffix()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn rand_suffix() -> u64 {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos() as u64 % 1_000_000_007) * 1000 + n
}

pub fn seed_catalogue_value() -> Value {
    let v: Value = serde_json::from_str(include_str!("../fixtures/contract.json")).unwrap();
    v["catalogue"].clone()
}

pub fn base_bundle(version: u64, mode: &str) -> Value {
    json!({
        "protocol": 1,
        "orgId": "org_fernwood",
        "deviceId": DEVICE_ID,
        "bundleVersion": version,
        "catalogueVersion": "2026-10-16",
        "generatedAt": "2026-10-16T00:00:00.000Z",
        "person": { "userId": "user_ada", "email": "ada@fernwood.example" },
        "clientMode": mode,
        "defaultAction": "allow",
        "services": {
            "deepseek": { "action": "block", "ruleId": "gsr_00000002", "note": "Not approved for company data." },
            "openai-chatgpt": { "action": "allow", "ruleId": "gsr_00000001" }
        },
        "contentRules": [
            { "ruleId": "gcr_00000001", "name": "Tax file numbers", "detector": { "kind": "au-tfn" }, "services": "*", "action": "block", "note": "A TFN is never pasted into an AI service." },
            { "ruleId": "gcr_00000003", "name": "Project words", "detector": { "kind": "keyword", "keywords": ["falcon"] }, "services": "*", "action": "allow" }
        ],
        "exceptions": [],
        "settings": { "requestsEnabled": true, "workspaceRedirect": { "enabled": true, "url": "https://fernwood.example/workspace" }, "snippetPolicy": "redacted", "snippetMax": 80 }
    })
}

#[derive(Default)]
pub struct FakeState {
    pub bundle: Value,
    pub catalogue: Value,
    pub revoked: bool,
    pub tamper_next_bundle: bool,
    pub tamper_next_catalogue: bool,
    pub preflight_key_id: Option<String>,
    pub events: Vec<Value>,
    pub asks: Vec<Value>,
    pub calls: Vec<String>,
    pub postflights: Vec<Value>,
    pub preflights: Vec<Value>,
    pub enrolled: bool,
}

pub struct FakeRegistry {
    pub addr: SocketAddr,
    pub state: Arc<Mutex<FakeState>>,
}

impl FakeRegistry {
    pub fn base(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn approve_latest(&self) {
        let mut s = self.state.lock().unwrap();
        let ask = s.asks.last_mut().expect("an ask");
        ask["status"] = json!("approved");
        ask["decidedAt"] = json!("2026-10-16T01:00:00.000Z");
        ask["grantExpiresAt"] = json!("2099-10-23T00:00:00.000Z");
        let subject = ask["subject"].clone();
        let mut exc = json!({ "grantId": "pg_test1", "scope": "user", "serviceId": subject["serviceId"], "expiresAt": "2099-10-23T00:00:00.000Z" });
        if let Some(r) = subject.get("ruleId") {
            exc["ruleId"] = r.clone();
        }
        s.bundle["exceptions"].as_array_mut().unwrap().push(exc);
    }
}

fn reply(status: u16, v: Value) -> Response<Full<Bytes>> {
    Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(v.to_string()))).unwrap()
}

fn sign_bundle(bundle: &Value) -> Value {
    sign_document(
        SignSpec {
            kind: "bundle",
            doc_field: "bundle",
            key_id: TEST_KEY_ID,
            org_id: "org_fernwood",
            device_id: Some(DEVICE_ID),
            version: bundle["bundleVersion"].clone(),
            iat: 1_760_000_000,
        },
        bundle,
        &TEST_KEY,
    )
    .unwrap()
}

fn sign_catalogue(cat: &Value) -> Value {
    sign_document(
        SignSpec {
            kind: "catalogue",
            doc_field: "catalogue",
            key_id: TEST_KEY_ID,
            org_id: "org_fernwood",
            device_id: None,
            version: cat["version"].clone(),
            iat: 1_760_000_000,
        },
        cat,
        &TEST_KEY,
    )
    .unwrap()
}

async fn route(state: Arc<Mutex<FakeState>>, base: String, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let auth = req.headers().get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let body = req.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let door = path.trim_start_matches("/api/guard/v1/").split('/').next().unwrap_or("").to_string();
    state.lock().unwrap().calls.push(format!("{method} {door}"));
    if door == "enrol" {
        if body["enrolToken"] != ENROL_TOKEN || body["protocol"] != 1 || body["ca"]["fingerprintSha256"].as_str().map(|s| s.len()) != Some(64) {
            return reply(400, json!({ "code": "GUARD_ENROL_TOKEN_INVALID", "message": "bad enrol" }));
        }
        state.lock().unwrap().enrolled = true;
        return reply(
            200,
            json!({
                "deviceId": DEVICE_ID, "deviceToken": DEVICE_TOKEN, "orgId": "org_fernwood", "orgHandle": "fernwood", "orgName": "Fernwood",
                "person": { "userId": "user_ada", "email": "ada@fernwood.example", "name": "Ada" },
                "server": { "baseUrl": base, "syncIntervalSeconds": 60, "batchSize": 2 },
                "signing": { "keyId": TEST_KEY_ID, "alg": "ES256", "publicKeyPem": public_key_pem(&TEST_KEY).unwrap() },
                "clientMode": "enforce"
            }),
        );
    }
    if auth != format!("Bearer {DEVICE_TOKEN}") {
        return reply(401, json!({ "code": "GUARD_TOKEN_INVALID", "message": "bearer" }));
    }
    if state.lock().unwrap().revoked {
        return reply(401, json!({ "code": "GUARD_DEVICE_REVOKED", "message": "revoked" }));
    }
    if !path.ends_with(DEVICE_ID) {
        return reply(404, json!({ "code": "GUARD_DEVICE_UNKNOWN", "message": "who" }));
    }
    let mut s = state.lock().unwrap();
    match (method.as_str(), door.as_str()) {
        ("POST", "preflight") => {
            assert_eq!(body["protocol"], 1);
            s.preflights.push(body.clone());
            let digest_changed = true;
            let rules_changed = body.get("bundleVersion") != Some(&s.bundle["bundleVersion"]) || digest_changed;
            reply(
                200,
                json!({
                    "clientMode": s.bundle["clientMode"], "syncIntervalSeconds": 60, "batchSize": 2, "cleanSync": false,
                    "bundleVersion": s.bundle["bundleVersion"], "catalogueVersion": s.catalogue["version"],
                    "rulesChanged": rules_changed, "catalogueChanged": body.get("catalogueVersion") != Some(&s.catalogue["version"]),
                    "signingKeyId": s.preflight_key_id.clone().unwrap_or_else(|| TEST_KEY_ID.to_string()), "person": { "userId": "user_ada", "email": "ada@fernwood.example" }, "serverTime": "2026-10-16T00:00:00.000Z"
                }),
            )
        }
        ("POST", "ruledownload") => {
            assert_eq!(body["protocol"], 1);
            let mut out = json!({});
            let mut signed = sign_bundle(&s.bundle);
            if s.tamper_next_bundle {
                s.tamper_next_bundle = false;
                signed["bundle"]["defaultAction"] = json!("block");
            }
            out["bundle"] = signed;
            if body.get("catalogueVersion") != Some(&s.catalogue["version"]) {
                let mut cat = sign_catalogue(&s.catalogue);
                if s.tamper_next_catalogue {
                    s.tamper_next_catalogue = false;
                    cat["catalogue"]["services"][0]["enabled"] = json!(false);
                }
                out["catalogue"] = cat;
            }
            reply(200, out)
        }
        ("POST", "eventupload") => {
            assert_eq!(body["protocol"], 1);
            let events = body["events"].as_array().cloned().unwrap_or_default();
            let mut rejected = Vec::new();
            let mut accepted = 0;
            for e in events {
                let ok = e["eventId"].as_str().is_some_and(|id| id.starts_with("gev_") && id.len() == 20) && e.get("body").is_none() && e.get("url").is_none();
                if ok {
                    accepted += 1;
                    s.events.push(e);
                } else {
                    rejected.push(json!({ "eventId": e["eventId"], "reason": "malformed" }));
                }
            }
            reply(200, json!({ "accepted": accepted, "rejected": rejected }))
        }
        ("POST", "postflight") => {
            assert_eq!(body["protocol"], 1);
            s.postflights.push(body.clone());
            reply(200, json!({ "ok": true, "nextSyncInSeconds": 60 }))
        }
        ("POST", "requests") => {
            let n = s.asks.len() + 1;
            let mut subject = json!({ "serviceId": body["serviceId"], "deviceId": DEVICE_ID });
            for k in ["ruleId", "matchType", "eventId", "app"] {
                if let Some(v) = body.get(k) {
                    subject[k] = v.clone();
                }
            }
            let ask = json!({ "requestId": format!("pr_{n:04}"), "kind": "guard", "status": "pending", "subject": subject, "createdAt": "2026-10-16T00:00:00.000Z", "expiresAt": "2026-10-30T00:00:00.000Z" });
            s.asks.push(ask.clone());
            reply(200, json!({ "request": ask, "created": true }))
        }
        ("GET", "requests") => reply(200, json!({ "requests": s.asks })),
        _ => reply(404, json!({ "code": "NOT_FOUND", "message": path })),
    }
}

pub async fn fake_registry() -> FakeRegistry {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(Mutex::new(FakeState { bundle: base_bundle(3, "enforce"), catalogue: seed_catalogue_value(), ..Default::default() }));
    let st = state.clone();
    let base = format!("http://{addr}");
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let st = st.clone();
            let base = base.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req| {
                    let st = st.clone();
                    let base = base.clone();
                    async move { Ok::<_, Infallible>(route(st, base, req).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });
    FakeRegistry { addr, state }
}

pub async fn mock_ai() -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let seen = s2.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let seen = seen.clone();
                    async move {
                        let host = req.headers().get("host").and_then(|h| h.to_str().ok()).unwrap_or("").to_string();
                        let path = req.uri().path().to_string();
                        let body = req.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
                        let n = body.len();
                        use sha2::Digest;
                        let digest = hex::encode(sha2::Sha256::digest(&body));
                        seen.lock().unwrap().push(format!("{host}{path}"));
                        Ok::<_, Infallible>(
                            Response::builder()
                                .status(200)
                                .header("x-seen-host", host)
                                .header("x-seen-bytes", n.to_string())
                                .header("x-seen-sha256", digest)
                                .body(Full::new(Bytes::from_static(b"upstream ok")))
                                .unwrap(),
                        )
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    });
    (addr, seen)
}
