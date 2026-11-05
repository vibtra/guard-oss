// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::{digits_of, examples_of, number_matches, DetectInput, DetectorMatch, NumberRule};
use fancy_regex::Regex;
use std::sync::LazyLock;

static CARD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?<![0-9A-Za-z_-])(?:[0-9][ -]?){12,18}[0-9](?![0-9A-Za-z_-])").expect("card regex"));

pub fn is_valid_luhn(candidate: &str) -> bool {
    let d = digits_of(candidate);
    if d.len() < 13 || d.len() > 19 {
        return false;
    }
    let mut sum = 0;
    let mut double = false;
    for &digit in d.iter().rev() {
        let mut x = digit;
        if double {
            x *= 2;
            if x > 9 {
                x -= 9;
            }
        }
        sum += x;
        double = !double;
    }
    sum % 10 == 0
}

pub fn iin_allows(d: &[u32]) -> bool {
    let n = d.len();
    let p = |k: usize| d.iter().take(k).fold(0u32, |a, &x| a * 10 + x);
    let (p1, p2, p3, p4) = (p(1), p(2), p(3), p(4));
    match p1 {
        4 => matches!(n, 13 | 16 | 19),
        5 => ((51..=55).contains(&p2) && n == 16) || (matches!(p4, 5018 | 5020 | 5038 | 5893) && (12..=19).contains(&n)),
        2 => ((2221..=2720).contains(&p4) && n == 16) || ((2200..=2204).contains(&p4) && (16..=19).contains(&n)),
        3 => {
            (matches!(p2, 34 | 37) && n == 15)
                || ((3528..=3589).contains(&p4) && (16..=19).contains(&n))
                || (((300..=305).contains(&p3) || matches!(p2, 36 | 38 | 39)) && (14..=19).contains(&n))
        }
        6 => {
            ((p4 == 6011 || (644..=649).contains(&p3) || p2 == 65) && (16..=19).contains(&n))
                || (p2 == 62 && (16..=19).contains(&n))
                || (matches!(p4, 6304 | 6759 | 6761 | 6762 | 6763) && (12..=19).contains(&n))
        }
        _ => false,
    }
}

pub fn is_valid_card(candidate: &str) -> bool {
    is_valid_luhn(candidate) && iin_allows(&digits_of(candidate))
}

static CONTEXT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:\b|_)(?:credit|card|visa|master\s*card|cc|amex|american\s+express|discover|jcb|diners|maestro|unionpay)(?:\b|_)")
        .expect("card context regex")
});

static LABEL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[^0-9a-z])(?:con[\s-]?note|consignment|waybill|air[\s-]?waybill|awb|sscc|pallet|parcel|shipment|tracking|imei|serial|s/n)(?:\s*(?:no\.?|number|num|id|code|#))?\s*[:#=.-]?\s*$",
    )
    .expect("card exclusion label regex")
});

pub fn detect(input: &DetectInput<'_>) -> Option<DetectorMatch> {
    let m = number_matches(
        input,
        &NumberRule {
            re: &CARD_RE,
            valid: is_valid_card,
            context: &CONTEXT_RE,
            require_context: false,
            grouped: None,
            phone_guard: false,
            exclude: Some(&LABEL_RE),
        },
    );
    (!m.is_empty()).then(|| DetectorMatch::new("card-number", m.len(), examples_of(&m), None))
}
