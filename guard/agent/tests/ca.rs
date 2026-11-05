// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

mod common;

use common::*;
use vibtra_guard_agent::agent::{Agent, Options};
use vibtra_guard_agent::ca::{is_trusted, Ca};
use vibtra_guard_agent::config::Paths;

#[test]
fn one_ca_per_laptop_survives_a_restart() {
    let dir = temp_dir("ca");
    let paths = Paths::resolve(Some(&dir));
    paths.ensure().unwrap();
    assert!(Ca::load(&paths).unwrap().is_none(), "nothing on disk yet");

    let created = Ca::load_or_create(&paths, "ada-mbp").unwrap();
    assert_eq!(created.facts.subject, "Vibtra Guard CA (ada-mbp)");
    assert_eq!(created.facts.fingerprint_sha256.len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(paths.ca_key()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    let loaded = Ca::load(&paths).unwrap().expect("ca.pem + ca.key load");
    assert_eq!(loaded.cert_pem, created.cert_pem);
    assert_eq!(loaded.key_pem, created.key_pem);
    assert_eq!(loaded.facts.fingerprint_sha256, created.facts.fingerprint_sha256);
    assert_eq!(loaded.facts.not_after, created.facts.not_after);
    assert_eq!(loaded.spki_sha256_b64, created.spki_sha256_b64);
    let again = Ca::load_or_create(&paths, "renamed-laptop").unwrap();
    assert_eq!(again.facts.fingerprint_sha256, created.facts.fingerprint_sha256);
    assert!(loaded.issuer().is_ok(), "the reloaded key and certificate still mint leaves");

    let a = Agent::open(&Options { data_dir: Some(dir.clone()), sync: false, ..Default::default() }).unwrap();
    let b = Agent::open(&Options { data_dir: Some(dir.clone()), sync: false, ..Default::default() }).unwrap();
    assert_eq!(a.ca.facts.fingerprint_sha256, created.facts.fingerprint_sha256);
    assert_eq!(b.ca.facts.fingerprint_sha256, created.facts.fingerprint_sha256);
    assert!(!serde_json::to_string(&a.ca.facts).unwrap().contains("PRIVATE KEY"), "the facts the registry sees carry no key");
}

#[test]
fn a_half_written_ca_is_not_loaded_and_a_broken_pem_is_an_error() {
    let dir = temp_dir("ca-broken");
    let paths = Paths::resolve(Some(&dir));
    paths.ensure().unwrap();
    std::fs::write(paths.ca_pem(), "not a certificate").unwrap();
    assert!(Ca::load(&paths).unwrap().is_none(), "ca.pem without ca.key: no CA");
    std::fs::write(paths.ca_key(), "not a key").unwrap();
    let err = Ca::load(&paths).unwrap_err().to_string();
    assert!(err.contains("ca.pem has no certificate"), "{err}");
    assert!(Ca::from_pem(Ca::generate("x").unwrap().cert_pem, "not a key".into()).unwrap().issuer().is_err());
}

#[test]
fn is_trusted_answers_none_where_it_cannot_check() {
    let dir = temp_dir("ca-trust");
    let paths = Paths::resolve(Some(&dir));
    paths.ensure().unwrap();
    assert_eq!(is_trusted(&paths), None, "no ca.pem: nothing to check");
    Ca::load_or_create(&paths, "ada-mbp").unwrap();
    if cfg!(target_os = "macos") {
        assert_eq!(is_trusted(&paths), Some(false));
    } else {
        assert_eq!(is_trusted(&paths), None, "off macOS the check cannot run");
    }
}
