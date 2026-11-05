// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

pub fn redact_match(value: &str) -> String {
    let compact: Vec<char> = value.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let n = compact.len();
    if n < 7 {
        return "*".repeat(n);
    }
    let head: String = compact[..3].iter().collect();
    let tail: String = compact[n - 3..].iter().collect();
    format!("{head}{}{tail}", "*".repeat(n - 6))
}
