// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use common::*;
use std::sync::Arc;
use vibtra_guard_agent::agent::{Agent, Options, RequestMeta};
use vibtra_guard_agent::sync::{enrol, sync_once, SyncError};

fn open(dir: &std::path::Path) -> Arc<Agent> {
    Agent::open(&Options { data_dir: Some(dir.to_path_buf()), sync: false, ..Default::default() }).unwrap()
}

#[tokio::test]
async fn enrol_then_a_full_cycle_then_revoke() {
    let reg = fake_registry().await;
    let dir = temp_dir("sync");
    let agent = open(&dir);
    assert!(!agent.enrolled());
    assert!(agent.active_bundle().is_none());

    assert!(enrol(&agent, &reg.base(), "genr_ffffffffffffffffffffffffffffffff").await.is_err());
    assert!(!dir.join("device.json").exists());

    let device = enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    assert_eq!(device.device_id, DEVICE_ID);
    assert_eq!(device.signing.key_id, TEST_KEY_ID);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("device.token")).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(dir.join("ca.key")).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(!std::fs::read_to_string(dir.join("device.json")).unwrap().contains(DEVICE_TOKEN), "the bearer never sits in device.json");

    let r = sync_once(&agent).await.unwrap();
    assert!(r.bundle_updated && r.catalogue_updated);
    assert_eq!(r.bundle_version, Some(3));
    let b = agent.active_bundle().expect("a verified bundle is in force");
    assert_eq!(b.bundle.client_mode.as_str(), "enforce");
    assert!(dir.join("bundle.json").exists() && dir.join("catalogue.json").exists());
    {
        let s = reg.state.lock().unwrap();
        let calls: Vec<&str> = s.calls.iter().map(String::as_str).collect();
        assert_eq!(calls, vec!["POST enrol", "POST enrol", "POST preflight", "POST ruledownload", "POST postflight"]);
        let pf = &s.postflights[0];
        assert_eq!(pf["bundleVersion"], 3);
        assert_eq!(pf["bundleDigest"].as_str().unwrap(), b.digest);
        assert_eq!(pf["rulesReceived"], pf["rulesProcessed"]);
        assert_eq!(s.preflights[0]["requestCleanSync"], true);
        assert_eq!(s.preflights[0]["ca"]["fingerprintSha256"].as_str().unwrap().len(), 64);
        assert!(s.preflights[0].get("caKey").is_none() && !s.preflights[0].to_string().contains("PRIVATE KEY"));
    }

    for text in ["hello", "my tfn is 123 456 782", "about falcon"] {
        agent
            .decide(RequestMeta {
                host: "chatgpt.com",
                port: Some(443),
                method: Some("POST"),
                path: Some("/backend-api/conversation?x=1"),
                text,
                ..Default::default()
            })
            .await
            .unwrap();
    }
    assert_eq!(agent.queue.len().await, 3);
    reg.state.lock().unwrap().calls.clear();
    let r = sync_once(&agent).await.unwrap();
    assert_eq!(r.events_uploaded, 3);
    assert_eq!(agent.queue.len().await, 0);
    {
        let s = reg.state.lock().unwrap();
        assert_eq!(s.calls.iter().filter(|c| c.as_str() == "POST eventupload").count(), 2);
        let tfn = s.events.iter().find(|e| e["matchType"] == "au-tfn").expect("the TFN event");
        assert_eq!(tfn["action"], "blocked");
        assert_eq!(tfn["kind"], "content");
        assert_eq!(tfn["snippet"], "TFN 123***782");
        assert_eq!(tfn["pathHint"], "/backend-api");
        let all = serde_json::to_string(&s.events).unwrap();
        assert!(!all.contains("123 456 782") && !all.contains("123456782") && !all.contains("x=1"), "no content and no query string leaves the laptop");
    }

    reg.state.lock().unwrap().tamper_next_bundle = true;
    let r = sync_once(&agent).await.unwrap();
    assert!(r.verify_failure.as_deref().unwrap().contains("digest-mismatch"));
    assert_eq!(agent.active_bundle().unwrap().digest, b.digest);

    reg.state.lock().unwrap().revoked = true;
    match sync_once(&agent).await {
        Err(SyncError::Revoked(code)) => assert_eq!(code, "GUARD_DEVICE_REVOKED"),
        other => panic!("expected a revocation, got {other:?}"),
    }
    assert!(agent.active_bundle().is_none());
    assert!(!agent.should_intercept("chatgpt.com"), "a revoked agent decrypts nothing");
    let status = agent.status_json().await;
    assert_eq!(status["state"], "revoked");
    assert_eq!(status["enrolled"], false);
    let on_disk: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("device.json")).unwrap()).unwrap();
    assert_eq!(on_disk["revoked"], true);
    let again = open(&dir);
    assert!(again.active_bundle().is_none());
}

#[tokio::test]
async fn a_bundle_on_disk_that_does_not_verify_is_not_trusted() {
    let reg = fake_registry().await;
    let dir = temp_dir("disk");
    let agent = open(&dir);
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&agent).await.unwrap();
    assert!(open(&dir).active_bundle().is_some());
    let p = dir.join("bundle.json");
    let edited = std::fs::read_to_string(&p).unwrap().replace("\"enforce\"", "\"monitor\"");
    std::fs::write(&p, edited).unwrap();
    assert!(open(&dir).active_bundle().is_none(), "an edited bundle fails its digest and is not loaded");
}

fn report_ok(next: u64) -> Result<vibtra_guard_agent::sync::SyncReport, SyncError> {
    Ok(vibtra_guard_agent::sync::SyncReport { next_sync_in_seconds: next, ..Default::default() })
}

#[tokio::test]
async fn a_downloaded_catalogue_that_does_not_verify_keeps_the_last_good_one() {
    let reg = fake_registry().await;
    let dir = temp_dir("cat-tamper");
    let agent = open(&dir);
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    let first = sync_once(&agent).await.unwrap();
    assert!(first.catalogue_updated);
    let good_version = agent.matcher().matcher.catalogue.version.clone();
    let good_digest = agent.matcher().digest.clone().expect("a signed catalogue");
    let on_disk = std::fs::read(dir.join("catalogue.json")).unwrap();

    {
        let mut s = reg.state.lock().unwrap();
        s.catalogue["version"] = serde_json::json!("2026-10-17+org.1");
        s.tamper_next_catalogue = true;
    }
    let r = sync_once(&agent).await.unwrap();
    assert_eq!(r.verify_failure.as_deref(), Some("catalogue: digest-mismatch"));
    assert!(!r.catalogue_updated);
    let cat = agent.matcher();
    assert_eq!(cat.source, "signed");
    assert_eq!(cat.matcher.catalogue.version, good_version, "the matcher keeps the last good catalogue");
    assert_eq!(cat.digest.as_deref(), Some(good_digest.as_str()));
    assert!(cat.matcher.is_intercepted_host("chatgpt.com"), "the tampered copy (ChatGPT switched off) is not in force");
    assert_eq!(std::fs::read(dir.join("catalogue.json")).unwrap(), on_disk, "catalogue.json is untouched");
    assert_eq!(r.catalogue_version, good_version, "postflight reports the catalogue actually in force");

    let r = sync_once(&agent).await.unwrap();
    assert!(r.catalogue_updated && r.verify_failure.is_none());
    assert_eq!(agent.matcher().matcher.catalogue.version, "2026-10-17+org.1");
}

#[tokio::test]
async fn a_signing_key_id_mismatch_at_preflight_downloads_nothing_and_says_re_enrol() {
    let reg = fake_registry().await;
    let dir = temp_dir("key-mismatch");
    let agent = open(&dir);
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&agent).await.unwrap();
    let held = agent.active_bundle().unwrap().digest.clone();
    {
        let mut s = reg.state.lock().unwrap();
        s.preflight_key_id = Some("gk_0000beef".into());
        s.bundle = base_bundle(9, "monitor");
        s.calls.clear();
    }
    let err = sync_once(&agent).await.unwrap_err();
    match &err {
        SyncError::KeyMismatch { pinned, server } => {
            assert_eq!(pinned, TEST_KEY_ID);
            assert_eq!(server, "gk_0000beef");
        }
        other => panic!("expected a key mismatch, got {other:?}"),
    }
    let text = err.to_string();
    assert!(text.contains(TEST_KEY_ID) && text.contains("gk_0000beef") && text.contains("enrol it again"), "{text}");
    let calls = reg.state.lock().unwrap().calls.clone();
    assert_eq!(calls, vec!["POST preflight"], "no ruledownload, no postflight under a key the device did not pin");
    let b = agent.active_bundle().expect("the bundle in force stays");
    assert_eq!(b.digest, held);
    assert_eq!(b.bundle.bundle_version, 3);
    let status = agent.status_json().await;
    assert_eq!(status["signingKeyMismatch"], true);
    assert_eq!(status["lastSync"]["ok"], false);
    assert!(status["lastSync"]["error"].as_str().unwrap().contains("gk_0000beef"));
}

#[tokio::test]
async fn a_stored_catalogue_that_does_not_verify_falls_back_to_the_seed() {
    let reg = fake_registry().await;
    let dir = temp_dir("cat-disk");
    let agent = open(&dir);
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&agent).await.unwrap();
    let again = open(&dir);
    assert_eq!(again.matcher().source, "signed", "a good catalogue.json is loaded at start-up");
    let p = dir.join("catalogue.json");
    let mut raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
    raw["catalogue"]["services"][0]["enabled"] = serde_json::json!(false);
    std::fs::write(&p, serde_json::to_vec(&raw).unwrap()).unwrap();
    let edited = open(&dir);
    let cat = edited.matcher();
    assert_eq!(cat.source, "seed", "an edited catalogue fails its digest; the seed is used until the next sync");
    assert!(cat.digest.is_none());
    assert!(cat.matcher.is_intercepted_host("chatgpt.com"));
    assert!(edited.active_bundle().is_some(), "the bundle verifies on its own and stays in force");
}

#[tokio::test]
async fn revoked_on_the_asks_get_then_offline_nothing_is_decrypted_or_sent() {
    let reg = fake_registry().await;
    let dir = temp_dir("revoke-get");
    let agent = open(&dir);
    enrol(&agent, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&agent).await.unwrap();
    let d = agent
        .decide(RequestMeta {
            host: "chatgpt.com",
            method: Some("POST"),
            path: Some("/backend-api/conversation"),
            text: "tfn 123 456 782",
            ..Default::default()
        })
        .await
        .unwrap();
    let info = d.info.expect("a refusal carries its facts");
    let ask = vibtra_guard_agent::sync::file_ask(&agent, &info, Some("month end".into())).await.unwrap();
    assert_eq!(ask.request.status, "pending");

    {
        let mut s = reg.state.lock().unwrap();
        s.revoked = true;
        s.calls.clear();
    }
    match vibtra_guard_agent::sync::refresh_asks(&agent).await {
        Err(SyncError::Revoked(code)) => assert_eq!(code, "GUARD_DEVICE_REVOKED"),
        other => panic!("expected a revocation, got {other:?}"),
    }
    assert_eq!(reg.state.lock().unwrap().calls, vec!["GET requests"]);
    assert!(agent.device().unwrap().revoked);
    assert!(agent.active_bundle().is_none());
    assert!(!agent.should_intercept("chatgpt.com"), "a revoked agent decrypts nothing");
    assert!(agent.decide(RequestMeta { host: "chatgpt.com", method: Some("POST"), text: "tfn 123 456 782", ..Default::default() }).await.is_none());

    reg.state.lock().unwrap().calls.clear();
    assert!(matches!(sync_once(&agent).await, Err(SyncError::Revoked(_))));
    assert!(matches!(vibtra_guard_agent::sync::file_ask(&agent, &info, None).await, Err(SyncError::Revoked(_))));
    let fresh = open(&dir);
    assert!(matches!(sync_once(&fresh).await, Err(SyncError::Revoked(_))), "a restarted agent reads revoked from device.json");
    assert!(!fresh.should_intercept("chatgpt.com"));
    assert!(reg.state.lock().unwrap().calls.is_empty(), "the revoked device calls nothing");
}

#[tokio::test]
async fn reload_enrolment_picks_up_a_new_enrolment_and_drops_the_old_bundle() {
    use vibtra_guard_agent::config;
    use vibtra_guard_agent::sync::reload_enrolment;
    let reg = fake_registry().await;
    let dir = temp_dir("reload");
    let running = open(&dir);
    assert!(!running.enrolled());
    reload_enrolment(&running);
    assert!(!running.enrolled(), "nothing on disk: nothing changes");

    let app = open(&dir);
    enrol(&app, &reg.base(), ENROL_TOKEN).await.unwrap();
    sync_once(&app).await.unwrap();
    reload_enrolment(&running);
    assert!(running.enrolled());
    assert_eq!(running.token().as_deref(), Some(DEVICE_TOKEN));
    let picked = running.active_bundle().expect("the stored bundle verifies and is loaded");
    assert_eq!(running.matcher().source, "signed");

    reload_enrolment(&running);
    assert!(Arc::ptr_eq(&picked, &running.active_bundle().unwrap()));

    let paths = config::Paths::resolve(Some(&dir));
    let mut device = config::load_device(&paths).unwrap().unwrap();
    device.signing.key_id = "gk_0000beef".into();
    config::save_device(&paths, &device).unwrap();
    let new_token = "gdt_ffffffffffffffffffffffffffffffffffffffffffffffff";
    config::save_token(&paths, new_token).unwrap();
    reload_enrolment(&running);
    assert_eq!(running.device().unwrap().signing.key_id, "gk_0000beef");
    assert_eq!(running.token().as_deref(), Some(new_token));
    assert!(running.active_bundle().is_none(), "the old bundle is dropped and does not verify under the new key");
}

#[test]
fn next_wait_follows_the_server_backs_off_and_caps() {
    use vibtra_guard_agent::contract::SYNC_BACKOFF_MAX_S;
    use vibtra_guard_agent::sync::next_wait;
    let net = || Err(SyncError::Network("down".into()));
    assert_eq!(next_wait(&report_ok(60), 4, 60, None), (60, 0));
    assert_eq!(next_wait(&report_ok(60), 4, 60, Some(5)), (5, 0));
    assert_eq!(next_wait(&Err(SyncError::NotEnrolled), 2, 60, None), (15, 2));
    assert_eq!(next_wait(&Err(SyncError::Revoked("GUARD_DEVICE_REVOKED".into())), 2, 60, None), (60, 2));
    assert_eq!(next_wait(&net(), 0, 60, None), (120, 1));
    assert_eq!(next_wait(&net(), 1, 60, None), (240, 2));
    assert_eq!(next_wait(&net(), 2, 60, None), (480, 3));
    assert_eq!(next_wait(&net(), 3, 60, None), (SYNC_BACKOFF_MAX_S, 4));
    assert_eq!(next_wait(&net(), u32::MAX, 60, None), (SYNC_BACKOFF_MAX_S, u32::MAX), "no overflow at the extreme");
    assert_eq!(next_wait(&net(), 0, 60, Some(5)), (10, 1));
    let api = Err(SyncError::Api { status: 500, code: "X".into(), message: String::new() });
    assert_eq!(next_wait(&api, 0, 60, None), (120, 1));
    let km = Err(SyncError::KeyMismatch { pinned: "a".into(), server: "b".into() });
    assert_eq!(next_wait(&km, 0, 60, None), (120, 1));
}

#[tokio::test]
async fn sync_now_wakes_the_loop_early() {
    use vibtra_guard_agent::sync::wait_or_wake;
    let agent = open(&temp_dir("wake"));
    agent.sync_now.notify_one();
    let woke = tokio::time::timeout(std::time::Duration::from_secs(5), wait_or_wake(&agent, 3600)).await.expect("woken, not the hour");
    assert!(woke);
    assert!(!wait_or_wake(&agent, 0).await);
}
