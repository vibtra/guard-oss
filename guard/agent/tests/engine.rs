// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::{json, Value};
use time::macros::datetime;
use vibtra_guard_agent::catalogue::Matcher;
use vibtra_guard_agent::detect::DetectInput;
use vibtra_guard_agent::engine::{decide_content, decide_flow, decide_request, FlowSource, RequestFacts, VerdictKind};
use vibtra_guard_agent::types::{Action, Bundle, Catalogue};

const NOW: time::OffsetDateTime = datetime!(2026-10-16 09:00 UTC);

fn seed() -> Catalogue {
    let c: Value = serde_json::from_str(include_str!("fixtures/contract.json")).unwrap();
    serde_json::from_value(c["catalogue"].clone()).unwrap()
}

fn bo(mode: &str, exceptions: Value) -> Bundle {
    let mut services = serde_json::Map::new();
    for s in seed().services {
        services.insert(s.service_id.clone(), json!({ "action": "allow", "ruleId": "gsr_00000001" }));
    }
    services.insert("deepseek".into(), json!({ "action": "block", "ruleId": "gsr_00000002", "note": "Not approved for company data." }));
    serde_json::from_value(json!({
        "protocol": 1, "orgId": "org_fernwood", "deviceId": "gdev_0123456789abcdef", "bundleVersion": 3, "catalogueVersion": "2026-10-16",
        "generatedAt": "2026-10-16T09:00:00.000Z", "person": { "userId": "u_bo", "email": "bo@fernwood.example" }, "clientMode": mode,
        "defaultAction": "allow", "services": services,
        "contentRules": [
            { "ruleId": "gcr_00000001", "name": "Tax file numbers", "detector": { "kind": "au-tfn" }, "services": "*", "action": "block" },
            { "ruleId": "gcr_00000002", "name": "Cards to ChatGPT", "detector": { "kind": "card-number" }, "services": ["openai-chatgpt"], "action": "ask" },
            { "ruleId": "gcr_00000003", "name": "Project words", "detector": { "kind": "keyword", "keywords": ["falcon"], "wholeWord": false }, "services": "*", "action": "allow" }
        ],
        "exceptions": exceptions,
        "settings": { "requestsEnabled": true, "workspaceRedirect": { "enabled": false }, "snippetPolicy": "redacted", "snippetMax": 80 }
    }))
    .unwrap()
}

#[test]
fn flow_exception_beats_rule_beats_default() {
    let mut b = bo("monitor", json!([{ "grantId": "pgr_a", "scope": "user", "serviceId": "openai-chatgpt" }]));
    b.services.insert("openai-chatgpt".into(), serde_json::from_value(json!({ "action": "block", "ruleId": "gsr_00000004" })).unwrap());
    let f = decide_flow(&b, "openai-chatgpt", NOW);
    assert_eq!((f.action, f.source, f.grant_id.as_deref()), (Action::Allow, FlowSource::Exception, Some("pgr_a")));
    let d = decide_flow(&b, "deepseek", NOW);
    assert_eq!(
        (d.action, d.source, d.rule_id.as_deref(), d.note.as_deref()),
        (Action::Block, FlowSource::Rule, Some("gsr_00000002"), Some("Not approved for company data."))
    );
    let mut bare = bo("monitor", json!([]));
    bare.services.clear();
    bare.default_action = Action::Ask;
    let c = decide_flow(&bare, "cursor", NOW);
    assert_eq!((c.action, c.source, c.rule_id), (Action::Ask, FlowSource::Default, None));
    bare.services.insert("poe".into(), serde_json::from_value(json!({ "action": "block" })).unwrap());
    assert_eq!(decide_flow(&bare, "poe", NOW).source, FlowSource::Default);
}

#[test]
fn an_expired_exception_is_ignored_on_the_laptop() {
    let b = bo("enforce", json!([{ "grantId": "pgr_old", "scope": "user", "serviceId": "deepseek", "expiresAt": "2026-10-01T00:00:00.000Z" }]));
    assert_eq!(decide_flow(&b, "deepseek", NOW).action, Action::Block);
}

#[test]
fn content_strongest_non_excepted_wins_and_everything_is_reported() {
    let b = bo("monitor", json!([]));
    let text = "tfn 123 456 782, card 4242424242424242, project falcon";
    let input = DetectInput::new(text, &[]);
    let chat = decide_content(&b, "openai-chatgpt", &input, NOW);
    assert_eq!(chat.action, Action::Block);
    assert_eq!(chat.decided().unwrap().rule.rule_id, "gcr_00000001");
    let got: Vec<(String, usize, bool)> = chat.matches.iter().map(|m| (m.rule.rule_id.clone(), m.m.count, m.excepted)).collect();
    assert_eq!(got, vec![("gcr_00000001".into(), 1, false), ("gcr_00000002".into(), 1, false), ("gcr_00000003".into(), 1, false)]);
    let claude = decide_content(&b, "anthropic-claude", &input, NOW);
    assert_eq!(claude.matches.iter().map(|m| m.rule.rule_id.as_str()).collect::<Vec<_>>(), vec!["gcr_00000001", "gcr_00000003"]);

    let excepted = bo("monitor", json!([{ "grantId": "pgr_x", "scope": "user", "serviceId": "openai-chatgpt", "ruleId": "gcr_00000001" }]));
    let e = decide_content(&excepted, "openai-chatgpt", &input, NOW);
    assert_eq!(e.action, Action::Ask);
    assert!(e.matches[0].excepted);
    assert_eq!(e.matches[0].grant_id.as_deref(), Some("pgr_x"));
}

#[test]
fn decide_request_cases() {
    let m = Matcher::new(seed());
    let b = bo("monitor", json!([]));
    let req = |host: &'static str, text: &'static str| RequestFacts { host, text, ..Default::default() };
    let g = decide_request(&b, &m, &req("www.google.com", "tfn 123 456 782"), NOW);
    assert!(!g.intercepted && g.verdict == VerdictKind::NotIntercepted && !g.enforced);
    let blocked = decide_request(&b, &m, &req("chat.deepseek.com", "tfn 123 456 782"), NOW);
    assert!(blocked.intercepted && blocked.verdict == VerdictKind::Blocked && !blocked.enforced);
    assert!(blocked.content.is_none(), "a blocked flow never runs the detectors");
    let enforce = bo("enforce", json!([]));
    let v = decide_request(&enforce, &m, &req("chatgpt.com", "tfn 123 456 782"), NOW);
    assert!(v.verdict == VerdictKind::Blocked && v.enforced);
    assert_eq!(decide_request(&enforce, &m, &req("chatgpt.com", "hello"), NOW).verdict, VerdictKind::Allowed);
    let codex = decide_request(&enforce, &m, &RequestFacts { host: "chatgpt.com", cli_name: Some("codex"), text: "hello", ..Default::default() }, NOW);
    assert_eq!(codex.service.unwrap().service_id, "openai-codex");
    let card = decide_request(&enforce, &m, &req("chatgpt.com", "card 4242424242424242"), NOW);
    assert_eq!(card.verdict, VerdictKind::Asked);
}

#[test]
fn explain_names_the_rule_or_the_default() {
    use vibtra_guard_agent::engine::explain;
    let m = Matcher::new(seed());
    let req = |host: &'static str, text: &'static str| RequestFacts { host, text, ..Default::default() };
    let enforce = bo("enforce", json!([]));
    assert_eq!(explain(&decide_request(&enforce, &m, &req("chat.deepseek.com", "hi"), NOW)), "Blocked: DeepSeek is set to block by rule gsr_00000002.");
    let mut bare = bo("monitor", json!([]));
    bare.services.clear();
    bare.default_action = Action::Ask;
    assert_eq!(
        explain(&decide_request(&bare, &m, &req("claude.ai", "hi"), NOW)),
        "Needs IT's OK: Claude is set to ask by the default (monitor mode: recorded, not enforced)."
    );
    bare.default_action = Action::Block;
    assert!(
        explain(&decide_request(&bare, &m, &req("claude.ai", "hi"), NOW)).ends_with("is set to block by the default (monitor mode: recorded, not enforced).")
    );
    assert_eq!(
        explain(&decide_request(&enforce, &m, &req("chatgpt.com", "tfn 123 456 782"), NOW)),
        "Blocked: the content rule \"Tax file numbers\" found a tax file number (1×) going to ChatGPT."
    );
    assert_eq!(
        explain(&decide_request(&enforce, &m, &req("chatgpt.com", "card 4242424242424242"), NOW)),
        "Needs IT's OK: the content rule \"Cards to ChatGPT\" found a payment card number (1×) going to ChatGPT."
    );
    assert_eq!(
        explain(&decide_request(&enforce, &m, &req("chatgpt.com", "hello"), NOW)),
        "Allowed: ChatGPT is allowed for this person and no content rule fired."
    );
    assert_eq!(
        explain(&decide_request(&enforce, &m, &req("chatgpt.com", "project falcon"), NOW)),
        "Allowed to ChatGPT: \"Project words\" (record only) fired."
    );
    let excepted = bo("enforce", json!([{ "grantId": "pgr_x", "scope": "user", "serviceId": "openai-chatgpt", "ruleId": "gcr_00000001" }]));
    assert_eq!(
        explain(&decide_request(&excepted, &m, &req("chatgpt.com", "tfn 123 456 782"), NOW)),
        "Allowed to ChatGPT: \"Tax file numbers\" (excepted by a grant) fired."
    );
    assert!(explain(&decide_request(&enforce, &m, &req("www.google.com", "hi"), NOW)).starts_with("Not an AI service in the catalogue"));
}
