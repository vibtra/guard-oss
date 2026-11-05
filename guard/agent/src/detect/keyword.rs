// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::DetectorMatch;

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_'
}

fn count(hay: &str, needle: &str, whole_word: bool) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut n = 0;
    let mut from = 0;
    while let Some(at) = hay[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let ok = !whole_word || {
            let before = hay[..start].chars().next_back();
            let after = hay[end..].chars().next();
            !before.is_some_and(is_word_char) && !after.is_some_and(is_word_char)
        };
        if ok {
            n += 1;
            from = end;
        } else {
            from = start + hay[start..].chars().next().map(char::len_utf8).unwrap_or(1);
        }
    }
    n
}

pub fn detect(text: &str, keywords: &[String], whole_word: bool) -> Option<DetectorMatch> {
    let lower = text.to_lowercase();
    let mut hits: Vec<String> = Vec::new();
    for k in keywords {
        let n = count(&lower, &k.to_lowercase(), whole_word);
        for _ in 0..n {
            hits.push(k.clone());
        }
    }
    if hits.is_empty() {
        return None;
    }
    let mut unique: Vec<String> = Vec::new();
    for h in &hits {
        if !unique.contains(h) {
            unique.push(h.clone());
        }
    }
    let examples = unique.iter().take(3).cloned().collect();
    Some(DetectorMatch::new("keyword", hits.len(), examples, Some(unique)))
}
