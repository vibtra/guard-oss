// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::contract::SIGNATURE_TYP;
use crate::types::{Bundle, Catalogue, SignaturePayload};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::pkcs8::DecodePublicKey;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    Malformed,
    WrongKey,
    BadSignature,
    DigestMismatch,
    WrongKind,
    WrongDevice,
}

impl VerifyError {
    pub fn as_str(self) -> &'static str {
        match self {
            VerifyError::Malformed => "malformed",
            VerifyError::WrongKey => "wrong-key",
            VerifyError::BadSignature => "bad-signature",
            VerifyError::DigestMismatch => "digest-mismatch",
            VerifyError::WrongKind => "wrong-kind",
            VerifyError::WrongDevice => "wrong-device",
        }
    }
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

pub fn canonical_json(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write_canonical(value, &mut out)?;
    Ok(out)
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                let f = n.as_f64().unwrap_or(f64::NAN);
                if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.007_199_254_740_992e15 {
                    out.push_str(&(f as i64).to_string());
                } else {
                    return Err("a signed Guard document carries integers only".to_string());
                }
            }
        }
        Value::String(s) => out.push_str(&serde_json::to_string(s).map_err(|e| e.to_string())?),
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).map_err(|e| e.to_string())?);
                out.push(':');
                write_canonical(&map[*k], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

pub fn digest_of(value: &Value) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(canonical_json(value)?.as_bytes())))
}

fn b64(part: &str) -> Result<Vec<u8>, VerifyError> {
    URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).map_err(|_| VerifyError::Malformed)
}

#[derive(Debug, Clone)]
pub struct Verified {
    pub payload: SignaturePayload,
    pub digest: String,
}

pub fn verify_signed(
    signed: &Value,
    doc_field: &str,
    kind: &str,
    public_key_pem: &str,
    key_id: &str,
    device_id: Option<&str>,
) -> Result<Verified, VerifyError> {
    let document = signed.get(doc_field).ok_or(VerifyError::Malformed)?;
    let signature = signed.get("signature").ok_or(VerifyError::Malformed)?;
    let jws = signature.get("jws").and_then(Value::as_str).ok_or(VerifyError::Malformed)?;
    let sig_key_id = signature.get("keyId").and_then(Value::as_str).ok_or(VerifyError::Malformed)?;
    if signature.get("alg").and_then(Value::as_str) != Some("ES256") {
        return Err(VerifyError::Malformed);
    }
    let parts: Vec<&str> = jws.split('.').collect();
    if parts.len() != 3 {
        return Err(VerifyError::Malformed);
    }
    let header: Value = serde_json::from_slice(&b64(parts[0])?).map_err(|_| VerifyError::Malformed)?;
    let payload: SignaturePayload = serde_json::from_slice(&b64(parts[1])?).map_err(|_| VerifyError::Malformed)?;
    if !payload_well_formed(&payload) {
        return Err(VerifyError::Malformed);
    }
    if header.get("alg").and_then(Value::as_str) != Some("ES256") || header.get("typ").and_then(Value::as_str) != Some(SIGNATURE_TYP) {
        return Err(VerifyError::Malformed);
    }
    if header.get("kid").and_then(Value::as_str) != Some(key_id) || payload.key_id != key_id || sig_key_id != key_id {
        return Err(VerifyError::WrongKey);
    }
    if payload.kind != kind {
        return Err(VerifyError::WrongKind);
    }
    if let Some(d) = device_id {
        if payload.device_id.as_deref() != Some(d) {
            return Err(VerifyError::WrongDevice);
        }
    }
    let key = VerifyingKey::from_public_key_pem(public_key_pem).map_err(|_| VerifyError::BadSignature)?;
    let sig_bytes = b64(parts[2]).map_err(|_| VerifyError::BadSignature)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| VerifyError::BadSignature)?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    key.verify(signing_input.as_bytes(), &sig).map_err(|_| VerifyError::BadSignature)?;
    let digest = digest_of(document).map_err(|_| VerifyError::Malformed)?;
    if digest != payload.digest {
        return Err(VerifyError::DigestMismatch);
    }
    Ok(Verified { payload, digest })
}

fn payload_well_formed(p: &SignaturePayload) -> bool {
    (p.kind == "bundle" || p.kind == "catalogue")
        && p.digest.len() == 64
        && p.digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && !p.org_id.is_empty()
        && (p.version.is_u64() || p.version.as_str().is_some_and(|s| !s.is_empty()))
}

#[derive(Debug, Clone)]
pub struct VerifiedBundle {
    pub bundle: Bundle,
    pub digest: String,
    pub raw: Value,
}

pub fn verify_bundle(signed: &Value, public_key_pem: &str, key_id: &str, device_id: Option<&str>) -> Result<VerifiedBundle, VerifyError> {
    let v = verify_signed(signed, "bundle", "bundle", public_key_pem, key_id, device_id)?;
    let bundle: Bundle = serde_json::from_value(signed["bundle"].clone()).map_err(|_| VerifyError::Malformed)?;
    if let Some(d) = device_id {
        if bundle.device_id != d {
            return Err(VerifyError::WrongDevice);
        }
    }
    Ok(VerifiedBundle { bundle, digest: v.digest, raw: signed.clone() })
}

#[derive(Debug, Clone)]
pub struct VerifiedCatalogue {
    pub catalogue: Catalogue,
    pub digest: String,
    pub raw: Value,
}

pub fn verify_catalogue(signed: &Value, public_key_pem: &str, key_id: &str) -> Result<VerifiedCatalogue, VerifyError> {
    let v = verify_signed(signed, "catalogue", "catalogue", public_key_pem, key_id, None)?;
    let catalogue: Catalogue = serde_json::from_value(signed["catalogue"].clone()).map_err(|_| VerifyError::Malformed)?;
    Ok(VerifiedCatalogue { catalogue, digest: v.digest, raw: signed.clone() })
}

pub struct SignSpec<'a> {
    pub kind: &'a str,
    pub doc_field: &'a str,
    pub key_id: &'a str,
    pub org_id: &'a str,
    pub device_id: Option<&'a str>,
    pub version: Value,
    pub iat: u64,
}

pub fn sign_document(spec: SignSpec<'_>, document: &Value, signing_key_bytes: &[u8]) -> Result<Value, String> {
    let key = SigningKey::from_slice(signing_key_bytes).map_err(|e| e.to_string())?;
    let header = serde_json::json!({ "alg": "ES256", "typ": SIGNATURE_TYP, "kid": spec.key_id });
    let payload = SignaturePayload {
        kind: spec.kind.to_string(),
        key_id: spec.key_id.to_string(),
        iat: spec.iat,
        org_id: spec.org_id.to_string(),
        device_id: spec.device_id.map(str::to_string),
        version: spec.version,
        digest: digest_of(document)?,
    };
    let h = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&header).map_err(|e| e.to_string())?);
    let p = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    let sig: Signature = key.sign(format!("{h}.{p}").as_bytes());
    let jws = format!("{h}.{p}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()));
    Ok(serde_json::json!({ spec.doc_field: document, "signature": { "keyId": spec.key_id, "alg": "ES256", "jws": jws } }))
}

pub fn public_key_pem(signing_key_bytes: &[u8]) -> Result<String, String> {
    use p256::pkcs8::{EncodePublicKey, LineEnding};
    let key = SigningKey::from_slice(signing_key_bytes).map_err(|e| e.to_string())?;
    key.verifying_key().to_public_key_pem(LineEnding::LF).map_err(|e| e.to_string())
}
