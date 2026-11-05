import type { Locator, Page } from "@playwright/test";
import { GuardActivityPage, GuardDevicesPage, GuardEnrolLinksPage } from "@vibtra/guard-contract";
import { choose, expect, menuItem, openConsole, pick, routeOf, test } from "./support/console.ts";
import { answerDoors, refused, type Doors } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const opener = (page: Page, name: string | RegExp): Locator =>
  page.getByRole("button", typeof name === "string" ? { name, exact: true } : { name });
const rowOf = (page: Page, name: string | RegExp): Locator => page.getByRole("row").filter({ has: opener(page, name) });
const actionsOf = (row: Locator): Locator => row.getByRole("button", { name: /^Actions for/ });
const toast = (page: Page, kind: "success" | "error", words: string): Locator =>
  page.locator(`[data-sonner-toast][data-type="${kind}"]`).filter({ hasText: words });

const fleet = (extra: Doors = {}): Doors => ({
  "GET /guard/devices": { body: fixtures.devices() },
  "GET /guard/devices/enrol-links": { body: fixtures.enrolLinks() },
  ...extra,
});

test.describe("Devices", () => {
  test("draws the stats, the status pills and quiet, and a row opens the 800 sheet at ?device= with that laptop's activity", async ({ page, seed }) => {
    const graces = GuardActivityPage.parse({ rows: [fixtures.event({ deviceId: fixtures.DEVICE_ID_2, hostname: "graces-air", person: fixtures.GRACE })] });
    const { calls } = await answerDoors(
      page,
      fleet({
        "GET /guard/overview": { body: fixtures.overview() },
        "GET /guard/activity": (call) => ({ body: call.query.get("deviceId") === fixtures.DEVICE_ID_2 ? graces : GuardActivityPage.parse({ rows: [] }) }),
      }),
    );
    await openConsole(page, seed, "/devices");
    const grace = rowOf(page, /^graces-air/);
    await expect(grace.getByTestId("device-status")).toHaveText("Quiet");
    await expect(grace.getByTestId("quiet-pill")).toHaveText("Quiet for 30 h");
    await expect(rowOf(page, /^adas-mbp/).getByTestId("device-status")).toHaveText("Monitoring");
    const stats = page.getByLabel("Device totals", { exact: true });
    await expect(stats).toHaveText(/Open enrol links1$/);
    await expect(stats).toContainText(`Would have blocked this week${fixtures.overview().totals.blocked}`);
    await expect(stats).toContainText("Devices2");
    await expect(stats).toContainText("Quiet1");

    await opener(page, /^graces-air/).click();
    const sheet = page.getByTestId("device-sheet");
    await expect(sheet.getByTestId("sheet-event")).toHaveCount(1);
    await expect.poll(() => routeOf(page, seed).search).toBe(`?device=${fixtures.DEVICE_ID_2}`);
    const dialog = page.getByRole("dialog");
    await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(800);
    const asked = calls.filter((c) => c.path === "/guard/activity");
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.map((c) => c.query.get("deviceId"))).toEqual(asked.map(() => fixtures.DEVICE_ID_2));
    await dialog.getByRole("tab", { name: "AI usage", exact: true }).click();
    await expect(page.getByTestId("usage-row")).toContainText("ChatGPT");
    await dialog.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByTestId("ca-trusted")).toHaveAttribute("data-trusted", "false");
  });

  test("the enrol sheet shows the link and the command once", async ({ page, seed }) => {
    const link = fixtures.enrolLink();
    const { calls } = await answerDoors(page, fleet({ "GET /people": { body: fixtures.people() }, "POST /guard/devices/enrol-links": { body: link } }));
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    const sheet = page.getByTestId("enrol-dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("select")).toHaveCount(0);
    await pick(sheet.getByRole("combobox", { name: "Person", exact: true }), "grace", /Grace Ho/);
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    const minted = page.getByTestId("enrol-minted");
    await expect(minted).toContainText(fixtures.FAKE_ENROL_TOKEN);
    await expect(minted.getByRole("group", { name: "Enrol command", exact: true })).toContainText(link.command);
    await expect(minted.getByRole("group", { name: "Enrol link", exact: true })).toContainText(link.url);
    await expect(minted.getByTestId("enrol-once")).toContainText("This will not be shown again");
    expect(calls.find((c) => c.method === "POST" && c.path === "/guard/devices/enrol-links")?.body).toEqual({ personEmail: fixtures.GRACE.email, expiresInHours: 24 });

    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(minted).toHaveCount(0);
    await page.getByTestId("enrol-open").click();
    await expect(page.getByTestId("enrol-dialog")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(fixtures.FAKE_ENROL_TOKEN);
  });
});

test.describe("Devices: revoke, links, validation, empty", () => {
  test("Revoke asks first, POSTs the revoke, says so, and re-reads the page; a revoked laptop offers no Revoke and sorts last", async ({ page, seed }) => {
    const revokedRow = fixtures.deviceRow({ status: "revoked", revokedAt: fixtures.iso(), revokedBy: fixtures.ADA.email });
    const revokedPage = GuardDevicesPage.parse({
      ...fixtures.devices(),
      rows: fixtures.devices().rows.map((row) => (row.deviceId === fixtures.DEVICE_ID ? revokedRow : row)),
    });
    let revoked = false;
    const { calls } = await answerDoors(
      page,
      fleet({
        "GET /guard/devices": () => ({ body: revoked ? revokedPage : fixtures.devices() }),
        [`POST /guard/devices/${fixtures.DEVICE_ID}/revoke`]: () => {
          revoked = true;
          return { body: revokedRow };
        },
      }),
    );
    await openConsole(page, seed, "/devices");
    const ada = rowOf(page, /^adas-mbp/);
    await actionsOf(ada).click();
    await menuItem(page, "Revoke…").click();
    await page.getByRole("alertdialog", { name: "Revoke adas-mbp?" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await actionsOf(ada).click();
    await menuItem(page, "Revoke…").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke laptop", exact: true }).click();
    await expect.poll(() => calls.some((c) => c.method === "POST" && c.path === `/guard/devices/${fixtures.DEVICE_ID}/revoke`)).toBe(true);
    await expect(toast(page, "success", "adas-mbp is revoked").locator("[data-title]")).toHaveText("adas-mbp is revoked: it can no longer sync.");
    const statuses = page.getByTestId("device-status");
    await expect(statuses.last()).toHaveAttribute("data-state", "revoked");
    await expect(statuses.last()).toHaveText("Revoked");
    await actionsOf(page.getByRole("row").filter({ has: page.getByTestId("device-status") }).last()).click();
    await expect(menuItem(page, "Copy device ID")).toBeVisible();
    await expect(menuItem(page, "Revoke…")).toHaveCount(0);
  });

  test("a refused revoke says so", async ({ page, seed }) => {
    await answerDoors(page, fleet({ [`POST /guard/devices/${fixtures.DEVICE_ID}/revoke`]: refused(404, "NOT_FOUND", "No such device") }));
    await openConsole(page, seed, "/devices");
    await actionsOf(rowOf(page, /^adas-mbp/)).click();
    await menuItem(page, "Revoke…").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Revoke laptop", exact: true }).click();
    const failure = toast(page, "error", "adas-mbp was not revoked");
    await expect(failure.locator("[data-title]")).toHaveText("adas-mbp was not revoked");
    await expect(failure.locator("[data-description]")).toHaveText("No such device. Try again.");
  });

  test("the Enrol links view reads Open, Expired or Used, with the device that used it", async ({ page, seed }) => {
    const links = GuardEnrolLinksPage.parse({
      rows: [
        { tokenPrefix: "11111111", personEmail: fixtures.GRACE.email, createdBy: fixtures.ADA.email, createdAt: "2099-01-01T00:00:00.000Z", expiresAt: "2099-01-02T00:00:00.000Z", note: "Grace's Air" },
        { tokenPrefix: "22222222", personEmail: fixtures.GRACE.email, createdBy: fixtures.ADA.email, createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-02T00:00:00.000Z" },
        {
          tokenPrefix: "33333333",
          personEmail: fixtures.ADA.email,
          createdBy: fixtures.ADA.email,
          createdAt: "2026-10-15T00:00:00.000Z",
          expiresAt: "2026-10-16T00:00:00.000Z",
          usedAt: "2026-10-15T01:00:00.000Z",
          usedByDevice: fixtures.DEVICE_ID,
        },
      ],
    });
    await answerDoors(page, fleet({ "GET /guard/devices/enrol-links": { body: links } }));
    await openConsole(page, seed, "/devices");
    await page.getByRole("tab", { name: "Enrol links", exact: true }).click();
    const section = page.getByTestId("enrol-links");
    const line = (prefix: string): Locator => section.getByRole("row").filter({ has: page.getByText(`${prefix}…`, { exact: true }) });
    await expect(line("11111111").getByTestId("link-state")).toHaveText("Open");
    await expect(line("11111111")).toContainText("Grace's Air");
    await expect(line("22222222").getByTestId("link-state")).toHaveText("Expired");
    await expect(line("33333333").getByTestId("link-state")).toHaveText("Used");
    await expect(line("33333333")).toContainText(fixtures.DEVICE_ID);
  });

  test("the enrol sheet refuses an empty person: the field is marked, described and focused, nothing is sent", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, fleet({ "GET /people": { body: fixtures.people() }, "POST /guard/devices/enrol-links": { body: fixtures.enrolLink() } }));
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    const sheet = page.getByTestId("enrol-dialog");
    const person = sheet.getByRole("combobox", { name: "Person", exact: true });
    await expect(person).toBeVisible();
    const create = page.getByRole("button", { name: "Create link", exact: true });
    await create.click();
    await expect(sheet.getByRole("alert")).toHaveText("Choose the person whose laptop this is.");
    await expect(person).toHaveAttribute("aria-invalid", "true");
    await expect(person).toHaveAttribute("aria-describedby", "enrol-person-error");
    await expect(person).toBeFocused();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await pick(person, "grace", /Grace Ho/);
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await choose(sheet.getByRole("combobox", { name: "The link works for", exact: true }), "7 days");
    await sheet.getByLabel("Note", { exact: true }).fill("  Grace's Air ");
    const command = page.getByRole("radio", { name: /^Run a command/ });
    await page.locator("[data-slot=radio-card]").filter({ has: command }).click();
    await expect(command).toBeChecked();
    await create.click();
    const minted = page.getByTestId("enrol-minted");
    await expect(minted.getByRole("group").first()).toHaveAttribute("aria-label", "Enrol command");
    expect(calls.find((c) => c.method === "POST" && c.path === "/guard/devices/enrol-links")?.body).toEqual({
      personEmail: fixtures.GRACE.email,
      expiresInHours: 168,
      note: "Grace's Air",
    });
  });

  test("with no people list the person is typed; ?enrol=1 opens the sheet; a refused mint says so; Cancel closes", async ({ page, seed }) => {
    await answerDoors(page, fleet({ "GET /people": refused(403, "admin_only", "No"), "POST /guard/devices/enrol-links": refused(400, "VALIDATION", "Not a member") }));
    await openConsole(page, seed, "/devices?enrol=1");
    const dialog = page.getByRole("dialog", { name: "Enrol a laptop" });
    const person = dialog.getByRole("textbox", { name: "Person", exact: true });
    await expect(person).toHaveAttribute("type", "text");
    await expect(person).toHaveAttribute("inputmode", "email");
    await expect(person).toHaveAttribute("autocomplete", "email");
    const create = dialog.getByRole("button", { name: "Create link", exact: true });
    await create.click();
    await expect(person).toHaveAttribute("aria-invalid", "true");
    await person.fill(" Visitor@Example.Test ");
    await create.click();
    const failure = toast(page, "error", "No enrol link was made for");
    await expect(failure.locator("[data-title]")).toHaveText("No enrol link was made for visitor@example.test");
    await expect(failure.locator("[data-description]")).toHaveText("Not a member. Try again.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed).search).toBe("");
  });

  test("no laptop yet and no links yet: the empty states say what to do", async ({ page, seed }) => {
    await answerDoors(
      page,
      fleet({
        "GET /guard/devices": { body: GuardDevicesPage.parse({ ...fixtures.devices(), rows: [] }) },
        "GET /guard/devices/enrol-links": { body: GuardEnrolLinksPage.parse({ rows: [] }) },
      }),
    );
    await openConsole(page, seed, "/devices");
    await expect(page.getByTestId("devices-empty")).toContainText("No laptop enrolled yet");
    await page.getByRole("tab", { name: "Enrol links", exact: true }).click();
    await expect(page.getByText("No enrol links yet", { exact: true })).toBeVisible();
    await expect(page.getByTestId("enrol-open")).toBeVisible();
  });

  test("a failed links read shows its own error in its view; a failed devices read shows the error and no table", async ({ page, seed }) => {
    await answerDoors(page, fleet({ "GET /guard/devices/enrol-links": refused(500, "INTERNAL", "Something went wrong") }));
    await openConsole(page, seed, "/devices");
    await expect(opener(page, /^adas-mbp/)).toBeVisible();
    await page.getByRole("tab", { name: "Enrol links", exact: true }).click();
    const links = page.getByTestId("enrol-links");
    await expect(links).toContainText("Something went wrong");
    await expect(links.getByRole("button", { name: "Try again", exact: true })).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await answerDoors(page, fleet({ "GET /guard/devices": refused(500, "INTERNAL", "Something went wrong") }));
    await openConsole(page, seed, "/devices");
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    await expect(page.getByRole("table", { name: "Devices", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("enrol-open")).toBeVisible();
  });

  test("search and the status filter narrow the table", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await expect(opener(page, /^adas-mbp/)).toBeVisible();
    const search = page.getByRole("searchbox", { name: "Search devices…", exact: true });
    await search.fill("grace");
    await expect(opener(page, /^graces-air/)).toBeVisible();
    await expect(opener(page, /^adas-mbp/)).toHaveCount(0);
    await search.fill("nobody");
    await expect(page.getByText("No devices match “nobody”", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(opener(page, /^adas-mbp/)).toBeVisible();

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await menuItem(page, "Status").hover();
    await page.getByRole("menuitemcheckbox", { name: "Quiet", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Filter, 1 selected", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(opener(page, /^graces-air/)).toBeVisible();
    await expect(opener(page, /^adas-mbp/)).toHaveCount(0);
  });
});

test.describe("Devices on the seeded registry", () => {
  test("adas-mbp and graces-air are listed with their person, status, group and CA trust", async ({ page, seed }) => {
    await openConsole(page, seed, "/devices");
    const ada = rowOf(page, "adas-mbp, details");
    const grace = rowOf(page, "graces-air, details");
    await expect(ada).toContainText("Ada Park");
    await expect(ada.getByTestId("device-status")).toHaveText("Monitoring");
    await expect(grace).toContainText("Grace Ho");
    await expect(grace).toContainText("Finance");
    await expect(grace.getByTestId("device-status")).toHaveText("Monitoring");

    await opener(page, "graces-air, details").click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?device=${seed.devices.gracesAir.deviceId}`);
    const dialog = page.getByRole("dialog");
    await expect(page.getByTestId("sheet-event").filter({ hasText: "Claude" }).first()).toBeVisible();
    await dialog.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByTestId("ca-trusted")).toHaveAttribute("data-trusted", "false");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    await opener(page, "adas-mbp, details").click();
    await dialog.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByTestId("ca-trusted")).toHaveAttribute("data-trusted", "true");
  });

  test("a real enrol link for Dee shows its token once", async ({ page, seed }) => {
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    await pick(page.getByTestId("enrol-dialog").getByRole("combobox", { name: "Person", exact: true }), "dee", /Dee Shah/);
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    const minted = page.getByTestId("enrol-minted");
    await expect(minted.getByRole("group", { name: "Enrol link", exact: true })).toContainText(/vibtra-guard:\/\/enrol\?server=\S+&token=genr_[0-9a-f]{32}/);
    await expect(minted.getByRole("group", { name: "Enrol command", exact: true })).toContainText(/vibtra-guard enrol --server \S+ --token genr_[0-9a-f]{32}/);
    await expect(minted.getByTestId("enrol-once")).toContainText(`enrol a laptop as ${seed.people.dee.email}`);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(minted).toHaveCount(0);
    await page.getByTestId("enrol-open").click();
    await expect(page.getByTestId("enrol-dialog")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/genr_[0-9a-f]{32}/);
  });
});
