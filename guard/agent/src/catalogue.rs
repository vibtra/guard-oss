// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use crate::types::{Catalogue, Service};
use regex::Regex;

pub fn normalise_host(host: &str) -> String {
    let no_port = if host.contains(':') && !host.starts_with('[') { &host[..host.find(':').unwrap_or(host.len())] } else { host };
    let lower = no_port.to_lowercase();
    lower.strip_suffix('.').map(str::to_string).unwrap_or(lower)
}

fn pattern_regex(pattern: &str) -> Option<Regex> {
    if !pattern.contains('*') {
        return None;
    }
    let escaped: Vec<String> = pattern.split('*').map(regex::escape).collect();
    Regex::new(&format!("^{}$", escaped.join("[a-z0-9-]+"))).ok()
}

fn matches_compiled(host: &str, pattern: &str, re: Option<&Regex>) -> bool {
    if host.is_empty() {
        return false;
    }
    match re {
        None => host == pattern || (host.len() > pattern.len() && host.ends_with(pattern) && host.as_bytes()[host.len() - pattern.len() - 1] == b'.'),
        Some(re) => re.is_match(host),
    }
}

pub fn host_matches_pattern(host: &str, pattern: &str) -> bool {
    let h = normalise_host(host);
    let re = pattern_regex(pattern);
    if pattern.contains('*') && re.is_none() {
        return false;
    }
    matches_compiled(&h, pattern, re.as_ref())
}

#[derive(Debug, Clone)]
pub struct Matcher {
    pub catalogue: Catalogue,
    patterns: Vec<(usize, String, Option<Regex>)>,
}

impl Matcher {
    pub fn new(catalogue: Catalogue) -> Self {
        let mut patterns = Vec::new();
        for (i, s) in catalogue.services.iter().enumerate() {
            for p in &s.domains {
                let re = pattern_regex(p);
                if p.contains('*') && re.is_none() {
                    continue;
                }
                patterns.push((i, p.clone(), re));
            }
        }
        Matcher { catalogue, patterns }
    }

    fn service_matches(&self, index: usize, host: &str) -> bool {
        self.patterns.iter().any(|(i, p, re)| *i == index && matches_compiled(host, p, re.as_ref()))
    }

    pub fn service_for_host(&self, host: &str) -> Option<&Service> {
        let h = normalise_host(host);
        let mut best: Option<(usize, usize)> = None;
        for (i, p, re) in &self.patterns {
            let service = &self.catalogue.services[*i];
            if !service.enabled {
                continue;
            }
            if matches_compiled(&h, p, re.as_ref()) && best.is_none_or(|(_, len)| p.len() > len) {
                best = Some((*i, p.len()));
            }
        }
        best.map(|(i, _)| &self.catalogue.services[i])
    }

    pub fn service_for_flow(&self, host: &str, bundle_id: Option<&str>, cli_name: Option<&str>) -> Option<&Service> {
        let by_host = self.service_for_host(host)?;
        let h = normalise_host(host);
        for (i, service) in self.catalogue.services.iter().enumerate() {
            if !service.enabled {
                continue;
            }
            let owns =
                bundle_id.is_some_and(|b| service.bundle_ids.iter().any(|x| x == b)) || cli_name.is_some_and(|c| service.cli_names.iter().any(|x| x == c));
            if owns && self.service_matches(i, &h) {
                return Some(service);
            }
        }
        Some(by_host)
    }

    pub fn is_intercepted_host(&self, host: &str) -> bool {
        self.service_for_host(host).is_some()
    }

    pub fn is_known_cli(&self, name: &str) -> bool {
        self.catalogue.services.iter().any(|s| s.cli_names.iter().any(|c| c == name))
    }

    pub fn service(&self, service_id: &str) -> Option<&Service> {
        self.catalogue.services.iter().find(|s| s.service_id == service_id)
    }
}

pub fn seed_catalogue() -> Catalogue {
    let v: serde_json::Value = serde_json::from_str(crate::contract::CONTRACT_JSON).expect("embedded contract.json parses");
    serde_json::from_value(v["catalogue"].clone()).expect("embedded seed catalogue parses")
}
