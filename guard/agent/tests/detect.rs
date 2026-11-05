// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use vibtra_guard_agent::detect::views::{collapse, normalise, prepare, unwrap_lines};
use vibtra_guard_agent::detect::{run_detector, DetectInput};
use vibtra_guard_agent::types::Detector;

#[test]
fn views_normalise_collapse_and_unwrap() {
    assert_eq!(normalise("１２３ ４５６"), "123 456");
    assert_eq!(normalise("12\u{200B}3"), "123");
    assert_eq!(normalise("My%20TFN%20is"), "My TFN is");
    assert_eq!(normalise("100%ff sure"), "100%ff sure", "a run that is not UTF-8 stays");
    assert_eq!(collapse("123.456.782 and 1 23  45"), "123456782 and 12345");
    assert_eq!(collapse("123\n456"), "123456");
    assert_eq!(unwrap_lines("ghp_abc\ndef\n\nnext", 0), "ghp_abcdef\n\nnext");
    assert_eq!(unwrap_lines("AKIAIOSFOD\nNN7EXAMPLE\naws_secret", 0), "AKIAIOSFODNN7EXAMPLE\naws_secret");
    assert_eq!(unwrap_lines("my token\nghp_ABC\nDEF please", 1), "my token\nghp_ABCDEF please");
}

#[test]
fn views_decode_printable_base64_only() {
    let p = prepare("decode TXkgVEZOIGlzIDEyMyA0NTYgNzgyLCB0aGFua3M= please", &[]);
    assert_eq!(p.decoded, vec!["My TFN is 123 456 782, thanks".to_string()]);
    assert!(prepare("commit 3f786850e387550fdab836ed7e6dc881de23001b", &[]).decoded.is_empty(), "a hex digest decodes to binary");
}

#[test]
fn phone_numbers_in_every_written_shape() {
    let phones = |text: &str| run_detector(&Detector::PhoneBulk { threshold: 1 }, &DetectInput::new(text, &[])).map(|m| m.count);
    let shapes =
        ["0491 570 313", "0491570313", "+61 491 570 313", "+61491570313", "(02) 5550 1234", "02 5550 1234", "+61 2 5550 1234", "1300 555 123", "0491.570.313"];
    for s in shapes {
        assert_eq!(phones(&format!("call {s} today")), Some(1), "{s}");
    }
    for s in ["order 104915703130", "ABN 51 824 753 556", "x0491570313", "2026-10-17"] {
        assert_eq!(phones(s), None, "{s}");
    }
    assert_eq!(phones("+61 491 570 313 or 0491 570 313"), Some(1), "one number written two ways is one number");
}
