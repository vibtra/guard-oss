// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use vibtra_guard_agent::prompt::{extract, gemini_form_text};

#[test]
fn reads_provider_envelopes() {
    for (host, path, body) in [
        ("api.openai.com", "/v1/chat/completions", r#"{"messages":[{"role":"user","content":"TFN 123 456 782"}]}"#),
        ("chatgpt.com", "/backend-api/conversation", r#"{"messages":[{"author":{"role":"user"},"content":{"parts":["TFN 123 456 782"]}}]}"#),
        ("api.openai.com", "/v1/responses", r#"{"input":[{"role":"user","content":[{"type":"input_text","text":"TFN 123 456 782"}]}]}"#),
        ("api.anthropic.com", "/v1/messages", r#"{"messages":[{"role":"user","content":[{"type":"text","text":"TFN 123 456 782"}]}]}"#),
        ("claude.ai", "/api/organizations/x/chat_conversations/y/completion", r#"{"prompt":"TFN 123 456 782"}"#),
        (
            "generativelanguage.googleapis.com",
            "/v1beta/models/gemini:generateContent",
            r#"{"contents":[{"role":"user","parts":[{"text":"TFN 123 456 782"}]}]}"#,
        ),
    ] {
        let result = extract(host, path, Some("application/json"), body.as_bytes());
        assert!(result.format.is_some(), "{host}");
        assert!(result.parts.iter().any(|p| p == "TFN 123 456 782"), "{host}");
    }
}

#[test]
fn decodes_gemini_form_and_nested_json_escapes() {
    let nested = serde_json::json!([null, r#"[["TFN \u0031\u0032\u0033 456 782"]]"#]).to_string();
    let form: String = url::form_urlencoded::Serializer::new(String::new()).append_pair("f.req", &nested).finish();
    let result = extract(
        "gemini.google.com",
        "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
        Some("application/x-www-form-urlencoded;charset=UTF-8"),
        form.as_bytes(),
    );
    assert_eq!(result.parts, ["TFN 123 456 782"]);
}

#[test]
fn no_broad_host_or_path_matches_and_malformed_bodies_are_safe() {
    assert!(extract("api.openai.com.evil.test", "/v1/responses", None, b"{}").format.is_none());
    assert!(extract("gemini.google.com", "/analytics", None, b"{}").format.is_none());
    assert!(extract("api.anthropic.com", "/v1/messages", None, b"{bad").parts.is_empty());
}

#[test]
fn gemini_expansion_preserves_all_fields_without_duplicate_counts() {
    let inner = serde_json::json!({ "metadata": "TFN 123 456 782", "prompt": "one@example.test two@example.test", "confidential": true });
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("f.req", &serde_json::json!([null, inner.to_string()]).to_string())
        .append_pair("other", "TFN 987 654 321")
        .finish();
    let text = gemini_form_text(form.as_bytes());
    assert_eq!(text.matches("one@example.test").count(), 1);
    assert!(text.contains("TFN 123 456 782"));
    assert!(text.contains("TFN 987 654 321"));
    assert!(text.contains("confidential"));
    assert!(text.contains("true"));
    assert_eq!(gemini_form_text(b"f.req=%7Bbad&other=hello"), "{bad\nhello\n");
}
