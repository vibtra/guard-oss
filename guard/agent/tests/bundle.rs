// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use serde_json::Value;
use vibtra_guard_agent::bundle::{canonical_json, digest_of, verify_bundle, verify_catalogue, VerifyError};

fn fixture(name: &str) -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let mut v: Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
    if let Some(sig) = v.get_mut("signature").and_then(Value::as_object_mut) {
        if let Some(parts) = sig.remove("jwsParts") {
            let joined: Vec<&str> = parts.as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
            sig.insert("jws".into(), Value::String(joined.join(".")));
        }
    }
    v
}

fn pem() -> String {
    std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/signing-public.pem")).unwrap()
}

const DEVICE: &str = "gdev_0123456789abcdef";

#[test]
fn canonical_json_matches_typescript() {
    let d = fixture("digests.json");
    let signed = fixture("signed-bundle.json");
    assert_eq!(canonical_json(&signed["bundle"]).unwrap(), d["bundleCanonical"].as_str().unwrap());
    assert_eq!(digest_of(&signed["bundle"]).unwrap(), d["bundleDigest"].as_str().unwrap());
    assert_eq!(digest_of(&fixture("signed-catalogue.json")["catalogue"]).unwrap(), d["catalogueDigest"].as_str().unwrap());
    assert!(canonical_json(&serde_json::json!({ "a": 1.5 })).is_err());
    assert_eq!(canonical_json(&serde_json::json!({ "b": 2.0, "a": [true, null, "é\n\"x\""] })).unwrap(), r#"{"a":[true,null,"é\n\"x\""],"b":2}"#);
}

#[test]
fn a_good_bundle_and_catalogue_verify() {
    let key_id = fixture("digests.json")["keyId"].as_str().unwrap().to_string();
    let v = verify_bundle(&fixture("signed-bundle.json"), &pem(), &key_id, Some(DEVICE)).expect("verifies");
    assert_eq!(v.bundle.bundle_version, 7);
    assert_eq!(v.digest, fixture("digests.json")["bundleDigest"].as_str().unwrap());
    assert_eq!(v.bundle.content_rules.len(), 3);
    let c = verify_catalogue(&fixture("signed-catalogue.json"), &pem(), &key_id).expect("catalogue verifies");
    assert!(c.catalogue.services.len() >= 40);
}

#[test]
fn every_failure_says_why() {
    let key_id = fixture("digests.json")["keyId"].as_str().unwrap().to_string();
    let good = fixture("signed-bundle.json");
    assert_eq!(verify_bundle(&fixture("signed-bundle-tampered.json"), &pem(), &key_id, Some(DEVICE)).unwrap_err(), VerifyError::DigestMismatch);
    assert_eq!(verify_bundle(&fixture("signed-bundle-other-device.json"), &pem(), &key_id, Some(DEVICE)).unwrap_err(), VerifyError::WrongDevice);
    assert_eq!(verify_bundle(&good, &pem(), "gk_00000000", Some(DEVICE)).unwrap_err(), VerifyError::WrongKey);
    let mut wrong_kind = good.clone();
    wrong_kind["signature"] = fixture("signed-catalogue.json")["signature"].clone();
    assert_eq!(verify_bundle(&wrong_kind, &pem(), &key_id, Some(DEVICE)).unwrap_err(), VerifyError::WrongKind);
    let mut bad = good.clone();
    let jws = bad["signature"]["jws"].as_str().unwrap().to_string();
    let (head, sig) = jws.rsplit_once('.').unwrap();
    let mut sig: Vec<char> = sig.chars().collect();
    sig[10] = if sig[10] == 'A' { 'B' } else { 'A' };
    bad["signature"]["jws"] = Value::String(format!("{head}.{}", sig.into_iter().collect::<String>()));
    assert_eq!(verify_bundle(&bad, &pem(), &key_id, Some(DEVICE)).unwrap_err(), VerifyError::BadSignature);
    let mut junk = good.clone();
    junk["signature"]["jws"] = Value::String("not.a-jws".into());
    assert_eq!(verify_bundle(&junk, &pem(), &key_id, Some(DEVICE)).unwrap_err(), VerifyError::Malformed);
    let other = vibtra_guard_agent::bundle::public_key_pem(&[9u8; 32]).unwrap();
    assert_eq!(verify_bundle(&good, &other, &key_id, Some(DEVICE)).unwrap_err(), VerifyError::BadSignature);
}

#[test]
fn a_bundle_signed_for_another_device_is_refused() {
    use vibtra_guard_agent::bundle::{public_key_pem, sign_document, SignSpec};
    let key = [7u8; 32];
    let pem = public_key_pem(&key).unwrap();
    let mut doc = fixture("signed-bundle.json")["bundle"].clone();
    let spec = |device: &'static str, version: Value| SignSpec {
        kind: "bundle",
        doc_field: "bundle",
        key_id: "gk_0000feed",
        org_id: "org_fernwood",
        device_id: Some(device),
        version,
        iat: 1_760_000_000,
    };
    doc["deviceId"] = Value::String(DEVICE.into());
    let ok = sign_document(spec(DEVICE, doc["bundleVersion"].clone()), &doc, &key).unwrap();
    assert!(verify_bundle(&ok, &pem, "gk_0000feed", Some(DEVICE)).is_ok());
    doc["deviceId"] = Value::String("gdev_ffffffffffffffff".into());
    let swapped = sign_document(spec(DEVICE, doc["bundleVersion"].clone()), &doc, &key).unwrap();
    assert_eq!(verify_bundle(&swapped, &pem, "gk_0000feed", Some(DEVICE)).unwrap_err(), VerifyError::WrongDevice);
    assert_eq!(VerifyError::WrongDevice.to_string(), "wrong-device");
    doc["deviceId"] = Value::String(DEVICE.into());
    let other = sign_document(spec("gdev_ffffffffffffffff", doc["bundleVersion"].clone()), &doc, &key).unwrap();
    assert_eq!(verify_bundle(&other, &pem, "gk_0000feed", Some(DEVICE)).unwrap_err(), VerifyError::WrongDevice);
    assert!(verify_bundle(&swapped, &pem, "gk_0000feed", None).is_ok());
}

#[test]
fn floats_in_a_signed_document_follow_the_integers_only_rule() {
    use vibtra_guard_agent::bundle::{public_key_pem, sign_document, SignSpec};
    let parse = |s: &str| serde_json::from_str::<Value>(s).unwrap();
    assert_eq!(canonical_json(&parse(r#"{"n":2.0}"#)).unwrap(), canonical_json(&parse(r#"{"n":2}"#)).unwrap());
    assert_eq!(canonical_json(&parse(r#"{"n":-0.0}"#)).unwrap(), r#"{"n":0}"#, "JSON.stringify(-0) is 0");
    assert_eq!(canonical_json(&parse(r#"{"n":1e3}"#)).unwrap(), r#"{"n":1000}"#);
    for refused in [r#"{"n":1.5}"#, r#"[0.1]"#, r#"{"a":{"b":-2.25}}"#, "1e20"] {
        assert!(canonical_json(&parse(refused)).is_err(), "{refused} is refused");
    }
    let key = [7u8; 32];
    let mut doc = fixture("signed-bundle.json")["bundle"].clone();
    doc["deviceId"] = Value::String(DEVICE.into());
    let spec = || SignSpec {
        kind: "bundle",
        doc_field: "bundle",
        key_id: "gk_0000feed",
        org_id: "org_fernwood",
        device_id: Some(DEVICE),
        version: doc["bundleVersion"].clone(),
        iat: 1_760_000_000,
    };
    let mut signed = sign_document(spec(), &doc, &key).unwrap();
    let mut fraction = doc.clone();
    fraction["settings"]["snippetMax"] = parse("80.5");
    assert!(sign_document(spec(), &fraction, &key).is_err());
    signed["bundle"]["settings"]["snippetMax"] = parse("80.5");
    assert_eq!(verify_bundle(&signed, &public_key_pem(&key).unwrap(), "gk_0000feed", Some(DEVICE)).unwrap_err(), VerifyError::Malformed);
}
