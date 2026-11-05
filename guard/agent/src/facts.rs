// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::contract::AGENT_VERSION;
use crate::types::DeviceFacts;
use std::process::Command;

fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn clip(s: String, max: usize) -> String {
    s.chars().take(max).collect()
}

pub fn hostname() -> String {
    run("/usr/sbin/scutil", &["--get", "LocalHostName"])
        .or_else(|| run("hostname", &[]))
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|s| clip(s, 253))
        .unwrap_or_else(|| "unknown-host".to_string())
}

fn serial_number() -> Option<String> {
    let out = run("/usr/sbin/ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?;
    let line = out.lines().find(|l| l.contains("IOPlatformSerialNumber"))?;
    let value = line.split('=').nth(1)?.trim().trim_matches('"').to_string();
    (!value.is_empty()).then(|| clip(value, 64))
}

pub fn collect() -> DeviceFacts {
    let arch = match std::env::consts::ARCH {
        "aarch64" => Some("arm64".to_string()),
        "x86_64" => Some("x86_64".to_string()),
        _ => None,
    };
    DeviceFacts {
        hostname: hostname(),
        serial_number: serial_number(),
        model_identifier: run("/usr/sbin/sysctl", &["-n", "hw.model"]).map(|s| clip(s, 64)),
        os_version: run("/usr/bin/sw_vers", &["-productVersion"])
            .map(|v| clip(v, 40))
            .unwrap_or_else(|| clip(format!("{} (unknown version)", std::env::consts::OS), 40)),
        os_build: run("/usr/bin/sw_vers", &["-buildVersion"]).map(|s| clip(s, 40)),
        agent_version: AGENT_VERSION.to_string(),
        primary_user: std::env::var("USER").ok().filter(|u| !u.is_empty()).map(|u| clip(u, 120)),
        arch,
    }
}
