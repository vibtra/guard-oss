// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::views::{unwrap_lines, Prepared};
use super::DetectorMatch;
use regex::Regex;
use std::sync::LazyLock;

pub struct SecretPattern {
    pub id: &'static str,
    pub re: Regex,
    pub label: &'static str,
}

const B: &str = r"(?-u:\b)";

pub static SECRET_PATTERNS: LazyLock<Vec<SecretPattern>> = LazyLock::new(|| {
    let p = |id: &'static str, re: String, label: &'static str| SecretPattern { id, re: Regex::new(&re).expect(id), label };
    vec![
        p("aws-access-token", format!("{B}(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{{16}}{B}"), "an AWS access key id"),
        p("github-pat", format!("{B}ghp_[0-9A-Za-z]{{36}}{B}"), "a GitHub personal access token"),
        p("github-fine-grained-pat", format!("{B}github_pat_[0-9A-Za-z_]{{82}}{B}"), "a GitHub fine-grained token"),
        p("github-app-token", format!("{B}(?:ghu|ghs|gho|ghr)_[0-9A-Za-z]{{36}}{B}"), "a GitHub app or OAuth token"),
        p("openai-api-key", format!("{B}sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{{20,}}T3BlbkFJ[A-Za-z0-9_-]{{20,}}{B}"), "an OpenAI API key"),
        p("anthropic-api-key", format!("{B}sk-ant-[a-z]+[0-9]{{2}}-[A-Za-z0-9_-]{{80,}}"), "an Anthropic API key"),
        p("slack-token", format!("{B}xox[baprs]-[0-9]{{10,13}}-[0-9A-Za-z-]{{10,}}"), "a Slack token"),
        p("stripe-access-token", format!("{B}(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{{10,99}}{B}"), "a Stripe key"),
        p("gcp-api-key", format!("{B}AIza[0-9A-Za-z_-]{{35}}(?:[^0-9A-Za-z_-]|$)"), "a Google API key"),
        p("gcp-oauth-token", format!(r"{B}ya29\.[0-9A-Za-z_-]{{20,}}"), "a Google OAuth access token"),
        p("gcp-client-secret", format!("{B}GOCSPX-[0-9A-Za-z_-]{{28}}"), "a Google OAuth client secret"),
        p("slack-webhook-url", r"hooks\.slack\.com/(?:services|workflows|triggers)/[A-Za-z0-9+/]{43,56}".to_string(), "a Slack webhook URL"),
        p(
            "private-key",
            r"-----BEGIN[ \t\r\n]+(?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)[ \t\r\n]+)?PRIVATE[ \t\r\n]+KEY(?:[ \t\r\n]+BLOCK)?-----".to_string(),
            "a private key",
        ),
        p("jwt", format!(r"{B}eyJ[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}\.[A-Za-z0-9_-]{{10,}}{B}"), "a JSON web token"),
        p("sendgrid-api-token", format!(r"{B}SG\.[A-Za-z0-9_-]{{22}}\.[A-Za-z0-9_-]{{43}}{B}"), "a SendGrid key"),
    ]
});

fn secret_key(id: &str, m: &str) -> String {
    let t: String = m.chars().filter(|c| !c.is_whitespace()).take(16).collect();
    format!("{id}\u{0}{t}")
}

fn views(p: &Prepared) -> Vec<String> {
    let mut base: Vec<String> = p.strict_views().cloned().collect();
    base.extend(p.joined.iter().cloned());
    let unwrapped: Vec<String> =
        base.iter().flat_map(|v| [0, 1].map(|parity| (v, unwrap_lines(v, parity)))).filter_map(|(v, u)| (u != *v).then_some(u)).collect();
    base.extend(unwrapped);
    base
}

pub fn detect(p: &Prepared, rules: Option<&[String]>) -> Option<DetectorMatch> {
    let wanted = |id: &str| match rules {
        None => true,
        Some([]) => true,
        Some(r) => r.iter().any(|x| x == id),
    };
    let views = views(p);
    let mut fired: Vec<String> = Vec::new();
    let mut examples: Vec<String> = Vec::new();
    let mut count = 0;
    for pat in SECRET_PATTERNS.iter() {
        if !wanted(pat.id) {
            continue;
        }
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut found: Vec<String> = Vec::new();
        for (i, view) in views.iter().enumerate() {
            for m in pat.re.find_iter(view) {
                let key = secret_key(pat.id, m.as_str());
                if i > 0 && seen.contains(&key) {
                    continue;
                }
                seen.insert(key);
                found.push(m.as_str().to_string());
            }
        }
        let Some(first) = found.first().map(|m| m.chars().take(6).collect::<String>()) else { continue };
        count += found.len();
        fired.push(pat.id.to_string());
        if examples.len() < 3 {
            examples.push(format!("{} ({first}…)", pat.label));
        }
    }
    (count > 0).then(|| DetectorMatch::new("secret", count, examples, Some(fired)))
}
