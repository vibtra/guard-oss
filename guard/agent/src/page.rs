// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::agent::BlockInfo;
use crate::detect::match_words;
use crate::marks;
use crate::types::{Action, AskView};

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

const STYLE: &str = r#"
:root{color-scheme:light dark;--page:#fafafa;--card:#fff;--surface:#f5f5f5;--ink:#1f1f1f;--label:#525252;--muted:#737373;--line:#e1e1e1;--field:#737373;--button:#262626;--button-ink:#fafafa;--secondary:#f5f5f5;--ok-bg:#e8fae6;--ok-ink:#047a00;--warn-bg:#fceade;--warn-ink:#b34700;--warn-solid:#ee6002;--danger-bg:#fce3e5;--danger-ink:#ad0002;--danger-solid:#e90007;--tile:rgba(0,0,0,.05)}
@media (prefers-color-scheme:dark){:root{--page:#161515;--card:#1f1f1f;--surface:rgba(255,255,255,.05);--ink:#fafafa;--label:#d4d4d4;--muted:#a3a3a3;--line:rgba(255,255,255,.10);--field:#a3a3a3;--button:#fff;--button-ink:#1f1f1f;--secondary:rgba(255,255,255,.08);--ok-bg:rgba(6,159,0,.13);--ok-ink:#3ecf2f;--warn-bg:rgba(254,123,39,.25);--warn-ink:#fe9a5b;--warn-solid:#fe9a5b;--danger-bg:rgba(255,30,39,.25);--danger-ink:#ff878d;--danger-solid:#ff1e27;--tile:rgba(255,255,255,.05)}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page);color:var(--ink);-webkit-font-smoothing:antialiased}
body{font:0.875rem/1.4286 "Inter Variable",Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;max-width:560px;width:100%;padding:24px}
.brand{display:flex;align-items:center;gap:8px;font-size:0.75rem;line-height:1.3333;font-weight:500;color:var(--muted);margin-bottom:16px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--danger-solid)}
.dot.ask{background:var(--warn-solid)}
h1{color:var(--ink);font-size:1.5rem;line-height:1.3333;font-weight:510;margin:0 0 8px;text-wrap:balance}
.head{display:flex;align-items:flex-start;gap:16px}.head>div{min-width:0}
p{margin:0 0 8px;text-wrap:pretty}
.facts{background:var(--surface);border-radius:8px;padding:8px 16px;margin:16px 0}
.facts div{display:flex;gap:16px;padding:4px 0}
.facts dt{min-width:96px;color:var(--label)}
.facts dd{margin:0;min-width:0;color:var(--ink);overflow-wrap:anywhere}
@media (max-width:400px){.facts div{flex-direction:column;gap:2px}.facts dt{min-width:0}}
.why{border-inline-start:3px solid var(--line);padding-inline-start:12px}
form{margin:16px 0 0}
label{display:block;font-size:0.875rem;line-height:1.4286;font-weight:500;color:var(--ink);margin-bottom:8px}
textarea{width:100%;min-height:72px;border:1px solid var(--field);border-radius:8px;padding:8px 12px;font:inherit;color:var(--ink);resize:vertical;background:var(--card)}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.btn{appearance:none;border:0;border-radius:8px;background:var(--button);color:var(--button-ink);font:inherit;font-weight:500;min-height:36px;padding:8px 16px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.btn.secondary{background:var(--secondary);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
.status{border-radius:8px;padding:8px 16px;margin-top:16px;background:var(--surface);color:var(--ink)}
.status.ok{background:var(--ok-bg);color:var(--ok-ink)}
.status.no{background:var(--danger-bg);color:var(--danger-ink)}
.foot{margin-top:24px;font-size:0.75rem;line-height:1.3333;color:var(--muted);overflow-wrap:anywhere}
.foot span{white-space:nowrap}
"#;

fn fmt_date(iso: &str) -> String {
    if iso.len() >= 16 {
        format!("{} {} UTC", &iso[..10], &iso[11..16])
    } else {
        iso.to_string()
    }
}

pub fn render(info: &BlockInfo, ask: Option<&AskView>, applied: bool, base: &str) -> String {
    let service = &info.service_name;
    let is_ask = info.action == Action::Ask;
    let title = match (info.rule_kind.as_str(), is_ask) {
        ("content", false) => format!("This was not sent to {service}"),
        ("content", true) => format!("Sending this to {service} needs IT's OK"),
        (_, false) => format!("{service} is blocked on this laptop"),
        (_, true) => format!("Using {service} needs IT's OK"),
    };
    let lead = match (info.rule_kind.as_str(), is_ask) {
        ("content", _) => format!(
            "Vibtra Guard stopped this request because it contained {}{}.",
            match_words(info.match_type.as_deref().unwrap_or("")),
            match info.match_count {
                Some(n) if n > 1 => format!(" ({n} found)"),
                _ => String::new(),
            }
        ),
        (_, false) => "Your organisation does not allow this AI service from work laptops.".to_string(),
        (_, true) => "Your organisation asks people to get IT's OK before using this AI service.".to_string(),
    };
    let mut facts = String::new();
    let service_mark = marks::for_service(&info.service_id);
    facts.push_str(&format!("<div><dt>Service</dt><dd>{}{}</dd></div>", marks::tile(service_mark, false, "s"), esc(&info.service_name)));
    let app_html = info.app.as_deref().map(|app| format!("<div><dt>App</dt><dd>{}{}</dd></div>", marks::tile(marks::for_app(app), false, "a"), esc(app)));
    let mut fact = |k: &str, v: &str| facts.push_str(&format!("<div><dt>{}</dt><dd>{}</dd></div>", esc(k), esc(v)));
    if let Some(r) = &info.rule_name {
        fact("Rule", r);
    }
    if let Some(m) = &info.match_type {
        let mut what = match_words(m).to_string();
        if let Some(ex) = &info.example {
            what.push_str(&format!(": {ex}"));
        }
        fact("Found", &what);
    }
    if let Some(app) = &app_html {
        facts.push_str(app);
    }
    let mut fact = |k: &str, v: &str| facts.push_str(&format!("<div><dt>{}</dt><dd>{}</dd></div>", esc(k), esc(v)));
    fact("Where", &info.host);
    if !info.enforced {
        fact("Mode", "Monitor: this request was let through and recorded");
    }
    let why = info.note.as_deref().map(|n| format!("<p class=\"why\">This is blocked because: {}</p>", esc(n))).unwrap_or_default();
    let ev = esc(&info.event_id);
    let request_url = format!("{base}/blocked/{ev}/request");
    let status_url = format!("{base}/blocked/{ev}/status");

    let mut status_html = String::new();
    let mut poll = false;
    let state: Option<&str> = ask.map(|a| match a.status.as_str() {
        "pending" => "Waiting for IT",
        "approved" => "Approved",
        "declined" => "IT declined",
        "expired" => "Request expired",
        "cancelled" => "Request cancelled",
        _ => "Request replaced",
    });
    match ask {
        Some(a) if a.status == "pending" => {
            poll = true;
            status_html = "<div class=\"status\" id=\"ask\" role=\"status\"><strong>Waiting for IT.</strong> Your request is on the IT desk. This page updates when they decide; you can leave it open.</div>".to_string();
        }
        Some(a) if a.status == "approved" => {
            let until = a.grant_expires_at.as_deref().map(fmt_date).map(|d| format!(" until {d}")).unwrap_or_default();
            if applied {
                status_html = format!("<div class=\"status ok\" id=\"ask\" role=\"status\"><strong>Approved{}.</strong> Try again.</div>", esc(&until));
            } else {
                poll = true;
                status_html = format!(
                    "<div class=\"status ok\" id=\"ask\" role=\"status\"><strong>Approved{}.</strong> Applying the new rules to this laptop…</div>",
                    esc(&until)
                );
            }
        }
        Some(a) => {
            let note = a.decision_note.as_deref().map(|n| format!(" IT said: “{}”", esc(n))).unwrap_or_default();
            let word = match a.status.as_str() {
                "declined" => "IT declined this request.",
                "expired" => "This request expired before IT decided.",
                "cancelled" => "This request was cancelled.",
                _ => "This request was replaced by a newer one.",
            };
            status_html = format!("<div class=\"status no\" id=\"ask\" role=\"status\"><strong>{word}</strong>{note}</div>");
        }
        None => {}
    }

    let form = if info.requests_enabled && ask.is_none_or(|a| a.status != "pending" && a.status != "approved") {
        format!(
            "<form method=\"post\" action=\"{request_url}\"><label for=\"note\">Why do you need it? (optional, IT sees this line)</label><textarea id=\"note\" name=\"note\" maxlength=\"280\"></textarea><div class=\"row\"><button class=\"btn\" type=\"submit\">Request access</button>{ws}</div></form>",
            ws = workspace_button(info, base)
        )
    } else if let Some(ws) = Some(workspace_button(info, base)).filter(|w| !w.is_empty()) {
        format!("<div class=\"row\">{ws}</div>")
    } else {
        String::new()
    };

    let script = if poll {
        format!(
            "<script>(function(){{var u={u:?};function t(){{fetch(u,{{cache:'no-store'}}).then(function(r){{return r.json()}}).then(function(s){{if(s.status!=='pending'&&!(s.status==='approved'&&!s.applied)){{location.reload()}}else{{setTimeout(t,3000)}}}}).catch(function(){{setTimeout(t,5000)}})}}setTimeout(t,3000)}})();</script>",
            u = status_url
        )
    } else {
        String::new()
    };

    let dot = if is_ask { "dot ask" } else { "dot" };
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"icon\" href=\"data:,\"><title>{title_plain} · Vibtra Guard</title><style>{STYLE}{mark_style}</style></head><body><main><div class=\"card\"><div class=\"brand\"><span class=\"{dot}\" aria-hidden=\"true\"></span>Vibtra Guard</div><div class=\"head\">{head_mark}<div><h1>{title_html}</h1><p>{lead}</p></div></div>{why}<dl class=\"facts\">{facts}</dl>{status_html}{form}<div class=\"foot\"><span>Event {ev}</span> · <span>{when}</span></div></div></main>{script}</body></html>",
        title_plain = match state {
            Some(st) => format!("{st}: {}", esc(&title)),
            None => esc(&title),
        },
        title_html = esc(&title),
        lead = esc(&lead),
        when = esc(&fmt_date(&info.occurred_at)),
        head_mark = marks::tile(service_mark, true, "h"),
        mark_style = marks::STYLE,
    )
}

fn workspace_button(info: &BlockInfo, base: &str) -> String {
    match &info.workspace {
        Some(_) => format!("<a class=\"btn secondary\" href=\"{base}/blocked/{}/workspace\">Use the company Vibtra workspace</a>", esc(&info.event_id)),
        None => String::new(),
    }
}

pub fn message(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><link rel=\"icon\" href=\"data:,\"><title>{t} · Vibtra Guard</title><style>{STYLE}</style></head><body><main><div class=\"card\"><div class=\"brand\"><span class=\"dot\" aria-hidden=\"true\"></span>Vibtra Guard</div><h1>{t}</h1><p>{b}</p></div></main></body></html>",
        t = esc(title),
        b = esc(body)
    )
}
