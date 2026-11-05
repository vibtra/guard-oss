// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

pub mod abn;
pub mod acn;
pub mod card;
pub mod email;
pub mod filetype;
pub mod keyword;
pub mod medicare;
pub mod phone;
pub mod secret;
pub mod tfn;
pub mod views;

use crate::redact::redact_match;
use crate::types::Detector;
use serde::Serialize;

pub use abn::is_valid_abn;
pub use acn::is_valid_acn;
pub use card::{is_valid_card, is_valid_luhn};
pub use medicare::is_valid_medicare;
pub use tfn::is_valid_tfn;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DetectorMatch {
    pub kind: String,
    pub count: usize,
    pub examples: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Vec<String>>,
}

impl DetectorMatch {
    pub fn new(kind: &str, count: usize, examples: Vec<String>, details: Option<Vec<String>>) -> Self {
        DetectorMatch { kind: kind.to_string(), count, examples, details }
    }
}

#[derive(Debug, Clone, Default)]
pub struct DetectInput<'a> {
    pub text: &'a str,
    pub filenames: &'a [String],
    pub joined: &'a [String],
    prepared: std::cell::OnceCell<views::Prepared>,
}

impl<'a> DetectInput<'a> {
    pub fn new(text: &'a str, filenames: &'a [String]) -> Self {
        DetectInput { text, filenames, joined: &[], prepared: std::cell::OnceCell::new() }
    }
    pub fn with_joined(mut self, joined: &'a [String]) -> Self {
        self.joined = joined;
        self.prepared = std::cell::OnceCell::new();
        self
    }
    pub fn prepared(&self) -> &views::Prepared {
        self.prepared.get_or_init(|| views::prepare(self.text, self.joined))
    }
}

pub(crate) fn digits_of(s: &str) -> Vec<u32> {
    s.chars().filter_map(|c| c.to_digit(10).filter(|_| c.is_ascii_digit())).collect()
}

fn digit_key(s: &str) -> String {
    s.chars().filter(char::is_ascii_digit).collect()
}

pub const CONTEXT_WINDOW: usize = 60;

pub(crate) fn near_context(text: &str, start: usize, end: usize, context: &fancy_regex::Regex) -> bool {
    let near = |s: &str| context.is_match(s).unwrap_or(false);
    let before: String = {
        let chars: Vec<char> = text[..start].chars().collect();
        chars[chars.len().saturating_sub(CONTEXT_WINDOW)..].iter().collect()
    };
    let after: String = text[end..].chars().take(CONTEXT_WINDOW).collect();
    near(&before) || near(&after)
}

pub(crate) struct NumberRule<'r> {
    pub re: &'r fancy_regex::Regex,
    pub valid: fn(&str) -> bool,
    pub context: &'r fancy_regex::Regex,
    pub require_context: bool,
    pub grouped: Option<fn(&str) -> bool>,
    pub phone_guard: bool,
    pub exclude: Option<&'r fancy_regex::Regex>,
}

pub const LABEL_WINDOW: usize = 40;

pub(crate) fn labelled_as(text: &str, start: usize, label: &fancy_regex::Regex) -> bool {
    let chars: Vec<char> = text[..start].chars().collect();
    let before: String = chars[chars.len().saturating_sub(LABEL_WINDOW)..].iter().collect();
    label.is_match(&before).unwrap_or(false)
}

pub(crate) fn number_matches(input: &DetectInput<'_>, rule: &NumberRule<'_>) -> Vec<String> {
    let p = input.prepared();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let strict = std::iter::once(&p.primary).chain(p.decoded.iter());
    for (i, view) in strict.enumerate() {
        let phones = if rule.phone_guard { phone::spans(view) } else { Vec::new() };
        for m in rule.re.find_iter(view).filter_map(Result::ok) {
            if !(rule.valid)(m.as_str()) {
                continue;
            }
            let ctx = near_context(view, m.start(), m.end(), rule.context);
            if rule.require_context && !ctx && !rule.grouped.is_some_and(|g| g(m.as_str())) {
                continue;
            }
            if !ctx && phones.iter().any(|&(a, b)| a < m.end() && m.start() < b) {
                continue;
            }
            if !ctx && rule.exclude.is_some_and(|x| labelled_as(view, m.start(), x)) {
                continue;
            }
            let key = digit_key(m.as_str());
            if i > 0 && seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            out.push(m.as_str().to_string());
        }
    }
    for view in p.context_views() {
        for m in rule.re.find_iter(view).filter_map(Result::ok) {
            if !(rule.valid)(m.as_str()) || !near_context(view, m.start(), m.end(), rule.context) {
                continue;
            }
            let key = digit_key(m.as_str());
            if seen.insert(key) {
                out.push(m.as_str().to_string());
            }
        }
    }
    out
}

pub(crate) fn examples_of(matches: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in matches {
        let r = redact_match(m);
        if !out.contains(&r) {
            out.push(r);
        }
        if out.len() == 3 {
            break;
        }
    }
    out
}

pub fn run_detector(detector: &Detector, input: &DetectInput<'_>) -> Option<DetectorMatch> {
    let text = input.text;
    match detector {
        Detector::AuTfn { require_context } => tfn::detect(input, *require_context),
        Detector::AuAbn => abn::detect(input),
        Detector::AuAcn { require_context } => acn::detect(input, *require_context),
        Detector::AuMedicare { require_context } => medicare::detect(input, *require_context),
        Detector::CardNumber => card::detect(input),
        Detector::Secret { rules } => secret::detect(input.prepared(), rules.as_deref()),
        Detector::EmailBulk { threshold } => email::detect(input.prepared(), *threshold),
        Detector::PhoneBulk { threshold } => phone::detect(input.prepared(), *threshold),
        Detector::Keyword { keywords, whole_word } => keyword::detect(text, keywords, *whole_word),
        Detector::FileType { extensions } => filetype::detect(input.filenames, extensions),
    }
}

pub fn snippet_label(kind: &str) -> &'static str {
    match kind {
        "au-tfn" => "TFN",
        "au-abn" => "ABN",
        "au-acn" => "ACN",
        "au-medicare" => "Medicare",
        "card-number" => "Card",
        "secret" => "Secret",
        "email-bulk" => "Emails",
        "phone-bulk" => "Phones",
        "keyword" => "Keyword",
        "file-type" => "File",
        _ => "Match",
    }
}

pub fn match_words(kind: &str) -> &'static str {
    match kind {
        "au-tfn" => "a tax file number",
        "au-abn" => "an ABN",
        "au-acn" => "an ACN",
        "au-medicare" => "a Medicare number",
        "card-number" => "a payment card number",
        "secret" => "an API key or secret",
        "email-bulk" => "a list of email addresses",
        "phone-bulk" => "a list of phone numbers",
        "keyword" => "a restricted word",
        "file-type" => "a restricted file type",
        _ => "restricted content",
    }
}
