import { readFileSync } from "node:fs";
type Vectors = typeof import("./detectors.vectors.json", { with: { type: "json" } });

export const FIXTURE_SPLIT = "~~";

export const readFixtureJson = <T>(file: URL | string): T => JSON.parse(readFileSync(file, "utf8").replaceAll(FIXTURE_SPLIT, "")) as T;

export const vectors = readFixtureJson<Vectors>(new URL("./detectors.vectors.json", import.meta.url));
