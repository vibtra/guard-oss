// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::Value;
use vibtra_guard_agent::contract::{self, doors, local_paths};

fn committed() -> Value {
    serde_json::from_str(include_str!("fixtures/contract.json")).unwrap()
}

#[test]
fn constants_match_the_contract_export() {
    let c = committed();
    assert_eq!(c["protocol"], contract::PROTOCOL);
    assert_eq!(c["apiPrefix"], contract::API_PREFIX);
    let d = "{deviceId}";
    assert_eq!(c["doors"]["enrol"], doors::enrol());
    assert_eq!(c["doors"]["preflight"], doors::preflight(d));
    assert_eq!(c["doors"]["ruledownload"], doors::ruledownload(d));
    assert_eq!(c["doors"]["eventupload"], doors::eventupload(d));
    assert_eq!(c["doors"]["postflight"], doors::postflight(d));
    assert_eq!(c["doors"]["requests"], doors::requests(d));
    let a = &c["agent"];
    assert_eq!(a["proxyPort"], contract::PROXY_PORT);
    assert_eq!(a["localPort"], contract::LOCAL_PORT);
    assert_eq!(a["transparentPort"], contract::TRANSPARENT_PORT);
    assert_eq!(a["localHost"], contract::LOCAL_HOST);
    assert_eq!(a["localPaths"]["status"], local_paths::STATUS);
    assert_eq!(a["localPaths"]["events"], local_paths::EVENTS);
    assert_eq!(a["localPaths"]["ca"], local_paths::CA);
    assert_eq!(a["localPaths"]["healthz"], local_paths::HEALTHZ);
    assert_eq!(a["localPaths"]["blocked"], local_paths::blocked("{eventId}"));
    assert_eq!(a["localPaths"]["requestAccess"], local_paths::request_access("{eventId}"));
    assert_eq!(a["decisionHeader"], contract::DECISION_HEADER);
    assert_eq!(a["blockedCode"], contract::BLOCKED_CODE);
    assert_eq!(c["limits"]["snippetMax"], contract::SNIPPET_MAX);
    assert_eq!(c["limits"]["eventUploadMax"], contract::EVENT_UPLOAD_MAX);
    assert_eq!(c["limits"]["syncIntervalDefaultS"], contract::SYNC_INTERVAL_DEFAULT_S);
    assert_eq!(c["signatureTyp"], contract::SIGNATURE_TYP);
    assert_eq!(c["secretRuleIds"], serde_json::json!(contract::SECRET_RULE_IDS));
    assert_eq!(c["catalogueSeedVersion"], contract::CATALOGUE_SEED_VERSION);
    let cat: vibtra_guard_agent::types::Catalogue = serde_json::from_value(c["catalogue"].clone()).unwrap();
    assert_eq!(cat.version, contract::CATALOGUE_SEED_VERSION);
    assert!(cat.services.len() >= 40);
}

#[test]
fn the_committed_export_is_current() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let out = std::process::Command::new("pnpm").args(["--silent", "--filter", "@vibtra/guard-contract", "contract:json"]).current_dir(&root).output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else {
        eprintln!("pnpm or the workspace is not available here: comparing against the committed export only");
        return;
    };
    let live: Value = serde_json::from_slice(&out.stdout).expect("contract:json prints JSON");
    assert_eq!(live, committed(), "tests/fixtures/contract.json is stale: regenerate it with `pnpm --silent --filter @vibtra/guard-contract contract:json > guard/agent/tests/fixtures/contract.json`");
}
