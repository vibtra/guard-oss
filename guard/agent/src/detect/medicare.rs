// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::{digits_of, examples_of, number_matches, DetectInput, DetectorMatch, NumberRule};
use fancy_regex::Regex;
use std::sync::LazyLock;

const WEIGHTS: [u32; 8] = [1, 3, 7, 9, 1, 3, 7, 9];

static MEDICARE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?<![0-9A-Za-z_+-])([2-6][0-9]{3})[ -]?([0-9]{5})[ -]?([0-9])(?:[ -]?([0-9]))?(?![0-9A-Za-z_-])").expect("medicare regex"));

pub fn is_valid_medicare(candidate: &str) -> bool {
    let d = digits_of(candidate);
    if d.len() != 10 && d.len() != 11 {
        return false;
    }
    if !(2..=6).contains(&d[0]) {
        return false;
    }
    let sum: u32 = d[..8].iter().zip(WEIGHTS.iter()).map(|(a, w)| a * w).sum();
    sum % 10 == d[8]
}

static CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)medicare").expect("medicare context regex"));

fn grouped(m: &str) -> bool {
    let groups: Vec<&str> = m.split([' ', '-']).collect();
    matches!(groups.iter().map(|g| g.len()).collect::<Vec<_>>().as_slice(), [4, 5, 1] | [4, 5, 1, 1])
}

pub fn detect(input: &DetectInput<'_>, require_context: bool) -> Option<DetectorMatch> {
    let m = number_matches(
        input,
        &NumberRule {
            re: &MEDICARE_RE,
            valid: is_valid_medicare,
            context: &CONTEXT_RE,
            require_context,
            grouped: Some(grouped),
            phone_guard: true,
            exclude: None,
        },
    );
    (!m.is_empty()).then(|| DetectorMatch::new("au-medicare", m.len(), examples_of(&m), None))
}
