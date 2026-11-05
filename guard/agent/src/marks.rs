// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    pub title: String,
    pub light: String,
    pub dark: Option<String>,
    pub light_tile_on_dark: bool,
    #[serde(default)]
    pub wide: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub by_bundle_id: HashMap<String, String>,
    pub by_name: HashMap<String, String>,
    pub by_cli: HashMap<String, String>,
    pub by_service: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct Marks {
    pub marks: HashMap<String, Mark>,
    pub index: Index,
}

const GENERATED: &str = include_str!("marks.generated.json");

pub fn marks() -> &'static Marks {
    static MARKS: OnceLock<Marks> = OnceLock::new();
    MARKS.get_or_init(|| serde_json::from_str(GENERATED).expect("marks.generated.json is the generator's own output"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Glyph {
    Service,
    App,
    Cli,
}

#[derive(Debug, Clone, Copy)]
pub enum Lookup {
    Mark(&'static str),
    Glyph(Glyph),
}

fn mark_id(id: Option<&String>) -> Option<&'static str> {
    let m = marks();
    let id = id?;
    m.marks.get_key_value(id.as_str()).map(|(k, _)| k.as_str())
}

pub fn for_service(service_id: &str) -> Lookup {
    match mark_id(marks().index.by_service.get(service_id)) {
        Some(id) => Lookup::Mark(id),
        None => Lookup::Glyph(Glyph::Service),
    }
}

pub fn for_app(app: &str) -> Lookup {
    let ix = &marks().index;
    let lower = app.to_ascii_lowercase();
    let mut hits: Vec<Option<&String>> = vec![ix.by_bundle_id.get(app), ix.by_name.get(&lower), ix.by_cli.get(app)];
    for c in [
        lower.clone(),
        lower.trim_end_matches("-cli").to_string(),
        lower.trim_end_matches("_cli_rs").to_string(),
        lower.trim_end_matches("_cli").to_string(),
        lower.trim_end_matches("-code").to_string(),
    ] {
        hits.push(ix.by_cli.get(&c));
    }
    if let Some(hit) = hits.into_iter().flatten().next() {
        return match mark_id(Some(hit)) {
            Some(id) => Lookup::Mark(id),
            None => Lookup::Glyph(Glyph::Cli),
        };
    }
    let cli_like = !app.is_empty() && app.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'_' || b == b'-');
    Lookup::Glyph(if cli_like { Glyph::Cli } else { Glyph::App })
}

const GLOBE: &str = r#"<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>"#;
const WINDOW: &str = r#"<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>"#;
const PROMPT: &str = r#"<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/>"#;

pub const STYLE: &str = r#"
.mk{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:6px;background:var(--tile);color:var(--ink);vertical-align:-5px;margin-inline-end:8px}
.mk svg{width:14px;height:14px;display:block}
.mk.lg{width:40px;height:40px;border-radius:10px;margin:0}.mk.lg svg{width:26px;height:26px}
.mk.w svg{width:16px;height:auto}.mk.lg.w svg{width:36px;height:auto}
.mk.glyph svg{fill:none;stroke:var(--muted);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.mk .d{display:none}
@media (prefers-color-scheme:dark){.mk .l{display:none}.mk .d{display:block}.mk.lt{background:#fafafa;color:#1f1f1f}}
"#;

pub fn tile(lookup: Lookup, large: bool, instance: &str) -> String {
    let size = if large { " lg" } else { "" };
    match lookup {
        Lookup::Glyph(g) => {
            let (body, name) = match g {
                Glyph::Service => (GLOBE, "service"),
                Glyph::App => (WINDOW, "app"),
                Glyph::Cli => (PROMPT, "cli"),
            };
            format!("<span class=\"mk glyph{size}\" data-glyph=\"{name}\" aria-hidden=\"true\"><svg viewBox=\"0 0 24 24\">{body}</svg></span>")
        }
        Lookup::Mark(id) => {
            let m = &marks().marks[id];
            let lt = if m.light_tile_on_dark { " lt" } else { "" };
            let lt = if m.wide { format!("{lt} w") } else { lt.to_string() };
            let light = m.light.replace("gmid_", &format!("{instance}l_"));
            let inner = match &m.dark {
                None => light,
                Some(dark) => format!(
                    "{}{}",
                    light.replacen("<svg ", "<svg class=\"l\" ", 1),
                    dark.replace("gmid_", &format!("{instance}d_")).replacen("<svg ", "<svg class=\"d\" ", 1)
                ),
            };
            format!("<span class=\"mk{size}{lt}\" data-mark=\"{id}\" title=\"{}\" aria-hidden=\"true\">{inner}</span>", crate::page::esc(&m.title))
        }
    }
}
