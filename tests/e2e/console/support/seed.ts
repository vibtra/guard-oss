import { readFileSync } from "node:fs";
import { SEED_FILE } from "./env.ts";
import type { Account } from "./registry.ts";

export interface SeedPerson {
  name: string;
  email: string;
  userId: string;
}

export interface SeedDevice {
  hostname: string;
  deviceId: string;
  deviceToken: string;
  personEmail: string;
  serialNumber: string;
}

export interface Seed {
  handle: string;
  orgId: string;
  orgName: string;
  people: { ada: SeedPerson; grace: SeedPerson; bo: SeedPerson; dee: SeedPerson };
  accounts: { ada: Account; grace: Account; bo: Account; dee: Account };
  groups: { engineering: string; finance: string };
  rules: { version: number; deepseekBlock: string; taxFileNumbers: string };
  customServiceId: string;
  devices: { adasMbp: SeedDevice; gracesAir: SeedDevice; bosVm: SeedDevice };
  events: { adaBlocked: string; adaObserved: string; graceBlocked: string; graceObserved: string };
  requests: { pending: string; approved: string; declined: string };
  grants: { approved: string };
}

export const readSeed = (): Seed => {
  const seed: Seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  return seed;
};
