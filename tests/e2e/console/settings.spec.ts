import type { Locator, Page } from "@playwright/test";
import { CONSOLE_API_PREFIX, ConsoleRegistrationPage } from "@vibtra/console-api";
import { GUARD_STAFF_NOTICE_TEMPLATE, GuardProtectionApplied, GuardProtectionPreview, GuardProtectionRollout, GuardSettingsPage, GuardSettingsUpdate, type GuardClientMode } from "@vibtra/guard-contract";
import { choose, consolePath, expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { type Call, type Doors, answerDoors, refused } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const NOT_OPERATOR: Doors = { "GET /registration": refused(404, "NOT_FOUND", "No operator") };

const settingsPage = (settings: Partial<GuardSettingsPage["settings"]> = {}, devices = 2): GuardSettingsPage =>
  GuardSettingsPage.parse({ ...fixtures.settings(settings), devices });

const echo = (base: GuardSettingsPage) => (call: Call) => ({
  body: GuardSettingsPage.parse({ ...base, settings: { ...base.settings, ...GuardSettingsUpdate.parse(call.body) } }),
});

const puts = (calls: Call[]): unknown[] => calls.filter((c) => c.method === "PUT").map((c) => c.body);

const settingsRow = (page: Page, title: string): Locator => page.locator("[data-slot=settings-row]").filter({ has: page.getByText(title, { exact: true }) });

const radioCard = (dialog: Locator, name: string): Locator =>
  dialog.locator("[data-slot=radio-card]").filter({ has: dialog.page().getByRole("radio", { name, exact: true }) });

const toast = (page: Page, type: "success" | "error", title: string): Locator =>
  page.locator(`[data-sonner-toast][data-type="${type}"]`).filter({ has: page.locator("[data-title]").getByText(title, { exact: true }) });

const ALLOWED = { id: "al_1", subject: "partner.example", kind: "domain", note: "Design partner", addedBy: fixtures.ADA.email, addedAt: fixtures.iso(-fixtures.DAY) } as const;

const registration = (over: Partial<ConsoleRegistrationPage> = {}): ConsoleRegistrationPage =>
  ConsoleRegistrationPage.parse({ mode: "allowlist", rows: [ALLOWED], mayManage: true, operatorDomain: "fernwood.example", contactEmail: "sam@fernwood.example", ...over });

const signupDoors = (extra: Doors): Doors => ({ "GET /guard/settings": { body: settingsPage() }, ...extra });

test.describe("the company workspace address", () => {
  test("a wrong address is marked and announced, and Save puts focus in the field without a write", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: settingsPage() } });
    await openConsole(page, seed, "/settings");
    await expect(page.getByRole("switch", { name: "Company workspace", exact: true })).toBeDisabled();
    await expect(page.getByTestId("workspace-url")).toHaveText("Not set");
    await settingsRow(page, "Workspace address").click();
    const dialog = page.getByRole("dialog", { name: "Workspace address", exact: true });
    const field = dialog.getByLabel("Where it goes", { exact: true });
    await expect(dialog.getByText("Then switch it on under Block page.", { exact: true })).toBeVisible();
    await field.fill("vibtra.example/fernwood");
    await expect(dialog.getByRole("alert")).toHaveText("Enter a full address that starts with https://");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(field).toHaveAttribute("aria-describedby", "redirect-url-error");
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await save.focus();
    await save.click();
    await expect(field).toBeFocused();
    expect(puts(calls)).toEqual([]);
  });

  test("a good address saves with the switch's current state; then the switch turns it on and off with the URL kept", async ({ page, seed }) => {
    const base = settingsPage();
    const url = "https://vibtra.example/fernwood/workspace";
    const { calls } = await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: base }, "PUT /guard/settings": echo(base) });
    await openConsole(page, seed, "/settings");
    const workspace = page.getByRole("switch", { name: "Company workspace", exact: true });
    await expect(workspace).toBeVisible();
    await settingsRow(page, "Workspace address").click();
    const dialog = page.getByRole("dialog", { name: "Workspace address", exact: true });
    await dialog.getByLabel("Where it goes", { exact: true }).fill(`  ${url} `);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => puts(calls)).toEqual([{ workspaceRedirect: { enabled: false, url } }]);
    await expect(toast(page, "success", "Saved the workspace address.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("workspace-url")).toHaveText("vibtra.example");
    await expect(page.getByTestId("workspace-url")).not.toHaveAttribute("title");

    await workspace.click();
    await expect.poll(() => puts(calls)).toEqual([{ workspaceRedirect: { enabled: false, url } }, { workspaceRedirect: { enabled: true, url } }]);
    await expect(toast(page, "success", "The block page offers the company workspace.")).toBeVisible();

    await workspace.click();
    await expect
      .poll(() => puts(calls))
      .toEqual([{ workspaceRedirect: { enabled: false, url } }, { workspaceRedirect: { enabled: true, url } }, { workspaceRedirect: { enabled: false, url } }]);
    await expect(toast(page, "success", "The block page no longer offers the company workspace.")).toBeVisible();
  });

  test("an empty address with Save pressed says what is missing and focuses the field", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      ...NOT_OPERATOR,
      "GET /guard/settings": { body: settingsPage({ workspaceRedirect: { enabled: true, url: "https://vibtra.example/x" } }) },
    });
    await openConsole(page, seed, "/settings");
    await expect(page.getByRole("switch", { name: "Company workspace", exact: true })).toBeVisible();
    await settingsRow(page, "Workspace address").click();
    const dialog = page.getByRole("dialog", { name: "Workspace address", exact: true });
    const field = dialog.getByLabel("Where it goes", { exact: true });
    await expect(field).toHaveValue("https://vibtra.example/x");
    await field.fill("");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter a full address that starts with https://");
    await expect(field).toBeFocused();
    expect(puts(calls)).toEqual([]);
  });
});

test.describe("the mode", () => {
  const PREVIEW = "/people/protection/preview";
  const APPLY = "/people/protection/apply";
  const posted = (calls: Call[], path: string): unknown[] => calls.filter((c) => c.method === "POST" && c.path === path).map((c) => c.body);
  const moved = (from: GuardClientMode, to: GuardClientMode, effect: string, summary: string): GuardProtectionPreview =>
    GuardProtectionPreview.parse({
      revision: 4,
      peopleDigest: fixtures.PROTECTION_DIGEST,
      summary,
      people: [fixtures.BO, fixtures.GRACE].map((who) => ({ ...who, from, to, effect })),
    });
  const toEnforce = moved("monitor", "enforce", "Matches will now be blocked", "The organisation default changes from Monitor to Enforce. Changes 2 people: 2 from Monitor to Enforce.");
  const modeDoors = (base: GuardSettingsPage, after: GuardSettingsPage, preview: GuardProtectionPreview, protection = fixtures.protection()): { doors: Doors; applied: () => boolean } => {
    let applied = false;
    return {
      applied: () => applied,
      doors: {
        ...NOT_OPERATOR,
        "GET /guard/settings": () => ({ body: applied ? after : base }),
        "GET /people/protection": { body: protection },
        [`POST ${PREVIEW}`]: { body: preview },
        [`POST ${APPLY}`]: () => {
          applied = true;
          return { body: GuardProtectionApplied.parse({ revision: 5, applied: 2, unchanged: 0 }) };
        },
        "GET /people/protection/rollout": { body: GuardProtectionRollout.parse({ revision: 5, applied: 0, pending: 0, people: [] }) },
      },
    };
  };

  test("the Mode row offers Off, Monitor and Enforce, and previews the effect on each person; Cancel writes nothing", async ({ page, seed }) => {
    const base = settingsPage();
    const { doors } = modeDoors(base, base, toEnforce);
    const { calls } = await answerDoors(page, doors);
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-mode")).toHaveText("Monitor");
    await settingsRow(page, "Mode").click();
    const sheet = page.getByRole("dialog", { name: "Default mode", exact: true });
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    for (const name of ["Off", "Monitor", "Enforce"]) await expect(sheet.getByRole("radio", { name, exact: true })).toBeVisible();
    await expect(sheet.getByRole("radio", { name: "Monitor", exact: true })).toBeChecked();
    await radioCard(sheet, "Enforce").click();
    await sheet.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Change the default to Enforce?", exact: true });
    await expect(dialog.getByTestId("effect-words")).toHaveText(["Matches will now be blocked"]);
    await expect(dialog.getByTestId("effect-people")).toHaveText(["Bo Tran, Grace Ho"]);
    await expect(dialog.getByTestId("preview-notice")).toContainText("Guard starts blocking for 2 people. Make sure they have had the staff notice.");
    await expect(dialog.getByTestId("preview-kept")).toContainText("1 person set to Off on their own stays off.");
    expect(posted(calls, PREVIEW)).toEqual([{ changes: [{ default: "enforce" }] }]);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(posted(calls, APPLY)).toEqual([]);
    expect(puts(calls)).toEqual([]);
  });

  test("Change the default applies exactly what was previewed, the row reads Enforce, and the danger zone appears", async ({ page, seed }) => {
    const base = settingsPage();
    const { doors } = modeDoors(base, settingsPage({ clientMode: "enforce" }), toEnforce);
    const { calls } = await answerDoors(page, doors);
    await openConsole(page, seed, "/settings");
    await expect(page.getByRole("heading", { name: "Danger zone", exact: true })).toHaveCount(0);
    await settingsRow(page, "Mode").click();
    const sheet = page.getByRole("dialog", { name: "Default mode", exact: true });
    await radioCard(sheet, "Enforce").click();
    await sheet.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByRole("dialog", { name: "Change the default to Enforce?", exact: true }).getByRole("button", { name: "Change the default", exact: true }).click();
    await expect.poll(() => posted(calls, APPLY)).toEqual([{ changes: [{ default: "enforce" }], revision: 4, peopleDigest: fixtures.PROTECTION_DIGEST }]);
    await expect(toast(page, "success", "The default is now Enforce.")).toBeVisible();
    await expect(page.getByTestId("settings-mode")).toHaveText("Enforce");
    await expect(page.getByRole("heading", { name: "Danger zone", exact: true })).toBeVisible();
    await expect(page.getByTestId("rollout")).toBeVisible();
    expect(puts(calls)).toEqual([]);
  });

  test("Off is a default too: the preview says Guard stops checking them, and the confirm is marked as dangerous", async ({ page, seed }) => {
    const base = settingsPage();
    const toOff = moved("monitor", "off", "Guard stops checking their AI traffic; nothing is recorded", "The organisation default changes from Monitor to Off. Changes 2 people: 2 from Monitor to Off.");
    const { doors } = modeDoors(base, settingsPage({ clientMode: "off" }), toOff);
    const { calls } = await answerDoors(page, doors);
    await openConsole(page, seed, "/settings");
    await settingsRow(page, "Mode").click();
    const sheet = page.getByRole("dialog", { name: "Default mode", exact: true });
    await radioCard(sheet, "Off").click();
    await sheet.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Change the default to Off?", exact: true });
    await expect(dialog.getByTestId("effect-words")).toHaveText(["Guard stops checking their AI traffic; nothing is recorded"]);
    const confirm = dialog.getByRole("button", { name: "Change the default", exact: true });
    await expect(confirm).toHaveAttribute("data-variant", "danger");
    await confirm.click();
    await expect.poll(() => posted(calls, APPLY)).toEqual([{ changes: [{ default: "off" }], revision: 4, peopleDigest: fixtures.PROTECTION_DIGEST }]);
    await expect(page.getByTestId("settings-mode")).toHaveText("Off");
  });

  test("Stop blocking changes only the default, says how many people set to Enforce keep blocking, and links to them", async ({ page, seed }) => {
    const base = settingsPage({ clientMode: "enforce" });
    const enforcing = fixtures.protection({
      defaultMode: "enforce",
      people: fixtures.protection().people.map((p) => (p.source === "default" ? { ...p, mode: "enforce" as const } : p)),
    });
    const toMonitor = moved("enforce", "monitor", "Matches will be recorded, no longer blocked", "The organisation default changes from Enforce to Monitor. Changes 2 people: 2 from Enforce to Monitor.");
    const { doors } = modeDoors(base, settingsPage(), toMonitor, enforcing);
    const { calls } = await answerDoors(page, doors);
    await openConsole(page, seed, "/settings");
    await expect(settingsRow(page, "Stop blocking for people on the default")).toContainText("People set to Enforce on their own keep blocking");
    await page.getByRole("button", { name: "Stop blocking", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Stop blocking for people on the default?", exact: true });
    await expect(dialog.getByTestId("effect-people")).toHaveText(["Bo Tran, Grace Ho"]);
    const kept = dialog.getByTestId("preview-kept").locator("li[data-mode=enforce]");
    await expect(kept).toContainText("1 person set to Enforce on their own keeps blocking.");
    await expect(kept.getByRole("link", { name: "Show them", exact: true })).toHaveAttribute("href", consolePath(seed, "/people?tab=protection&mode=enforce&source=set"));
    expect(posted(calls, PREVIEW)).toEqual([{ changes: [{ default: "monitor" }] }]);
    await dialog.getByRole("button", { name: "Stop blocking", exact: true }).click();
    await expect.poll(() => posted(calls, APPLY)).toEqual([{ changes: [{ default: "monitor" }], revision: 4, peopleDigest: fixtures.PROTECTION_DIGEST }]);
    await expect(toast(page, "success", "People on the default stop blocking now.")).toBeVisible();
    await expect(page.getByTestId("settings-mode")).toHaveText("Monitor");
    await expect(page.getByRole("heading", { name: "Danger zone", exact: true })).toHaveCount(0);
    expect(puts(calls)).toEqual([]);
  });
});

test.describe("an org that is Off by default", () => {
  test("the Mode row reads Off and says Guard records nothing", async ({ page, seed }) => {
    await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: settingsPage({ clientMode: "off" }) } });
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-mode")).toHaveText("Off");
    await expect(settingsRow(page, "Mode")).toContainText("Off passes AI traffic through without checking it and records nothing.");
    await expect(settingsRow(page, "Mode")).not.toContainText("Monitor records rule decisions.");
  });
});

test.describe("uninspectable TLS", () => {
  test("in monitor IT can allow uninspectable connections and restore blocking, and the Mode row says which", async ({ page, seed }) => {
    const base = settingsPage();
    const { calls } = await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: base }, "PUT /guard/settings": echo(base) });
    await openConsole(page, seed, "/settings");
    const select = page.getByRole("combobox", { name: "Uninspectable TLS", exact: true });
    await expect(select).toHaveText("Block");
    await expect(settingsRow(page, "Mode")).toContainText("Uninspectable TLS is currently blocked.");
    await choose(select, "Allow without inspection");
    await expect.poll(() => puts(calls)).toEqual([{ unreproducibleTls: "tunnel" }]);
    await expect(select).toHaveText("Allow without inspection");
    await expect(settingsRow(page, "Mode")).toContainText("Uninspectable TLS is currently allowed without inspection.");
    await choose(select, "Block");
    await expect.poll(() => puts(calls)).toEqual([{ unreproducibleTls: "tunnel" }, { unreproducibleTls: "block" }]);
    await expect(settingsRow(page, "Mode")).toContainText("Uninspectable TLS is currently blocked.");
  });

  test("enforce shows Block and a disabled select even with a saved monitor tunnel preference, and writes nothing", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: settingsPage({ clientMode: "enforce", unreproducibleTls: "tunnel" }) } });
    await openConsole(page, seed, "/settings");
    const select = page.getByRole("combobox", { name: "Uninspectable TLS", exact: true });
    await expect(select).toHaveText("Block");
    await expect(select).toBeDisabled();
    await expect(settingsRow(page, "Mode")).toContainText("Uninspectable TLS is currently blocked.");
    await select.click({ force: true });
    await expect(page.getByRole("listbox")).toHaveCount(0);
    expect(puts(calls)).toEqual([]);
  });

  test("the mode sheet and the stop-blocking preview name the uninspectable TLS exception", async ({ page, seed }) => {
    const preview = GuardProtectionPreview.parse({
      revision: 4,
      peopleDigest: fixtures.PROTECTION_DIGEST,
      summary: "The organisation default changes from Enforce to Monitor. Changes 1 person: 1 from Enforce to Monitor.",
      people: [{ ...fixtures.BO, from: "enforce", to: "monitor", effect: "Matches will be recorded, no longer blocked" }],
    });
    await answerDoors(page, {
      ...NOT_OPERATOR,
      "GET /guard/settings": { body: settingsPage({ clientMode: "enforce" }) },
      "GET /people/protection": { body: fixtures.protection({ defaultMode: "enforce" }) },
      "POST /people/protection/preview": { body: preview },
    });
    await openConsole(page, seed, "/settings");
    await settingsRow(page, "Mode").click();
    const mode = page.getByRole("dialog", { name: "Default mode", exact: true });
    await expect(mode).toContainText("Connections Guard can’t inspect are still blocked unless you allow them under Uninspectable TLS.");
    await mode.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Stop blocking", exact: true }).click();
    const pause = page.getByRole("dialog", { name: "Stop blocking for people on the default?", exact: true });
    await expect(pause.getByTestId("preview-kept")).toContainText("1 person set to Enforce on their own keeps blocking.");
    await expect(pause.getByTestId("preview-tls")).toHaveText("For people in Monitor, connections Guard cannot inspect are blocked (Uninspectable TLS: Block).");
  });

  test("with uninspectable connections allowed, the stop-blocking preview says they pass without inspection and asks for no staff notice", async ({ page, seed }) => {
    const preview = GuardProtectionPreview.parse({
      revision: 4,
      peopleDigest: fixtures.PROTECTION_DIGEST,
      summary: "The organisation default changes from Enforce to Monitor. Changes 1 person: 1 from Enforce to Monitor.",
      people: [{ ...fixtures.BO, from: "enforce", to: "monitor", effect: "Matches will be recorded, no longer blocked" }],
    });
    await answerDoors(page, {
      ...NOT_OPERATOR,
      "GET /guard/settings": { body: settingsPage({ clientMode: "enforce", unreproducibleTls: "tunnel" }) },
      "GET /people/protection": { body: fixtures.protection({ defaultMode: "enforce" }) },
      "POST /people/protection/preview": { body: preview },
    });
    await openConsole(page, seed, "/settings");
    await page.getByRole("button", { name: "Stop blocking", exact: true }).click();
    const pause = page.getByRole("dialog", { name: "Stop blocking for people on the default?", exact: true });
    await expect(pause.getByTestId("preview-tls")).toHaveText("For people in Monitor, connections Guard cannot inspect pass without inspection (Uninspectable TLS: Allow without inspection).");
    await expect(pause.getByTestId("preview-notice")).toHaveCount(0);
  });
});

test.describe("the other settings, one partial PUT each", () => {
  test("quiet after, Request access, redacted examples and the notice", async ({ page, seed }) => {
    const base = settingsPage();
    const { calls } = await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: base }, "PUT /guard/settings": echo(base) });
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-mode")).toBeVisible();
    await expect(page.getByTestId("settings-page").locator("select")).toHaveCount(0);
    await choose(page.getByRole("combobox", { name: "Quiet laptops", exact: true }), "8 hours");
    await expect.poll(() => puts(calls).length).toBe(1);
    await page.getByRole("switch", { name: "Request access", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(2);
    await choose(page.getByRole("combobox", { name: "Redacted examples", exact: true }), "Counts only");
    await expect.poll(() => puts(calls).length).toBe(3);
    await settingsRow(page, "Staff notice").click();
    const dialog = page.getByRole("dialog", { name: "Staff notice", exact: true });
    await expect(dialog.getByTestId("notice-not-advice")).toContainText("not legal advice");
    const template = dialog.getByLabel("Template", { exact: true });
    const save = dialog.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await template.fill("Hello {{orgName}}.");
    await expect(dialog.getByTestId("notice-preview")).toHaveText("Hello Fernwood.");
    await dialog.getByRole("button", { name: "Start from the template", exact: true }).click();
    await expect(template).toHaveValue(GUARD_STAFF_NOTICE_TEMPLATE);
    await template.fill("Hello {{orgName}}.");
    await save.click();
    await expect
      .poll(() => puts(calls))
      .toEqual([{ quietAfterMinutes: 480 }, { requestsEnabled: false }, { snippetPolicy: "none" }, { staffNotice: { template: "Hello {{orgName}}." } }]);
    await expect(dialog).toHaveCount(0);
  });

  test("an off-preset quiet time is named; a missing key and domain read as such", async ({ page, seed }) => {
    const odd = GuardSettingsPage.parse({
      ...settingsPage({ quietAfterMinutes: 90 }),
      signingKeyId: undefined,
      org: { orgId: "org_fernwood", name: "Fernwood", handle: "fernwood" },
    });
    await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: odd } });
    await openConsole(page, seed, "/settings");
    await expect(page.getByRole("combobox", { name: "Quiet laptops", exact: true })).toHaveText("2 h (set elsewhere)");
    await expect(page.getByTestId("signing-key")).toHaveText("Not made yet (made at the first enrolment)");
    await expect(settingsRow(page, "Domain")).toHaveCount(0);
    await expect(page.getByTestId("settings-page").getByText("fernwood.example", { exact: true })).toHaveCount(0);
  });

  test("a refused save says so and keeps the page as it was", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      ...NOT_OPERATOR,
      "GET /guard/settings": { body: settingsPage() },
      "PUT /guard/settings": refused(400, "VALIDATION", "No"),
    });
    await openConsole(page, seed, "/settings");
    const requests = page.getByRole("switch", { name: "Request access", exact: true });
    await expect(requests).toHaveAttribute("aria-checked", "true");
    await requests.click();
    await expect(toast(page, "error", "Request access was not saved")).toBeVisible();
    expect(puts(calls)).toEqual([{ requestsEnabled: false }]);
    await expect(requests).toHaveAttribute("aria-checked", "true");
  });

  test("no tabs are drawn: Guard has no door for console users or an audit log, and one pill would switch nothing", async ({ page, seed }) => {
    await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: settingsPage() } });
    const asked = page.waitForResponse((response) => new URL(response.url()).pathname === `${CONSOLE_API_PREFIX}/registration`);
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-mode")).toBeVisible();
    await asked;
    await expect(page.getByRole("navigation", { name: "Settings", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "General", exact: true })).toHaveCount(0);
  });

  test("a sheet lives in the address: opening pushes ?sheet=, Back closes it, and a pasted link opens it", async ({ page, seed }) => {
    await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": { body: settingsPage() } });
    await openConsole(page, seed, "/settings");
    await settingsRow(page, "Mode").click();
    const mode = page.getByRole("dialog", { name: "Default mode", exact: true });
    await expect(mode).toBeVisible();
    await expect.poll(() => routeOf(page, seed).search).toBe("?sheet=mode");
    await page.goBack();
    await expect(mode).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/settings", search: "" });
    await openConsole(page, seed, "/settings?sheet=notice");
    await expect(page.getByRole("dialog", { name: "Staff notice", exact: true })).toBeVisible();
  });

  test("a failed read shows the error", async ({ page, seed }) => {
    await answerDoors(page, { ...NOT_OPERATOR, "GET /guard/settings": refused(500, "INTERNAL", "Something went wrong") });
    await openConsole(page, seed, "/settings");
    const failed = page.locator("[data-slot=door-error]");
    await expect(failed).toContainText("Something went wrong");
    await expect(failed.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  });
});

test.describe("the Sign-ups tab", () => {
  for (const [status, code, message] of [
    [404, "NOT_FOUND", "No operator"],
    [403, "FORBIDDEN", "Only the operator"],
  ] as const) {
    test(`is not drawn when the registration door says this is not the operator (${status})`, async ({ page, seed }) => {
      await answerDoors(page, signupDoors({ "GET /registration": refused(status, code, message) }));
      const asked = page.waitForResponse((response) => new URL(response.url()).pathname === `${CONSOLE_API_PREFIX}/registration`);
      await openConsole(page, seed, "/settings?tab=signups");
      await expect(page.getByTestId("settings-page")).toBeVisible();
      expect((await asked).status()).toBe(status);
      await expect(page.getByRole("link", { name: /Sign-ups/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /General/ })).toHaveCount(0);
    });
  }

  test("shows General | Sign-ups for the operator: the mode, the operator domain, the list", async ({ page, seed }) => {
    await answerDoors(page, signupDoors({ "GET /registration": { body: registration() } }));
    await openConsole(page, seed, "/settings");
    await expect(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Sign-ups", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=signups");
    const signups = page.getByTestId("signups-page");
    await expect(signups.getByTestId("signups-mode")).toHaveText("Invite only");
    await expect(signups.getByTestId("signups-operator")).toHaveText("fernwood.example");
    await expect(signups).toContainText("sam@fernwood.example");
    const row = signups.getByRole("row").filter({ hasText: "partner.example" });
    await expect(row).toContainText("Domain");
    await expect(row).toContainText("Design partner");
    await expect(row).toContainText(fixtures.ADA.email);
  });

  test("Add says how it reads what was typed, and posts it; a refusal stays in the sheet", async ({ page, seed }) => {
    const after = registration({ rows: [ALLOWED, { id: "al_2", subject: "lee@else.example", kind: "email", addedBy: fixtures.ADA.email, addedAt: fixtures.iso(0) }] });
    let first = true;
    const { calls } = await answerDoors(
      page,
      signupDoors({
        "GET /registration": { body: registration() },
        "POST /registration/allowlist": () => {
          if (first) {
            first = false;
            return refused(403, "FORBIDDEN", "partner.example is already on the sign-up list");
          }
          return { body: after };
        },
      }),
    );
    await openConsole(page, seed, "/settings?tab=signups");
    await page.getByTestId("allowlist-add-open").click();
    const form = page.getByTestId("allowlist-add");
    const field = form.getByLabel("Email address or domain", { exact: true });
    const add = page.getByRole("dialog", { name: "Allow sign-ups", exact: true }).getByRole("button", { name: "Add to the list", exact: true });
    await add.click();
    await expect(form.getByRole("alert")).toHaveText("Enter an email address or a domain.");
    await field.fill("Partner.Example");
    await expect(form).toContainText("Anyone with an address at partner.example can sign up. Subdomains are not included.");
    await add.click();
    await expect(form.getByRole("alert")).toContainText("partner.example is already on the sign-up list");
    await field.fill("lee@else.example");
    await expect(form).toContainText("Only lee@else.example can sign up.");
    await add.click();
    await expect(toast(page, "success", "lee@else.example can sign up now.")).toBeVisible();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ subject: "Partner.Example" }, { subject: "lee@else.example" }]);
    await expect(page.getByTestId("signups-page").getByText("lee@else.example", { exact: true })).toBeVisible();
  });

  test("Remove asks first, then DELETEs the row", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      signupDoors({ "GET /registration": { body: registration() }, "DELETE /registration/allowlist/al_1": { body: registration({ rows: [] }) } }),
    );
    await openConsole(page, seed, "/settings?tab=signups");
    await page.getByRole("button", { name: "Actions for partner.example", exact: true }).click();
    await menuItem(page, "Remove from the list").click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Remove partner.example from the list?", { exact: true })).toBeVisible();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Nobody is on the list", { exact: true })).toBeVisible();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/registration/allowlist/al_1")).toBe(true);
  });

  test("the waitlist admits through its door", async ({ page, seed }) => {
    const waiting = { orgId: "org_wait", name: "Kestrel", createdAt: fixtures.iso(-2 * fixtures.DAY) };
    const { calls } = await answerDoors(
      page,
      signupDoors({
        "GET /registration": { body: registration({ waitlist: [waiting] }) },
        "POST /registration/waitlist/org_wait/admit": { body: registration({ waitlist: [] }) },
      }),
    );
    await openConsole(page, seed, "/settings?tab=signups");
    await page.getByRole("button", { name: "Admit Kestrel", exact: true }).click();
    await expect(page.getByText("Nobody is waiting", { exact: true })).toBeVisible();
    expect(calls.some((c) => c.method === "POST" && c.path === "/registration/waitlist/org_wait/admit")).toBe(true);
    await expect(toast(page, "success", "Kestrel was admitted.")).toBeVisible();
  });

  test("an admin of the operator reads the list but gets no Add, no ⋮ and no Admit", async ({ page, seed }) => {
    await answerDoors(
      page,
      signupDoors({ "GET /registration": { body: registration({ mayManage: false, waitlist: [{ orgId: "org_wait", name: "Kestrel", createdAt: fixtures.iso(0) }] }) } }),
    );
    await openConsole(page, seed, "/settings?tab=signups");
    const signups = page.getByTestId("signups-page");
    await expect(signups).toContainText("Only an owner can change who may sign up.");
    await expect(signups.getByRole("row").filter({ hasText: "partner.example" })).toBeVisible();
    await expect(signups.getByText("Kestrel", { exact: true })).toBeVisible();
    await expect(page.getByTestId("allowlist-add-open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Actions for partner.example" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Admit Kestrel" })).toHaveCount(0);
  });
});

test.describe("the real registry", () => {
  test("the Settings page shows the seeded org's monitor mode", async ({ page, seed }) => {
    await openConsole(page, seed, "/settings");
    const mode = page.getByTestId("settings-mode");
    await expect(mode).toHaveText("Monitor");
    await expect(mode).toHaveAttribute("data-mode", "monitor");
    await expect(settingsRow(page, "Name")).toContainText(seed.orgName);
    await expect(page.getByTestId("signing-key")).toHaveText(/^gk_[0-9a-f]{8,16}$/);
  });
});
