// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use vibtra_guard_agent::agent::{parse_upstream_map, path_hint};

#[test]
fn upstream_maps_parse_and_refuse() {
    let m = parse_upstream_map(" ChatGPT.com.=http://127.0.0.1:4801 , claude.ai=https://127.0.0.1:4802/,, ").unwrap();
    assert_eq!(m.len(), 2);
    assert_eq!(m[0].0, "chatgpt.com", "the host is normalised");
    assert_eq!(m[0].1.as_str(), "http://127.0.0.1:4801/");
    assert_eq!(m[1].0, "claude.ai");
    assert_eq!(m[1].1.scheme(), "https");
    assert!(parse_upstream_map("").unwrap().is_empty());
    let no_eq = parse_upstream_map("chatgpt.com").unwrap_err().to_string();
    assert!(no_eq.contains("is not host=url"), "{no_eq}");
    let bad_url = format!("{:#}", parse_upstream_map("chatgpt.com=not a url").unwrap_err());
    assert!(bad_url.contains("--upstream-map target"), "{bad_url}");
    let bad_scheme = parse_upstream_map("chatgpt.com=ftp://127.0.0.1/").unwrap_err().to_string();
    assert!(bad_scheme.contains("must be http:// or https://"), "{bad_scheme}");
}

#[test]
fn path_hints_keep_the_first_segment_only() {
    assert_eq!(path_hint("/backend-api/conversation?x=1"), "/backend-api");
    assert_eq!(path_hint("/v1#frag"), "/v1");
    assert_eq!(path_hint(""), "/");
    assert_eq!(path_hint(&format!("/{}", "a".repeat(80))).chars().count(), 40);
}
