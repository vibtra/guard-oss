// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::{digits_of, examples_of, number_matches, DetectInput, DetectorMatch, NumberRule};
use fancy_regex::Regex;
use std::sync::LazyLock;

const WEIGHTS: [u32; 9] = [1, 4, 3, 7, 5, 8, 6, 9, 10];

pub(crate) static TFN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?<![0-9A-Za-z_+-])([0-9]{3})[ -]?([0-9]{3})[ -]?([0-9]{3})(?![0-9A-Za-z_-])").expect("tfn regex"));

pub fn is_valid_tfn(candidate: &str) -> bool {
    let d = digits_of(candidate);
    if d.len() != 9 {
        return false;
    }
    let sum: u32 = d.iter().zip(WEIGHTS.iter()).map(|(a, w)| a * w).sum();
    sum.is_multiple_of(11)
}

pub(crate) static CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:\b|_)(?:tfn|tax[\s_-]*file)").expect("tfn context regex"));

pub(crate) fn grouped(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 11 && b[3] == b' ' && b[7] == b' '
}

pub fn detect(input: &DetectInput<'_>, require_context: bool) -> Option<DetectorMatch> {
    let m = number_matches(
        input,
        &NumberRule { re: &TFN_RE, valid: is_valid_tfn, context: &CONTEXT_RE, require_context, grouped: Some(grouped), phone_guard: true, exclude: None },
    );
    (!m.is_empty()).then(|| DetectorMatch::new("au-tfn", m.len(), examples_of(&m), None))
}
