// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::Value;

#[derive(Debug, Default, Clone)]
pub struct Extracted {
    pub text: String,
    pub filenames: Vec<String>,
    pub joined: Vec<String>,
}

pub fn inspectable(content_type: Option<&str>) -> bool {
    let Some(ct) = content_type else { return true };
    let ct = ct.to_ascii_lowercase();
    let essence = ct.split(';').next().unwrap_or("").trim();
    essence == "application/json"
        || essence.ends_with("+json")
        || essence == "application/x-www-form-urlencoded"
        || essence == "multipart/form-data"
        || essence.starts_with("text/")
}

pub fn extract(content_type: Option<&str>, body: &[u8]) -> Extracted {
    if content_type.is_none() {
        return Extracted { text: String::from_utf8_lossy(body).into_owned(), ..Default::default() };
    }
    let ct = content_type.unwrap_or("").to_string();
    let lower = ct.to_ascii_lowercase();
    let essence = lower.split(';').next().unwrap_or("").trim().to_string();
    if essence == "application/json" || essence.ends_with("+json") {
        let mut out = Extracted::default();
        match serde_json::from_slice::<Value>(body) {
            Ok(v) => {
                json_strings(&v, &mut out.text);
                let mut groups: Vec<(String, Vec<String>)> = Vec::new();
                json_paths(&v, String::new(), &mut groups);
                out.joined = groups.into_iter().filter(|(_, g)| g.len() > 1).map(|(_, g)| g.concat()).collect();
            }
            Err(_) => out.text = String::from_utf8_lossy(body).into_owned(),
        }
        return out;
    }
    if essence == "application/x-www-form-urlencoded" {
        let mut text = String::new();
        for (_, v) in url::form_urlencoded::parse(body) {
            text.push_str(&v);
            text.push('\n');
        }
        return Extracted { text, ..Default::default() };
    }
    if essence == "multipart/form-data" {
        return multipart(&ct, body);
    }
    if essence.starts_with("text/") {
        return Extracted { text: String::from_utf8_lossy(body).into_owned(), ..Default::default() };
    }
    Extracted::default()
}

fn nested_json(s: &str) -> Option<Value> {
    let t = s.trim_start();
    if !(t.starts_with('{') || t.starts_with('[')) {
        return None;
    }
    serde_json::from_str::<Value>(s).ok().filter(|v| v.is_object() || v.is_array())
}

fn json_strings(v: &Value, out: &mut String) {
    match v {
        Value::String(s) => match nested_json(s) {
            Some(inner) => json_strings(&inner, out),
            None => {
                out.push_str(s);
                out.push('\n');
            }
        },
        Value::Number(n) => {
            out.push_str(&n.to_string());
            out.push('\n');
        }
        Value::Array(items) => items.iter().for_each(|i| json_strings(i, out)),
        Value::Object(map) => map.values().for_each(|i| json_strings(i, out)),
        _ => {}
    }
}

fn json_paths(v: &Value, path: String, groups: &mut Vec<(String, Vec<String>)>) {
    match v {
        Value::String(s) => match nested_json(s) {
            Some(inner) => json_paths(&inner, format!("{path}{{}}"), groups),
            None => match groups.iter_mut().find(|(p, _)| *p == path) {
                Some((_, g)) => g.push(s.clone()),
                None => groups.push((path, vec![s.clone()])),
            },
        },
        Value::Array(items) => items.iter().for_each(|i| json_paths(i, format!("{path}[]"), groups)),
        Value::Object(map) => map.iter().for_each(|(k, i)| json_paths(i, format!("{path}.{k}"), groups)),
        _ => {}
    }
}

fn param(header: &str, name: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let mut search_from = 0;
    while let Some(at) = lower[search_from..].find(name) {
        let start = search_from + at;
        let before_ok = start == 0 || matches!(lower.as_bytes()[start - 1], b';' | b' ' | b'\t');
        let rest = &header[start + name.len()..];
        if before_ok {
            if let Some(rest) = rest.strip_prefix('=') {
                let value = if let Some(q) = rest.strip_prefix('"') {
                    q.split('"').next().unwrap_or("").to_string()
                } else {
                    rest.split(';').next().unwrap_or("").trim().to_string()
                };
                return Some(value);
            }
            if let Some(rest) = rest.strip_prefix("*=") {
                let raw = rest.split(';').next().unwrap_or("").trim();
                let encoded = raw.split("''").nth(1).unwrap_or(raw);
                return Some(percent_encoding::percent_decode_str(encoded).decode_utf8_lossy().into_owned());
            }
        }
        search_from = start + name.len();
    }
    None
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || from > hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

fn multipart(content_type: &str, body: &[u8]) -> Extracted {
    let mut out = Extracted::default();
    let Some(boundary) = param(content_type, "boundary") else { return out };
    let delim = format!("--{boundary}").into_bytes();
    let mut pos = match find(body, &delim, 0) {
        Some(p) => p + delim.len(),
        None => return out,
    };
    loop {
        if body[pos..].starts_with(b"--") {
            break;
        }
        if body[pos..].starts_with(b"\r\n") {
            pos += 2;
        } else if body[pos..].starts_with(b"\n") {
            pos += 1;
        }
        let Some(next) = find(body, &delim, pos) else { break };
        let part = &body[pos..next];
        let (head, content) = match find(part, b"\r\n\r\n", 0) {
            Some(h) => (&part[..h], &part[h + 4..]),
            None => match find(part, b"\n\n", 0) {
                Some(h) => (&part[..h], &part[h + 2..]),
                None => (part, &[][..]),
            },
        };
        let content = content.strip_suffix(b"\r\n").or_else(|| content.strip_suffix(b"\n")).unwrap_or(content);
        let head = String::from_utf8_lossy(head);
        let mut filename = None;
        let mut part_type = String::new();
        for line in head.lines() {
            let l = line.to_ascii_lowercase();
            if l.starts_with("content-disposition:") {
                filename = param(line, "filename");
            } else if let Some(t) = l.strip_prefix("content-type:") {
                part_type = t.trim().to_string();
            }
        }
        let is_text = part_type.is_empty() || part_type.starts_with("text/") || part_type.starts_with("application/json");
        match filename {
            Some(f) => {
                if !f.is_empty() {
                    out.filenames.push(f);
                }
                if !part_type.is_empty() && is_text {
                    out.text.push_str(&String::from_utf8_lossy(content));
                    out.text.push('\n');
                }
            }
            None => {
                if is_text {
                    out.text.push_str(&String::from_utf8_lossy(content));
                    out.text.push('\n');
                }
            }
        }
        pos = next + delim.len();
        if pos >= body.len() {
            break;
        }
    }
    out
}
