// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub state: &'static str,
    pub reason: Option<&'static str>,
    pub format: Option<&'static str>,
    pub text_parts: usize,
}

impl Inspection {
    pub fn flow_only(reason: &'static str) -> Self {
        Self { state: "flow-only", reason: Some(reason), format: None, text_parts: 0 }
    }

    pub fn inspected(format: Option<&'static str>, text_parts: usize) -> Self {
        Self { state: "inspected", reason: None, format, text_parts }
    }
}

#[derive(Default)]
pub struct Prompt {
    pub format: Option<&'static str>,
    pub parts: Vec<String>,
}

fn format_for(host: &str, path: &str) -> Option<&'static str> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let path = path.split('?').next().unwrap_or(path);
    match host.as_str() {
        "chatgpt.com" | "chat.openai.com" if path.starts_with("/backend-api/") && path.ends_with("/conversation") => Some("chatgpt-web"),
        "api.openai.com" if path == "/v1/responses" => Some("openai-responses"),
        "api.openai.com" | "api.deepseek.com" if path == "/v1/chat/completions" || path == "/chat/completions" => Some("openai-chat"),
        "api.githubcopilot.com" if path == "/chat/completions" => Some("openai-chat"),
        h if h.ends_with(".openai.azure.com") && path.starts_with("/openai/deployments/") && path.ends_with("/chat/completions") => Some("openai-chat"),
        "api.anthropic.com" | "a-api.anthropic.com" if path == "/v1/messages" => Some("anthropic-messages"),
        "claude.ai" if path.starts_with("/api/") && (path.ends_with("/completion") || path.ends_with("/retry_completion")) => Some("claude-web"),
        "generativelanguage.googleapis.com"
            if (path.starts_with("/v1/models/") || path.starts_with("/v1beta/models/"))
                && (path.ends_with(":generateContent") || path.ends_with(":streamGenerateContent")) =>
        {
            Some("gemini-api")
        }
        "gemini.google.com" if path.starts_with("/_/BardChatUi/data/") && path.ends_with("StreamGenerate") => Some("gemini-web"),
        _ => None,
    }
}

fn text(value: &Value, parts: &mut Vec<String>, depth: usize) {
    if depth > 16 {
        return;
    }
    match value {
        Value::String(s) if !s.is_empty() => {
            if let Ok(inner) = serde_json::from_str::<Value>(s) {
                if inner.is_array() || inner.is_object() || inner.is_string() {
                    text(&inner, parts, depth + 1);
                    return;
                }
            }
            parts.push(s.clone());
        }
        Value::Array(a) => a.iter().for_each(|v| text(v, parts, depth + 1)),
        Value::Object(o) => {
            for key in ["text", "content", "parts", "input_text", "output"] {
                if let Some(v) = o.get(key) {
                    text(v, parts, depth + 1);
                }
            }
        }
        _ => {}
    }
}

pub fn extract(host: &str, path: &str, content_type: Option<&str>, body: &[u8]) -> Prompt {
    let Some(format) = format_for(host, path) else { return Prompt::default() };
    let mut result = Prompt { format: Some(format), parts: Vec::new() };
    let form = content_type.is_some_and(|t| t.split(';').next().unwrap_or("").trim().eq_ignore_ascii_case("application/x-www-form-urlencoded"));
    if format == "gemini-web" && form {
        for (_, value) in url::form_urlencoded::parse(body).filter(|(key, _)| key == "f.req") {
            if let Ok(value) = serde_json::from_str::<Value>(&value) {
                text(&value, &mut result.parts, 0);
            }
        }
        return result;
    }
    let Ok(root) = serde_json::from_slice::<Value>(body) else { return result };
    for key in ["prompt", "system", "instructions"] {
        if let Some(v) = root.get(key) {
            text(v, &mut result.parts, 0);
        }
    }
    if let Some(input) = root.get("input") {
        text(input, &mut result.parts, 0);
    }
    for key in ["messages", "contents"] {
        if let Some(messages) = root.get(key).and_then(Value::as_array) {
            for message in messages {
                let role = message.get("role").and_then(Value::as_str).or_else(|| message.pointer("/author/role").and_then(Value::as_str));
                if matches!(role, Some("assistant" | "model")) {
                    continue;
                }
                text(message, &mut result.parts, 0);
            }
        }
    }
    result
}

pub fn gemini_form_text(body: &[u8]) -> String {
    fn flatten(value: &Value, out: &mut String, depth: usize) {
        if depth > 16 {
            out.push_str(&value.to_string());
        } else {
            match value {
                Value::String(s) => {
                    if let Ok(inner) = serde_json::from_str::<Value>(s) {
                        if inner.is_array() || inner.is_object() || inner.is_string() {
                            flatten(&inner, out, depth + 1);
                            return;
                        }
                    }
                    out.push_str(s);
                }
                Value::Array(values) => {
                    for v in values {
                        flatten(v, out, depth + 1);
                    }
                }
                Value::Object(values) => {
                    for (key, value) in values {
                        out.push_str(key);
                        out.push('\n');
                        flatten(value, out, depth + 1);
                    }
                }
                _ => out.push_str(&value.to_string()),
            }
        }
        out.push('\n');
    }
    let mut out = String::new();
    for (key, value) in url::form_urlencoded::parse(body) {
        if key == "f.req" {
            if let Ok(value) = serde_json::from_str::<Value>(&value) {
                flatten(&value, &mut out, 0);
                continue;
            }
        }
        out.push_str(&value);
        out.push('\n');
    }
    out
}
