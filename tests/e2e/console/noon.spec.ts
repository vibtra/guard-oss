import type { Locator, Page } from "@playwright/test";
import { ConsolePeoplePage } from "@vibtra/console-api";
import { GuardServiceRow, GuardServiceUpdate, GuardServicesPage } from "@vibtra/guard-contract";
import { expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { type Doors, answerDoors } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

type Recorder = Window & { __starting: string[]; __titles: string[]; __closing: boolean[] };

const DEE = { userId: "usr_dee", email: "dee@fernwood.example", name: "Dee Shah" };

const fleet = (extra: Doors = {}): Doors => ({
  "GET /guard/devices": { body: fixtures.devices() },
  "GET /guard/devices/enrol-links": { body: fixtures.enrolLinks() },
  "GET /guard/activity": { body: fixtures.activity() },
  "GET /people": {
    body: ConsolePeoplePage.parse({
      rows: [...fixtures.people().rows, { issuer: "x", subject: DEE.userId, email: DEE.email, name: DEE.name, role: "member", createdAt: fixtures.iso(-10 * fixtures.DAY) }],
      total: 3,
    }),
  },
  ...extra,
});

const serviceNamed = (serviceId: string): GuardServiceRow => {
  const row = fixtures.services().rows.find((r) => r.serviceId === serviceId);
  if (row === undefined) throw new Error(`the services fixture has no ${serviceId}`);
  return row;
};

const catalogue = (extra: Doors = {}): Doors => ({
  "GET /guard/services": { body: fixtures.services() },
  "GET /guard/rules": { body: fixtures.rulesPage() },
  ...extra,
});

const focusedText = (page: Page): Promise<string> => page.evaluate(() => globalThis.document.activeElement?.textContent?.trim() ?? "");

const listbox = (page: Page): Locator => page.getByRole("listbox");

const heldScale = async (page: Page, button: Locator): Promise<number> => {
  const box = await button.boundingBox();
  const viewport = page.viewportSize();
  if (box === null || viewport === null) throw new Error("the button has no box to press");
  const x = box.x + box.width / 2;
  await page.mouse.move(x, box.y + box.height / 2);
  await page.mouse.down();
  const scale = await button.evaluate((element) => {
    for (const animation of element.getAnimations()) animation.finish();
    return getComputedStyle(element).scale;
  });
  await page.mouse.move(x, box.y + box.height + 120 < viewport.height ? box.y + box.height + 120 : box.y - 120);
  await page.mouse.up();
  const parts = scale === "none" ? [1] : [...new Set(scale.split(" ").map((part) => Math.round(Number(part) * 100) / 100))];
  const [uniform] = parts;
  if (parts.length !== 1 || uniform === undefined) throw new Error(`the scale is not uniform: ${scale}`);
  return uniform;
};

test.describe("SegmentedTabs", () => {
  test("is a tablist in local mode: click, the arrow keys, Home and End select, and focus follows", async ({ page, seed }) => {
    await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    const list = page.getByRole("tablist", { name: "Catalogue views", exact: true });
    const tabs = list.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    expect(await tabs.evaluateAll((all) => all.map((tab) => tab.getAttribute("aria-selected")))).toEqual(["true", "false", "false"]);
    const apps = list.getByRole("tab", { name: /^Mac apps/ });
    await expect(apps).toHaveAttribute("aria-controls", "svc-panel-apps");
    await expect(apps).toHaveText(/^Mac apps\d+$/);

    await apps.click();
    await expect(apps).toHaveAttribute("aria-selected", "true");
    await expect(page.locator("#svc-panel-apps")).toHaveAttribute("role", "tabpanel");
    await page.keyboard.press("ArrowRight");
    const clis = list.getByRole("tab", { name: /^CLIs/ });
    await expect(clis).toHaveAttribute("aria-selected", "true");
    await expect(clis).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const services = list.getByRole("tab", { name: /^Services/ });
    await expect(services).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(clis).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(services).toHaveAttribute("aria-selected", "true");
    await expect(services).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(clis).toHaveAttribute("aria-selected", "true");
  });

  test("is a nav of links when every item has a `to`; the page says which is current", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": { body: fixtures.rulesPage() } });
    await openConsole(page, seed, "/rules");
    const nav = page.getByRole("navigation", { name: "Rule views", exact: true });
    await expect(nav.getByRole("tab")).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Services", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Content", exact: true })).not.toHaveAttribute("aria-current", /.*/);
    await nav.getByRole("link", { name: "Content", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=content");
    await expect(nav.getByRole("link", { name: "Content", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Services", exact: true })).not.toHaveAttribute("aria-current", /.*/);
  });
});

test.describe("DetailSheet with useSheetParam", () => {
  test("opening pushes ?device=… and keeps the other params; closing goes back to the address it came from", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices?keep=1");
    await page.getByRole("button", { name: "graces-air, details", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?keep=1&device=${fixtures.DEVICE_ID_2}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("graces-air");
    await dialog.locator("[data-slot=overlay-close]").click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?keep=1");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goForward();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?keep=1&device=${fixtures.DEVICE_ID_2}`);
    await expect(page.getByRole("dialog")).toContainText("graces-air");
  });

  test("the browser's Back closes it", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await page.getByRole("button", { name: "graces-air, details", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("graces-air");
    await page.goBack();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/devices", search: "" });
  });

  test("a pasted link opens it, and closing replaces the address without the param", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, `/devices?device=${fixtures.DEVICE_ID_2}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("graces-air");
    const entries = await page.evaluate(() => history.length);
    await dialog.locator("[data-slot=overlay-close]").click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/devices", search: "" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(await page.evaluate(() => history.length)).toBe(entries);
  });
});

test.describe("DataTable", () => {
  test("opens a row on click or from its named button, keeps a menu click to itself, and expands groups without opening", async ({ page, seed }) => {
    const chatgpt = serviceNamed("openai-chatgpt");
    await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    const table = page.getByRole("table", { name: "AI services", exact: true });
    const details = page.getByRole("dialog", { name: `Where ${chatgpt.name} is recognised`, exact: true });
    const closeDetails = (): Promise<void> => details.locator("[data-slot=modal-footer]").getByRole("button", { name: "Close", exact: true }).click();

    await table.getByTestId("service-name").getByText(chatgpt.name, { exact: true }).click();
    await expect(details).toBeVisible();
    await closeDetails();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const opener = { name: `${chatgpt.name}, where it is recognised`, exact: true };
    const open = table.getByRole("button", opener);
    const row = table.getByRole("row").filter({ has: page.getByRole("button", opener) });
    await expect(row).not.toHaveAttribute("tabindex", /.*/);
    await expect(row).not.toHaveAttribute("aria-label", /.*/);
    await open.click();
    await expect(details).toBeVisible();
    await closeDetails();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await row.getByRole("button", { name: `Actions for ${chatgpt.name}`, exact: true }).click();
    await expect(menuItem(page, "View details")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(menuItem(page, "View details")).toHaveCount(0);

    await expect(page.getByRole("combobox", { name: "Claude website access", exact: true })).toHaveCount(0);
    await table.getByRole("button", { name: "Show surfaces for Claude", exact: true }).click();
    await expect(table.getByRole("button", { name: "Hide surfaces for Claude", exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("combobox", { name: "Claude website access", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("holds collapsing child rows while they shrink (g-expand, data-closing), then unmounts them", async ({ page, seed }) => {
    await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    const table = page.getByRole("table", { name: "AI services", exact: true });
    await table.getByRole("button", { name: "Show surfaces for Claude", exact: true }).click();
    const surface = page.getByRole("combobox", { name: "Claude website access", exact: true });
    await expect(surface).toBeVisible();
    const holder = table.locator(".g-expand").filter({ has: surface });
    await expect(holder).not.toHaveAttribute("data-closing", /.*/);
    await table.evaluate((root) => {
      const recorder = window as unknown as Recorder;
      recorder.__closing = [];
      new MutationObserver(() => {
        for (const node of root.querySelectorAll(".g-expand")) {
          if (node.querySelector("[aria-label='Claude website access']") !== null) recorder.__closing.push(node.hasAttribute("data-closing"));
        }
      }).observe(root, { subtree: true, attributes: true, childList: true });
    });
    await table.getByRole("button", { name: "Hide surfaces for Claude", exact: true }).click();
    await expect(surface).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Recorder).__closing)).toContain(true);
    await expect(table.getByRole("button", { name: "Show surfaces for Claude", exact: true })).toHaveAttribute("aria-expanded", "false");
  });

  test("fades the table in once (g-enter) and scrolls inside a positioned box", async ({ page, seed }) => {
    await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    const box = page.locator("[data-slot='data-table']").filter({ has: page.getByRole("table", { name: "AI services", exact: true }) });
    await expect(box).toHaveClass(/(^|\s)g-enter(\s|$)/);
    await expect(box).toHaveClass(/(^|\s)relative(\s|$)/);
    await expect(box).toHaveCSS("position", "relative");
  });

  test("gives a menu-less clickable row a trailing chevron button named by its row", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const table = page.getByRole("table", { name: "Device activity", exact: true });
    const chevron = table.locator("[data-slot=row-open-cell]").getByRole("button", { name: "ChatGPT on adas-mbp, open the device", exact: true });
    await expect(chevron).toHaveCount(1);
    await expect(table.locator("[data-slot=row-menu-cell]")).toHaveCount(0);
    await chevron.click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?device=${fixtures.DEVICE_ID}`);
    await expect(page.getByRole("dialog")).toContainText("adas-mbp");
  });
});

test.describe("SelectInput (Base UI select)", () => {
  test("is a button combobox named by its label, showing the chosen option, with aria passed through, and no <select> anywhere", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": { body: fixtures.rulesPage() } });
    await openConsole(page, seed, "/rules?tab=content");
    await page.getByTestId("add-content-rule").click();
    const dialog = page.getByRole("dialog", { name: "Add a content rule", exact: true });
    const detects = dialog.getByRole("combobox", { name: "Detects", exact: true });
    await expect(detects).toBeVisible();
    expect(await detects.evaluate((node) => node.tagName)).toBe("BUTTON");
    await expect(detects).toHaveAttribute("aria-describedby", "crule-detector-hint");
    await expect(detects).toHaveAttribute("aria-expanded", "false");
    await expect(detects).toHaveAccessibleDescription(/Fixed patterns and lists only/);
    await expect(page.locator("select")).toHaveCount(0);
  });

  test("opens from the keyboard, moves with the arrows and type-ahead, Enter picks and focus returns", async ({ page, seed }) => {
    const plain = serviceNamed("openai-api");
    let listed = fixtures.services();
    const { calls } = await answerDoors(
      page,
      catalogue({
        "GET /guard/services": () => ({ body: listed }),
        [`PUT /guard/services/${plain.serviceId}`]: (call) => {
          const next = GuardServiceRow.parse({ ...plain, ...GuardServiceUpdate.parse(call.body) });
          listed = GuardServicesPage.parse({ ...listed, rows: listed.rows.map((r) => (r.serviceId === next.serviceId ? next : r)) });
          return { body: next };
        },
      }),
    );
    await openConsole(page, seed, "/services");
    const trigger = page.getByRole("combobox", { name: `Default for ${plain.name}`, exact: true });
    await expect(trigger).toHaveText("Inherit");
    await expect(trigger).toHaveClass(/(^|\s)h-8(\s|$)/);
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const options = listbox(page).getByRole("option");
    await expect(options).toHaveText(["Inherit", "Allow", "Block", "Ask IT"]);
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => focusedText(page)).toBe("Inherit");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedText(page)).toBe("Allow");
    await page.keyboard.press("b");
    await expect.poll(() => focusedText(page)).toBe("Block");
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => focusedText(page)).toBe("Ask IT");
    await page.keyboard.press("Enter");
    await expect.poll(() => calls.filter((c) => c.method === "PUT" && c.path === `/guard/services/${plain.serviceId}`).map((c) => c.body)).toEqual([{ defaultAction: "ask" }]);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveText("Ask IT");
  });

  test("Enter and Space open it; Escape closes it without choosing, and focus returns to the trigger", async ({ page, seed }) => {
    const plain = serviceNamed("openai-api");
    const { calls } = await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    const trigger = page.getByRole("combobox", { name: `Default for ${plain.name}`, exact: true });
    for (const key of ["Enter", "Space", "ArrowUp"]) {
      await trigger.focus();
      await page.keyboard.press(key);
      await expect(listbox(page), key).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect.poll(() => page.evaluate(() => globalThis.document.activeElement?.getAttribute("role"))).toBe("option");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(trigger).toBeFocused();
    }
    await expect(trigger).toHaveText("Inherit");
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  test("shows the placeholder while nothing is chosen", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": { body: fixtures.rulesPage() } });
    await openConsole(page, seed, "/rules?service=deepseek-chat");
    const dialog = page.getByRole("dialog", { name: "DeepSeek", exact: true });
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByRole("combobox", { name: "Exception 1: who", exact: true })).toHaveText("Pick a group");
  });
});

test.describe("ComboboxInput (person pickers)", () => {
  test("filters the options by what is typed, says when nothing matches, and picks one with the keyboard", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, fleet({ "POST /guard/devices/enrol-links": { body: fixtures.enrolLink() } }));
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    const dialog = page.getByTestId("enrol-dialog");
    const person = dialog.getByRole("combobox", { name: "Person", exact: true });
    await person.click();
    await person.pressSequentially("gr");
    await expect(listbox(page).getByRole("option")).toHaveText([/^Grace Ho/]);
    await person.fill("zz");
    await expect(page.getByText("No matches", { exact: true })).toBeVisible();
    await person.fill("de");
    await expect(listbox(page).getByRole("option")).toHaveText([/^Dee Shah/]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(person).toHaveValue("Dee Shah");
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect.poll(() => calls.find((c) => c.method === "POST" && c.path === "/guard/devices/enrol-links")?.body).toEqual({ personEmail: DEE.email, expiresInHours: 24 });
  });

  test("finds an option by its email but shows only the name once chosen", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    const person = page.getByTestId("enrol-dialog").getByRole("combobox", { name: "Person", exact: true });
    await person.click();
    await person.pressSequentially("grace@");
    await expect(listbox(page).getByRole("option")).toHaveText([/^Grace Ho/]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(person).toHaveValue("Grace Ho");
  });
});

test.describe("Checkbox", () => {
  test("is a named checkbox that toggles with a click and carries its state", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": { body: fixtures.rulesPage() } });
    await openConsole(page, seed, "/rules?tab=content");
    await page.getByTestId("add-content-rule").click();
    const dialog = page.getByRole("dialog", { name: "Add a content rule", exact: true });
    await dialog.getByRole("switch", { name: "Every AI service", exact: true }).click();
    const box = dialog.getByRole("list", { name: "Services", exact: true }).getByRole("checkbox", { name: "ChatGPT", exact: true });
    await expect(box).toHaveAttribute("aria-checked", "false");
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "true");
    await expect(box).toHaveClass(/(^|\s)bg-g-ink(\s|$)/);
    await box.click();
    await expect(box).toHaveAttribute("aria-checked", "false");
    await expect(box).not.toHaveClass(/(^|\s)bg-g-ink(\s|$)/);
  });
});

test.describe("useHeld", () => {
  test("a modal keeps its record through its exit and is gone after it", async ({ page, seed }) => {
    const chatgpt = serviceNamed("openai-chatgpt");
    const title = `Where ${chatgpt.name} is recognised`;
    await answerDoors(page, catalogue());
    await openConsole(page, seed, "/services");
    await page.getByRole("button", { name: `${chatgpt.name}, where it is recognised`, exact: true }).click();
    const modal = page.getByRole("dialog", { name: title, exact: true });
    await expect(modal).toBeVisible();
    await page.evaluate(() => {
      const recorder = window as unknown as Recorder;
      recorder.__titles = [];
      new MutationObserver(() => {
        const node = document.querySelector("[data-slot=modal]");
        if (node !== null) recorder.__titles.push(node.querySelector("h2")?.textContent ?? "");
      }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    await modal.locator("[data-slot=modal-footer]").getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.locator("[data-slot=modal]")).toHaveCount(0);
    const titles = await page.evaluate(() => (window as unknown as Recorder).__titles);
    expect(titles.length).toBeGreaterThan(0);
    expect([...new Set(titles)]).toEqual([title]);
  });
});

test.describe("overlays that mount open still play their enter", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const recorder = window as unknown as Recorder;
      recorder.__starting = [];
      new MutationObserver(() => {
        for (const node of document.querySelectorAll("[data-starting-style]")) {
          const slot = node.getAttribute("data-slot");
          if (slot !== null && !recorder.__starting.includes(slot)) recorder.__starting.push(slot);
        }
      }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-starting-style"] });
    });
  });

  test("a detail sheet opened from a pasted link emits data-starting-style on the sheet and its overlay", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, `/devices?device=${fixtures.DEVICE_ID_2}`);
    await expect(page.getByRole("dialog")).toContainText("graces-air");
    const seen = await page.evaluate(() => (window as unknown as Recorder).__starting);
    expect(seen).toContain("detail-sheet");
    expect(seen).toContain("detail-sheet-overlay");
  });

  test("a confirm modal mounted open emits data-starting-style", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await page.getByRole("button", { name: "Actions for adas-mbp", exact: true }).click();
    await menuItem(page, "Revoke…").click();
    await expect(page.getByRole("alertdialog", { name: "Revoke adas-mbp?", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Recorder).__starting)).toContain("modal");
  });
});

test.describe("FormSheet and ActionButton", () => {
  test("a form sheet is a noValidate form; while busy, Cancel stays focusable but does nothing and the primary ignores clicks", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, fleet({ "POST /guard/devices/enrol-links": "pending" }));
    await openConsole(page, seed, "/devices");
    await page.getByTestId("enrol-open").click();
    const dialog = page.getByRole("dialog", { name: "Enrol a laptop", exact: true });
    expect(await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).noValidate)).toBe(true);
    const person = dialog.getByRole("combobox", { name: "Person", exact: true });
    await person.click();
    await person.pressSequentially("grace@");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const create = dialog.getByRole("button", { name: "Create link", exact: true });
    await create.click();
    await expect(create).toHaveAttribute("aria-busy", "true");
    await expect(create).toHaveAttribute("aria-disabled", "true");
    await expect(create).not.toHaveAttribute("disabled", /.*/);
    await expect(create).toBeFocused();
    await create.click({ force: true });
    const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });
    await expect(cancel).toHaveAttribute("aria-disabled", "true");
    await expect(cancel).not.toHaveAttribute("disabled", /.*/);
    await cancel.focus();
    await expect(cancel).toBeFocused();
    await cancel.click({ force: true });
    await expect(dialog).toBeVisible();
    expect(calls.filter((c) => c.method === "POST" && c.path === "/guard/devices/enrol-links")).toHaveLength(1);
  });

  test("a button presses to .96 only under motion-safe and never when disabled; a static one opts out", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    const enrol = page.getByTestId("enrol-open");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    expect(await heldScale(page, enrol)).toBe(0.96);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await heldScale(page, enrol)).toBe(1);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const attribute of ["aria-disabled", "disabled"]) {
      await enrol.evaluate((button, name) => button.setAttribute(name, "true"), attribute);
      expect(await heldScale(page, enrol), attribute).toBe(1);
      await enrol.evaluate((button, name) => button.removeAttribute(name), attribute);
    }
    expect(await heldScale(page, enrol)).toBe(0.96);
    await enrol.click();
    const dialog = page.getByRole("dialog", { name: "Enrol a laptop", exact: true });
    expect(await heldScale(page, dialog.getByRole("button", { name: "Cancel", exact: true }))).toBe(1);
    await expect(dialog).toBeVisible();
  });
});
