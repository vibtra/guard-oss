// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use bytes::Bytes;
use common::*;
use futures::StreamExt;
use serde_json::Value;
use std::sync::Arc;
use std::time::{Duration, Instant};
use vibtra_guard_agent::agent::{Agent, BlockInfo, Options};
use vibtra_guard_agent::local::{handle, sse_stream_every, LocalBody, LocalRequest, LocalResponse};
use vibtra_guard_agent::sync::{enrol, sync_once};
use vibtra_guard_agent::types::Action;

const EV: &str = "gev_00000000000000a1";

#[tokio::test]
async fn desktop_views_are_bounded_metadata_only_and_keep_activity_after_upload() {
    let (_reg, agent) = enrolled().await;
    let policy = handle(&agent, get("/policy")).await;
    assert_eq!(header(&policy, "cache-control"), Some("no-store"));
    assert_eq!(header(&policy, "access-control-allow-origin"), None);
    assert_eq!(json(&policy)["available"], true);
    assert_eq!(json(&policy)["contentRules"][0]["detector"], "au-tfn");
    assert!(!body(&policy).contains("falcon"), "detector keywords stay out of policy summaries");

    for i in 0..305 {
        let event = vibtra_guard_agent::types::Event {
            event_id: format!("gev_{i:016x}"),
            action: "observed".into(),
            kind: "flow".into(),
            occurred_at: "2026-10-17T00:00:00.000Z".into(),
            ..Default::default()
        };
        agent.record(&event, serde_json::json!({ "inspection": { "state": "flow-only", "reason": "encoded-body" } })).await;
    }
    let activity = handle(&agent, get("/activity")).await;
    assert_eq!(header(&activity, "access-control-allow-origin"), None);
    let rows = json(&activity);
    assert_eq!(rows["events"].as_array().unwrap().len(), 300);
    assert_eq!(rows["events"][0]["eventId"], "gev_0000000000000130");
    assert_eq!(rows["events"][0]["inspection"]["reason"], "encoded-body");
    assert!(agent.queue.peek(500).await.iter().all(|e| serde_json::to_value(e).unwrap().get("inspection").is_none()));
    for _ in 0..4 {
        sync_once(&agent).await.unwrap();
    }
    assert!(agent.queue.is_empty().await);
    assert_eq!(agent.activity_json()["events"].as_array().unwrap().len(), 300);
}

#[tokio::test]
async fn an_unenrolled_agent_never_claims_a_policy_is_active() {
    let agent = open(&temp_dir("desktop-unenrolled"));
    assert_eq!(agent.policy_json()["available"], false);
    assert_eq!(agent.activity_json()["events"], serde_json::json!([]));
}

fn req(method: &str, path: &str, accept: &str, content_type: &str, body: &str) -> LocalRequest {
    LocalRequest { method: method.into(), path: path.into(), accept: accept.into(), content_type: content_type.into(), body: Bytes::from(body.to_string()) }
}

fn get(path: &str) -> LocalRequest {
    req("GET", path, "*/*", "", "")
}

fn header<'a>(r: &'a LocalResponse, name: &str) -> Option<&'a str> {
    r.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
}

fn body(r: &LocalResponse) -> String {
    match &r.body {
        LocalBody::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        LocalBody::Sse(_) => panic!("an SSE body"),
    }
}

fn json(r: &LocalResponse) -> Value {
    serde_json::from_str(&body(r)).unwrap()
}

fn block(requests_enabled: bool, workspace: Option<&str>) -> BlockInfo {
    BlockInfo {
        event_id: EV.into(),
        occurred_at: "2026-10-16T00:00:00.000Z".into(),
        service_id: "openai-chatgpt".into(),
        service_name: "ChatGPT".into(),
        host: "chatgpt.com".into(),
        action: Action::Block,
        rule_id: Some("gcr_00000001".into()),
        rule_name: Some("Tax file numbers".into()),
        rule_kind: "content".into(),
        match_type: Some("au-tfn".into()),
        match_count: Some(1),
        example: Some("123***782".into()),
        note: None,
        app: None,
        requests_enabled,
        workspace: workspace.map(str::to_string),
        enforced: true,
    }
}

fn open(dir: &std::path::Path) -> Arc<Agent> {
    Agent::open(&Options { data_dir: Some(dir.to_path_buf()), sync: false, ..Default::default() }).unwrap()
}

async fn enrolled() -> (FakeRegistry, Arc<Agent>) {
    let reg = fake_registry().await;
    let agent = open(&temp_dir("local"));
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&agent).await.unwrap();
    (reg, agent)
}

async fn notified(agent: &Agent) -> bool {
    tokio::time::timeout(Duration::from_secs(2), agent.sync_now.notified()).await.is_ok()
}

#[tokio::test]
async fn the_preflight_and_the_small_doors() {
    let agent = open(&temp_dir("local-doors"));
    let r = handle(&agent, req("OPTIONS", "/blocked/gev_x/status", "*/*", "", "")).await;
    assert_eq!(r.status, 204);
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    assert_eq!(header(&r, "access-control-allow-methods"), Some("GET, POST"));
    assert_eq!(header(&r, "access-control-allow-headers"), Some("content-type"));
    assert_eq!(header(&r, "access-control-allow-private-network"), Some("true"), "Chrome's Private Network Access preflight");

    let r = handle(&agent, get("/")).await;
    assert_eq!(r.status, 200);
    assert!(header(&r, "content-type").unwrap().starts_with("text/html"));
    assert!(header(&r, "content-security-policy").unwrap().starts_with("default-src 'none'"));
    assert!(body(&r).contains("<h1>Vibtra Guard is running</h1>"));

    let r = handle(&agent, get("/healthz?probe=1")).await;
    assert_eq!((r.status, body(&r).as_str()), (200, "ok\n"), "the query string is ignored");
    let r = handle(&agent, get("/ca.pem")).await;
    assert_eq!(header(&r, "content-type"), Some("application/x-pem-file"));
    assert!(body(&r).contains("BEGIN CERTIFICATE") && !body(&r).contains("PRIVATE KEY"), "the certificate, never the key");
    let r = handle(&agent, get("/status")).await;
    assert_eq!(json(&r)["state"], "not enrolled");
    assert!(header(&r, "access-control-allow-origin").is_none(), "no CORS on /status: a web page cannot read it");

    for path in ["/nope", "/blocked", "/blocked/not-an-event", "/other/gev_00000000000000a1"] {
        assert_eq!(handle(&agent, get(path)).await.status, 404, "{path}");
    }
    assert_eq!(handle(&agent, req("POST", "/healthz", "*/*", "", "")).await.status, 404);
}

#[tokio::test]
async fn a_block_no_longer_on_file_answers_404_in_both_shapes() {
    let agent = open(&temp_dir("local-gone"));
    let r = handle(&agent, req("GET", "/blocked/gev_ffffffffffffffff", "text/html,*/*", "", "")).await;
    assert_eq!(r.status, 404);
    assert!(body(&r).contains("This block is no longer on file"));
    let r = handle(&agent, get("/blocked/gev_ffffffffffffffff/status")).await;
    assert_eq!(r.status, 404);
    assert_eq!(json(&r)["code"], "GUARD_EVENT_UNKNOWN");
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"), "the inline page's poll can read the refusal");
}

#[tokio::test]
async fn request_access_when_requests_are_off_is_refused_locally() {
    let (reg, agent) = enrolled().await;
    agent.remember(block(false, None));
    reg.state.lock().unwrap().calls.clear();
    let r = handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "*/*", "application/json", r#"{"note":"x"}"#)).await;
    assert_eq!(r.status, 403);
    assert_eq!(json(&r)["code"], "GUARD_REQUESTS_OFF");
    assert!(reg.state.lock().unwrap().calls.is_empty(), "nothing is filed");
}

#[tokio::test]
async fn request_access_files_the_ask_and_answers_by_shape() {
    let (reg, agent) = enrolled().await;
    agent.remember(block(true, None));
    let r = handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "*/*", "application/x-www-form-urlencoded", "note=month+end")).await;
    assert_eq!(r.status, 303);
    assert_eq!(header(&r, "location").unwrap(), format!("{}/blocked/{EV}", agent.local_base()));
    assert!(notified(&agent).await, "filing an ask syncs at once");
    let r = handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "application/json", "application/json", r#"{"note":"  "}"#)).await;
    assert_eq!(r.status, 200);
    assert_eq!(json(&r)["request"]["status"], "pending");
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    let s = reg.state.lock().unwrap();
    assert_eq!(s.asks.len(), 2);
    assert_eq!(s.calls.iter().filter(|c| c.as_str() == "POST requests").count(), 2);
}

#[tokio::test]
async fn request_access_with_the_registry_unreachable_answers_502() {
    let (_reg, agent) = enrolled().await;
    agent.remember(block(true, None));
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    agent.device.write().unwrap().as_mut().unwrap().server.base_url = format!("http://{dead}");
    let r = handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "text/html", "application/x-www-form-urlencoded", "note=x")).await;
    assert_eq!(r.status, 502);
    let html = body(&r);
    assert!(html.contains("The request did not reach IT") && html.contains("network:"), "{html}");
    let r = handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "*/*", "application/json", "{}")).await;
    assert_eq!(r.status, 502);
    assert_eq!(json(&r)["code"], "GUARD_REQUEST_FAILED");
    assert_eq!(header(&r, "access-control-allow-origin"), Some("*"));
    assert!(agent.ask_for(EV).is_none(), "no ask is remembered when none was filed");
}

#[tokio::test]
async fn the_workspace_door_redirects_or_404s() {
    let (_reg, agent) = enrolled().await;
    agent.remember(block(true, Some("https://fernwood.example/workspace")));
    let before = agent.queue.len().await;
    let r = handle(&agent, get(&format!("/blocked/{EV}/workspace"))).await;
    assert_eq!(r.status, 302);
    assert_eq!(header(&r, "location"), Some("https://fernwood.example/workspace"));
    assert_eq!(agent.queue.len().await, before + 1, "`redirected` is recorded");
    let queued = std::fs::read_to_string(agent.paths.events()).unwrap();
    assert!(queued.lines().last().unwrap().contains("\"action\":\"redirected\""));

    agent.remember(block(true, None));
    let r = handle(&agent, get(&format!("/blocked/{EV}/workspace"))).await;
    assert_eq!(r.status, 404);
    assert_eq!(body(&r), "no workspace is configured\n");
    assert_eq!(handle(&agent, req("DELETE", &format!("/blocked/{EV}"), "*/*", "", "")).await.status, 404);
    assert_eq!(handle(&agent, get(&format!("/blocked/{EV}/unknown"))).await.status, 404);
}

#[tokio::test]
async fn the_status_poll_refreshes_a_stale_ask_and_nudges_a_sync_until_the_grant_lands() {
    let (reg, agent) = enrolled().await;
    agent.remember(block(true, None));
    let status = |agent: Arc<Agent>| async move { json(&handle(&agent, get(&format!("/blocked/{EV}/status"))).await) };

    let s = status(agent.clone()).await;
    assert_eq!((s["status"].as_str(), s["applied"].as_bool()), (Some("none"), Some(false)));

    handle(&agent, req("POST", &format!("/blocked/{EV}/request"), "*/*", "application/json", "{}")).await;
    assert!(notified(&agent).await);
    reg.state.lock().unwrap().calls.clear();
    assert_eq!(status(agent.clone()).await["status"], "pending");
    assert!(reg.state.lock().unwrap().calls.is_empty(), "checked < 3 s ago: no registry call");

    reg.approve_latest();
    agent.asks.lock().unwrap().get_mut(EV).unwrap().checked = Instant::now() - Duration::from_secs(4);
    let s = status(agent.clone()).await;
    assert_eq!(reg.state.lock().unwrap().calls, vec!["GET requests"]);
    assert_eq!(s["status"], "approved");
    assert_eq!(s["applied"], false);
    assert_eq!(s["grantExpiresAt"], "2099-10-23T00:00:00.000Z");
    assert!(notified(&agent).await, "the approval is announced and syncs");
    reg.state.lock().unwrap().calls.clear();
    assert_eq!(status(agent.clone()).await["applied"], false);
    assert!(notified(&agent).await, "approved but not applied: sync now");
    assert!(reg.state.lock().unwrap().calls.is_empty());

    sync_once(&agent).await.unwrap();
    let s = status(agent.clone()).await;
    assert_eq!(s["applied"], true);
    assert!(tokio::time::timeout(Duration::from_millis(200), agent.sync_now.notified()).await.is_err(), "applied: no nudge");
    let html = body(&handle(&agent, req("GET", &format!("/blocked/{EV}"), "text/html", "", "")).await);
    assert!(html.contains("Try again"));
}

#[tokio::test]
async fn the_events_stream_frames_messages_and_keeps_alive() {
    let agent = open(&temp_dir("local-sse"));
    let r = handle(&agent, get("/events")).await;
    assert_eq!(header(&r, "content-type"), Some("text/event-stream"));
    let LocalBody::Sse(rx) = r.body else { panic!("an SSE body") };
    let mut stream = Box::pin(sse_stream_every(rx, Duration::from_millis(50)));
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("a frame").unwrap(), Bytes::from_static(b": vibtra-guard events\n\n"));
    agent.emit("synced", serde_json::json!({ "ok": true }));
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("a frame").unwrap(),
        Bytes::from_static(b"event: synced\ndata: {\"ok\":true}\n\n")
    );
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), stream.next()).await.expect("a frame").unwrap(), Bytes::from_static(b": keep-alive\n\n"));
}

#[tokio::test]
async fn a_lagging_subscriber_skips_ahead_and_a_closed_bus_ends_the_stream() {
    use vibtra_guard_agent::agent::Sse;
    let (tx, rx) = tokio::sync::broadcast::channel::<Sse>(1);
    for n in 0..3 {
        tx.send(Sse { event: "decision", data: n.to_string() }).unwrap();
    }
    drop(tx);
    let frames: Vec<Bytes> = tokio::time::timeout(Duration::from_secs(5), sse_stream_every(rx, Duration::from_secs(60)).collect()).await.unwrap();
    assert_eq!(frames, vec![Bytes::from_static(b": vibtra-guard events\n\n"), Bytes::from_static(b"event: decision\ndata: 2\n\n")]);
}
