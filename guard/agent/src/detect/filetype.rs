// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

use super::DetectorMatch;

pub fn detect(filenames: &[String], extensions: &[String]) -> Option<DetectorMatch> {
    let ext_of = |f: &str| -> Option<String> {
        let dot = f.rfind('.')?;
        (dot > 0).then(|| f[dot + 1..].to_lowercase())
    };
    let hit: Vec<String> = filenames.iter().filter_map(|f| ext_of(f)).filter(|e| extensions.iter().any(|w| w == e)).collect();
    if hit.is_empty() {
        return None;
    }
    let mut exts: Vec<String> = Vec::new();
    for e in &hit {
        if !exts.contains(e) {
            exts.push(e.clone());
        }
    }
    let examples = exts.iter().take(3).map(|e| format!(".{e}")).collect();
    Some(DetectorMatch::new("file-type", hit.len(), examples, Some(exts)))
}
