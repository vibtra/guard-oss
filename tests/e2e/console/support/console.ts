import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { GUARD_CONSOLE_PATH } from "@vibtra/guard-contract";
import { MEMBER_STATE } from "./env.ts";
import { AgentClient, ConsoleClient, caFacts, deviceFacts } from "./registry.ts";
import { type Seed, type SeedDevice, readSeed } from "./seed.ts";

export { expect };

export const MEMBER = MEMBER_STATE;
export const SIGNED_OUT = { cookies: [], origins: [] };

export const test = base.extend<{ seed: Seed }>({
  seed: async ({}, use) => {
    await use(readSeed());
  },
});

export const consolePath = (seed: Seed, route = "/"): string => `/${seed.handle}${GUARD_CONSOLE_PATH}${route === "/" ? "" : route}`;

export const openConsole = async (page: Page, seed: Seed, route = "/"): Promise<void> => {
  await page.goto(consolePath(seed, route));
};

export const routeOf = (page: Page, seed: Seed): { pathname: string; search: string } => {
  const url = new URL(page.url());
  const base = consolePath(seed);
  const pathname = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
  return { pathname, search: url.search };
};

const named = (name: string | RegExp) => (typeof name === "string" ? { name, exact: true } : { name });

export const choose = async (trigger: Locator, option: string | RegExp): Promise<void> => {
  await trigger.click();
  await trigger.page().getByRole("listbox").getByRole("option", named(option)).click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger.page().getByRole("listbox")).toHaveCount(0);
};

export const optionsOf = async (trigger: Locator): Promise<string[]> => {
  await trigger.click();
  const options = trigger.page().getByRole("listbox").getByRole("option");
  await expect(options.first()).toBeVisible();
  const names = (await options.allTextContents()).map((text) => text.trim());
  await trigger.page().keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  return names;
};

export const pick = async (input: Locator, text: string, option: string | RegExp): Promise<void> => {
  await input.fill(text);
  await input.page().getByRole("listbox").getByRole("option", named(option)).click();
  await expect(input).toHaveAttribute("aria-expanded", "false");
};

export const menuItem = (page: Page, name: string | RegExp): Locator => page.getByRole("menuitem", named(name));

export const adminApi = (seed: Seed): Promise<ConsoleClient> => ConsoleClient.open(seed.accounts.ada);

export const agentFor = (device: SeedDevice): AgentClient =>
  new AgentClient(device.deviceId, device.deviceToken, deviceFacts(device.hostname, device.personEmail.split("@")[0] ?? "user"), caFacts(device.hostname));
