#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepository } from "./lib/ee-boundary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { violations, files } = scanRepository(root);
for (const v of violations) console.error(`  - ${v.file} (${v.from}) imports ${v.spec} (${v.to})`);
if (violations.length > 0) {
  console.error(`[boundary] FAILED — ${violations.length} import(s) cross the licence line`);
  process.exit(1);
}
console.log(`[boundary] PASSED — ${files} source files, 0 core→ee and 0 apache→core/ee imports`);
