// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import { runRegistryCli } from "./cli.js";
import { bootLog, errorFields } from "./telemetry.js";

if (process.env.REGISTRY_MODE && process.env.REGISTRY_MODE !== "hosted") throw new Error("Guard requires REGISTRY_MODE=hosted (also for self-hosting)");
process.env.REGISTRY_MODE = "hosted";

runRegistryCli().catch((err: unknown) => {
  bootLog("fatal", "registry failed to start", { err: errorFields(err, "stack") });
  process.exit(1);
});
