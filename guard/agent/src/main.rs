// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use std::net::SocketAddr;
use std::path::PathBuf;
use vibtra_guard_agent::agent::{self, Options};
use vibtra_guard_agent::bundle::verify_bundle;
use vibtra_guard_agent::catalogue::{seed_catalogue, Matcher};
use vibtra_guard_agent::config::{self, Paths};
use vibtra_guard_agent::contract;
use vibtra_guard_agent::engine::{decide_request, explain, RequestFacts};
use vibtra_guard_agent::types::{Bundle, Catalogue};
use vibtra_guard_agent::{ca::Ca, sync};

#[derive(Parser)]
#[command(name = "vibtra-guard", version, about = "Vibtra Guard: see and govern which AI services this laptop uses.")]
struct Cli {
    #[arg(long, global = true, help = "The data directory (default: $VIBTRA_GUARD_DIR, else ~/Library/Application Support/Vibtra Guard)")]
    data_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    #[command(about = "Enrol this laptop with the enrol link IT gave you")]
    Enrol {
        #[arg(long, required_unless_present = "link", help = "The registry's address (https://…)")]
        server: Option<String>,
        #[arg(long, required_unless_present = "link", help = "The enrol token (genr_…)")]
        token: Option<String>,
        #[arg(long, conflicts_with_all = ["server", "token"], help = "Or the whole link: vibtra-guard://enrol?server=…&token=…")]
        link: Option<String>,
    },
    #[command(about = "Run the proxy, the local pages and the sync loop")]
    Run {
        #[arg(long, default_value_t = SocketAddr::from(([127, 0, 0, 1], contract::PROXY_PORT)))]
        proxy: SocketAddr,
        #[arg(long, default_value_t = SocketAddr::from(([127, 0, 0, 1], contract::LOCAL_PORT)))]
        local: SocketAddr,
        #[arg(
            long,
            num_args = 0..=1,
            default_missing_value = "127.0.0.1:9472",
            help = "Also listen for the Network Extension's steered flows (PROXY protocol v1), e.g. 127.0.0.1:9472"
        )]
        transparent: Option<SocketAddr>,
        #[arg(long, help = "host=url[,host=url…]: send a catalogued host's upstream elsewhere (demo / tests); Host and SNI stay")]
        upstream_map: Option<String>,
        #[arg(long, hide = true, help = "A PEM root to trust for MAPPED https upstreams only (a test upstream's self-signed certificate)")]
        upstream_ca: Option<PathBuf>,
        #[arg(long, help = "Sync every S seconds instead of the server's interval")]
        sync_every: Option<u64>,
    },
    #[command(about = "Run one sync cycle now (preflight → ruledownload → eventupload → postflight)")]
    Sync,
    #[command(about = "Show the agent's state")]
    Status {
        #[arg(long)]
        json: bool,
        #[arg(long, default_value_t = SocketAddr::from(([127, 0, 0, 1], contract::LOCAL_PORT)), help = "Where the running agent's local pages are")]
        local: SocketAddr,
    },
    #[command(about = "The per-laptop CA")]
    Ca {
        #[command(subcommand)]
        command: CaCommand,
    },
    #[command(about = "Would this be blocked? Evaluates one request against the stored bundle (or --bundle) without sending it")]
    Test {
        #[arg(long)]
        host: String,
        #[arg(long)]
        text: Option<String>,
        #[arg(long, help = "A file whose NAME is checked by the file-type rules and whose text (if UTF-8) by the others")]
        file: Vec<PathBuf>,
        #[arg(long)]
        bundle_id: Option<String>,
        #[arg(long)]
        cli: Option<String>,
        #[arg(long, help = "A bundle file (SignedGuardBundle or a bare GuardBundle) to evaluate instead of the stored one; not verified")]
        bundle: Option<PathBuf>,
        #[arg(long, help = "A catalogue file (SignedGuardCatalogue or bare) instead of the stored one")]
        catalogue: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    #[command(
        hide = true,
        about = "Detection-coverage harness (scripts/guard-detect): read JSON lines `{id, contentType?, body, filenames?}` on stdin, run body extraction + every detector in --detectors (a JSON array of `{name, detector}`), and write one JSON line per input `{id, inspectable, hits: [{name, kind, count, details?}]}` — kinds and counts only, never the matched text. Offline; touches no data dir"
    )]
    DetectScan {
        #[arg(long)]
        detectors: PathBuf,
    },
}

#[derive(Subcommand)]
enum CaCommand {
    #[command(
        about = "Print the CA certificate (PEM), or with --spki the base64 SHA-256 of its public key (Chromium's --ignore-certificate-errors-spki-list value)"
    )]
    Export {
        #[arg(long)]
        spki: bool,
    },
    #[command(about = "Trust the CA in the login keychain (macOS asks for your password)")]
    Trust,
}

fn init_logs() {
    let filter = tracing_subscriber::EnvFilter::try_from_env("VIBTRA_GUARD_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(vibtra_guard_agent::LOG_FILTER_DEFAULT));
    tracing_subscriber::fmt().with_env_filter(filter).with_writer(std::io::stderr).with_target(false).init();
}

fn parse_link(link: &str) -> Result<(String, String)> {
    let url = url::Url::parse(link).context("the enrol link does not parse")?;
    if url.scheme() != "vibtra-guard" {
        bail!("an enrol link starts with vibtra-guard://enrol");
    }
    let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    Ok((q.get("server").cloned().context("the link has no server=")?, q.get("token").cloned().context("the link has no token=")?))
}

fn load_doc<T: serde::de::DeserializeOwned>(path: &PathBuf, field: &str) -> Result<T> {
    let v: serde_json::Value = serde_json::from_slice(&std::fs::read(path).with_context(|| format!("reading {}", path.display()))?)?;
    let doc = if v.get("signature").is_some() { v[field].clone() } else { v };
    Ok(serde_json::from_value(doc)?)
}

fn detect_scan(detectors: &PathBuf) -> Result<()> {
    use std::io::{BufRead, Write};
    use vibtra_guard_agent::body::{extract, inspectable};
    use vibtra_guard_agent::detect::{run_detector, DetectInput};
    #[derive(serde::Deserialize)]
    struct Named {
        name: String,
        detector: vibtra_guard_agent::types::Detector,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Item {
        id: String,
        content_type: Option<String>,
        body: String,
        #[serde(default)]
        filenames: Vec<String>,
    }
    let list: Vec<Named> = serde_json::from_slice(&std::fs::read(detectors).with_context(|| format!("reading {}", detectors.display()))?)?;
    let stdin = std::io::stdin();
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let item: Item = serde_json::from_str(&line)?;
        let ct = item.content_type.as_deref();
        let ok = inspectable(ct);
        let mut ex = if ok { extract(ct, item.body.as_bytes()) } else { Default::default() };
        ex.filenames.extend(item.filenames);
        let input = DetectInput::new(&ex.text, &ex.filenames).with_joined(&ex.joined);
        let hits: Vec<serde_json::Value> = list
            .iter()
            .filter_map(|n| {
                run_detector(&n.detector, &input).map(|m| serde_json::json!({ "name": n.name, "kind": m.kind, "count": m.count, "details": m.details }))
            })
            .collect();
        writeln!(out, "{}", serde_json::json!({ "id": item.id, "inspectable": ok, "hits": hits }))?;
    }
    out.flush()?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logs();
    vibtra_guard_agent::init_crypto();
    let cli = Cli::parse();
    let data_dir = cli.data_dir.clone();
    match cli.command {
        Command::Enrol { server, token, link } => {
            let (server, token) = match link {
                Some(l) => parse_link(&l)?,
                None => (server.unwrap_or_default(), token.unwrap_or_default()),
            };
            let a = agent::Agent::open(&Options { data_dir, sync: false, ..Default::default() })?;
            let device = sync::enrol(&a, &server, &token).await?;
            println!("Enrolled {} as {} for {} ({}).", a.facts.hostname, device.device_id, device.person.email, device.org_name);
            match sync::sync_once(&a).await {
                Ok(r) => println!(
                    "First sync done: {} mode, bundle {}, catalogue {}.",
                    r.client_mode,
                    r.bundle_version.map(|v| v.to_string()).unwrap_or_else(|| "none".into()),
                    r.catalogue_version
                ),
                Err(e) => println!("Enrolled, but the first sync failed: {e}. `vibtra-guard run` retries."),
            }
            println!("Next: `vibtra-guard ca trust` (macOS asks for your password), then `vibtra-guard run`.");
        }
        Command::Run { proxy, local, transparent, upstream_map, upstream_ca, sync_every } => {
            let upstream_map = upstream_map.as_deref().map(agent::parse_upstream_map).transpose()?.unwrap_or_default();
            let running = agent::start(Options { data_dir, proxy, local, transparent, upstream_map, upstream_ca, sync_every, sync: true }).await?;
            eprintln!(
                "vibtra-guard: proxy http://{} · local pages http://{}{}",
                running.proxy_addr,
                running.local_addr,
                running.transparent_addr.map(|t| format!(" · transparent {t}")).unwrap_or_default()
            );
            if !running.agent.enrolled() {
                eprintln!("vibtra-guard: not enrolled: nothing is decrypted until `vibtra-guard enrol` succeeds.");
            }
            tokio::signal::ctrl_c().await?;
            eprintln!("vibtra-guard: stopping");
        }
        Command::Sync => {
            let a = agent::Agent::open(&Options { data_dir, sync: false, ..Default::default() })?;
            match sync::sync_once(&a).await {
                Ok(r) => println!("{}", serde_json::to_string_pretty(&r)?),
                Err(e) => bail!("sync failed: {e}"),
            }
        }
        Command::Status { json, local } => {
            let live = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(2))
                .build()?
                .get(format!("http://{local}{}", contract::local_paths::STATUS))
                .send()
                .await;
            let status: serde_json::Value = match live {
                Ok(r) if r.status().is_success() => r.json().await?,
                _ => {
                    let a = agent::Agent::open(&Options { data_dir, sync: false, ..Default::default() })?;
                    let mut s = a.status_json().await;
                    s["proxyListening"] = serde_json::json!(false);
                    s["running"] = serde_json::json!(false);
                    s
                }
            };
            if json {
                println!("{}", serde_json::to_string_pretty(&status)?);
            } else {
                let g = |k: &str| {
                    status
                        .get(k)
                        .filter(|v| !v.is_null())
                        .map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()))
                        .unwrap_or_else(|| "-".to_string())
                };
                println!("State:      {}", g("state"));
                println!("Person:     {}", status["person"]["email"].as_str().unwrap_or("-"));
                println!("Server:     {}", status["server"].as_str().unwrap_or("-"));
                println!("Mode:       {}", status["clientMode"].as_str().unwrap_or("-"));
                println!(
                    "Bundle:     {} {}",
                    g("bundleVersion"),
                    status["bundleDigest"].as_str().map(|d| format!("({}…)", &d[..12.min(d.len())])).unwrap_or_default()
                );
                println!("Catalogue:  {} ({})", g("catalogueVersion"), g("catalogueSource"));
                println!(
                    "Last sync:  {} {}",
                    status["lastSync"]["at"].as_str().unwrap_or("never"),
                    status["lastSync"]["error"].as_str().map(|e| format!("(error: {e})")).unwrap_or_default()
                );
                println!("Queued:     {} events", g("queuedEvents"));
                println!("CA trusted: {}", g("caTrusted"));
                println!("Proxy:      {}", if status["proxyListening"].as_bool() == Some(true) { g("proxy") } else { "not running".into() });
            }
        }
        Command::Ca { command } => {
            let paths = Paths::resolve(data_dir.as_deref());
            let ca = Ca::load_or_create(&paths, &vibtra_guard_agent::facts::hostname())?;
            match command {
                CaCommand::Export { spki } => {
                    if spki {
                        println!("{}", ca.spki_sha256_b64);
                    } else {
                        print!("{}", ca.cert_pem);
                    }
                }
                CaCommand::Trust => {
                    eprintln!("Adding \"{}\" to your login keychain as trusted for SSL. macOS will ask for your password.", ca.facts.subject);
                    vibtra_guard_agent::ca::trust_in_login_keychain(&paths)?;
                    println!("Trusted. Fingerprint {}", ca.facts.fingerprint_sha256);
                }
            }
        }
        Command::DetectScan { detectors } => detect_scan(&detectors)?,
        Command::Test { host, text, file, bundle_id, cli, bundle, catalogue, json } => {
            let paths = Paths::resolve(data_dir.as_deref());
            let device = config::load_device(&paths)?;
            let b: Bundle = match &bundle {
                Some(p) => load_doc(p, "bundle")?,
                None => {
                    let d = device.as_ref().context("not enrolled and no --bundle given")?;
                    let raw: serde_json::Value = config::read_json(&paths.bundle())?.context("no bundle yet: run `vibtra-guard sync`")?;
                    verify_bundle(&raw, &d.signing.public_key_pem, &d.signing.key_id, Some(&d.device_id))
                        .map_err(|e| anyhow::anyhow!("the stored bundle does not verify: {e}"))?
                        .bundle
                }
            };
            let cat: Catalogue = match &catalogue {
                Some(p) => load_doc(p, "catalogue")?,
                None => match config::read_json::<serde_json::Value>(&paths.catalogue())? {
                    Some(v) => serde_json::from_value(v["catalogue"].clone())?,
                    None => seed_catalogue(),
                },
            };
            let mut body_text = text.unwrap_or_default();
            let mut names = Vec::new();
            for f in &file {
                names.push(f.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                if let Ok(s) = std::fs::read_to_string(f) {
                    body_text.push('\n');
                    body_text.push_str(&s);
                }
            }
            let matcher = Matcher::new(cat);
            let v = decide_request(
                &b,
                &matcher,
                &RequestFacts { host: &host, bundle_id: bundle_id.as_deref(), cli_name: cli.as_deref(), text: &body_text, filenames: &names, joined: &[] },
                time::OffsetDateTime::now_utc(),
            );
            if json {
                let mut out = serde_json::to_value(&v)?;
                out["explanation"] = serde_json::json!(explain(&v));
                println!("{}", serde_json::to_string_pretty(&out)?);
            } else {
                println!("{}", explain(&v));
                if let Some(c) = &v.content {
                    for m in &c.matches {
                        println!(
                            "  - {} [{}] {}× {}{}",
                            m.rule.name,
                            m.rule.action.as_str(),
                            m.m.count,
                            m.m.examples.join(", "),
                            if m.excepted { " (excepted)" } else { "" }
                        );
                    }
                }
            }
        }
    }
    Ok(())
}
