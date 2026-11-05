// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::Value;
use vibtra_guard_agent::catalogue::{host_matches_pattern, Matcher};
use vibtra_guard_agent::detect::{is_valid_abn, is_valid_acn, is_valid_luhn, is_valid_medicare, is_valid_tfn, run_detector, DetectInput};
use vibtra_guard_agent::redact::redact_match;
use vibtra_guard_agent::types::{Catalogue, Detector};

fn vectors() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/guard-contract/src/detectors.vectors.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display())).replace("~~", "")).unwrap()
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

fn text(t: &str) -> DetectInput<'_> {
    DetectInput::new(t, &[])
}

#[test]
fn checksums() {
    let v = vectors();
    type Check = fn(&str) -> bool;
    let cases: [(&str, Check); 5] =
        [("tfn", is_valid_tfn), ("abn", is_valid_abn), ("acn", is_valid_acn), ("medicare", is_valid_medicare), ("card", is_valid_luhn)];
    for (name, f) in cases {
        for s in strs(&v[name]["valid"]) {
            assert!(f(&s), "{name} should accept {s}");
        }
        for s in strs(&v[name]["invalid"]) {
            assert!(!f(&s), "{name} should refuse {s}");
        }
    }
}

#[test]
fn identifier_detectors_over_text() {
    let v = vectors();
    let cases = [
        ("tfn", Detector::AuTfn { require_context: false }),
        ("abn", Detector::AuAbn),
        ("acn", Detector::AuAcn { require_context: false }),
        ("medicare", Detector::AuMedicare { require_context: false }),
        ("card", Detector::CardNumber),
    ];
    for (name, det) in cases {
        for s in strs(&v[name]["valid"]) {
            let t = format!("here it is: {s}.");
            let m = run_detector(&det, &text(&t)).unwrap_or_else(|| panic!("{name} detector misses `{t}`"));
            assert_eq!(m.count, 1, "{name} counts `{t}` once");
            assert!(!m.examples[0].contains(&s.replace([' ', '-'], "")), "{name} example is redacted");
        }
        for s in strs(&v[name]["invalid"]) {
            let t = format!("here it is: {s}.");
            let m = run_detector(&det, &text(&t));
            assert!(m.is_none(), "{name} detector fires on invalid `{t}`: {m:?}");
        }
    }
    let tfn = Detector::AuTfn { require_context: false };
    assert!(run_detector(&tfn, &text("ref 1234567820")).is_none());
    assert!(run_detector(&tfn, &text("ref -123456782")).is_none());
}

#[test]
fn require_context_gates_tfn_and_acn() {
    let v = vectors();
    for (name, on, off) in [
        ("tfn", Detector::AuTfn { require_context: true }, Detector::AuTfn { require_context: false }),
        ("acn", Detector::AuAcn { require_context: true }, Detector::AuAcn { require_context: false }),
    ] {
        for t in strs(&v["context"][name]["fire"]) {
            assert_eq!(run_detector(&on, &text(&t)).map(|m| m.count), Some(1), "{name} with context misses `{t}`");
        }
        for t in strs(&v["context"][name]["quiet"]) {
            assert!(run_detector(&on, &text(&t)).is_none(), "{name} with requireContext fires on `{t}`");
            assert_eq!(run_detector(&off, &text(&t)).map(|m| m.count), Some(1), "{name} without requireContext misses `{t}`");
        }
    }
    let far = format!("TFN below.{}100200300", " ".repeat(70));
    assert!(run_detector(&Detector::AuTfn { require_context: true }, &text(&far)).is_none());
    let bare: Detector = serde_json::from_str(r#"{"kind":"au-tfn"}"#).unwrap();
    assert_eq!(bare, Detector::AuTfn { require_context: false });
    assert_eq!(serde_json::to_string(&bare).unwrap(), r#"{"kind":"au-tfn"}"#);
    let on: Detector = serde_json::from_str(r#"{"kind":"au-acn","requireContext":true}"#).unwrap();
    assert_eq!(on, Detector::AuAcn { require_context: true });
}

#[test]
fn views_and_look_alikes() {
    let v = vectors();
    let input = |case: &Value| -> (Detector, String, Vec<String>) {
        let det: Detector = serde_json::from_value(case["detector"].clone()).unwrap();
        let joined = case.get("joined").map(strs).unwrap_or_default();
        (det, case["text"].as_str().unwrap().to_string(), joined)
    };
    for case in v["views"]["fire"].as_array().unwrap() {
        let (det, t, joined) = input(case);
        let m = run_detector(&det, &DetectInput::new(&t, &[]).with_joined(&joined));
        assert_eq!(m.map(|m| m.count as u64), case["count"].as_u64(), "fire {case}");
    }
    for case in v["views"]["quiet"].as_array().unwrap() {
        let (det, t, joined) = input(case);
        let m = run_detector(&det, &DetectInput::new(&t, &[]).with_joined(&joined));
        assert!(m.is_none(), "quiet {case}: {m:?}");
    }
}

#[test]
fn secrets_fire_and_stay_quiet() {
    let v = vectors();
    for case in v["secrets"]["fire"].as_array().unwrap() {
        let rule = case["rule"].as_str().unwrap().to_string();
        let t = case["text"].as_str().unwrap();
        let all = run_detector(&Detector::Secret { rules: None }, &text(t)).unwrap_or_else(|| panic!("secret detector misses {rule}"));
        assert!(all.details.as_ref().unwrap().contains(&rule), "{rule} not among {:?}", all.details);
        let only = run_detector(&Detector::Secret { rules: Some(vec![rule.clone()]) }, &text(t)).unwrap_or_else(|| panic!("{rule} alone misses"));
        assert_eq!(only.details.as_ref().unwrap(), &vec![rule.clone()]);
        assert!(only.examples[0].ends_with("…)"), "a secret example is a label and a short prefix");
        let inner = only.examples[0].rsplit_once('(').map(|(_, p)| p.trim_end_matches(")").trim_end_matches('…')).unwrap_or("");
        assert!(inner.chars().count() <= 6, "at most six characters of a secret travel: {}", only.examples[0]);
    }
    for t in strs(&v["secrets"]["quiet"]) {
        assert!(run_detector(&Detector::Secret { rules: None }, &text(&t)).is_none(), "secret detector fires on quiet `{t}`");
    }
}

#[test]
fn bulk_email() {
    let v = vectors();
    let threshold = v["emailBulk"]["threshold"].as_u64().unwrap() as usize;
    let fire = run_detector(&Detector::EmailBulk { threshold }, &text(v["emailBulk"]["fire"].as_str().unwrap())).expect("fires");
    assert_eq!(fire.count, 3);
    assert!(run_detector(&Detector::EmailBulk { threshold }, &text(v["emailBulk"]["quiet"].as_str().unwrap())).is_none());
}

#[test]
fn keywords() {
    let v = vectors();
    let k = &v["keyword"];
    let det = Detector::Keyword { keywords: strs(&k["keywords"]), whole_word: false };
    let m = run_detector(&det, &text(k["fire"].as_str().unwrap())).expect("fires");
    assert_eq!(m.count as u64, k["fireCount"].as_u64().unwrap());
    assert!(run_detector(&det, &text(k["quiet"].as_str().unwrap())).is_none());
    let whole = Detector::Keyword { keywords: strs(&k["keywords"]), whole_word: true };
    assert!(run_detector(&whole, &text(k["wholeWord"]["fire"].as_str().unwrap())).is_some());
    assert!(run_detector(&whole, &text(k["wholeWord"]["quiet"].as_str().unwrap())).is_none());
    assert!(run_detector(&det, &text(k["wholeWord"]["quiet"].as_str().unwrap())).is_some());
}

#[test]
fn file_types() {
    let v = vectors();
    let f = &v["fileType"];
    let det = Detector::FileType { extensions: strs(&f["extensions"]) };
    let fire = strs(&f["fire"]);
    let m = run_detector(&det, &DetectInput::new("", &fire)).expect("fires");
    assert_eq!(m.count as u64, f["fireCount"].as_u64().unwrap());
    assert_eq!(m.details.unwrap(), vec!["xlsx".to_string(), "csv".to_string()]);
    let quiet = strs(&f["quiet"]);
    assert!(run_detector(&det, &DetectInput::new("", &quiet)).is_none());
}

#[test]
fn redaction() {
    for case in vectors()["redact"].as_array().unwrap() {
        assert_eq!(redact_match(case["in"].as_str().unwrap()), case["out"].as_str().unwrap());
    }
}

#[test]
fn host_patterns() {
    for case in vectors()["hosts"].as_array().unwrap() {
        let (h, p, m) = (case["host"].as_str().unwrap(), case["pattern"].as_str().unwrap(), case["matches"].as_bool().unwrap());
        assert_eq!(host_matches_pattern(h, p), m, "{h} vs {p}");
    }
}

fn seed() -> Matcher {
    let contract: Value = serde_json::from_str(include_str!("fixtures/contract.json")).unwrap();
    let cat: Catalogue = serde_json::from_value(contract["catalogue"].clone()).unwrap();
    Matcher::new(cat)
}

#[test]
fn service_for_host_and_flow() {
    let v = vectors();
    let m = seed();
    for case in v["serviceForHost"].as_array().unwrap() {
        let host = case["host"].as_str().unwrap();
        let want = case["serviceId"].as_str();
        assert_eq!(m.service_for_host(host).map(|s| s.service_id.as_str()), want, "serviceForHost({host})");
        assert_eq!(m.is_intercepted_host(host), want.is_some());
    }
    for case in v["serviceForFlow"].as_array().unwrap() {
        let got = m.service_for_flow(case["host"].as_str().unwrap(), case["bundleId"].as_str(), case["cliName"].as_str()).map(|s| s.service_id.clone());
        assert_eq!(got.as_deref(), case["serviceId"].as_str(), "serviceForFlow({case})");
    }
}

#[test]
fn examples_stop_at_three_but_the_count_does_not() {
    use vibtra_guard_agent::detect::is_valid_tfn;
    let tfns = ["216 666 655", "239 999 986", "403 333 303", "426 666 634", "123 456 782"];
    assert!(tfns.iter().all(|t| is_valid_tfn(t)), "the fixture numbers pass the checksum");
    let t = format!("tfns: {}", tfns.join(", "));
    let m = run_detector(&Detector::AuTfn { require_context: false }, &text(&t)).unwrap();
    assert_eq!(m.count, 5);
    assert_eq!(m.examples, vec!["216***655", "239***986", "403***303"]);
    let m = run_detector(&Detector::AuTfn { require_context: false }, &text("123 456 782 and again 123 456 782")).unwrap();
    assert_eq!((m.count, m.examples.len()), (2, 1));

    let v = vectors();
    let cap = &v["secrets"]["cap"];
    let m = run_detector(&Detector::Secret { rules: None }, &text(cap["text"].as_str().unwrap())).unwrap();
    assert_eq!(m.count as u64, cap["count"].as_u64().unwrap());
    assert_eq!(m.details.unwrap(), strs(&cap["details"]));
    assert_eq!(m.examples, strs(&cap["examples"]));
}

#[test]
fn match_words_and_snippet_labels() {
    use vibtra_guard_agent::detect::{match_words, snippet_label};
    let table = [
        ("au-tfn", "a tax file number", "TFN"),
        ("au-abn", "an ABN", "ABN"),
        ("au-acn", "an ACN", "ACN"),
        ("au-medicare", "a Medicare number", "Medicare"),
        ("card-number", "a payment card number", "Card"),
        ("secret", "an API key or secret", "Secret"),
        ("email-bulk", "a list of email addresses", "Emails"),
        ("phone-bulk", "a list of phone numbers", "Phones"),
        ("keyword", "a restricted word", "Keyword"),
        ("file-type", "a restricted file type", "File"),
        ("something-new", "restricted content", "Match"),
    ];
    for (kind, words, label) in table {
        assert_eq!(match_words(kind), words, "{kind}");
        assert_eq!(snippet_label(kind), label, "{kind}");
    }
}
