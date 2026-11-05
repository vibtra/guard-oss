// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::{digits_of, examples_of, number_matches, DetectInput, DetectorMatch, NumberRule};
use fancy_regex::Regex;
use std::sync::LazyLock;

const WEIGHTS: [i64; 11] = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

static ABN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?<![0-9A-Za-z_+-])([0-9]{2})[ -]?([0-9]{3})[ -]?([0-9]{3})[ -]?([0-9]{3})(?![0-9A-Za-z_-])").expect("abn regex"));

pub fn is_valid_abn(candidate: &str) -> bool {
    let d = digits_of(candidate);
    if d.len() != 11 {
        return false;
    }
    let sum: i64 = d.iter().enumerate().map(|(i, &x)| (if i == 0 { x as i64 - 1 } else { x as i64 }) * WEIGHTS[i]).sum();
    sum % 89 == 0
}

static CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:\b|_)(?:abn|business[\s_-]*number)").expect("abn context regex"));

pub fn detect(input: &DetectInput<'_>) -> Option<DetectorMatch> {
    let m = number_matches(
        input,
        &NumberRule { re: &ABN_RE, valid: is_valid_abn, context: &CONTEXT_RE, require_context: false, grouped: None, phone_guard: false, exclude: None },
    );
    (!m.is_empty()).then(|| DetectorMatch::new("au-abn", m.len(), examples_of(&m), None))
}
