import type { Locator, Page } from "@playwright/test";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import { GuardRulesUpdate, GuardServiceRow, GuardServiceUpdate, GuardServicesPage } from "@vibtra/guard-contract";
import { choose, expect, menuItem, openConsole, test } from "./support/console.ts";
import { type Call, type Doors, answerDoors, refused } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const SIDE: Doors = { "GET /guard/rules": { body: fixtures.rulesPage() } };

const rowWith = (services: GuardServicesPage, serviceId: string): GuardServiceRow => {
  const row = services.rows.find((r) => r.serviceId === serviceId);
  if (row === undefined) throw new Error(`the services fixture has no ${serviceId}`);
  return row;
};

const custom = (): GuardServiceRow => {
  const row = fixtures.services().rows.find((r) => r.custom);
  if (row === undefined) throw new Error("the services fixture has no custom row");
  return row;
};

const serviceRows = (page: Page): Locator => page.locator("tr", { has: page.getByTestId("service-name") });

const rowNamed = (page: Page, name: string): Locator =>
  serviceRows(page).filter({ has: page.getByTestId("service-name").getByText(name, { exact: true }) });

const formSheet = (page: Page): Locator => page.locator("[data-slot=form-sheet]");

const openMenu = (page: Page, name: string): Promise<void> =>
  rowNamed(page, name).getByRole("button", { name: `Actions for ${name}`, exact: true }).click();

const toast = (page: Page, type: "success" | "error", title: string): Locator =>
  page.locator(`[data-sonner-toast][data-type="${type}"]`).filter({ has: page.locator("[data-title]").getByText(title, { exact: true }) });

const callsTo = (calls: Call[], method: string, path: string): Call[] => calls.filter((c) => c.method === method && c.path === path);

const optionIn = async (trigger: Locator, name: string): Promise<Locator> => {
  await trigger.click();
  const option = trigger.page().getByRole("listbox").getByRole("option", { name, exact: true });
  await expect(option).toBeVisible();
  return option;
};

test.describe("Add a service", () => {
  test("refuses an empty form: every failing field is marked and described, the first is focused, nothing is sent", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...SIDE, "GET /guard/services": { body: fixtures.services() } });
    await openConsole(page, seed, "/services");
    await page.getByTestId("add-service").click();
    const sheet = formSheet(page);
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Add service", exact: true }).click();
    const said: Record<string, string> = {
      "svc-name": "Give the service a name.",
      "svc-slug": "Use lowercase letters, digits and hyphens for the ID.",
      "svc-vendor": "Name the vendor.",
      "svc-domains": "Add at least one domain, one per line.",
    };
    await expect(sheet.getByRole("alert")).toHaveCount(Object.keys(said).length);
    for (const [id, words] of Object.entries(said)) {
      const field = page.locator(`#${id}`);
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveAttribute("aria-describedby", `${id}-error`);
      await expect(page.locator(`#${id}-error`)).toHaveText(words);
    }
    await expect(sheet.getByText(/String must|Array must|Invalid/)).toHaveCount(0);
    await expect(page.locator("#svc-problem")).toHaveCount(0);
    await expect(page.locator("#svc-category")).not.toHaveAttribute("aria-invalid");
    await expect(page.locator("#svc-name")).toBeFocused();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("submits the trimmed, de-duplicated row and re-reads the page; a fixed field clears its mark", async ({ page, seed }) => {
    const created = GuardServiceRow.parse({ ...custom(), serviceId: "custom-acme-assistant", name: "Acme Assistant" });
    const { calls } = await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": { body: fixtures.services() },
      "POST /guard/services": { status: 201, body: created },
    });
    await openConsole(page, seed, "/services");
    await page.getByTestId("add-service").click();
    const sheet = formSheet(page);
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("Name", { exact: true }).fill("  Acme Assistant ");
    await sheet.getByRole("button", { name: "Add service", exact: true }).click();
    await expect(page.locator("#svc-slug")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#svc-name")).not.toHaveAttribute("aria-invalid");
    await sheet.getByLabel("ID", { exact: true }).fill("Acme-Assistant");
    await sheet.getByLabel("Vendor", { exact: true }).fill("Acme");
    await choose(sheet.getByRole("combobox", { name: "Category", exact: true }), "Coding");
    await sheet.getByLabel("Domains, one per line", { exact: true }).fill("Assistant.Acme.example\n\n*.acme-ai.example, Assistant.Acme.example");
    await sheet.getByLabel("Mac app bundle IDs", { exact: true }).fill("com.example.assistant");
    await sheet.getByLabel("CLI names", { exact: true }).fill("acme, acme");
    await sheet.getByRole("button", { name: "Add service", exact: true }).click();
    await expect.poll(() => callsTo(calls, "POST", "/guard/services").map((c) => c.body)).toEqual([
      {
        slug: "acme-assistant",
        name: "Acme Assistant",
        vendor: "Acme",
        category: "coding",
        domains: ["assistant.acme.example", "*.acme-ai.example"],
        bundleIds: ["com.example.assistant"],
        cliNames: ["acme"],
      },
    ]);
    await expect(formSheet(page)).toHaveCount(0);
    await expect(toast(page, "success", "Acme Assistant is in the catalogue. Laptops start recognising it at their next check-in.")).toBeVisible();
    await expect.poll(() => callsTo(calls, "GET", "/guard/services").length).toBe(2);
  });

  test("a refused add keeps the dialog open and says so; Cancel closes it without a write", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": { body: fixtures.services() },
      "POST /guard/services": refused(409, "CONFLICT", "That id is taken"),
    });
    await openConsole(page, seed, "/services");
    await page.getByTestId("add-service").click();
    const sheet = formSheet(page);
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("Name", { exact: true }).fill("Acme");
    await sheet.getByLabel("ID", { exact: true }).fill("acme-ai");
    await sheet.getByLabel("Vendor", { exact: true }).fill("Acme");
    await sheet.getByLabel("Domains, one per line", { exact: true }).fill("ai.acme.example");
    await sheet.getByRole("button", { name: "Add service", exact: true }).click();
    await expect(toast(page, "error", "Acme was not added")).toBeVisible();
    await expect(sheet).toBeVisible();
    await expect(page.locator("#svc-problem")).toHaveText("That id is taken. Try again.");
    const posts = callsTo(calls, "POST", "/guard/services").length;
    expect(posts).toBe(1);
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(formSheet(page)).toHaveCount(0);
    expect(callsTo(calls, "POST", "/guard/services")).toHaveLength(posts);
  });
});

test.describe("Delete and the default action", () => {
  test("Delete asks first; Cancel sends nothing; Delete service sends DELETE and draws the answer", async ({ page, seed }) => {
    const row = custom();
    const listed = fixtures.services();
    const after = GuardServicesPage.parse({ ...listed, rows: listed.rows.filter((r) => !r.custom) });
    const { calls } = await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": { body: listed },
      [`DELETE /guard/services/${row.serviceId}`]: { body: after },
    });
    await openConsole(page, seed, "/services");
    await openMenu(page, row.name);
    await menuItem(page, "Delete…").click();
    const panel = page.getByRole("alertdialog", { name: `Delete ${row.name}?`, exact: true });
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    await openMenu(page, row.name);
    await menuItem(page, "Delete…").click();
    await panel.getByRole("button", { name: "Delete service", exact: true }).click();
    await expect.poll(() => callsTo(calls, "DELETE", `/guard/services/${row.serviceId}`).length).toBe(1);
    await expect(rowNamed(page, row.name)).toHaveCount(0);
    await expect(toast(page, "success", `${row.name} left the catalogue.`)).toBeVisible();
  });

  test("a refused delete names the row and keeps it", async ({ page, seed }) => {
    const row = custom();
    await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": { body: fixtures.services() },
      [`DELETE /guard/services/${row.serviceId}`]: refused(409, "CONFLICT", "A rule names it"),
    });
    await openConsole(page, seed, "/services");
    await openMenu(page, row.name);
    await menuItem(page, "Delete…").click();
    await page.getByRole("alertdialog", { name: `Delete ${row.name}?`, exact: true }).getByRole("button", { name: "Delete service", exact: true }).click();
    await expect(toast(page, "error", `${row.name} was not deleted`)).toBeVisible();
    await expect(rowNamed(page, row.name)).toBeVisible();
  });

  test("a default is PUT as {defaultAction}; Inherit restores the seed's own default, and is disabled when there is none", async ({ page, seed }) => {
    const listed = fixtures.services();
    const seeded = GuardServiceRow.parse({ ...rowWith(listed, "openai-chatgpt"), defaultAction: "block", seedDefaultAction: "ask" });
    const plain = rowWith(listed, "openai-api");
    let body = GuardServicesPage.parse({ ...listed, rows: listed.rows.map((r) => (r.serviceId === seeded.serviceId ? seeded : r)) });
    const write = (row: GuardServiceRow) => (call: Call) => {
      const next = GuardServiceRow.parse({ ...row, ...GuardServiceUpdate.parse(call.body) });
      body = GuardServicesPage.parse({ ...body, rows: body.rows.map((r) => (r.serviceId === next.serviceId ? next : r)) });
      return { body: next };
    };
    const { calls } = await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": () => ({ body }),
      [`PUT /guard/services/${seeded.serviceId}`]: write(seeded),
      [`PUT /guard/services/${plain.serviceId}`]: write(plain),
    });
    await openConsole(page, seed, "/services");
    const plainSelect = page.getByRole("combobox", { name: `Default for ${plain.name}`, exact: true });
    await expect(plainSelect).toHaveText("Inherit");
    await choose(plainSelect, "Ask IT");
    await expect.poll(() => callsTo(calls, "PUT", `/guard/services/${plain.serviceId}`).map((c) => c.body)).toEqual([{ defaultAction: "ask" }]);

    const seededSelect = page.getByRole("combobox", { name: `Default for ${seeded.name}`, exact: true });
    await expect(seededSelect).toHaveText("Block");
    const inherit = await optionIn(seededSelect, "Inherit");
    await expect(inherit).not.toHaveAttribute("aria-disabled", "true");
    await inherit.click();
    await expect(seededSelect).toHaveAttribute("aria-expanded", "false");
    await expect.poll(() => callsTo(calls, "PUT", `/guard/services/${seeded.serviceId}`).map((c) => c.body)).toEqual([{ defaultAction: "ask" }]);
  });

  test("an override with no seed default cannot go back to Inherit (the contract gap): the option is disabled and a change sends nothing", async ({ page, seed }) => {
    const row = custom();
    const { calls } = await answerDoors(page, { ...SIDE, "GET /guard/services": { body: fixtures.services() } });
    await openConsole(page, seed, "/services");
    const select = page.getByRole("combobox", { name: `Default for ${row.name}`, exact: true });
    await expect(select).toHaveText("Block");
    const inherit = await optionIn(select, "Inherit");
    await expect(inherit).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(select).toHaveAttribute("aria-expanded", "false");
    await expect(select).toHaveText("Block");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("a refused switch names the row", async ({ page, seed }) => {
    const listed = fixtures.services();
    const first = rowWith(listed, "openai-chatgpt");
    await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": { body: listed },
      [`PUT /guard/services/${first.serviceId}`]: refused(400, "VALIDATION", "No"),
    });
    await openConsole(page, seed, "/services");
    await expect(serviceRows(page)).toHaveCount(listed.rows.length);
    const toggle = serviceRows(page).first().getByRole("switch");
    await expect(toggle).toHaveAccessibleName(`${first.name} on`);
    await toggle.click();
    await expect(toast(page, "error", `${first.name} was not changed`)).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });
});

test.describe("search and states", () => {
  test("search matches a domain, an app or a CLI; a miss names the search and Clear search brings everything back", async ({ page, seed }) => {
    const base = fixtures.services();
    const listed = GuardServicesPage.parse({ ...base, rows: base.rows.map((r) => (r.custom ? { ...r, cliNames: [...r.cliNames, "acmectl"] } : r)) });
    await answerDoors(page, { ...SIDE, "GET /guard/services": { body: listed } });
    await openConsole(page, seed, "/services");
    await expect(serviceRows(page)).toHaveCount(listed.rows.length);
    const search = page.getByPlaceholder("Search by name, vendor, domain, app or CLI");
    for (const [words, name] of [
      ["AI.ACME.EXAMPLE", "Acme AI"],
      ["com.openai.chat", "ChatGPT"],
      ["ACMECTL", "Acme AI"],
    ] as const) {
      await search.fill(words);
      await expect(serviceRows(page)).toHaveCount(1);
      await expect(rowNamed(page, name)).toBeVisible();
    }
    await search.fill("no-such-service-anywhere");
    await expect(page.getByText("No service matches “no-such-service-anywhere”")).toBeVisible();
    await expect(serviceRows(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect(serviceRows(page)).toHaveCount(listed.rows.length);
    await expect(search).toHaveValue("");
  });

  test("⋮ View details lists every domain, app and CLI in the centred list modal", async ({ page, seed }) => {
    const base = fixtures.services();
    const many = GuardServiceRow.parse({ ...rowWith(base, "openai-codex"), domains: ["a.example", "b.example", "c.example", "d.example"] });
    await answerDoors(page, { ...SIDE, "GET /guard/services": { body: GuardServicesPage.parse({ ...base, rows: [many] }) } });
    await openConsole(page, seed, "/services");
    await openMenu(page, many.name);
    await menuItem(page, "View details").click();
    const details = page.getByTestId("service-details");
    for (const item of [...many.domains, ...many.bundleIds, ...many.cliNames.map((c) => `$ ${c}`)]) {
      await expect(details.getByText(item, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("dialog", { name: `Where ${many.name} is recognised`, exact: true })).toBeVisible();
  });

  test("a failed read shows the error with a retry", async ({ page, seed }) => {
    let first = true;
    await answerDoors(page, {
      ...SIDE,
      "GET /guard/services": () => {
        if (first) {
          first = false;
          return refused(503, "UNAVAILABLE", "The registry is restarting");
        }
        return { body: fixtures.services() };
      },
    });
    await openConsole(page, seed, "/services");
    await expect(page.getByText("The registry is restarting", { exact: true })).toBeVisible();
    await expect(serviceRows(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(serviceRows(page)).toHaveCount(fixtures.services().rows.length);
  });
});

test.describe("surfaces, views and stats (VIB-15)", () => {
  test("a service with surfaces expands to them; a surface's select writes the rules document's surfaceBlocks", async ({ page, seed }) => {
    const rules = fixtures.rulesPage();
    const { calls } = await answerDoors(page, {
      "GET /guard/services": { body: fixtures.services() },
      "GET /guard/rules": { body: rules },
      "PUT /guard/rules": (call) => ({
        body: fixtures.rulesPage({ document: { ...rules.document, version: 4, surfaceBlocks: GuardRulesUpdate.parse(call.body).document.surfaceBlocks } }),
      }),
    });
    await openConsole(page, seed, "/services");
    const claude = rowNamed(page, "Claude");
    await expect(claude).toContainText("Per surface");
    await expect(page.getByRole("combobox", { name: "Claude website access" })).toHaveCount(0);
    await claude.getByRole("button", { name: "Show surfaces for Claude", exact: true }).click();
    const web = page.getByRole("combobox", { name: "Claude website access", exact: true });
    await expect(web).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Claude Mac app access", exact: true })).toBeVisible();
    await expect(web).toHaveText("Allowed");
    await expect(page.getByTestId("services-page").locator("select")).toHaveCount(0);
    await choose(web, "Blocked");
    await expect.poll(() => callsTo(calls, "PUT", "/guard/rules").length).toBe(1);
    const sent = GuardRulesUpdate.parse(callsTo(calls, "PUT", "/guard/rules")[0]?.body);
    expect(sent.baseVersion).toBe(3);
    expect(sent.document.surfaceBlocks).toEqual({ "claude-web": true });
    expect(sent.document.serviceRules).toEqual(rules.document.serviceRules);
    expect(sent.document.contentRules).toEqual(rules.document.contentRules);
    await expect(web).toHaveText("Blocked");
    await expect(toast(page, "success", "Claude website is blocked. Laptops pick it up at their next check-in (about a minute).")).toBeVisible();
    await expect(page.locator("[data-slot=stat-card]").filter({ hasText: "Surfaces blocked" }).locator("dd span").first()).toHaveText("1 of 4");
  });

  test("a stale write says so and re-reads the rules", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /guard/services": { body: fixtures.services() },
      "GET /guard/rules": { body: fixtures.rulesPage() },
      "PUT /guard/rules": refused(409, "STALE_BASE", "Stale"),
    });
    await openConsole(page, seed, "/services");
    await rowNamed(page, "ChatGPT").getByRole("button", { name: "Show surfaces for ChatGPT", exact: true }).click();
    await choose(page.getByRole("combobox", { name: "ChatGPT website access", exact: true }), "Blocked");
    const refusal = toast(page, "error", "ChatGPT website was not changed");
    await expect(refusal).toBeVisible();
    await expect(refusal.locator("[data-description]")).toHaveText("The rules changed somewhere else. They have been reloaded, so try again.");
    await expect.poll(() => callsTo(calls, "GET", "/guard/rules").length).toBe(2);
  });

  test("a 409 that is not a stale base says its own reason and does not re-read", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /guard/services": { body: fixtures.services() },
      "GET /guard/rules": { body: fixtures.rulesPage() },
      "PUT /guard/rules": refused(409, "GUARD_UPGRADE_REQUIRED", "Upgrade all active Guard agents before enabling surface blocks"),
    });
    await openConsole(page, seed, "/services");
    await rowNamed(page, "ChatGPT").getByRole("button", { name: "Show surfaces for ChatGPT", exact: true }).click();
    await choose(page.getByRole("combobox", { name: "ChatGPT website access", exact: true }), "Blocked");
    const refusal = toast(page, "error", "ChatGPT website was not changed");
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("Upgrade all active Guard agents before enabling surface blocks");
    await expect(refusal).not.toContainText("changed somewhere else");
    expect(callsTo(calls, "GET", "/guard/rules")).toHaveLength(1);
  });

  test("without the rules door the surfaces show a dash, never a guessed state", async ({ page, seed }) => {
    await answerDoors(page, {
      "GET /guard/services": { body: fixtures.services() },
      "GET /guard/rules": refused(500, "BROKEN", "No"),
    });
    const rulesRead = page.waitForResponse((response) => new URL(response.url()).pathname === `${CONSOLE_API_PREFIX}/guard/rules`);
    await openConsole(page, seed, "/services");
    await rulesRead;
    await rowNamed(page, "Claude").getByRole("button", { name: "Show surfaces for Claude", exact: true }).click();
    const surfaces = page.locator("tr[data-depth='1']");
    await expect(surfaces).toHaveCount(2);
    await expect(surfaces.filter({ hasText: "—" })).toHaveCount(2);
    await expect(page.getByRole("combobox", { name: "Claude website access" })).toHaveCount(0);
    await expect(page.locator("[data-slot=stat-card]").filter({ hasText: "Surfaces blocked" }).locator("dd span").first()).toHaveText("—");
  });

  test("the views split the catalogue by what it lists: Mac apps, CLIs", async ({ page, seed }) => {
    const listed = fixtures.services();
    await answerDoors(page, { ...SIDE, "GET /guard/services": { body: listed } });
    await openConsole(page, seed, "/services");
    await expect(serviceRows(page)).toHaveCount(listed.rows.length);
    await page.getByRole("tab", { name: /^CLIs/ }).click();
    await expect(serviceRows(page)).toHaveCount(listed.rows.filter((r) => r.cliNames.length > 0).length);
    await expect(serviceRows(page).filter({ hasText: "$ acme" })).toHaveCount(1);
    await page.getByRole("tab", { name: /^Mac apps/ }).click();
    await expect(serviceRows(page)).toHaveCount(listed.rows.filter((r) => r.bundleIds.length > 0).length);
    await expect(rowNamed(page, "Acme AI")).toHaveCount(0);
  });
});

test.describe("the real registry", () => {
  test("the seeded custom service Acme AI is listed with default Block", async ({ page, seed }) => {
    await openConsole(page, seed, "/services");
    const acme = rowNamed(page, "Acme AI");
    await expect(acme).toBeVisible();
    await expect(acme).toContainText("Acme · Chat · Added by your organisation");
    await expect(acme.getByRole("combobox", { name: "Default for Acme AI", exact: true })).toHaveText("Block");
    await expect(acme.getByRole("switch", { name: "Acme AI on", exact: true })).toHaveAttribute("aria-checked", "true");
  });
});
