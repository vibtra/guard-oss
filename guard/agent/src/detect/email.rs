// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::views::Prepared;
use super::DetectorMatch;
use regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;

static EMAIL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?-u:\b)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?-u:\b)").expect("email regex"));
static SPELLED_AT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[ \t]*[\[({][ \t]*at[ \t]*[\])}][ \t]*").expect("at regex"));
static SPELLED_DOT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[ \t]*[\[({][ \t]*dot[ \t]*[\])}][ \t]*").expect("dot regex"));

fn unspell(s: &str) -> String {
    let s = SPELLED_AT.replace_all(s, "@");
    SPELLED_DOT.replace_all(&s, ".").into_owned()
}

pub fn detect(p: &Prepared, threshold: usize) -> Option<DetectorMatch> {
    let mut distinct: BTreeSet<String> = BTreeSet::new();
    for view in p.strict_views() {
        distinct.extend(EMAIL_RE.find_iter(view).map(|m| m.as_str().to_lowercase()));
        let plain = unspell(view);
        if plain != *view {
            distinct.extend(EMAIL_RE.find_iter(&plain).map(|m| m.as_str().to_lowercase()));
        }
    }
    if distinct.len() < threshold {
        return None;
    }
    Some(DetectorMatch::new("email-bulk", distinct.len(), vec![format!("{} distinct addresses", distinct.len())], None))
}
