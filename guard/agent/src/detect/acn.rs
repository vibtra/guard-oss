// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::{digits_of, examples_of, number_matches, tfn, tfn::TFN_RE, DetectInput, DetectorMatch, NumberRule};
use fancy_regex::Regex;
use std::sync::LazyLock;

const WEIGHTS: [u32; 8] = [8, 7, 6, 5, 4, 3, 2, 1];

pub fn is_valid_acn(candidate: &str) -> bool {
    let d = digits_of(candidate);
    if d.len() != 9 {
        return false;
    }
    let sum: u32 = d[..8].iter().zip(WEIGHTS.iter()).map(|(a, w)| a * w).sum();
    (10 - (sum % 10)) % 10 == d[8]
}

static CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:\b|_)(?:acn|company[\s_-]*number)").expect("acn context regex"));

pub fn detect(input: &DetectInput<'_>, require_context: bool) -> Option<DetectorMatch> {
    let m = number_matches(
        input,
        &NumberRule { re: &TFN_RE, valid: is_valid_acn, context: &CONTEXT_RE, require_context, grouped: Some(tfn::grouped), phone_guard: true, exclude: None },
    );
    (!m.is_empty()).then(|| DetectorMatch::new("au-acn", m.len(), examples_of(&m), None))
}
