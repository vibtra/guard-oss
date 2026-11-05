// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::config::{write_atomic, Paths};
use crate::types::CaFacts;
use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, Issuer, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256};
use sha2::{Digest, Sha256};
use std::fs;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

#[derive(Debug, Clone)]
pub struct Ca {
    pub cert_pem: String,
    pub key_pem: String,
    pub cert_der: Vec<u8>,
    pub facts: CaFacts,
    pub spki_sha256_b64: String,
}

impl Ca {
    pub fn load_or_create(paths: &Paths, hostname: &str) -> Result<Ca> {
        paths.ensure()?;
        if paths.ca_pem().exists() && paths.ca_key().exists() {
            let cert_pem = fs::read_to_string(paths.ca_pem())?;
            let key_pem = fs::read_to_string(paths.ca_key())?;
            return Ca::from_pem(cert_pem, key_pem);
        }
        let ca = Ca::generate(hostname)?;
        write_atomic(&paths.ca_key(), ca.key_pem.as_bytes(), 0o600)?;
        write_atomic(&paths.ca_pem(), ca.cert_pem.as_bytes(), 0o644)?;
        tracing::info!(subject = %ca.facts.subject, fingerprint = %ca.facts.fingerprint_sha256, "created the per-laptop CA");
        Ok(ca)
    }

    pub fn load(paths: &Paths) -> Result<Option<Ca>> {
        if !paths.ca_pem().exists() || !paths.ca_key().exists() {
            return Ok(None);
        }
        Ok(Some(Ca::from_pem(fs::read_to_string(paths.ca_pem())?, fs::read_to_string(paths.ca_key())?)?))
    }

    pub fn generate(hostname: &str) -> Result<Ca> {
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
        let mut params = CertificateParams::new(Vec::<String>::new())?;
        let mut dn = DistinguishedName::new();
        let subject = format!("Vibtra Guard CA ({})", hostname.chars().take(120).collect::<String>());
        dn.push(DnType::CommonName, subject.as_str());
        dn.push(DnType::OrganizationName, "Vibtra Guard");
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign, KeyUsagePurpose::DigitalSignature];
        let now = OffsetDateTime::now_utc();
        params.not_before = now - Duration::days(1);
        params.not_after = now + Duration::days(730);
        let cert = params.self_signed(&key)?;
        Ca::from_pem(cert.pem(), key.serialize_pem())
    }

    pub fn from_pem(cert_pem: String, key_pem: String) -> Result<Ca> {
        let der = rustls_pemfile::certs(&mut cert_pem.as_bytes()).next().ok_or_else(|| anyhow!("ca.pem has no certificate"))?.context("ca.pem")?;
        let cert_der = der.to_vec();
        let (_, x509) = x509_parser::parse_x509_certificate(&cert_der).map_err(|e| anyhow!("ca.pem does not parse: {e}"))?;
        let subject = x509.subject().iter_common_name().next().and_then(|cn| cn.as_str().ok()).unwrap_or("Vibtra Guard CA").to_string();
        let not_after = OffsetDateTime::from_unix_timestamp(x509.validity().not_after.timestamp())?.format(&Rfc3339)?;
        let spki = x509.public_key().raw;
        let facts = CaFacts { fingerprint_sha256: hex::encode(Sha256::digest(&cert_der)), subject, not_after };
        let spki_sha256_b64 = STANDARD.encode(Sha256::digest(spki));
        Ok(Ca { cert_pem, key_pem, cert_der, facts, spki_sha256_b64 })
    }

    pub fn issuer(&self) -> Result<Issuer<'static, KeyPair>> {
        let key = KeyPair::from_pem(&self.key_pem)?;
        Ok(Issuer::from_ca_cert_pem(&self.cert_pem, key)?)
    }
}

pub fn trust_in_login_keychain(paths: &Paths) -> Result<()> {
    let home = std::env::var("HOME").context("HOME")?;
    let keychain = format!("{home}/Library/Keychains/login.keychain-db");
    let status = std::process::Command::new("/usr/bin/security")
        .args(["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-p", "basic", "-k", &keychain])
        .arg(paths.ca_pem())
        .status()
        .context("running /usr/bin/security")?;
    if !status.success() {
        return Err(anyhow!("security add-trusted-cert exited with {status}"));
    }
    Ok(())
}

pub fn is_trusted(paths: &Paths) -> Option<bool> {
    if !cfg!(target_os = "macos") || !paths.ca_pem().exists() {
        return None;
    }
    let out = std::process::Command::new("/usr/bin/security").args(["verify-cert", "-L", "-q", "-p", "ssl", "-c"]).arg(paths.ca_pem()).output().ok()?;
    Some(out.status.success())
}
