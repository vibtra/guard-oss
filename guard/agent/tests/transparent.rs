// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use common::*;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use vibtra_guard_agent::agent::{start, Options};
use vibtra_guard_agent::sync::{enrol, sync_once};
use vibtra_guard_agent::transparent::{
    parse_proxy_v1, place, serve_with, sni_from_client_hello, spawn_with, InterceptFn, Placement, HEALTH_ANSWER, HEALTH_LINE,
};

fn client_hello(sni: Option<&str>) -> Vec<u8> {
    let mut exts = Vec::new();
    exts.extend_from_slice(&[0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04]);
    if let Some(name) = sni {
        let n = name.as_bytes();
        let entry_len = 3 + n.len();
        exts.extend_from_slice(&[0x00, 0x00]);
        exts.extend_from_slice(&((entry_len + 2) as u16).to_be_bytes());
        exts.extend_from_slice(&(entry_len as u16).to_be_bytes());
        exts.push(0x00);
        exts.extend_from_slice(&(n.len() as u16).to_be_bytes());
        exts.extend_from_slice(n);
    }
    let mut body = vec![0x03, 0x03];
    body.extend_from_slice(&[0x11; 32]);
    body.push(0);
    body.extend_from_slice(&[0x00, 0x02, 0x13, 0x01]);
    body.extend_from_slice(&[0x01, 0x00]);
    body.extend_from_slice(&(exts.len() as u16).to_be_bytes());
    body.extend_from_slice(&exts);
    let mut hs = vec![0x01, 0x00];
    hs.extend_from_slice(&(body.len() as u16).to_be_bytes());
    hs.extend_from_slice(&body);
    let mut rec = vec![0x16, 0x03, 0x01];
    rec.extend_from_slice(&(hs.len() as u16).to_be_bytes());
    rec.extend_from_slice(&hs);
    rec
}

#[test]
fn proxy_v1_lines() {
    let h = parse_proxy_v1("PROXY TCP6 2001:db8::1 2001:db8::2 51234 8443").unwrap();
    assert_eq!((h.protocol.as_str(), h.dst.as_deref(), h.dst_port), ("TCP6", Some("2001:db8::2"), Some(8443)));
    assert_eq!(h.src_port, Some(51234));
    for bad in [
        "PROXY UDP4 1.2.3.4 5.6.7.8 1 2",
        "PROXY TCP4 1.2.3.4 5.6.7.8 1 2 3",
        "PROXY TCP4 1.2.3.4 5.6.7.8 1 70000",
        "PROXY TCP4 1.2.3.4 5.6.7.8 x 443",
        "PROXY TCP4 1.2.3.4",
        "PROXY",
        "proxy TCP4 1.2.3.4 5.6.7.8 1 2",
        "",
    ] {
        assert!(parse_proxy_v1(bad).is_none(), "`{bad}` is refused");
    }
}

#[test]
fn placement_is_by_sni() {
    let enabled = |h: &str| h == "chatgpt.com";
    let by_address = parse_proxy_v1("PROXY TCP4 192.0.2.1 203.0.113.10 0 443").unwrap();
    let by_name = parse_proxy_v1("PROXY UNKNOWN").unwrap();
    let original = Some(Placement::Blind { host: "203.0.113.10".into(), port: 443 });
    assert_eq!(place(&by_address, Some("chatgpt.com"), &enabled), Some(Placement::Intercept { authority: "chatgpt.com:443".into() }));
    assert_eq!(place(&by_address, Some("api.anthropic.com"), &enabled), original, "a switched-off or unknown SNI goes blind to the ORIGINAL address");
    assert_eq!(place(&by_address, None, &enabled), original);
    assert_eq!(place(&by_address, Some(""), &enabled), original, "an empty SNI is no SNI");
    assert_eq!(place(&by_name, Some("example.com"), &enabled), Some(Placement::Blind { host: "example.com".into(), port: 443 }));
    assert_eq!(place(&by_name, None, &enabled), None);
}

#[test]
fn client_hello_sni() {
    assert_eq!(sni_from_client_hello(&client_hello(Some("ChatGPT.com"))).as_deref(), Some("chatgpt.com"), "lower-cased");
    assert_eq!(sni_from_client_hello(&client_hello(None)), None, "no server_name extension");
    let mut not_tls = client_hello(Some("chatgpt.com"));
    not_tls[0] = b'G';
    assert_eq!(sni_from_client_hello(&not_tls), None, "a first byte that is not a TLS handshake record");
    let mut not_hello = client_hello(Some("chatgpt.com"));
    not_hello[5] = 0x02;
    assert_eq!(sni_from_client_hello(&not_hello), None);
    let full = client_hello(Some("chatgpt.com"));
    assert_eq!(sni_from_client_hello(&full[..20]), None, "a truncated record is not read past its end");
    assert_eq!(sni_from_client_hello(&[]), None);
}

async fn fake_proxy(reply: &'static [u8]) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut c, _)) = l.accept().await else { continue };
            let mut buf = Vec::new();
            let mut b = [0u8; 1];
            while !buf.ends_with(b"\r\n\r\n") && c.read_exact(&mut b).await.is_ok() {
                buf.push(b[0]);
            }
            s2.lock().unwrap().push(String::from_utf8_lossy(&buf).lines().next().unwrap_or("").to_string());
            let _ = c.write_all(reply).await;
        }
    });
    (addr, seen)
}

fn chatgpt_only() -> InterceptFn {
    Arc::new(|host: &str| host == "chatgpt.com")
}

async fn listener_for(proxy: SocketAddr) -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    drop(spawn_with(l, proxy, chatgpt_only()));
    addr
}

async fn send_and_wait_for_close(addr: SocketAddr, bytes: &[u8]) -> Vec<u8> {
    let mut c = TcpStream::connect(addr).await.unwrap();
    c.write_all(bytes).await.unwrap();
    c.shutdown().await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), c.read_to_end(&mut out)).await.expect("the listener ends the connection").ok();
    out
}

#[tokio::test]
async fn unplaceable_connections_are_dropped_before_the_proxy() {
    let (proxy, seen) = fake_proxy(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let t = listener_for(proxy).await;
    let hello = client_hello(Some("chatgpt.com"));
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("no PROXY preamble", [b"GET / HTTP/1.1\r\n".as_slice(), &hello].concat()),
        ("a malformed preamble", [b"PROXY TCP4 1.2.3.4 5.6.7.8 1 2 3\r\n".as_slice(), &hello].concat()),
        ("UNKNOWN and a ClientHello without SNI", [b"PROXY UNKNOWN\r\n".as_slice(), &client_hello(None)].concat()),
        ("UNKNOWN and a first byte that is not TLS", [b"PROXY UNKNOWN\r\n".as_slice(), b"GET\x00\x02ab"].concat()),
        ("a record cut short", [b"PROXY TCP4 127.0.0.1 127.0.0.1 1 443\r\n".as_slice(), &hello[..12]].concat()),
    ];
    for (why, bytes) in cases {
        let answer = send_and_wait_for_close(t, &bytes).await;
        assert!(answer.is_empty(), "{why}: nothing is answered");
    }
    assert!(seen.lock().unwrap().is_empty(), "no connection reached the proxy: {:?}", seen.lock().unwrap());
}

#[tokio::test]
async fn a_refused_connect_ends_the_connection_and_only_an_intercepted_sni_reaches_the_proxy() {
    let (proxy, seen) = fake_proxy(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
    let t = listener_for(proxy).await;
    let answer = send_and_wait_for_close(t, &[b"PROXY TCP4 10.0.0.1 104.18.32.47 50000 443\r\n".as_slice(), &client_hello(Some("ChatGPT.com"))].concat()).await;
    assert!(answer.is_empty(), "the refusal is not relayed: the connection just ends");
    send_and_wait_for_close(t, &[b"PROXY TCP4 127.0.0.1 127.0.0.1 50000 1\r\n".as_slice(), &client_hello(None)].concat()).await;
    send_and_wait_for_close(t, &[b"PROXY TCP4 127.0.0.1 127.0.0.1 50000 1\r\n".as_slice(), &client_hello(Some("api.anthropic.com"))].concat()).await;
    let seen = seen.lock().unwrap().clone();
    assert_eq!(seen, vec!["CONNECT chatgpt.com:443 HTTP/1.1"]);
}

#[tokio::test]
async fn a_flow_placed_only_by_address_is_tunnelled_blind() {
    let dest = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dest_port = dest.local_addr().unwrap().port();
    let got = Arc::new(Mutex::new(Vec::new()));
    let g2 = got.clone();
    tokio::spawn(async move {
        let (mut c, _) = dest.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        while let Ok(n) = c.read(&mut buf).await {
            if n == 0 {
                break;
            }
            g2.lock().unwrap().extend_from_slice(&buf[..n]);
            let _ = c.write_all(b"pong").await;
        }
    });
    let running = start(Options {
        data_dir: Some(temp_dir("transparent-blind")),
        proxy: "127.0.0.1:0".parse().unwrap(),
        local: "127.0.0.1:0".parse().unwrap(),
        transparent: Some("127.0.0.1:0".parse().unwrap()),
        sync: false,
        ..Default::default()
    })
    .await
    .unwrap();
    let mut c = TcpStream::connect(running.transparent_addr.unwrap()).await.unwrap();
    let hello = client_hello(None);
    c.write_all(format!("PROXY TCP4 127.0.0.1 127.0.0.1 50000 {dest_port}\r\n").as_bytes()).await.unwrap();
    c.write_all(&hello).await.unwrap();
    let mut pong = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(5), c.read_exact(&mut pong)).await.expect("the tunnel answers").unwrap();
    assert_eq!(&pong, b"pong");
    assert_eq!(*got.lock().unwrap(), hello, "the ClientHello arrives byte for byte: nothing was terminated or decrypted");
    assert!(running.agent.queue.len().await == 0, "no decision was recorded");
}

async fn serve_one_with_short_deadlines(proxy: SocketAddr) -> (TcpStream, tokio::sync::oneshot::Receiver<String>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (s, _) = l.accept().await.unwrap();
        let short = Duration::from_millis(300);
        let out = serve_with(s, proxy, chatgpt_only(), short, short, short).await;
        let _ = tx.send(out.err().map(|e| e.to_string()).unwrap_or_default());
    });
    (TcpStream::connect(addr).await.unwrap(), rx)
}

async fn closed_within(c: &mut TcpStream, limit: Duration) -> bool {
    let mut buf = [0u8; 64];
    matches!(tokio::time::timeout(limit, c.read(&mut buf)).await, Ok(Ok(0)) | Ok(Err(_)))
}

#[tokio::test]
async fn nothing_waits_for_ever() {
    let (proxy, seen) = fake_proxy(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let (mut c, why) = serve_one_with_short_deadlines(proxy).await;
    assert!(closed_within(&mut c, Duration::from_secs(3)).await, "a silent connection is closed, not held");
    assert!(why.await.unwrap().contains("PROXY v1 line"), "ended by the header deadline");

    let (mut c, why) = serve_one_with_short_deadlines(proxy).await;
    c.write_all(b"PROXY UNKNOWN\r\n").await.unwrap();
    assert!(closed_within(&mut c, Duration::from_secs(3)).await);
    assert!(why.await.unwrap().contains("ClientHello"));
    assert!(seen.lock().unwrap().is_empty(), "nothing reached the proxy");

    let mute = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mute_addr = mute.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = mute.accept().await {
            held.push(s);
        }
    });
    let (mut c, why) = serve_one_with_short_deadlines(mute_addr).await;
    c.write_all(&[b"PROXY UNKNOWN\r\n".as_slice(), &client_hello(Some("chatgpt.com"))].concat()).await.unwrap();
    assert!(closed_within(&mut c, Duration::from_secs(3)).await);
    assert!(why.await.unwrap().contains("CONNECT"));
}

#[tokio::test]
async fn a_health_probe_that_connects_and_closes_is_harmless() {
    let (proxy, seen) = fake_proxy(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let t = listener_for(proxy).await;
    for _ in 0..20 {
        drop(TcpStream::connect(t).await.unwrap());
    }
    let answer = send_and_wait_for_close(t, &[b"PROXY UNKNOWN\r\n".as_slice(), &client_hello(Some("chatgpt.com"))].concat()).await;
    assert!(!answer.starts_with(b"HTTP/1.1 200"), "the proxy's CONNECT answer is never relayed to the app");
    assert_eq!(seen.lock().unwrap().clone(), vec!["CONNECT chatgpt.com:443 HTTP/1.1"]);
}

#[tokio::test]
async fn the_health_line_is_answered_and_never_reaches_the_proxy() {
    let (proxy, seen) = fake_proxy(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let t = listener_for(proxy).await;
    for _ in 0..5 {
        let mut c = TcpStream::connect(t).await.unwrap();
        c.write_all(format!("{HEALTH_LINE}\r\n").as_bytes()).await.unwrap();
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_millis(750), c.read_to_end(&mut out)).await.expect("answered within the probe deadline").unwrap();
        assert_eq!(out, HEALTH_ANSWER);
    }
    assert!(seen.lock().unwrap().is_empty(), "a probe is not a flow");
    let _ = send_and_wait_for_close(t, &[b"PROXY UNKNOWN\r\n".as_slice(), &client_hello(Some("chatgpt.com"))].concat()).await;
    assert_eq!(seen.lock().unwrap().clone(), vec!["CONNECT chatgpt.com:443 HTTP/1.1"]);
}

#[tokio::test]
async fn a_silent_client_never_holds_up_the_next_accept() {
    let (proxy, _seen) = fake_proxy(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
    let t = listener_for(proxy).await;
    let mut silent = Vec::new();
    for _ in 0..10 {
        silent.push(TcpStream::connect(t).await.unwrap());
    }
    let mut c = TcpStream::connect(t).await.unwrap();
    c.write_all(format!("{HEALTH_LINE}\r\n").as_bytes()).await.unwrap();
    let mut out = Vec::new();
    tokio::time::timeout(Duration::from_millis(750), c.read_to_end(&mut out)).await.expect("not queued behind the silent ones").unwrap();
    assert_eq!(out, HEALTH_ANSWER);
    drop(silent);
}

async fn tls_site(names: &[&str]) -> (u16, rustls::pki_types::CertificateDer<'static>) {
    let key = rcgen::KeyPair::generate().unwrap();
    let cert = rcgen::CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>()).unwrap().self_signed(&key).unwrap();
    let der = cert.der().clone();
    let cfg = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![der.clone()], rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(cfg));
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((tcp, _)) = l.accept().await else { continue };
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else { return };
                let mut buf = vec![0u8; 4096];
                let _ = tls.read(&mut buf).await;
                let _ = tls.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 10\r\nconnection: close\r\n\r\nplain site").await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (port, der)
}

async fn steered_tls(
    listener: SocketAddr,
    dest_port: u16,
    sni: &str,
    roots: &[rustls::pki_types::CertificateDer<'static>],
) -> Result<(Vec<u8>, String), String> {
    let mut store = rustls::RootCertStore::empty();
    for r in roots {
        store.add(r.clone()).unwrap();
    }
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::aws_lc_rs::default_provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(store)
        .with_no_client_auth();
    let mut tcp = TcpStream::connect(listener).await.unwrap();
    tcp.write_all(format!("PROXY TCP4 127.0.0.1 127.0.0.1 50000 {dest_port}\r\n").as_bytes()).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from(sni.to_string()).unwrap();
    let connector = tokio_rustls::TlsConnector::from(Arc::new(cfg));
    let mut tls = tokio::time::timeout(Duration::from_secs(10), connector.connect(name, tcp))
        .await
        .map_err(|_| "handshake timed out".to_string())?
        .map_err(|e| e.to_string())?;
    let shown = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| c.to_vec()).unwrap_or_default();
    tls.write_all(format!("GET / HTTP/1.1\r\nhost: {sni}\r\nconnection: close\r\n\r\n").as_bytes()).await.map_err(|e| e.to_string())?;
    let mut page = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(10), tls.read_to_end(&mut page)).await;
    Ok((shown, String::from_utf8_lossy(&page).into_owned()))
}

#[tokio::test]
async fn a_steered_flow_is_decided_by_its_sni() {
    vibtra_guard_agent::init_crypto();
    let reg = fake_registry().await;
    {
        let mut s = reg.state.lock().unwrap();
        for svc in s.catalogue["services"].as_array_mut().unwrap() {
            if svc["serviceId"] == "anthropic-api" {
                svc["enabled"] = serde_json::json!(false);
            }
        }
    }
    let (mock, _seen) = mock_ai().await;
    let running = start(Options {
        data_dir: Some(temp_dir("transparent-sni")),
        proxy: "127.0.0.1:0".parse().unwrap(),
        local: "127.0.0.1:0".parse().unwrap(),
        transparent: Some("127.0.0.1:0".parse().unwrap()),
        upstream_map: vec![("chatgpt.com".into(), url::Url::parse(&format!("http://{mock}")).unwrap())],
        sync: false,
        ..Default::default()
    })
    .await
    .unwrap();
    enrol(&running.agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&running.agent).await.unwrap();
    let t = running.transparent_addr.unwrap();
    assert!(running.agent.should_intercept("chatgpt.com"));
    assert!(!running.agent.should_intercept("api.anthropic.com"), "the switched-off row is not intercepted");

    let (port, real) = tls_site(&["api.anthropic.com", "example.test"]).await;
    let (shown, page) = steered_tls(t, port, "api.anthropic.com", std::slice::from_ref(&real)).await.expect("the real site answers through the blind tunnel");
    assert_eq!(shown, real.to_vec(), "the REAL certificate, not one minted by the Guard CA");
    assert!(page.ends_with("plain site"), "{page}");

    let (shown, page) = steered_tls(t, port, "example.test", std::slice::from_ref(&real)).await.expect("blind");
    assert_eq!(shown, real.to_vec());
    assert!(page.ends_with("plain site"));
    assert_eq!(running.agent.queue.len().await, 0, "a blind tunnel records no decision");

    let guard_ca = rustls_pemfile::certs(&mut running.agent.ca.cert_pem.as_bytes()).next().unwrap().unwrap();
    let (shown, page) = steered_tls(t, port, "chatgpt.com", std::slice::from_ref(&guard_ca)).await.expect("decrypted by the agent");
    assert_ne!(shown, real.to_vec(), "a certificate minted by the agent");
    assert!(page.starts_with("HTTP/1.1"), "the agent answered over the intercepted connection: {page}");
    assert!(
        steered_tls(t, port, "chatgpt.com", std::slice::from_ref(&real)).await.is_err(),
        "the real site's trust does not accept the Guard CA's certificate"
    );
    drop(reg);
}
