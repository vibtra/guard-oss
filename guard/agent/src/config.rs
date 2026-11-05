// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::types::{ClientMode, Person, ServerFacts, SigningKey};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    pub dir: PathBuf,
}

impl Paths {
    pub fn resolve(explicit: Option<&Path>) -> Paths {
        if let Some(p) = explicit {
            return Paths { dir: p.to_path_buf() };
        }
        if let Ok(p) = std::env::var("VIBTRA_GUARD_DIR") {
            if !p.is_empty() {
                return Paths { dir: PathBuf::from(p) };
            }
        }
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        Paths { dir: PathBuf::from(home).join("Library").join("Application Support").join("Vibtra Guard") }
    }
    pub fn device(&self) -> PathBuf {
        self.dir.join("device.json")
    }
    pub fn token(&self) -> PathBuf {
        self.dir.join("device.token")
    }
    pub fn ca_key(&self) -> PathBuf {
        self.dir.join("ca.key")
    }
    pub fn ca_pem(&self) -> PathBuf {
        self.dir.join("ca.pem")
    }
    pub fn bundle(&self) -> PathBuf {
        self.dir.join("bundle.json")
    }
    pub fn catalogue(&self) -> PathBuf {
        self.dir.join("catalogue.json")
    }
    pub fn events(&self) -> PathBuf {
        self.dir.join("events.jsonl")
    }
    pub fn state(&self) -> PathBuf {
        self.dir.join("state.json")
    }
    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.dir).with_context(|| format!("creating {}", self.dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.dir, fs::Permissions::from_mode(0o700));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceFile {
    pub device_id: String,
    pub org_id: String,
    pub org_handle: String,
    pub org_name: String,
    pub person: Person,
    pub server: ServerFacts,
    pub signing: SigningKey,
    pub client_mode: ClientMode,
    pub enrolled_at: String,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
}

pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("tmp-{}-{seq}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).with_context(|| format!("writing {}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("renaming into {}", path.display()))?;
    Ok(())
}

pub fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| format!("parsing {}", path.display()))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

pub fn write_json<T: Serialize>(path: &Path, value: &T, mode: u32) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_atomic(path, &bytes, mode)
}

pub fn load_device(paths: &Paths) -> Result<Option<DeviceFile>> {
    read_json(&paths.device())
}

pub fn save_device(paths: &Paths, device: &DeviceFile) -> Result<()> {
    write_json(&paths.device(), device, 0o600)
}

pub fn load_token(paths: &Paths) -> Result<Option<String>> {
    match fs::read_to_string(paths.token()) {
        Ok(s) => Ok(Some(s.trim().to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn save_token(paths: &Paths, token: &str) -> Result<()> {
    write_atomic(&paths.token(), token.as_bytes(), 0o600)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateFile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_sync_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_key_mismatch: Option<bool>,
}
