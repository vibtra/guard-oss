// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use base64::Engine;
use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, Default)]
pub struct Prepared {
    pub primary: String,
    pub decoded: Vec<String>,
    pub joined: Vec<String>,
    pub collapsed: Vec<String>,
}

impl Prepared {
    pub fn context_views(&self) -> impl Iterator<Item = &String> {
        self.joined.iter().chain(self.collapsed.iter())
    }
    pub fn strict_views(&self) -> impl Iterator<Item = &String> {
        std::iter::once(&self.primary).chain(self.decoded.iter())
    }
}

static PERCENT_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:%[0-9A-Fa-f]{2})+").expect("percent regex"));
static ZERO_WIDTH: LazyLock<Regex> = LazyLock::new(|| Regex::new("[\u{200B}-\u{200D}\u{2060}\u{FEFF}]").expect("zero-width regex"));
static BASE64_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[A-Za-z0-9+/]{24,}={0,2}").expect("base64 regex"));
static DIGIT_GAP: LazyLock<FancyRegex> = LazyLock::new(|| FancyRegex::new(r"(?<=[0-9])(?:[ .\-]{1,3}|[ \t]*\r?\n[ \t]*)(?=[0-9])").expect("digit gap regex"));

fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    PERCENT_RUN
        .replace_all(s, |c: &regex::Captures<'_>| {
            let run = &c[0];
            let bytes: Vec<u8> = (0..run.len() / 3).filter_map(|i| u8::from_str_radix(&run[i * 3 + 1..i * 3 + 3], 16).ok()).collect();
            String::from_utf8(bytes).unwrap_or_else(|_| run.to_string())
        })
        .into_owned()
}

pub fn normalise(s: &str) -> String {
    let s = percent_decode(s);
    let s = ZERO_WIDTH.replace_all(&s, "");
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(&s).into_owned()
}

fn printable(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c == '\n' || c == '\r' || c == '\t' || !c.is_control())
}

fn decode_base64(run: &str) -> Option<String> {
    let body = run.trim_end_matches('=');
    let body = if body.len() % 4 == 1 { &body[..body.len() - 1] } else { body };
    const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::RequireNone),
    );
    let bytes = LENIENT.decode(body).ok()?;
    String::from_utf8(bytes).ok().filter(|t| printable(t))
}

pub fn prepare(text: &str, joined: &[String]) -> Prepared {
    let primary = normalise(text);
    let decoded: Vec<String> = BASE64_RUN.find_iter(&primary).filter_map(|m| decode_base64(m.as_str())).map(|t| normalise(&t)).collect();
    let joined: Vec<String> = joined.iter().map(|j| normalise(j)).collect();
    let collapsed = std::iter::once(&primary)
        .chain(decoded.iter())
        .chain(joined.iter())
        .filter_map(|v| {
            let c = collapse(v);
            (c != *v).then_some(c)
        })
        .collect();
    Prepared { primary, decoded, joined, collapsed }
}

pub fn collapse(s: &str) -> String {
    DIGIT_GAP.replace_all(s, "").into_owned()
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

pub fn unwrap_lines(s: &str, parity: usize) -> String {
    let lines: Vec<&str> = s.split('\n').collect();
    let bare = |l: &str| l.strip_suffix('\r').unwrap_or(l).to_string();
    let mut out = String::with_capacity(s.len());
    let mut chain: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if i == 0 {
            out.push_str(line);
            continue;
        }
        let prev = bare(lines[i - 1]);
        let removable = prev.chars().last().is_some_and(token_char) && line.chars().next().is_some_and(token_char);
        chain = match (removable, chain) {
            (false, _) => None,
            (true, Some(k)) if !prev.is_empty() && prev.chars().all(token_char) => Some(k + 1),
            (true, _) => Some(0),
        };
        if chain.is_some_and(|k| k % 2 == parity) {
            if out.ends_with('\r') {
                out.pop();
            }
        } else {
            out.push('\n');
        }
        out.push_str(line);
    }
    out
}
