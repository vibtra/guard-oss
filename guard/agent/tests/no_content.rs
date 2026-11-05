// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use common::*;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use vibtra_guard_agent::agent::{start, Options};
use vibtra_guard_agent::sync::{enrol, sync_once};

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn capture() -> &'static Capture {
    static CAPTURE: OnceLock<Capture> = OnceLock::new();
    CAPTURE.get_or_init(|| {
        let capture = Capture::default();
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace,hudsucker=off"))
            .with_ansi(false)
            .with_writer(capture.clone())
            .init();
        capture
    })
}

fn logs() -> String {
    String::from_utf8_lossy(&capture().0.lock().unwrap()).into_owned()
}

#[tokio::test]
async fn a_blocked_tfn_post_leaves_no_content_in_the_logs() {
    capture();
    vibtra_guard_agent::init_crypto();

    let reg = fake_registry().await;
    let (mock, _) = mock_ai().await;
    let running = start(Options {
        data_dir: Some(temp_dir("logs")),
        proxy: "127.0.0.1:0".parse().unwrap(),
        local: "127.0.0.1:0".parse().unwrap(),
        upstream_map: vec![("chatgpt.com".into(), url::Url::parse(&format!("http://{mock}")).unwrap())],
        sync: false,
        ..Default::default()
    })
    .await
    .unwrap();
    enrol(&running.agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&running.agent).await.unwrap();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", running.proxy_addr)).unwrap())
        .tls_certs_only([reqwest::Certificate::from_pem(running.agent.ca.cert_pem.as_bytes()).unwrap()])
        .build()
        .unwrap();

    let res = client
        .post("https://chatgpt.com/backend-api/conversation?secret_query=zebra42")
        .header("content-type", "application/json")
        .body(r#"{"prompt":"quarterly figures for my tfn 123 456 782 thanks"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let event_id = res.json::<serde_json::Value>().await.unwrap()["eventId"].as_str().unwrap().to_string();
    let res = client
        .post("https://chatgpt.com/backend-api/conversation")
        .header("content-type", "text/plain")
        .body("a perfectly ordinary prompt about walruses")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let local = format!("http://{}", running.local_addr);
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{local}/blocked/{event_id}/request"))
        .header("content-type", "application/x-www-form-urlencoded")
        .body("note=please+let+me+finish+payroll")
        .send()
        .await
        .unwrap();
    sync_once(&running.agent).await.unwrap();

    let logs = logs();
    assert!(logs.contains("decision"), "the capture saw the agent's decision lines");
    for needle in ["123 456 782", "123456782", "quarterly figures", "walruses", "zebra42", "secret_query", "finish payroll", "finish+payroll", DEVICE_TOKEN] {
        assert!(!logs.contains(needle), "the logs carry `{needle}`");
    }
}

fn vector_secret() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/guard-contract/src/detectors.vectors.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap().replace("~~", "")).unwrap();
    let text = v["secrets"]["fire"][0]["text"].as_str().unwrap();
    text.rsplit(['=', ' ']).next().unwrap().to_string()
}

#[tokio::test]
async fn no_body_shape_leaks_content_into_events_uploads_or_logs() {
    use vibtra_guard_agent::body::extract;
    capture();
    vibtra_guard_agent::init_crypto();
    let reg = fake_registry().await;
    {
        let mut s = reg.state.lock().unwrap();
        let rules = s.bundle["contentRules"].as_array_mut().unwrap();
        rules.push(serde_json::json!({ "ruleId": "gcr_00000010", "name": "Secrets", "detector": { "kind": "secret" }, "services": "*", "action": "block" }));
        rules.push(serde_json::json!({ "ruleId": "gcr_00000011", "name": "Cards", "detector": { "kind": "card-number" }, "services": "*", "action": "ask" }));
        rules.push(serde_json::json!({ "ruleId": "gcr_00000012", "name": "Spreadsheets", "detector": { "kind": "file-type", "extensions": ["xlsx", "csv"] }, "services": "*", "action": "block" }));
    }
    let (mock, _) = mock_ai().await;
    let running = start(Options {
        data_dir: Some(temp_dir("no-content")),
        proxy: "127.0.0.1:0".parse().unwrap(),
        local: "127.0.0.1:0".parse().unwrap(),
        upstream_map: vec![("chatgpt.com".into(), url::Url::parse(&format!("http://{mock}")).unwrap())],
        sync: false,
        ..Default::default()
    })
    .await
    .unwrap();
    enrol(&running.agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&running.agent).await.unwrap();
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{}", running.proxy_addr)).unwrap())
        .tls_certs_only([reqwest::Certificate::from_pem(running.agent.ca.cert_pem.as_bytes()).unwrap()])
        .build()
        .unwrap();

    let secret = vector_secret();
    let tfn = "123 456 782";
    let card = "4111 1111 1111 1111";
    let words = "walrus zeppelin quartz";
    let payload = format!("{words}: tfn {tfn}, card {card}, key {secret}");
    let form_payload: String = url::form_urlencoded::byte_serialize(payload.as_bytes()).collect();
    let crlf = format!(
        "--B0\r\nContent-Disposition: form-data; name=\"prompt\"\r\n\r\n{payload}\r\n--B0\r\nContent-Disposition: form-data; name=\"file\"; filename=\"secretplan-q3.xlsx\"\r\nContent-Type: application/octet-stream\r\n\r\nPK\x03\x04{payload}\r\n--B0--\r\n"
    );
    let lf = format!("--B1\nContent-Disposition: form-data; name=\"prompt\"\n\n{payload}\n--B1--\n");
    let star = format!(
        "--B2\r\nContent-Disposition: form-data; name=\"f\"; filename*=UTF-8''secretplan%20q3.csv\r\nContent-Type: text/csv\r\n\r\nname,tfn\nada,{tfn}\r\n--B2--\r\n"
    );
    let ndjson = format!("{{\"a\":\"{payload}\"}}\n{{\"b\":1}}\n");
    let broken = format!("{{\"messages\":[{{\"content\":\"{payload}");
    let bodies: Vec<(&str, String, &str)> = vec![
        ("application/json", serde_json::json!({ "messages": [{ "content": payload }], "n": 123456782u64 }).to_string(), "json"),
        ("application/x-www-form-urlencoded", format!("q={form_payload}&x=1"), "form"),
        ("multipart/form-data; boundary=B0", crlf, "multipart with a file"),
        ("multipart/form-data; boundary=B1", lf, "LF-only multipart"),
        ("multipart/form-data; boundary=B2", star, "filename*="),
        ("application/x-ndjson+json", ndjson, "NDJSON"),
        ("application/json", broken, "broken JSON"),
        ("text/markdown; charset=utf-8", format!("# notes\n\n{payload}\n"), "text/*"),
    ];
    for (ct, body, what) in &bodies {
        let ex = extract(Some(ct), body.as_bytes());
        assert!(ex.text.contains(tfn) || ex.text.contains("123456782"), "{what}: the TFN is in the extracted text");
        let res = client
            .post(format!("https://chatgpt.com/backend-api/conversation?cursor={}", words.replace(' ', "-")))
            .header("content-type", *ct)
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 403, "{what}: refused");
    }
    assert_eq!(extract(Some("multipart/form-data; boundary=B0"), bodies[2].1.as_bytes()).filenames, vec!["secretplan-q3.xlsx"]);
    assert_eq!(extract(Some("multipart/form-data; boundary=B2"), bodies[4].1.as_bytes()).filenames, vec!["secretplan q3.csv"]);

    let queued = std::fs::read_to_string(running.agent.paths.events()).unwrap();
    assert!(queued.lines().count() >= bodies.len());
    assert!(queued.contains("\"snippet\":\""), "the redacted snippets are there");
    sync_once(&running.agent).await.unwrap();
    let uploaded = serde_json::to_string(&reg.state.lock().unwrap().events).unwrap();
    assert!(uploaded.contains("au-tfn"));
    let all = format!("{queued}\n{uploaded}\n{}", logs());
    let tail = &secret[6..];
    let needles = [
        tfn,
        "123456782",
        "123+456+782",
        card,
        "4111111111111111",
        secret.as_str(),
        tail,
        "walrus",
        "zeppelin",
        "secretplan",
        "secretplan%20q3",
        "PK\u{3}\u{4}",
    ];
    for needle in needles {
        assert!(!all.contains(needle), "`{needle}` left the request");
    }
}
