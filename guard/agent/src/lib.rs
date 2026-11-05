// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

pub mod agent;
pub mod body;
pub mod bundle;
pub mod ca;
pub mod catalogue;
pub mod config;
pub mod contract;
pub mod detect;
pub mod engine;
pub mod events;
pub mod facts;
pub mod local;
pub mod marks;
pub mod page;
pub mod prompt;
pub mod proxy;
pub mod redact;
pub mod sync;
pub mod transparent;
pub mod types;

pub const LOG_FILTER_DEFAULT: &str = "info,hudsucker=off,hyper=warn,rustls=warn,reqwest=warn";

pub fn init_crypto() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}
