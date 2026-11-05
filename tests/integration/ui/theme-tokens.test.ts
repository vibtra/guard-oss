import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { motion } from "@vibtra/ui";
import { HUES, STEP_HUES, hueVar, stepHue } from "@vibtra/ui/react";

const themeCss = readFileSync(createRequire(import.meta.url).resolve("@vibtra/ui/theme.css"), "utf8");
const declaredNames = new Set(themeCss.match(/--[a-z0-9-]+(?=\s*:)/g) ?? []);
const declaredValue = (name: string): string | undefined => themeCss.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim();
const varName = (value: string): string => value.replace(/^var\((--[a-z0-9-]+)\)$/, "$1");
const milliseconds = (value: string | undefined): number => {
  if (value === undefined) return Number.NaN;
  if (value.endsWith("ms")) return Number(value.slice(0, -2));
  if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1000;
  return Number.NaN;
};
const kebab = (name: string): string => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

describe("step colours", () => {
  it("cycle orange, teal, pink first, and fold any index into the list", () => {
    expect([stepHue(0), stepHue(1), stepHue(2)]).toEqual(["orange", "teal", "pink"]);
    expect(stepHue(STEP_HUES.length)).toBe("orange");
    expect(stepHue(-1)).toBe(STEP_HUES[STEP_HUES.length - 1]);
    expect(stepHue(2.9)).toBe("pink");
  });

  it("name a hue step as its theme variable, 600 by default", () => {
    expect(hueVar("teal", 200)).toBe("var(--v-hue-teal-200)");
    expect(hueVar("orange")).toBe("var(--v-hue-orange-600)");
  });

  it("only name variables that the shared theme declares", () => {
    const named = [...HUES, "gray" as const].flatMap((hue) => ([200, 400, 600, 800, 1000] as const).map((step) => varName(hueVar(hue, step))));
    expect(named.filter((name) => !declaredNames.has(name))).toEqual([]);
  });
});

describe("the motion export and theme.css", () => {
  it("give every enter, exit and loop duration the same number of milliseconds", () => {
    const durations = Object.entries(motion).flatMap(([name, value]) => (typeof value === "number" && name !== "timerTick" ? [[`--v-motion-${kebab(name)}`, value] as const] : []));
    const loops = Object.entries(motion.loop).map(([name, value]) => [`--v-loop-${kebab(name)}`, value] as const);
    expect(durations.length).toBeGreaterThan(0);
    for (const [name, value] of [...durations, ...loops]) expect(milliseconds(declaredValue(name)), name).toBe(value);
  });

  it("give every motion the same easing curve", () => {
    for (const [name, value] of Object.entries(motion.ease)) expect(declaredValue(`--v-ease-${name}`), name).toBe(value);
  });
});
