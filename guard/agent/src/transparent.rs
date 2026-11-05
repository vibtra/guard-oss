// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyHeader {
    pub protocol: String,
    pub src: Option<String>,
    pub dst: Option<String>,
    pub src_port: Option<u16>,
    pub dst_port: Option<u16>,
}

pub fn parse_proxy_v1(line: &str) -> Option<ProxyHeader> {
    let mut it = line.split(' ');
    if it.next()? != "PROXY" {
        return None;
    }
    let protocol = it.next()?.to_string();
    if protocol == "UNKNOWN" {
        return Some(ProxyHeader { protocol, src: None, dst: None, src_port: None, dst_port: None });
    }
    if protocol != "TCP4" && protocol != "TCP6" {
        return None;
    }
    let src = it.next()?.to_string();
    let dst = it.next()?.to_string();
    let src_port = it.next()?.parse().ok()?;
    let dst_port = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some(ProxyHeader { protocol, src: Some(src), dst: Some(dst), src_port: Some(src_port), dst_port: Some(dst_port) })
}

pub fn sni_from_client_hello(record: &[u8]) -> Option<String> {
    let rd = |i: usize| record.get(i).copied();
    let u16_at = |i: usize| Some(((rd(i)? as usize) << 8) | rd(i + 1)? as usize);
    if rd(0)? != 0x16 {
        return None;
    }
    let rec_len = u16_at(3)?;
    let end = (5 + rec_len).min(record.len());
    if rd(5)? != 0x01 {
        return None;
    }
    let mut p = 5 + 4;
    p += 2 + 32;
    p += 1 + rd(p)? as usize;
    p += 2 + u16_at(p)?;
    p += 1 + rd(p)? as usize;
    let ext_end = (p + 2 + u16_at(p)?).min(end);
    p += 2;
    while p + 4 <= ext_end {
        let ty = u16_at(p)?;
        let len = u16_at(p + 2)?;
        p += 4;
        if ty == 0 {
            let mut q = p + 2;
            let list_end = (p + 2 + u16_at(p)?).min(p + len);
            while q + 3 <= list_end {
                let name_type = rd(q)?;
                let name_len = u16_at(q + 1)?;
                q += 3;
                if name_type == 0 {
                    let name = record.get(q..q + name_len)?;
                    return std::str::from_utf8(name).ok().map(|s| s.to_ascii_lowercase());
                }
                q += name_len;
            }
            return None;
        }
        p += len;
    }
    None
}

async fn read_line(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut line = Vec::with_capacity(108);
    let mut byte = [0u8; 1];
    while line.len() < 108 {
        stream.read_exact(&mut byte).await?;
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

pub const HEALTH_LINE: &str = "PROXY UNKNOWN vibtra-health";
pub const HEALTH_ANSWER: &[u8] = b"VIBTRA-GUARD OK\r\n";

pub const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

async fn within<T>(limit: Duration, what: &str, fut: impl std::future::Future<Output = std::io::Result<T>>) -> anyhow::Result<T> {
    match tokio::time::timeout(limit, fut).await {
        Ok(r) => Ok(r?),
        Err(_) => anyhow::bail!("{what}: no answer in {} s", limit.as_secs()),
    }
}

async fn read_client_hello(client: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut head = [0u8; 5];
    client.read_exact(&mut head).await?;
    let len = ((head[3] as usize) << 8) | head[4] as usize;
    let mut record = head.to_vec();
    record.resize(5 + len.min(16 * 1024 + 256), 0);
    client.read_exact(&mut record[5..]).await?;
    Ok(record)
}

async fn read_connect_answer(upstream: &mut TcpStream) -> std::io::Result<Vec<u8>> {
    let mut resp = Vec::new();
    let mut b = [0u8; 1];
    while !resp.ends_with(b"\r\n\r\n") && resp.len() < 4096 {
        upstream.read_exact(&mut b).await?;
        resp.push(b[0]);
    }
    Ok(resp)
}

pub type InterceptFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placement {
    Intercept { authority: String },
    Blind { host: String, port: u16 },
}

pub fn place(header: &ProxyHeader, sni: Option<&str>, intercept: &dyn Fn(&str) -> bool) -> Option<Placement> {
    let port = header.dst_port.unwrap_or(443);
    if let Some(name) = sni.filter(|n| !n.is_empty() && intercept(n)) {
        let authority = if name.contains(':') { format!("[{name}]:{port}") } else { format!("{name}:{port}") };
        return Some(Placement::Intercept { authority });
    }
    let host = header.dst.clone().or_else(|| sni.map(str::to_string))?;
    Some(Placement::Blind { host, port })
}

async fn serve(client: TcpStream, proxy: SocketAddr, intercept: InterceptFn) -> anyhow::Result<()> {
    serve_with(client, proxy, intercept, HEADER_TIMEOUT, HELLO_TIMEOUT, CONNECT_TIMEOUT).await
}

pub async fn serve_with(
    mut client: TcpStream,
    proxy: SocketAddr,
    intercept: InterceptFn,
    header_timeout: Duration,
    hello_timeout: Duration,
    connect_timeout: Duration,
) -> anyhow::Result<()> {
    let line = within(header_timeout, "the PROXY v1 line", read_line(&mut client)).await?;
    if line == HEALTH_LINE {
        client.write_all(HEALTH_ANSWER).await?;
        let _ = client.shutdown().await;
        return Ok(());
    }
    let header = parse_proxy_v1(&line).ok_or_else(|| anyhow::anyhow!("not a PROXY v1 preamble"))?;
    let record = within(hello_timeout, "the TLS ClientHello", read_client_hello(&mut client)).await?;
    let sni = sni_from_client_hello(&record);
    let authority = match place(&header, sni.as_deref(), &*intercept).ok_or_else(|| anyhow::anyhow!("no SNI and no destination"))? {
        Placement::Intercept { authority } => authority,
        Placement::Blind { host, port } => {
            let mut upstream = within(connect_timeout, "the original destination", TcpStream::connect((host.as_str(), port))).await?;
            upstream.write_all(&record).await?;
            tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
            return Ok(());
        }
    };
    let mut upstream = within(connect_timeout, "the agent's proxy", TcpStream::connect(proxy)).await?;
    upstream.write_all(format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n").as_bytes()).await?;
    let resp = within(connect_timeout, "the CONNECT", read_connect_answer(&mut upstream)).await?;
    if !resp.starts_with(b"HTTP/1.1 200") && !resp.starts_with(b"HTTP/1.0 200") {
        anyhow::bail!("the proxy refused CONNECT");
    }
    upstream.write_all(&record).await?;
    tokio::io::copy_bidirectional(&mut client, &mut upstream).await?;
    Ok(())
}

pub fn spawn(agent: Arc<crate::agent::Agent>, listener: TcpListener, proxy: SocketAddr) -> JoinHandle<()> {
    spawn_with(listener, proxy, Arc::new(move |host: &str| agent.should_intercept(host)))
}

pub fn spawn_with(listener: TcpListener, proxy: SocketAddr, intercept: InterceptFn) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let stream = match listener.accept().await {
                Ok((stream, _)) => stream,
                Err(e) => {
                    tracing::warn!(error = %e, "transparent accept failed");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                }
            };
            let intercept = intercept.clone();
            tokio::spawn(async move {
                if let Err(e) = serve(stream, proxy, intercept).await {
                    tracing::debug!(error = %e, "transparent connection ended");
                }
            });
        }
    })
}
