// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::Value;
use vibtra_guard_agent::marks::{for_app, for_service, marks, tile, Glyph, Lookup};

#[test]
fn resolves_like_the_contract() {
    assert!(matches!(for_service("openai-chatgpt"), Lookup::Mark("openai")));
    assert!(matches!(for_service("deepseek"), Lookup::Mark("deepseek")));
    assert!(matches!(for_service("quillbot"), Lookup::Glyph(Glyph::Service)));
    assert!(matches!(for_service("custom-acme"), Lookup::Glyph(Glyph::Service)));
    assert!(matches!(for_app("Google Chrome"), Lookup::Mark("google-chrome")));
    assert!(matches!(for_app("Microsoft Edge"), Lookup::Mark("microsoft-edge")));
    assert!(matches!(for_app("Chromium (headless)"), Lookup::Mark("chromium")));
    assert!(matches!(for_app("Safari"), Lookup::Mark("safari")));
    assert!(matches!(for_app("claude-cli"), Lookup::Mark("claude")));
    assert!(matches!(for_app("com.anthropic.claudefordesktop"), Lookup::Mark("claude")));
    assert!(matches!(for_app("Terminal"), Lookup::Glyph(Glyph::Cli)));
    assert!(matches!(for_app("curl"), Lookup::Glyph(Glyph::Cli)));
    assert!(matches!(for_app("Some App"), Lookup::Glyph(Glyph::App)));
}

#[test]
fn every_seed_service_but_the_recorded_one_has_a_mark() {
    let m = marks();
    assert!(m.index.by_service.len() >= 46);
    for id in m.index.by_service.values() {
        assert!(m.marks.contains_key(id), "{id}");
    }
    let contract: Value = serde_json::from_str(include_str!("fixtures/contract.json")).unwrap();
    for svc in contract["catalogue"]["services"].as_array().unwrap() {
        let id = svc["serviceId"].as_str().unwrap();
        match (svc["markId"].as_str(), for_service(id)) {
            (Some(want), Lookup::Mark(got)) => assert_eq!(got, want, "{id}"),
            (None, Lookup::Glyph(Glyph::Service)) => assert_eq!(id, "quillbot", "only the recorded service has no mark"),
            (want, _) => panic!("{id}: the seed says {want:?}, the marks index disagrees"),
        }
    }
}

#[test]
fn tiles_are_inline_and_unique_per_instance() {
    let a = tile(for_service("amazon-q"), false, "s");
    let b = tile(for_service("amazon-q"), true, "a");
    assert!(a.contains("id=\"sl_0\"") && b.contains("id=\"al_0\""));
    assert!(!a.replace("http://www.w3.org/2000/svg", "").contains("http"), "a tile loads no external URL");
    assert!(!a.contains("gmid_"));
    let g = tile(for_app("Some App"), false, "x");
    assert!(g.contains("data-glyph=\"app\"") && !g.contains("<text"));
}

#[test]
fn wordmarks_take_the_tile_width() {
    assert!(tile(for_service("jasper"), false, "j").starts_with("<span class=\"mk w\""));
    assert!(tile(for_service("deepseek"), false, "d").starts_with("<span class=\"mk\""));
}
