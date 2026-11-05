// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::catalogue::Matcher;
use crate::detect::{run_detector, DetectInput, DetectorMatch};
use crate::types::{Action, Bundle, ClientMode, ContentRule, Exception, Service};
use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FlowSource {
    Rule,
    Default,
    Exception,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowDecision {
    pub action: Action,
    pub source: FlowSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentMatch {
    pub rule: ContentRule,
    #[serde(rename = "match")]
    pub m: DetectorMatch,
    pub excepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grant_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentDecision {
    pub action: Action,
    pub matches: Vec<ContentMatch>,
    #[serde(skip)]
    pub decided_by: Option<usize>,
}

impl ContentDecision {
    pub fn decided(&self) -> Option<&ContentMatch> {
        self.decided_by.map(|i| &self.matches[i])
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerdictKind {
    Allowed,
    Blocked,
    Asked,
    NotIntercepted,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub intercepted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service: Option<Service>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<FlowDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ContentDecision>,
    pub verdict: VerdictKind,
    pub enforced: bool,
}

#[derive(Debug, Clone, Default)]
pub struct RequestFacts<'a> {
    pub host: &'a str,
    pub bundle_id: Option<&'a str>,
    pub cli_name: Option<&'a str>,
    pub text: &'a str,
    pub filenames: &'a [String],
    pub joined: &'a [String],
}

fn live(e: &Exception, now: OffsetDateTime) -> bool {
    match &e.expires_at {
        None => true,
        Some(at) => OffsetDateTime::parse(at, &Rfc3339).map(|t| t > now).unwrap_or(true),
    }
}

pub fn decide_flow(bundle: &Bundle, service_id: &str, now: OffsetDateTime) -> FlowDecision {
    if let Some(e) = bundle.exceptions.iter().find(|e| e.service_id == service_id && e.rule_id.is_none() && live(e, now)) {
        return FlowDecision { action: Action::Allow, source: FlowSource::Exception, rule_id: None, grant_id: Some(e.grant_id.clone()), note: None };
    }
    if let Some(d) = bundle.services.get(service_id) {
        return FlowDecision {
            action: d.action,
            source: if d.rule_id.is_none() { FlowSource::Default } else { FlowSource::Rule },
            rule_id: d.rule_id.clone(),
            grant_id: None,
            note: d.note.clone(),
        };
    }
    FlowDecision { action: bundle.default_action, source: FlowSource::Default, rule_id: None, grant_id: None, note: None }
}

pub fn decide_content(bundle: &Bundle, service_id: &str, input: &DetectInput<'_>, now: OffsetDateTime) -> ContentDecision {
    let mut matches = Vec::new();
    for rule in &bundle.content_rules {
        if !rule.services.applies_to(service_id) {
            continue;
        }
        let Some(m) = run_detector(&rule.detector, input) else { continue };
        let exception = bundle.exceptions.iter().find(|e| e.service_id == service_id && e.rule_id.as_deref() == Some(rule.rule_id.as_str()) && live(e, now));
        matches.push(ContentMatch { rule: rule.clone(), m, excepted: exception.is_some(), grant_id: exception.map(|e| e.grant_id.clone()) });
    }
    let mut action = Action::Allow;
    let mut decided_by = None;
    for (i, m) in matches.iter().enumerate() {
        if m.excepted {
            continue;
        }
        if m.rule.action.rank() > action.rank() {
            action = m.rule.action;
            decided_by = Some(i);
        }
    }
    ContentDecision { action, matches, decided_by }
}

pub fn decide_request(bundle: &Bundle, matcher: &Matcher, req: &RequestFacts<'_>, now: OffsetDateTime) -> Verdict {
    let enforced = bundle.client_mode == ClientMode::Enforce;
    let Some(service) = matcher.service_for_flow(req.host, req.bundle_id, req.cli_name) else {
        return Verdict { intercepted: false, service: None, flow: None, content: None, verdict: VerdictKind::NotIntercepted, enforced };
    };
    let flow = decide_flow(bundle, &service.service_id, now);
    if flow.action != Action::Allow {
        let verdict = if flow.action == Action::Block { VerdictKind::Blocked } else { VerdictKind::Asked };
        return Verdict { intercepted: true, service: Some(service.clone()), flow: Some(flow), content: None, verdict, enforced };
    }
    let content = decide_content(bundle, &service.service_id, &DetectInput::new(req.text, req.filenames).with_joined(req.joined), now);
    let verdict = match content.action {
        Action::Block => VerdictKind::Blocked,
        Action::Ask => VerdictKind::Asked,
        Action::Allow => VerdictKind::Allowed,
    };
    Verdict { intercepted: true, service: Some(service.clone()), flow: Some(flow), content: Some(content), verdict, enforced }
}

pub fn explain(v: &Verdict) -> String {
    let Some(service) = &v.service else { return "Not an AI service in the catalogue: the agent tunnels it untouched and never decrypts it.".to_string() };
    let mode = if v.enforced { "" } else { " (monitor mode: recorded, not enforced)" };
    let flow = v.flow.as_ref();
    match v.verdict {
        VerdictKind::NotIntercepted => unreachable!(),
        VerdictKind::Blocked | VerdictKind::Asked if v.content.is_none() => {
            let by = match flow.map(|f| f.source) {
                Some(FlowSource::Rule) => format!("rule {}", flow.and_then(|f| f.rule_id.clone()).unwrap_or_default()),
                _ => "the default".to_string(),
            };
            let word = if v.verdict == VerdictKind::Blocked { "Blocked" } else { "Needs IT's OK" };
            format!("{word}: {} is set to {} by {by}{mode}.", service.name, flow.map(|f| f.action.as_str()).unwrap_or("block"))
        }
        VerdictKind::Blocked | VerdictKind::Asked => {
            let c = v.content.as_ref().expect("content");
            let d = c.decided().expect("decided");
            let word = if v.verdict == VerdictKind::Blocked { "Blocked" } else { "Needs IT's OK" };
            format!(
                "{word}: the content rule \"{}\" found {} ({}×) going to {}{mode}.",
                d.rule.name,
                crate::detect::match_words(&d.m.kind),
                d.m.count,
                service.name
            )
        }
        VerdictKind::Allowed => {
            let fired: Vec<String> = v
                .content
                .as_ref()
                .map(|c| {
                    c.matches.iter().map(|m| format!("\"{}\"{}", m.rule.name, if m.excepted { " (excepted by a grant)" } else { " (record only)" })).collect()
                })
                .unwrap_or_default();
            if fired.is_empty() {
                format!("Allowed: {} is allowed for this person and no content rule fired.", service.name)
            } else {
                format!("Allowed to {}: {} fired.", service.name, fired.join(", "))
            }
        }
    }
}
