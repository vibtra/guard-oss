// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::agent::Agent;
use crate::contract::local_paths;
use crate::page;
use bytes::Bytes;
use futures::StreamExt;
use http_body_util::{BodyExt, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::json;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub struct LocalRequest {
    pub method: String,
    pub path: String,
    pub accept: String,
    pub content_type: String,
    pub body: Bytes,
}

pub enum LocalBody {
    Bytes(Bytes),
    Sse(tokio::sync::broadcast::Receiver<crate::agent::Sse>),
}

pub struct LocalResponse {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: LocalBody,
}

impl LocalResponse {
    fn new(status: u16, content_type: &str, body: impl Into<Bytes>) -> Self {
        LocalResponse {
            status,
            headers: vec![("content-type", content_type.to_string()), ("cache-control", "no-store".to_string())],
            body: LocalBody::Bytes(body.into()),
        }
    }
    fn json(status: u16, v: serde_json::Value) -> Self {
        Self::new(status, "application/json; charset=utf-8", v.to_string())
    }
    fn html(status: u16, s: String) -> Self {
        let mut r = Self::new(status, "text/html; charset=utf-8", s);
        r.headers.push(("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self' http://127.0.0.1:* http://localhost:*; form-action http://127.0.0.1:* http://localhost:* 'self'; img-src data:".to_string()));
        r
    }
    fn redirect(status: u16, to: String) -> Self {
        let mut r = Self::new(status, "text/plain; charset=utf-8", "");
        r.headers.push(("location", to));
        r
    }
    fn cors(mut self) -> Self {
        self.headers.push(("access-control-allow-origin", "*".to_string()));
        self
    }
}

fn wants_html(req: &LocalRequest) -> bool {
    req.accept.contains("text/html")
}

fn note_from(req: &LocalRequest) -> Option<String> {
    if req.content_type.starts_with("application/json") {
        return serde_json::from_slice::<serde_json::Value>(&req.body).ok().and_then(|v| v.get("note").and_then(|n| n.as_str()).map(str::to_string));
    }
    url::form_urlencoded::parse(&req.body).find(|(k, _)| k == "note").map(|(_, v)| v.into_owned())
}

pub async fn handle(agent: &Arc<Agent>, req: LocalRequest) -> LocalResponse {
    let path = req.path.split('?').next().unwrap_or("/").to_string();
    let method = req.method.as_str();
    if method == "OPTIONS" {
        let mut r = LocalResponse::new(204, "text/plain", "").cors();
        r.headers.push(("access-control-allow-methods", "GET, POST".to_string()));
        r.headers.push(("access-control-allow-headers", "content-type".to_string()));
        r.headers.push(("access-control-allow-private-network", "true".to_string()));
        return r;
    }
    match (method, path.as_str()) {
        ("GET", local_paths::HEALTHZ) => return LocalResponse::new(200, "text/plain; charset=utf-8", "ok\n"),
        ("GET", local_paths::STATUS) => return LocalResponse::json(200, agent.status_json().await),
        ("GET", "/activity") => return LocalResponse::json(200, agent.activity_json()),
        ("GET", "/policy") => return LocalResponse::json(200, agent.policy_json()),
        ("GET", local_paths::CA) => return LocalResponse::new(200, "application/x-pem-file", agent.ca.cert_pem.clone()),
        ("GET", local_paths::EVENTS) => {
            return LocalResponse {
                status: 200,
                headers: vec![("content-type", "text/event-stream".to_string()), ("cache-control", "no-store".to_string())],
                body: LocalBody::Sse(agent.bus.subscribe()),
            };
        }
        ("GET", "/") => {
            return LocalResponse::html(200, page::message("Vibtra Guard is running", "This laptop's AI-use guard. Blocked requests open their own page here."))
        }
        _ => {}
    }
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if parts.first() != Some(&"blocked") || parts.len() < 2 || !parts[1].starts_with("gev_") {
        return LocalResponse::new(404, "text/plain; charset=utf-8", "not found\n");
    }
    let event_id = parts[1];
    let Some(info) = agent.recalled(event_id) else {
        return if wants_html(&req) {
            LocalResponse::html(
                404,
                page::message(
                    "This block is no longer on file",
                    "The agent keeps recent blocks in memory and was restarted since. Try the request again to see why it is blocked.",
                ),
            )
        } else {
            LocalResponse::json(404, json!({ "code": "GUARD_EVENT_UNKNOWN", "message": "this event is not known to the running agent" })).cors()
        };
    };
    let base = agent.local_base();
    match (method, parts.get(2).copied()) {
        ("GET", None) => {
            let ask = agent.ask_for(event_id);
            LocalResponse::html(200, page::render(&info, ask.as_ref(), agent.excepted_now(&info), &base))
        }
        ("POST", Some("request")) => {
            if !info.requests_enabled {
                return LocalResponse::json(403, json!({ "code": "GUARD_REQUESTS_OFF", "message": "IT has turned requests off" }));
            }
            let note = note_from(&req);
            match crate::sync::file_ask(agent, &info, note).await {
                Ok(res) => {
                    if wants_html(&req) || req.content_type.starts_with("application/x-www-form-urlencoded") {
                        LocalResponse::redirect(303, format!("{base}/blocked/{event_id}"))
                    } else {
                        LocalResponse::json(200, serde_json::to_value(&res).unwrap_or_default()).cors()
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    if wants_html(&req) {
                        LocalResponse::html(
                            502,
                            page::message(
                                "The request did not reach IT",
                                &format!("The agent could not reach your organisation's Vibtra: {msg}. Try again in a minute."),
                            ),
                        )
                    } else {
                        LocalResponse::json(502, json!({ "code": "GUARD_REQUEST_FAILED", "message": msg })).cors()
                    }
                }
            }
        }
        ("GET", Some("status")) => {
            let stale = agent.asks.lock().unwrap().get(event_id).is_some_and(|a| a.checked.elapsed() > Duration::from_secs(3) && a.view.status == "pending");
            if stale {
                if let Some(a) = agent.asks.lock().unwrap().get_mut(event_id) {
                    a.checked = Instant::now();
                }
                let _ = crate::sync::refresh_asks(agent).await;
            }
            let ask = agent.ask_for(event_id);
            let applied = agent.excepted_now(&info);
            if ask.as_ref().is_some_and(|a| a.status == "approved") && !applied {
                agent.sync_now.notify_one();
            }
            LocalResponse::json(
                200,
                json!({
                    "eventId": event_id,
                    "status": ask.as_ref().map(|a| a.status.clone()).unwrap_or_else(|| "none".to_string()),
                    "requestId": ask.as_ref().map(|a| a.request_id.clone()),
                    "grantExpiresAt": ask.as_ref().and_then(|a| a.grant_expires_at.clone()),
                    "decisionNote": ask.as_ref().and_then(|a| a.decision_note.clone()),
                    "applied": applied,
                }),
            )
            .cors()
        }
        ("GET", Some("workspace")) => match info.workspace.clone() {
            Some(url) => {
                agent.record_followup(&info, "redirected", None).await;
                LocalResponse::redirect(302, url)
            }
            None => LocalResponse::new(404, "text/plain; charset=utf-8", "no workspace is configured\n"),
        },
        _ => LocalResponse::new(404, "text/plain; charset=utf-8", "not found\n"),
    }
}

type BoxedBody = http_body_util::combinators::BoxBody<Bytes, Infallible>;

pub const SSE_KEEP_ALIVE: Duration = Duration::from_secs(20);

pub fn sse_stream(rx: tokio::sync::broadcast::Receiver<crate::agent::Sse>) -> impl futures::Stream<Item = Bytes> + Send + Sync + 'static {
    sse_stream_every(rx, SSE_KEEP_ALIVE)
}

pub fn sse_stream_every(
    rx: tokio::sync::broadcast::Receiver<crate::agent::Sse>,
    keep_alive: Duration,
) -> impl futures::Stream<Item = Bytes> + Send + Sync + 'static {
    futures::stream::once(async { Bytes::from_static(b": vibtra-guard events\n\n") }).chain(futures::stream::unfold(rx, move |mut rx| async move {
        loop {
            match tokio::time::timeout(keep_alive, rx.recv()).await {
                Err(_) => return Some((Bytes::from_static(b": keep-alive\n\n"), rx)),
                Ok(Ok(m)) => return Some((Bytes::from(format!("event: {}\ndata: {}\n\n", m.event, m.data)), rx)),
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(_)) => return None,
            }
        }
    }))
}

fn to_hyper(r: LocalResponse) -> Response<BoxedBody> {
    let mut b = Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(*k, v);
    }
    let body: BoxedBody = match r.body {
        LocalBody::Bytes(bytes) => Full::new(bytes).boxed(),
        LocalBody::Sse(rx) => BodyExt::boxed(StreamBody::new(sse_stream(rx).map(|b| Ok::<_, Infallible>(Frame::data(b))))),
    };
    b.body(body).unwrap_or_else(|_| Response::new(Full::new(Bytes::new()).boxed()))
}

pub async fn from_hyper<B>(req: Request<B>) -> LocalRequest
where
    B: hyper::body::Body,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let (parts, body) = req.into_parts();
    let header = |n: &str| parts.headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let limited = http_body_util::Limited::new(body, 64 * 1024);
    let body = limited.collect().await.map(|c| c.to_bytes()).unwrap_or_default();
    LocalRequest {
        method: parts.method.as_str().to_string(),
        path: parts.uri.path_and_query().map(|p| p.as_str().to_string()).unwrap_or_else(|| "/".to_string()),
        accept: header("accept"),
        content_type: header("content-type").to_ascii_lowercase(),
        body,
    }
}

pub fn spawn(agent: Arc<Agent>, listener: TcpListener) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let agent = agent.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let agent = agent.clone();
                    async move {
                        let lr = from_hyper(req).await;
                        Ok::<_, Infallible>(to_hyper(handle(&agent, lr).await))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), svc).await;
            });
        }
    })
}

pub fn to_hudsucker(r: LocalResponse) -> Response<hudsucker::Body> {
    let mut b = Response::builder().status(r.status);
    for (k, v) in &r.headers {
        b = b.header(*k, v);
    }
    let body = match r.body {
        LocalBody::Bytes(bytes) => hudsucker::Body::from(Full::new(bytes)),
        LocalBody::Sse(rx) => hudsucker::Body::from_stream(sse_stream(rx).map(Ok::<_, std::io::Error>)),
    };
    b.body(body).unwrap_or_else(|_| Response::new(hudsucker::Body::empty()))
}
