// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import { runRegistryCli } from "./cli.js";

if (process.env.REGISTRY_MODE && process.env.REGISTRY_MODE !== "hosted") throw new Error("Guard requires REGISTRY_MODE=hosted (also for self-hosting)");
process.env.REGISTRY_MODE = "hosted";

runRegistryCli().catch((err: unknown) => {
  console.error("[vibtra-registry] failed to start:", err);
  process.exit(1);
});
