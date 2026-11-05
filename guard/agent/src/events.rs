// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::types::Event;
use anyhow::Result;
use rand::RngExt;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;
use tokio::sync::Mutex;

pub fn mint_event_id() -> String {
    let bytes: [u8; 8] = rand::rng().random();
    format!("gev_{}", hex::encode(bytes))
}

pub fn now_iso() -> String {
    iso(OffsetDateTime::now_utc())
}

pub fn iso(t: OffsetDateTime) -> String {
    let t = t.replace_nanosecond((t.nanosecond() / 1_000_000) * 1_000_000).unwrap_or(t);
    t.format(&Rfc3339).unwrap_or_default()
}

pub struct EventQueue {
    path: PathBuf,
    lock: Mutex<()>,
}

struct FileLock(fs::File);

impl FileLock {
    fn take(queue: &std::path::Path) -> Option<FileLock> {
        let f = OpenOptions::new().create(true).truncate(false).write(true).open(queue.with_extension("jsonl.lock")).ok()?;
        f.lock().ok()?;
        Some(FileLock(f))
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

impl EventQueue {
    pub fn new(path: PathBuf) -> Self {
        EventQueue { path, lock: Mutex::new(()) }
    }

    pub async fn append(&self, event: &Event) -> Result<()> {
        let _g = self.lock.lock().await;
        let _f = FileLock::take(&self.path);
        let mut line = serde_json::to_vec(event)?;
        line.push(b'\n');
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = f.set_permissions(fs::Permissions::from_mode(0o600));
        }
        f.write_all(&line)?;
        Ok(())
    }

    fn read_all(&self) -> Vec<Event> {
        let Ok(text) = fs::read_to_string(&self.path) else { return Vec::new() };
        text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| serde_json::from_str::<Event>(l).ok()).collect()
    }

    pub async fn len(&self) -> usize {
        let _g = self.lock.lock().await;
        let _f = FileLock::take(&self.path);
        self.read_all().len()
    }

    pub async fn is_empty(&self) -> bool {
        self.len().await == 0
    }

    pub async fn peek(&self, n: usize) -> Vec<Event> {
        let _g = self.lock.lock().await;
        let _f = FileLock::take(&self.path);
        self.read_all().into_iter().take(n).collect()
    }

    pub async fn remove(&self, ids: &HashSet<String>) -> Result<()> {
        let _g = self.lock.lock().await;
        let _f = FileLock::take(&self.path);
        let keep: Vec<Event> = self.read_all().into_iter().filter(|e| !ids.contains(&e.event_id)).collect();
        let mut out = Vec::new();
        for e in keep {
            out.extend(serde_json::to_vec(&e)?);
            out.push(b'\n');
        }
        crate::config::write_atomic(&self.path, &out, 0o600)?;
        Ok(())
    }
}
