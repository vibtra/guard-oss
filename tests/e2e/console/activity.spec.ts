import type { Locator, Page } from "@playwright/test";
import { consolePath, expect, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, type Call, type Doors } from "./support/doors.ts";
import { ADA, DEVICE_ID, GRACE, activity, devices, event, people, services } from "./support/fixtures.ts";

const ACTIVITY_SIDE: Doors = {
  "GET /guard/services": { body: services() },
  "GET /people": { body: people() },
  "GET /guard/devices": { body: devices() },
};

const FIRST_EVENT = "gev_00000000000000a1";

const dataRows = (page: Page): Locator => page.locator("tr[data-slot=data-row]");

const sheetOf = (page: Page): Locator => page.locator("[data-slot=detail-sheet]");

const definition = (scope: Locator, label: string): Locator =>
  scope.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd[1]");

const activityCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method === "GET" && call.path === "/guard/activity");

const lastActivityParam = (calls: readonly Call[], key: string): string | null | undefined => activityCalls(calls).at(-1)?.query.get(key);

test.describe("Activity (VIB-15: list + detail sheet)", () => {
  test("a row opens the decision sheet (?event=) with the counts and the redacted example; Load more follows the cursor", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      ...ACTIVITY_SIDE,
      "GET /guard/activity": (call) => ({
        body:
          call.query.get("cursor") === "c_2"
            ? activity({ rows: [event({ eventId: "gev_00000000000000a3", action: "asked" })], nextCursor: undefined })
            : activity(),
      }),
    });
    await openConsole(page, seed, "/activity");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();

    await test.step("a row opens the sheet at ?event= with the counts and the redacted example", async () => {
      await dataRows(page).first().click();
      const details = page.getByTestId("activity-details");
      await expect(definition(details, "Matched")).toHaveText("Tax file number, 1 time");
      await expect(definition(details, "Redacted example")).toHaveText("123***782");
      await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/activity", search: `?event=${FIRST_EVENT}` });
      await expect(page.getByRole("dialog", { name: "ChatGPT" })).toBeVisible();
      await expect(sheetOf(page).getByTestId("action-pill").first()).toHaveText("Blocked");
    });

    await test.step("Escape closes the sheet and drops ?event=", async () => {
      await page.keyboard.press("Escape");
      await expect(sheetOf(page)).toBeHidden();
      await expect.poll(() => routeOf(page, seed).search).toBe("");
    });

    await test.step("Load more follows the cursor", async () => {
      await page.getByTestId("activity-load-more").click();
      await expect(dataRows(page)).toHaveCount(3);
      await expect(dataRows(page).nth(2).getByTestId("action-pill")).toHaveText("Asked");
      expect(activityCalls(calls).some((call) => call.query.get("cursor") === "c_2")).toBe(true);
      await expect(page.getByText(/of 3 events/)).toHaveText("3 of 3 events");
      await expect(page.getByTestId("activity-load-more")).toHaveCount(0);
    });
  });

  test("a pasted ?event= link opens the sheet; Person and Device tabs read the people and devices doors", async ({ page, seed }) => {
    await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, `/activity?event=${FIRST_EVENT}`);
    const sheet = sheetOf(page);
    const details = page.getByTestId("activity-details");
    await expect(definition(details, "Decision ID")).toHaveText(FIRST_EVENT);
    await sheet.getByRole("tab", { name: "Person", exact: true }).click();
    await expect(definition(details, "Role")).toHaveText("Admin");
    await expect(definition(details, "Email")).toHaveText(ADA.email);
    await sheet.getByRole("tab", { name: "Device", exact: true }).click();
    await expect(definition(details, "Serial number")).toHaveText("C02TEST0001");
    await expect(sheet.getByRole("link", { name: "Open device" })).toHaveAttribute("href", consolePath(seed, `/devices?device=${DEVICE_ID}`));
  });

  test("the views ask the door by decision kind", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();
    await page.getByRole("tab", { name: "Blocked", exact: true }).click();
    await expect.poll(() => lastActivityParam(calls, "action")).toBe("blocked");
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await expect.poll(() => lastActivityParam(calls, "action")).toBeNull();
  });

  test("each row shows the decision pill, the person, the app with its bundle id, the service and the rule", async ({ page, seed }) => {
    await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();
    const first = dataRows(page).nth(0);
    const second = dataRows(page).nth(1);
    await expect(first.getByTestId("action-pill")).toHaveText("Blocked");
    await expect(first).toContainText("Ada Park");
    await expect(first).toContainText("com.google.Chrome");
    await expect(first.getByTestId("event-service-name")).toHaveText("ChatGPT");
    await expect(first).toContainText("Tax file numbers");
    await expect(second.getByTestId("action-pill")).toHaveText("Observed");
    await expect(second).toContainText("Grace Ho");
    await expect(second).toContainText("com.anthropic.claudefordesktop");
    await expect(second.getByTestId("event-service-name")).toHaveText("Claude");
  });
});

test.describe("empty states, Reset and lapsed grants", () => {
  test("Activity with no events reads 'No activity yet'; filtered to nothing names the search, and Reset clears every filter", async ({ page, seed }) => {
    const empty = activity({ rows: [], nextCursor: undefined, total: 0 });
    let filled = false;
    const { calls } = await answerDoors(page, {
      ...ACTIVITY_SIDE,
      "GET /guard/activity": (call) => ({ body: filled && !call.query.has("action") && !call.query.has("serviceId") ? activity() : empty }),
    });

    await test.step("no events: No activity yet, and no Reset", async () => {
      await openConsole(page, seed, "/activity");
      await expect(page.getByTestId("activity-empty")).toContainText("No activity yet");
      await expect(page.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
    });

    await test.step("filtered to nothing: the search is named, and Reset clears every filter", async () => {
      filled = true;
      const before = calls.length;
      const filters = new URLSearchParams({ action: "blocked", serviceId: "deepseek", personUserId: GRACE.userId, deviceId: DEVICE_ID, q: "falcon" });
      await openConsole(page, seed, `/activity?${filters.toString()}`);
      const nothing = page.getByTestId("activity-empty");
      await expect(nothing).toContainText("No events match “falcon”");
      await expect(nothing.getByRole("button", { name: "Clear search", exact: true })).toBeVisible();
      const read = activityCalls(calls.slice(before))[0]?.query;
      expect([read?.get("action"), read?.get("serviceId"), read?.get("personUserId"), read?.get("deviceId"), read?.get("q")]).toEqual([
        "blocked",
        "deepseek",
        GRACE.userId,
        DEVICE_ID,
        "falcon",
      ]);
      await page.getByRole("button", { name: "Reset", exact: true }).click();
      await expect(page.getByText(/2 of 3 events/)).toBeVisible();
      expect(lastActivityParam(calls, "action")).toBeNull();
      await expect(page.getByRole("button", { name: "Reset", exact: true })).toHaveCount(0);
    });
  });

  test("the address is the filter state: a view tab and Reset rewrite it, a sheet link carries the live filters", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity?action=blocked");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();
    await page.getByRole("tab", { name: "All", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("");
    await page.getByRole("tab", { name: "Allowed", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?action=allowed");
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("");

    await test.step("a row opened under a filter pushes an address that keeps the filter", async () => {
      await page.getByRole("tab", { name: "Blocked", exact: true }).click();
      await expect.poll(() => routeOf(page, seed).search).toBe("?action=blocked");
      await expect.poll(() => lastActivityParam(calls, "action")).toBe("blocked");
      await expect(page.getByText(/2 of 3 events/)).toBeVisible();
      await dataRows(page).first().click();
      await expect.poll(() => new URLSearchParams(routeOf(page, seed).search).get("event")).toBe(FIRST_EVENT);
      expect(new URLSearchParams(routeOf(page, seed).search).get("action")).toBe("blocked");
    });
  });

  test("typing in the search settles into ?q=", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();
    await page.getByRole("searchbox", { name: "Search activity" }).fill("falcon");
    await expect.poll(() => routeOf(page, seed).search).toBe("?q=falcon");
    await expect.poll(() => lastActivityParam(calls, "q")).toBe("falcon");
  });

  test("a ?event= link to a decision not in the list says so", async ({ page, seed }) => {
    await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity?event=gev_nosuch");
    await expect(page.getByTestId("activity-missing")).toContainText("That decision is not in the newest events.");
    await expect(sheetOf(page)).toHaveCount(0);
  });

  test("an unknown ?action= is ignored rather than sent", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed, "/activity?action=uploaded");
    await expect(page.getByText(/2 of 3 events/)).toBeVisible();
    expect(activityCalls(calls)[0]?.query.get("action")).toBeNull();
    await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("Activity on the seeded registry", () => {
  test("the seeded blocked event on adas-mbp opens its sheet with 123***782", async ({ page, seed }) => {
    const laptop = seed.devices.adasMbp;
    const address = new URLSearchParams({ deviceId: laptop.deviceId, action: "blocked", event: seed.events.adaBlocked });
    await openConsole(page, seed, `/activity?${address.toString()}`);
    const details = page.getByRole("dialog", { name: "ChatGPT" }).getByTestId("activity-details");
    await expect(definition(details, "Decision ID")).toHaveText(seed.events.adaBlocked);
    await expect(definition(details, "Redacted example")).toHaveText("123***782");
    await expect(definition(details, "Matched")).toHaveText("Tax file number, 1 time");
    await expect(definition(details, "Rule")).toHaveText("Tax file numbers");
    await expect(definition(details, "Device")).toHaveText(laptop.hostname);
    await expect(sheetOf(page).getByTestId("action-pill").first()).toHaveText("Blocked");
  });
});
