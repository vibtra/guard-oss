import type { Locator, Page } from "@playwright/test";
import { ConsolePolicyRequestsPage } from "@vibtra/console-api";
import { GUARD_CATALOGUE_SEED, GUARD_SERVICES_WITHOUT_MARK, type GuardEventApp } from "@vibtra/guard-contract";
import { expect, openConsole, test } from "./support/console.ts";
import { answerDoors } from "./support/doors.ts";
import { DAY, DEVICE_ID_2, GRACE, HOUR, activity, event, iso } from "./support/fixtures.ts";

const APP_MARKS: ReadonlyArray<{ app: GuardEventApp; shown: string; mark: string }> = [
  { app: { name: "Google Chrome", bundleId: "com.google.Chrome" }, shown: "Google Chrome", mark: "google-chrome" },
  { app: { name: "Safari", bundleId: "com.apple.Safari" }, shown: "Safari", mark: "safari" },
  { app: { name: "Microsoft Edge" }, shown: "Microsoft Edge", mark: "microsoft-edge" },
  { app: { name: "Firefox" }, shown: "Firefox", mark: "firefox" },
  { app: { name: "Claude", bundleId: "com.anthropic.claudefordesktop" }, shown: "Claude", mark: "claude" },
  { app: { cli: "claude" }, shown: "claude (CLI)", mark: "claude" },
  { app: { name: "Visual Studio Code", bundleId: "com.microsoft.VSCode" }, shown: "Visual Studio Code", mark: "vscode" },
  { app: { name: "Slack", bundleId: "com.tinyspeck.slackmacgap" }, shown: "Slack", mark: "slack" },
];

const UNKNOWN_APP = { name: "Some Internal Tool" } satisfies GuardEventApp;

const eventIdOf = (index: number): string => `gev_${(0xb0 + index).toString(16).padStart(16, "0")}`;

const tileIn = (scope: Locator): Locator => scope.locator("[data-slot=icon-tile]");
const cellShowing = (page: Page, text: string): Locator => page.getByRole("cell").filter({ has: page.getByText(text, { exact: true }) });
const catalogueTile = (page: Page, serviceName: string): Locator => tileIn(page.getByRole("button", { name: `${serviceName}, where it is recognised`, exact: true }));

const asksFor = (services: ReadonlyArray<{ serviceId: string; serviceName: string }>): ConsolePolicyRequestsPage =>
  ConsolePolicyRequestsPage.parse({
    requests: services.map((service, index) => ({
      id: `preq_brand_${index}`,
      orgId: "org_fernwood",
      requesterUserId: GRACE.userId,
      kind: "guard",
      subject: { ...service, deviceId: DEVICE_ID_2, hostname: "graces-air", app: "Google Chrome" },
      subjectKey: `${service.serviceId}/*@${GRACE.userId}`,
      words: `using ${service.serviceName} for a draft`,
      status: "pending",
      reminderAt: iso(7 * DAY),
      expiresAt: iso(14 * DAY),
      createdAt: iso(-(index + 1) * HOUR),
    })),
  });

test.describe("brand marks in the Guard console", () => {
  test("draws every seed service with its own mark (or the neutral globe, for the rows recorded without one)", async ({ page, seed }) => {
    await openConsole(page, seed, "/services");
    for (const { serviceId, name, markId } of GUARD_CATALOGUE_SEED) {
      const tile = catalogueTile(page, name);
      await expect(tile, serviceId).toBeEmpty();
      if (serviceId in GUARD_SERVICES_WITHOUT_MARK || markId === undefined) {
        await expect(tile, serviceId).toHaveAttribute("data-glyph", "service");
      } else {
        await expect(tile, serviceId).toHaveAttribute("data-mark", markId);
        await expect(tile.locator("svg").filter({ visible: true }), serviceId).toHaveCount(1);
      }
    }
    const custom = catalogueTile(page, "Acme AI");
    await expect(custom).toBeEmpty();
    await expect(custom).toHaveAttribute("data-glyph", "service");
  });

  test("draws browsers, editors and CLIs with their marks, and a neutral glyph for an unknown app", async ({ page, seed }) => {
    const rows = [...APP_MARKS.map(({ app }) => app), UNKNOWN_APP].map((app, index) => event({ eventId: eventIdOf(index), app }));
    await answerDoors(page, { "GET /guard/activity": { body: activity({ rows, total: rows.length, nextCursor: undefined }) } });
    await openConsole(page, seed, "/activity");
    for (const { shown, mark } of APP_MARKS) await expect(tileIn(cellShowing(page, shown)), shown).toHaveAttribute("data-mark", mark);
    await expect(tileIn(cellShowing(page, UNKNOWN_APP.name))).toHaveAttribute("data-glyph", "app");
  });

  test("gives two copies of a gradient mark distinct ids", async ({ page, seed }) => {
    const amazonQ = { serviceId: "amazon-q", serviceName: "Amazon Q Developer" };
    await answerDoors(page, { "GET /policy-requests": { body: asksFor([amazonQ, amazonQ]) } });
    await openConsole(page, seed, "/requests");
    const copies = tileIn(cellShowing(page, amazonQ.serviceName));
    await expect(copies).toHaveCount(2);
    await expect(copies.first()).toHaveAttribute("data-mark", "amazon-q");
    const gradients = copies.locator("linearGradient");
    await expect(gradients).toHaveCount(2);
    const ids = await gradients.evaluateAll((nodes) => nodes.map((node) => node.id));
    expect(new Set(ids).size).toBe(2);
  });

  test("draws a wordmark (Jasper, Otter.ai) across the tile's inner width, not in the square mark box", async ({ page, seed }) => {
    await answerDoors(page, {
      "GET /policy-requests": { body: asksFor([{ serviceId: "jasper", serviceName: "Jasper" }, { serviceId: "deepseek", serviceName: "DeepSeek" }]) },
    });
    await openConsole(page, seed, "/requests");
    const jasper = tileIn(cellShowing(page, "Jasper"));
    await expect(jasper).toHaveAttribute("data-mark", "jasper");
    await expect(jasper).toHaveAttribute("data-wide", "true");
    await expect(jasper.locator("span").first()).toHaveCSS("width", "20px");
    const deepseek = tileIn(cellShowing(page, "DeepSeek"));
    await expect(deepseek).toHaveAttribute("data-mark", "deepseek");
    await expect(deepseek).not.toHaveAttribute("data-wide");
    await expect(deepseek.locator("span").first()).toHaveCSS("width", "16px");
  });
});
