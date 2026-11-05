// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::agent::{Agent, BlockInfo, Decision, RequestMeta};
use crate::body::{extract, inspectable, Extracted};
use crate::contract::{BLOCKED_CODE, DECISION_HEADER, INSPECT_MAX_BYTES, LOCAL_HOST};
use crate::prompt::Inspection;
use crate::types::{Action, EventApp};
use bytes::Bytes;
use futures::StreamExt;
use http::{header, HeaderValue, Method, Request, Response, StatusCode, Uri};
use http_body_util::{BodyExt, Full};
use hudsucker::certificate_authority::RcgenAuthority;
use hudsucker::rustls::crypto::aws_lc_rs;
use hudsucker::{Body, HttpContext, HttpHandler, Proxy, RequestOrResponse};
use hyper_util::rt::TokioIo;
use serde_json::json;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Clone)]
pub struct Handler {
    agent: Arc<Agent>,
    stamp: Option<String>,
    origin: Option<HeaderValue>,
}

impl Handler {
    pub fn new(agent: Arc<Agent>) -> Self {
        Handler { agent, stamp: None, origin: None }
    }
}

fn host_of<B>(req: &Request<B>) -> Option<(String, Option<u16>)> {
    if let Some(h) = req.uri().host() {
        return Some((h.to_ascii_lowercase(), req.uri().port_u16()));
    }
    let h = req.headers().get(header::HOST)?.to_str().ok()?;
    let (host, port) = match h.rsplit_once(':') {
        Some((a, p)) if p.chars().all(|c| c.is_ascii_digit()) => (a, p.parse().ok()),
        _ => (h, None),
    };
    Some((host.to_ascii_lowercase(), port))
}

pub fn browser_from_user_agent(ua: &str) -> Option<&'static str> {
    if !ua.starts_with("Mozilla/") {
        return None;
    }
    Some(if ua.contains("Edg/") {
        "Microsoft Edge"
    } else if ua.contains("OPR/") {
        "Opera"
    } else if ua.contains("HeadlessChrome/") {
        "Chromium (headless)"
    } else if ua.contains("Chromium/") {
        "Chromium"
    } else if ua.contains("Chrome/") {
        "Google Chrome"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        return None;
    })
}

pub fn app_from_user_agent(agent: &Agent, ua: Option<&str>) -> EventApp {
    let Some(ua) = ua.map(str::trim).filter(|u| !u.is_empty()) else { return EventApp::default() };
    if ua.starts_with("Mozilla/") {
        return match browser_from_user_agent(ua) {
            Some(name) => EventApp { bundle_id: None, name: Some(name.into()), cli: None, pid: None },
            None => EventApp::default(),
        };
    }
    let token = ua.split([' ', '/']).next().unwrap_or("").to_ascii_lowercase();
    if token.is_empty() {
        return EventApp::default();
    }
    let cat = agent.matcher();
    let candidates =
        [token.as_str(), token.trim_end_matches("-cli"), token.trim_end_matches("_cli_rs"), token.trim_end_matches("_cli"), token.trim_end_matches("-code")];
    let cli = candidates.iter().find(|c| !c.is_empty() && cat.matcher.is_known_cli(c)).map(|c| c.to_string());
    EventApp { bundle_id: None, name: Some(token.chars().take(120).collect()), cli: cli.map(|c| c.chars().take(60).collect()), pid: None }
}

enum Collected {
    Whole(Bytes),
    TooBig(Body),
}

async fn collect_bounded(mut body: Body, limit: usize) -> Result<Collected, hudsucker::Error> {
    let mut chunks: Vec<Bytes> = Vec::new();
    let mut total = 0usize;
    while let Some(frame) = body.frame().await {
        let frame = frame?;
        if let Ok(data) = frame.into_data() {
            total += data.len();
            chunks.push(data);
            if total > limit {
                let head = futures::stream::iter(chunks.into_iter().map(Ok::<Bytes, hudsucker::Error>));
                let rest = body.into_data_stream();
                return Ok(Collected::TooBig(Body::from_stream(head.chain(rest))));
            }
        }
    }
    let mut buf = Vec::with_capacity(total);
    for c in chunks {
        buf.extend_from_slice(&c);
    }
    Ok(Collected::Whole(Bytes::from(buf)))
}

fn blocked_json(agent: &Agent, d: &Decision, info: &BlockInfo) -> serde_json::Value {
    let mut v = json!({
        "code": BLOCKED_CODE,
        "eventId": info.event_id,
        "action": if info.action == Action::Ask { "ask" } else { "block" },
        "blockPage": format!("{}/blocked/{}", agent.local_base(), info.event_id),
        "requestsEnabled": info.requests_enabled,
        "service": info.service_id,
        "message": crate::engine::explain(&d.verdict),
    });
    if let Some(r) = &info.rule_id {
        v["ruleId"] = json!(r);
    }
    if let Some(w) = &info.workspace {
        v["workspace"] = json!(w);
    }
    v
}

fn refuse(agent: &Agent, d: &Decision, navigation: bool, origin: Option<&HeaderValue>) -> Response<Body> {
    let info = d.info.as_ref().expect("a refusal carries its facts");
    let mut b = Response::builder().status(StatusCode::FORBIDDEN).header(DECISION_HEADER, &d.header).header(header::CACHE_CONTROL, "no-store");
    if let Some(o) = origin {
        b = b
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, o.clone())
            .header(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, "true")
            .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, DECISION_HEADER)
            .header(header::VARY, "Origin");
    }
    let body = if navigation {
        b = b
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src http://127.0.0.1:* http://localhost:*; form-action http://127.0.0.1:* http://localhost:*");
        Body::from(crate::page::render(info, agent.ask_for(&info.event_id).as_ref(), false, &agent.local_base()))
    } else {
        b = b.header(header::CONTENT_TYPE, "application/json; charset=utf-8");
        Body::from(blocked_json(agent, d, info).to_string())
    };
    b.body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}

fn stamp(mut res: Response<Body>, value: &str) -> Response<Body> {
    if let Ok(v) = HeaderValue::from_str(value) {
        res.headers_mut().insert(DECISION_HEADER, v);
    }
    res
}

async fn forward_mapped(agent: &Agent, target: &url::Url, original_host: &str, parts: http::request::Parts, body: Body) -> Response<Body> {
    match forward_mapped_inner(agent, target, original_host, parts, body).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(target = %target, error = %e, "mapped upstream failed");
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("vibtra-guard: the mapped upstream did not answer\n"))
                .unwrap_or_else(|_| Response::new(Body::empty()))
        }
    }
}

async fn forward_mapped_inner(
    agent: &Agent,
    target: &url::Url,
    original_host: &str,
    mut parts: http::request::Parts,
    body: Body,
) -> anyhow::Result<Response<Body>> {
    let host = target.host_str().ok_or_else(|| anyhow::anyhow!("mapped target has no host"))?;
    let port = target.port_or_known_default().unwrap_or(80);
    let tcp = TcpStream::connect((host, port)).await?;
    let path = parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".into());
    parts.uri = path.parse::<Uri>()?;
    if !parts.headers.contains_key(header::HOST) {
        parts.headers.insert(header::HOST, HeaderValue::from_str(original_host)?);
    }
    parts.headers.remove("proxy-connection");
    parts.headers.remove(header::PROXY_AUTHORIZATION);
    parts.version = http::Version::HTTP_11;
    let req = Request::from_parts(parts, body);
    if target.scheme() == "https" {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        for c in &agent.upstream_roots {
            let _ = roots.add(c.clone());
        }
        let mut cfg = rustls::ClientConfig::builder_with_provider(Arc::new(aws_lc_rs::default_provider()))
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        let name = rustls::pki_types::ServerName::try_from(crate::catalogue::normalise_host(original_host))?;
        let tls = tokio_rustls::TlsConnector::from(Arc::new(cfg)).connect(name, tcp).await?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tls)).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(sender.send_request(req).await?.map(Body::from))
    } else {
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(tcp)).await?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(sender.send_request(req).await?.map(Body::from))
    }
}

impl HttpHandler for Handler {
    async fn handle_request(&mut self, _ctx: &HttpContext, req: Request<Body>) -> RequestOrResponse {
        if req.method() == Method::CONNECT {
            return req.into();
        }
        let Some((host, port)) = host_of(&req) else { return req.into() };
        if host == LOCAL_HOST {
            let lr = crate::local::from_hyper(req).await;
            return crate::local::to_hudsucker(crate::local::handle(&self.agent, lr).await).into();
        }
        if !self.agent.should_intercept(&host) {
            return req.into();
        }
        let original_authority = req.headers().get(header::HOST).and_then(|h| h.to_str().ok()).map(str::to_string).unwrap_or_else(|| match port {
            Some(p) if p != 443 && p != 80 => format!("{host}:{p}"),
            _ => host.clone(),
        });
        let (parts, body) = req.into_parts();
        let header_str = |n: header::HeaderName| parts.headers.get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        let content_type = header_str(header::CONTENT_TYPE);
        let encoded = header_str(header::CONTENT_ENCODING).is_some_and(|e| !e.eq_ignore_ascii_case("identity"));
        let declared_len: Option<u64> = header_str(header::CONTENT_LENGTH).and_then(|l| l.parse().ok());
        let sends = matches!(parts.method, Method::POST | Method::PUT | Method::PATCH);
        let inspect = sends && !encoded && inspectable(content_type.as_deref()) && declared_len.is_none_or(|l| l <= INSPECT_MAX_BYTES as u64);
        let (body, extracted, bytes, inspection): (Body, Extracted, Option<u64>, Inspection) = if inspect {
            match collect_bounded(body, INSPECT_MAX_BYTES).await {
                Ok(Collected::Whole(b)) => {
                    let mut ex = extract(content_type.as_deref(), &b);
                    let prompt = crate::prompt::extract(&host, parts.uri.path(), content_type.as_deref(), &b);
                    if prompt.format == Some("gemini-web")
                        && content_type.as_deref().is_some_and(|t| t.to_ascii_lowercase().starts_with("application/x-www-form-urlencoded"))
                    {
                        ex.text = crate::prompt::gemini_form_text(&b);
                    }
                    let n = b.len() as u64;
                    (Body::from(Full::new(b)), ex, Some(n), Inspection::inspected(prompt.format, prompt.parts.len()))
                }
                Ok(Collected::TooBig(b)) => {
                    tracing::info!(host = %host, "request body over 4 MB: forwarded uninspected");
                    (b, Extracted::default(), declared_len, Inspection::flow_only("body-too-large"))
                }
                Err(_) => {
                    return Response::builder().status(StatusCode::BAD_REQUEST).body(Body::empty()).unwrap_or_else(|_| Response::new(Body::empty())).into()
                }
            }
        } else {
            let reason = if !sends {
                "no-request-body"
            } else if encoded {
                "encoded-body"
            } else if !inspectable(content_type.as_deref()) {
                "unsupported-content-type"
            } else {
                "body-too-large"
            };
            (body, Extracted::default(), declared_len, Inspection::flow_only(reason))
        };
        let app = app_from_user_agent(&self.agent, header_str(header::USER_AGENT).as_deref());
        let path = parts.uri.path().to_string();
        let meta = RequestMeta {
            host: &host,
            port,
            method: Some(parts.method.as_str()),
            path: Some(&path),
            app,
            text: &extracted.text,
            filenames: &extracted.filenames, joined: &extracted.joined,
            bytes,
        };
        let decision = self.agent.decide_with_inspection(meta, Some(inspection)).await;
        drop(extracted);
        let navigation = header_str(header::ACCEPT).is_some_and(|a| a.contains("text/html"));
        self.origin = parts.headers.get(header::ORIGIN).cloned();
        if let Some(d) = &decision {
            if d.refuse {
                return refuse(&self.agent, d, navigation, self.origin.as_ref()).into();
            }
            self.stamp = Some(d.header.clone());
        }
        if let Some(target) = self.agent.upstream_map.get(&host).cloned() {
            let res = forward_mapped(&self.agent, &target, &original_authority, parts, body).await;
            return match &self.stamp {
                Some(s) => stamp(res, s).into(),
                None => res.into(),
            };
        }
        Request::from_parts(parts, body).into()
    }

    async fn handle_response(&mut self, _ctx: &HttpContext, res: Response<Body>) -> Response<Body> {
        match self.stamp.take() {
            Some(s) => stamp(res, &s),
            None => res,
        }
    }

    async fn should_intercept_connect(&mut self, _ctx: &HttpContext, req: &Request<Body>) -> bool {
        let host = req.uri().host().unwrap_or("");
        self.agent.should_intercept(host)
    }
}

pub fn spawn(agent: Arc<Agent>, listener: TcpListener) -> anyhow::Result<JoinHandle<()>> {
    let ca = RcgenAuthority::new(agent.ca.issuer()?, 1_000, aws_lc_rs::default_provider());
    let proxy = Proxy::builder().with_listener(listener).with_ca(ca).with_rustls_connector(aws_lc_rs::default_provider()).with_http_handler(Handler::new(agent)).build()?;
    Ok(tokio::spawn(async move {
        if let Err(e) = proxy.start().await {
            tracing::error!(error = %e, "the proxy stopped");
        }
    }))
}
