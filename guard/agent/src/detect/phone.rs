// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::views::Prepared;
use super::DetectorMatch;
use fancy_regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;

pub(crate) static PHONE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?<![0-9A-Za-z+])(?:",
        r"(?:(?:\+|00)61[ .\-]?|61[ .\-]?|0)4[0-9]{2}[ .\-]?[0-9]{3}[ .\-]?[0-9]{3}",
        r"|(?:\(0[2378]\)[ .\-]?|0[2378][ .\-]?|(?:\+|00)61[ .\-]?\(?[2378]\)?[ .\-]?)[0-9]{4}[ .\-]?[0-9]{4}",
        r"|1[38]00[ .\-]?[0-9]{3}[ .\-]?[0-9]{3}",
        r")(?![0-9])"
    ))
    .expect("phone regex")
});

pub(crate) fn spans(text: &str) -> Vec<(usize, usize)> {
    PHONE_RE.find_iter(text).filter_map(Result::ok).map(|m| (m.start(), m.end())).collect()
}

fn canonical(s: &str) -> String {
    let d: String = s.chars().filter(char::is_ascii_digit).collect();
    if let Some(rest) = d.strip_prefix("0061") {
        return format!("0{rest}");
    }
    if d.len() == 11 {
        if let Some(rest) = d.strip_prefix("61") {
            return format!("0{rest}");
        }
    }
    d
}

pub fn detect(p: &Prepared, threshold: usize) -> Option<DetectorMatch> {
    let distinct: BTreeSet<String> =
        p.strict_views().flat_map(|v| PHONE_RE.find_iter(v).filter_map(Result::ok).map(|m| canonical(m.as_str())).collect::<Vec<_>>()).collect();
    if distinct.len() < threshold {
        return None;
    }
    Some(DetectorMatch::new("phone-bulk", distinct.len(), vec![format!("{} distinct numbers", distinct.len())], None))
}
