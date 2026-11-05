// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use common::*;
use std::sync::Arc;
use vibtra_guard_agent::agent::{start, Options, Running};
use vibtra_guard_agent::sync::{enrol, sync_once};

async fn tls_upstream() -> (u16, String) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(vec!["localhost".to_string()]).unwrap().self_signed(&key).unwrap();
    let cert_pem = cert.pem();
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![cert.der().clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = listener.accept().await else { continue };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else { return };
                let svc = hyper::service::service_fn(|_req: hyper::Request<hyper::body::Incoming>| async {
                    Ok::<_, std::convert::Infallible>(hyper::Response::new(http_body_util::Full::new(bytes::Bytes::from_static(b"plain site"))))
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(tls), svc).await;
            });
        }
    });
    (port, cert_pem)
}

struct Rig {
    mock: std::net::SocketAddr,
    tls_pem: String,
    reg: FakeRegistry,
    running: Running,
    client: reqwest::Client,
    seen: Arc<std::sync::Mutex<Vec<String>>>,
    tls_port: u16,
}

async fn rig() -> Rig {
    rig_with(Vec::new(), |_| {}).await
}

fn client_for(running: &Running, tls_pem: &str) -> reqwest::Client {
    reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", running.proxy_addr)).unwrap())
        .tls_certs_only([
            reqwest::Certificate::from_pem(running.agent.ca.cert_pem.as_bytes()).unwrap(),
            reqwest::Certificate::from_pem(tls_pem.as_bytes()).unwrap(),
        ])
        .build()
        .unwrap()
}

async fn rig_with(extra_map: Vec<(String, url::Url)>, prepare: impl FnOnce(&mut FakeState)) -> Rig {
    vibtra_guard_agent::init_crypto();
    let reg = fake_registry().await;
    prepare(&mut reg.state.lock().unwrap());
    let (mock, seen) = mock_ai().await;
    let (tls_port, tls_pem) = tls_upstream().await;
    let dir = temp_dir("proxy");
    let target = url::Url::parse(&format!("http://{mock}")).unwrap();
    let mut upstream_map = vec![("chatgpt.com".into(), target.clone()), ("chat.deepseek.com".into(), target.clone()), ("claude.ai".into(), target)];
    upstream_map.extend(extra_map);
    let running = start(Options {
        data_dir: Some(dir),
        proxy: "127.0.0.1:0".parse().unwrap(),
        local: "127.0.0.1:0".parse().unwrap(),
        upstream_map,
        sync: false,
        ..Default::default()
    })
    .await
    .unwrap();
    enrol(&running.agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&running.agent).await.unwrap();
    let client = client_for(&running, &tls_pem);
    Rig { mock, tls_pem, reg, running, client, seen, tls_port }
}

#[tokio::test]
async fn the_proxy_blocks_allows_tunnels_and_redirects() {
    let r = rig().await;
    let local = format!("http://{}", r.running.local_addr);
    let mut feed = reqwest::Client::builder().no_proxy().build().unwrap().get(format!("{local}/events")).send().await.unwrap();
    assert_eq!(feed.status(), 200);

    let res = r
        .client
        .post("https://chatgpt.com/backend-api/conversation")
        .header("content-type", "application/json")
        .header("origin", "https://chatgpt.com")
        .body(r#"{"messages":[{"content":"my tfn is 123 456 782"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let header = res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().to_string();
    assert!(header.starts_with("blocked; event=gev_"), "{header}");
    assert_eq!(res.headers().get("access-control-allow-origin").unwrap(), "https://chatgpt.com");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["code"], "GUARD_BLOCKED");
    assert_eq!(body["action"], "block");
    assert_eq!(body["ruleId"], "gcr_00000001");
    assert_eq!(body["requestsEnabled"], true);
    assert_eq!(body["workspace"], "https://fernwood.example/workspace");
    let event_id = body["eventId"].as_str().unwrap().to_string();
    assert_eq!(header, format!("blocked; event={event_id}"));
    assert_eq!(body["blockPage"], format!("{local}/blocked/{event_id}"));
    assert!(r.seen.lock().unwrap().is_empty(), "a blocked request never reaches the upstream");

    let decision = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut buf = String::new();
        loop {
            let chunk = feed.chunk().await.unwrap().expect("the feed stays open");
            buf.push_str(&String::from_utf8_lossy(&chunk));
            for block in buf.split("\n\n") {
                if !block.contains("event: decision") {
                    continue;
                }
                let data: String = block.lines().filter_map(|l| l.strip_prefix("data:")).map(str::trim_start).collect();
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&data) {
                    if v["eventId"] == event_id.as_str() {
                        return v;
                    }
                }
            }
        }
    })
    .await
    .expect("a decision event for the block");
    assert_eq!(decision["requestsEnabled"], true);
    assert_eq!(decision["workspace"]["enabled"], true);
    assert_eq!(decision["workspace"]["url"], "https://fernwood.example/workspace");
    let status: serde_json::Value =
        reqwest::Client::builder().no_proxy().build().unwrap().get(format!("{local}/status")).send().await.unwrap().json().await.unwrap();
    assert_eq!(status["settings"]["requestsEnabled"], true);
    assert_eq!(status["settings"]["workspaceRedirect"]["url"], "https://fernwood.example/workspace");

    let res = r
        .client
        .post("https://chatgpt.com/backend-api/conversation")
        .header("content-type", "application/json")
        .body(r#"{"messages":[{"content":"hello"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let stamp = res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().to_string();
    assert!(stamp == "allowed" || stamp == "observed", "{stamp}");
    assert_eq!(res.headers().get("x-seen-host").unwrap(), "chatgpt.com");
    assert_eq!(res.text().await.unwrap(), "upstream ok");

    let res = r.client.get(format!("https://localhost:{}/", r.tls_port)).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("x-vibtra-guard").is_none());
    assert_eq!(res.text().await.unwrap(), "plain site");

    let res = r.client.get("https://chat.deepseek.com/").header("accept", "text/html,application/xhtml+xml").send().await.unwrap();
    assert_eq!(res.status(), 403);
    assert!(res.headers().get("content-type").unwrap().to_str().unwrap().starts_with("text/html"));
    let html = res.text().await.unwrap();
    assert!(html.contains("DeepSeek is blocked on this laptop") && html.contains("Not approved for company data.") && html.contains("Request access"));

    let plain = reqwest::Client::builder().no_proxy().build().unwrap();
    let page = plain.get(format!("{local}/blocked/{event_id}")).send().await.unwrap();
    assert_eq!(page.status(), 200);
    let html = page.text().await.unwrap();
    assert!(
        html.contains("This was not sent to ChatGPT")
            && html.contains("123***782")
            && html.contains("This is blocked because: A TFN is never pasted into an AI service.")
    );
    assert!(!html.contains("123 456 782"), "the page shows the redacted form only");
    assert!(html.contains("Use the company Vibtra workspace"));
    let magic = r.client.get(format!("http://guard.vibtra.local/blocked/{event_id}")).send().await.unwrap();
    assert_eq!(magic.status(), 200);
    let healthz = r.client.get("http://guard.vibtra.local/healthz").send().await.unwrap().text().await.unwrap();
    assert_eq!(healthz, "ok\n");

    let res = plain
        .post(format!("{local}/blocked/{event_id}/request"))
        .header("content-type", "application/json")
        .body(r#"{"note":"payroll month end"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ask: serde_json::Value = res.json().await.unwrap();
    assert_eq!(ask["request"]["status"], "pending");
    {
        let s = r.reg.state.lock().unwrap();
        let a = s.asks.last().unwrap();
        assert_eq!(a["subject"]["serviceId"], "openai-chatgpt");
        assert_eq!(a["subject"]["ruleId"], "gcr_00000001");
        assert_eq!(a["subject"]["matchType"], "au-tfn");
        assert_eq!(a["subject"]["eventId"], event_id.as_str());
    }
    let page = plain.get(format!("{local}/blocked/{event_id}")).send().await.unwrap().text().await.unwrap();
    assert!(page.contains("Waiting for IT"));
    assert!(page.contains("<title>Waiting for IT: ") && page.contains("id=\"ask\" role=\"status\""));

    r.reg.approve_latest();
    sync_once(&r.running.agent).await.unwrap();
    let st: serde_json::Value = plain.get(format!("{local}/blocked/{event_id}/status")).send().await.unwrap().json().await.unwrap();
    assert_eq!(st["status"], "approved");
    assert_eq!(st["applied"], true);
    let page = plain.get(format!("{local}/blocked/{event_id}")).send().await.unwrap().text().await.unwrap();
    assert!(page.contains("Approved until 2099-10-23") && page.contains("Try again") && page.contains("<title>Approved: "));
    let res = r
        .client
        .post("https://chatgpt.com/backend-api/conversation")
        .header("content-type", "application/json")
        .body(r#"{"messages":[{"content":"my tfn is 123 456 782"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "the grant lets the retry through");
    let stamp = res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().to_string();
    assert!(stamp.starts_with("allowed; grant="), "the retry names the grant that let it through: {stamp}");

    let res = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap()
        .get(format!("{local}/blocked/{event_id}/workspace"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 302);
    assert_eq!(res.headers().get("location").unwrap(), "https://fernwood.example/workspace");

    let uploaded = serde_json::to_string(&r.reg.state.lock().unwrap().events).unwrap();
    let queued = format!("{uploaded}\n{}", std::fs::read_to_string(r.running.agent.paths.events()).unwrap());
    assert!(queued.contains("\"requested\"") && queued.contains("\"redirected\""));
    assert!(!queued.contains("123 456 782") && !queued.contains("payroll month end") && !queued.contains("hello"));

    let status: serde_json::Value = plain.get(format!("{local}/status")).send().await.unwrap().json().await.unwrap();
    assert_eq!(status["state"], "enforcing");
    assert_eq!(status["proxyListening"], true);
    assert!(status.get("token").is_none() && !status.to_string().contains(DEVICE_TOKEN));
}

#[tokio::test]
async fn monitor_mode_forwards_and_says_would_block() {
    let r = rig().await;
    r.reg.state.lock().unwrap().bundle = base_bundle(4, "monitor");
    sync_once(&r.running.agent).await.unwrap();
    let res =
        r.client.post("https://chatgpt.com/backend-api/conversation").header("content-type", "text/plain").body("my tfn is 123 456 782").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().starts_with("would-block; event=gev_"));
    let queued = std::fs::read_to_string(r.running.agent.paths.events()).unwrap();
    assert!(queued.contains("\"reason\":\"monitor\""));
}

#[tokio::test]
async fn transparent_listener_routes_by_sni() {
    use tokio::io::AsyncWriteExt;
    let r = rig().await;
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let taddr = l.local_addr().unwrap();
    let _t = vibtra_guard_agent::transparent::spawn(r.running.agent.clone(), l, r.running.proxy_addr);
    let mut tcp = tokio::net::TcpStream::connect(taddr).await.unwrap();
    tcp.write_all(b"PROXY TCP4 127.0.0.1 104.18.32.47 50000 443\r\n").await.unwrap();
    let mut roots = rustls::RootCertStore::empty();
    for c in rustls_pemfile::certs(&mut r.running.agent.ca.cert_pem.as_bytes()) {
        roots.add(c.unwrap()).unwrap();
    }
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg))
        .connect(rustls::pki_types::ServerName::try_from("chatgpt.com").unwrap(), tcp)
        .await
        .expect("the agent answers TLS for the SNI under its CA");
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls)).await.unwrap();
    tokio::spawn(conn);
    let req = hyper::Request::post("/backend-api/conversation")
        .header("host", "chatgpt.com")
        .header("content-type", "text/plain")
        .body(http_body_util::Full::new(bytes::Bytes::from_static(b"tfn 123 456 782")))
        .unwrap();
    let res = sender.send_request(req).await.unwrap();
    assert_eq!(res.status(), 403);
    assert!(res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().starts_with("blocked; event="));
}

fn queued(r: &Rig) -> Vec<serde_json::Value> {
    std::fs::read_to_string(r.running.agent.paths.events())
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

async fn raw(r: &Rig, request: String) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut c = tokio::net::TcpStream::connect(r.running.proxy_addr).await.unwrap();
    c.write_all(request.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(std::time::Duration::from_secs(10), c.read_to_end(&mut out)).await.expect("an answer").unwrap();
    String::from_utf8_lossy(&out).into_owned()
}

fn localhost_row(enabled: bool) -> serde_json::Value {
    serde_json::json!({ "serviceId": "local-ai", "name": "Local AI", "vendor": "Test", "category": "chat", "domains": ["localhost"],
        "bundleIds": [], "cliNames": [], "custom": true, "enabled": enabled })
}

#[tokio::test]
async fn the_host_header_names_the_host_when_the_request_line_does_not() {
    let r = rig().await;
    let body = "tfn 123 456 782";
    for host in ["CHATGPT.COM:8443", "ChatGPT.com"] {
        let answer = raw(
            &r,
            format!(
                "POST /backend-api/conversation HTTP/1.1\r\nHost: {host}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
        .await;
        assert!(answer.starts_with("HTTP/1.1 403"), "{host}: {answer}");
        assert!(answer.to_ascii_lowercase().contains("x-vibtra-guard: blocked; event=gev_"), "{host}");
    }
    let events = queued(&r);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["host"], "chatgpt.com", "lower-cased, port dropped");
    assert_eq!(events[0]["port"], 8443);
    assert!(events[1].get("port").is_none(), "no port in the Host header: none recorded");
    assert!(r.seen.lock().unwrap().is_empty());
    let answer = raw(&r, "GET /healthz HTTP/1.1\r\nHost: GUARD.VIBTRA.LOCAL\r\nConnection: close\r\n\r\n".into()).await;
    assert!(answer.starts_with("HTTP/1.1 200") && answer.ends_with("ok\n"), "{answer}");
}

#[tokio::test]
async fn plain_http_to_a_host_no_row_names_passes_untouched() {
    let r = rig().await;
    let res = r.client.post(format!("http://{}/anything?q=1", r.mock)).header("content-type", "text/plain").body("tfn 123 456 782").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("x-vibtra-guard").is_none(), "not decided, not stamped");
    assert_eq!(res.headers().get("x-seen-bytes").unwrap(), "15", "the body arrives whole");
    assert_eq!(*r.seen.lock().unwrap(), vec![format!("{}/anything", r.mock)]);
    assert!(queued(&r).is_empty(), "no event for a host outside the catalogue");
}

#[tokio::test]
async fn a_disabled_catalogue_row_is_not_intercepted() {
    let r = rig_with(Vec::new(), |s| s.catalogue["services"].as_array_mut().unwrap().push(localhost_row(true))).await;
    let url = format!("https://localhost:{}/v1/chat", r.tls_port);
    let post = || r.client.post(&url).header("content-type", "text/plain").body("tfn 123 456 782").send();
    let res = post().await.unwrap();
    assert_eq!(res.status(), 403);
    assert!(res.headers().get("x-vibtra-guard").unwrap().to_str().unwrap().starts_with("blocked; event="));
    {
        let mut s = r.reg.state.lock().unwrap();
        let rows = s.catalogue["services"].as_array_mut().unwrap();
        *rows.last_mut().unwrap() = localhost_row(false);
        s.catalogue["version"] = serde_json::json!("2026-10-17+org.1");
    }
    assert!(sync_once(&r.running.agent).await.unwrap().catalogue_updated);
    assert!(!r.running.agent.should_intercept("localhost"));
    let before = queued(&r).len();
    let res = client_for(&r.running, &r.tls_pem).post(&url).header("content-type", "text/plain").body("tfn 123 456 782").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("x-vibtra-guard").is_none());
    assert_eq!(res.text().await.unwrap(), "plain site", "the site's own certificate answered: nothing was decrypted");
    assert_eq!(queued(&r).len(), before, "no decision for a disabled row");
}

#[tokio::test]
async fn once_revoked_the_proxy_tunnels_everything_blind() {
    let r = rig_with(Vec::new(), |s| s.catalogue["services"].as_array_mut().unwrap().push(localhost_row(true))).await;
    let url = format!("https://localhost:{}/v1/chat", r.tls_port);
    let post = || r.client.post(&url).header("content-type", "text/plain").body("tfn 123 456 782").send();
    assert_eq!(post().await.unwrap().status(), 403);
    r.reg.state.lock().unwrap().revoked = true;
    assert!(sync_once(&r.running.agent).await.is_err());
    let before = queued(&r).len();
    let res = client_for(&r.running, &r.tls_pem).post(&url).header("content-type", "text/plain").body("tfn 123 456 782").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("x-vibtra-guard").is_none());
    assert_eq!(res.text().await.unwrap(), "plain site");
    let status: serde_json::Value = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .get(format!("http://{}/status", r.running.local_addr))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["state"], "revoked");
    assert_eq!(queued(&r).len(), before, "a revoked agent records nothing");
}

#[tokio::test]
async fn allowed_flow_events_name_their_source() {
    let r = rig_with(Vec::new(), |s| {
        s.bundle["exceptions"] =
            serde_json::json!([{ "grantId": "pg_flow0001", "scope": "user", "serviceId": "deepseek", "expiresAt": "2099-10-23T00:00:00.000Z" }]);
    })
    .await;
    let post = |url: &'static str| r.client.post(url).header("content-type", "text/plain").body("hello").send();
    let res = post("https://chat.deepseek.com/api/v0/chat").await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers().get("x-vibtra-guard").unwrap(), "allowed; grant=pg_flow0001");
    let res = post("https://chatgpt.com/backend-api/conversation").await.unwrap();
    assert_eq!(res.headers().get("x-vibtra-guard").unwrap(), "allowed");
    let res = post("https://claude.ai/api/append_message").await.unwrap();
    assert_eq!(res.headers().get("x-vibtra-guard").unwrap(), "observed");

    let events = queued(&r);
    let by = |service: &str| events.iter().find(|e| e["serviceId"] == service).unwrap_or_else(|| panic!("an event for {service}")).clone();
    let e = by("deepseek");
    assert_eq!((e["kind"].as_str(), e["action"].as_str(), e["ruleKind"].as_str()), (Some("flow"), Some("allowed"), Some("exception")));
    assert!(e.get("ruleId").is_none());
    let e = by("openai-chatgpt");
    assert_eq!((e["action"].as_str(), e["ruleKind"].as_str(), e["ruleId"].as_str()), (Some("allowed"), Some("service"), Some("gsr_00000001")));
    let e = by("anthropic-claude");
    assert_eq!((e["action"].as_str(), e["ruleKind"].as_str()), (Some("observed"), Some("default")));
    assert!(e.get("ruleId").is_none());
    for e in &events {
        assert_eq!(e["bytes"], 5, "the body size is a fact; its text is not");
        assert!(!e.to_string().contains("hello"));
    }
}

#[tokio::test]
async fn flow_facts_are_coalesced_within_their_window() {
    let r = rig().await;
    let agent = r.running.agent.clone();
    let blocked = || async {
        let res = r.client.post("https://chat.deepseek.com/api/v0/chat").header("content-type", "text/plain").body("hi").send().await.unwrap();
        assert_eq!(res.status(), 403);
        res.json::<serde_json::Value>().await.unwrap()["eventId"].as_str().unwrap().to_string()
    };
    let first = blocked().await;
    assert_eq!(blocked().await, first);
    assert_eq!(queued(&r).len(), 1);
    agent.age_dedupe(std::time::Duration::from_secs(59));
    assert_eq!(blocked().await, first, "still inside the minute");
    agent.age_dedupe(std::time::Duration::from_secs(2));
    let second = blocked().await;
    assert_ne!(second, first, "past 60 s: a new fact");
    assert_eq!(queued(&r).len(), 2);

    let get = |path: &str| r.client.get(format!("https://claude.ai{path}")).send();
    assert_eq!(get("/a").await.unwrap().headers().get("x-vibtra-guard").unwrap(), "observed");
    get("/b/c").await.unwrap();
    assert_eq!(queued(&r).len(), 3);
    agent.age_dedupe(std::time::Duration::from_secs(120));
    get("/d").await.unwrap();
    assert_eq!(queued(&r).len(), 3, "two minutes later: still the same fact");
    agent.age_dedupe(std::time::Duration::from_secs(181));
    get("/e").await.unwrap();
    assert_eq!(queued(&r).len(), 4, "past 300 s: a new fact");
    let g = r.client.get("https://chat.deepseek.com/").send().await.unwrap();
    let g1 = g.json::<serde_json::Value>().await.unwrap()["eventId"].as_str().unwrap().to_string();
    agent.age_dedupe(std::time::Duration::from_secs(61));
    let g = r.client.get("https://chat.deepseek.com/").send().await.unwrap();
    assert_ne!(g.json::<serde_json::Value>().await.unwrap()["eventId"].as_str().unwrap(), g1);
    for _ in 0..2 {
        r.client.post("https://chatgpt.com/backend-api/conversation").header("content-type", "text/plain").body("tfn 123 456 782").send().await.unwrap();
    }
    let tfn: Vec<_> = queued(&r).into_iter().filter(|e| e["matchType"] == "au-tfn").collect();
    assert_eq!(tfn.len(), 2);
    assert_ne!(tfn[0]["eventId"], tfn[1]["eventId"]);
}

#[tokio::test]
async fn a_block_evicted_from_memory_answers_404_in_both_shapes() {
    use vibtra_guard_agent::agent::RECENT_MAX;
    let r = rig().await;
    let res = r.client.post("https://chat.deepseek.com/api/v0/chat").header("content-type", "text/plain").body("hi").send().await.unwrap();
    let first = res.json::<serde_json::Value>().await.unwrap()["eventId"].as_str().unwrap().to_string();
    let plain = reqwest::Client::builder().no_proxy().build().unwrap();
    let page = format!("http://{}/blocked/{first}", r.running.local_addr);
    assert_eq!(plain.get(&page).send().await.unwrap().status(), 200);
    let mut info = r.running.agent.recalled(&first).unwrap();
    for n in 0..RECENT_MAX {
        info.event_id = format!("gev_{n:016x}");
        r.running.agent.remember(info.clone());
    }
    let html = plain.get(&page).header("accept", "text/html").send().await.unwrap();
    assert_eq!(html.status(), 404);
    assert!(html.text().await.unwrap().contains("This block is no longer on file"));
    let json = plain.get(format!("{page}/status")).send().await.unwrap();
    assert_eq!(json.status(), 404);
    assert_eq!(json.json::<serde_json::Value>().await.unwrap()["code"], "GUARD_EVENT_UNKNOWN");
    assert_eq!(plain.get(format!("http://{}/blocked/gev_{:016x}", r.running.local_addr, RECENT_MAX - 1)).send().await.unwrap().status(), 200);
}

#[tokio::test]
async fn a_body_over_4_mb_is_forwarded_uninspected() {
    use vibtra_guard_agent::contract::INSPECT_MAX_BYTES;
    let r = rig().await;
    let mut big = b"tfn 123 456 782 ".to_vec();
    big.resize(INSPECT_MAX_BYTES + 1, b'a');
    let res = r.client.post("https://chatgpt.com/backend-api/files").header("content-type", "text/plain").body(big.clone()).send().await.unwrap();
    assert_eq!(res.status(), 200, "forwarded: the flow decision applied, no content rule ran");
    assert_eq!(res.headers().get("x-seen-bytes").unwrap().to_str().unwrap(), (INSPECT_MAX_BYTES + 1).to_string(), "unchanged and whole");
    let e = queued(&r).pop().unwrap();
    assert_eq!(e["kind"], "flow");
    assert_eq!(e["reason"], "uninspected", "the event says the body was not read");
    assert_eq!(e["bytes"], (INSPECT_MAX_BYTES + 1) as u64);
    assert!(e.get("matchType").is_none());

    use http_body_util::BodyExt;
    let tcp = tokio::net::TcpStream::connect(r.running.proxy_addr).await.unwrap();
    let (mut sender, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tcp)).await.unwrap();
    tokio::spawn(conn);
    let chunks: Vec<Result<hyper::body::Frame<bytes::Bytes>, std::convert::Infallible>> =
        big.chunks(256 * 1024).map(|c| Ok(hyper::body::Frame::data(bytes::Bytes::copy_from_slice(c)))).collect();
    let req = hyper::Request::post("http://chatgpt.com/backend-api/files")
        .header("host", "chatgpt.com")
        .header("content-type", "text/plain")
        .body(http_body_util::StreamBody::new(futures::stream::iter(chunks)))
        .unwrap();
    let res = sender.send_request(req).await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers().get("x-seen-bytes").unwrap().to_str().unwrap(), (INSPECT_MAX_BYTES + 1).to_string(), "the replay loses nothing");
    let _ = res.into_body().collect().await;
    let e = queued(&r).pop().unwrap();
    assert_eq!(e["kind"], "flow", "the TFN at the start of the oversized body was not inspected");
    assert!(e.get("matchType").is_none());
}

#[tokio::test]
async fn a_mapped_upstream_that_does_not_answer_is_a_502() {
    let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
    let r = rig_with(vec![("gemini.google.com".into(), url::Url::parse(&format!("http://{dead}")).unwrap())], |_| {}).await;
    let res = r.client.post("https://gemini.google.com/app").header("content-type", "text/plain").body("hello").send().await.unwrap();
    assert_eq!(res.status(), 502);
    assert_eq!(res.headers().get("x-vibtra-guard").unwrap(), "observed", "the decision is still stamped");
    assert_eq!(res.text().await.unwrap(), "vibtra-guard: the mapped upstream did not answer\n");
}

#[tokio::test]
async fn gemini_nested_form_is_checked_without_logging_the_prompt() {
    let (mock, _) = mock_ai().await;
    let r = rig_with(vec![("gemini.google.com".into(), url::Url::parse(&format!("http://{mock}")).unwrap())], |_| {}).await;
    let nested = serde_json::json!([null, r#"[["TFN \u0031\u0032\u0033 456 782"]]"#]).to_string();
    let form = url::form_urlencoded::Serializer::new(String::new()).append_pair("f.req", &nested).finish();
    let res = r
        .client
        .post("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate")
        .header("content-type", "application/x-www-form-urlencoded;charset=UTF-8")
        .body(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let activity = r.running.agent.activity_json();
    assert_eq!(activity["events"][0]["inspection"]["format"], "gemini-web");
    assert_eq!(activity["events"][0]["inspection"]["state"], "inspected");
    assert!(!activity.to_string().contains("123 456 782"));
    assert!(!activity.to_string().contains("f.req"));
}

#[tokio::test]
async fn adapters_do_not_exempt_other_fields_or_unknown_routes() {
    let r = rig().await;
    for (path, text) in [
        ("/backend-api/conversation", r#"{"messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"TFN 123 456 782"}]}"#),
        ("/new/provider/route", r#"{"metadata":"TFN 123 456 782"}"#),
    ] {
        let res = r.client.post(format!("https://chatgpt.com{path}")).header("content-type", "application/json").body(text).send().await.unwrap();
        assert_eq!(res.status(), 403, "generic scanning still covers {path}");
    }
}

#[tokio::test]
async fn coverage_reports_unchecked_bodies_and_allowed_payloads_are_unchanged() {
    let r = rig().await;
    let text = r#"{"messages":[{"role":"user","content":"hello"}]}"#;
    let res = r.client.post("https://chatgpt.com/backend-api/conversation").header("content-type", "application/json").body(text).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers().get("x-seen-bytes").unwrap(), text.len().to_string().as_str());
    use sha2::Digest;
    assert_eq!(res.headers().get("x-seen-sha256").unwrap(), hex::encode(sha2::Sha256::digest(text.as_bytes())).as_str());
    assert_eq!(r.running.agent.activity_json()["events"][0]["inspection"]["state"], "inspected");
    let res = r
        .client
        .post("https://chatgpt.com/backend-api/conversation")
        .header("content-type", "application/json")
        .header("content-encoding", "gzip")
        .body("opaque bytes")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        r.running.agent.activity_json()["events"][0]["inspection"]["reason"],
        "encoded-body",
        "coalescing must not hide an unchecked request behind an earlier inspected one"
    );
}

#[test]
fn browsers_are_named_by_family() {
    use vibtra_guard_agent::proxy::browser_from_user_agent;
    let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
    assert_eq!(browser_from_user_agent(chrome), Some("Google Chrome"));
    let headless = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36";
    assert_eq!(browser_from_user_agent(headless), Some("Chromium (headless)"));
    let edge = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
    assert_eq!(browser_from_user_agent(edge), Some("Microsoft Edge"));
    let safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    assert_eq!(browser_from_user_agent(safari), Some("Safari"));
    assert_eq!(browser_from_user_agent("Mozilla/5.0 (X11; rv:130.0) Gecko/20100101 Firefox/130.0"), Some("Firefox"));
    assert_eq!(browser_from_user_agent("Mozilla/5.0 (compatible)"), None);
    assert_eq!(browser_from_user_agent("curl/8.7.1"), None);
}
