#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { statefulSnapshot } from "../test/stateful.js";

const [registryTemplate, ecrTemplate] = process.argv.slice(2);
if (registryTemplate === undefined || ecrTemplate === undefined) {
  console.error("usage: stateful-snapshot.ts <VibtraRegistry.template.json> <VibtraRegistryEcr.template.json>");
  process.exit(2);
}
const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof statefulSnapshot>[0];
process.stdout.write(
  `${JSON.stringify(
    { VibtraRegistry: statefulSnapshot(read(registryTemplate)), VibtraRegistryEcr: statefulSnapshot(read(ecrTemplate)) },
    null,
    2,
  )}\n`,
);
