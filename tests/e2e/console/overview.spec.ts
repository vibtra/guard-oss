import type { Locator } from "@playwright/test";
import { consolePath, expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, type Call, type Doors } from "./support/doors.ts";
import { activity, devices, overview, people, services } from "./support/fixtures.ts";

const ACTIVITY_SIDE: Doors = {
  "GET /guard/services": { body: services() },
  "GET /people": { body: people() },
  "GET /guard/devices": { body: devices() },
};

const dataRows = (scope: Locator): Locator => scope.locator("tr[data-slot=data-row]");

const overviewCalls = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method === "GET" && call.path === "/guard/overview");

test.describe("the Overview (VIB-15)", () => {
  test("draws the enrol banner when no laptop has checked in, linking to Devices", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview({ noDevicesYet: true, clientMode: "enforce" }) } });
    await openConsole(page, seed);
    const cta = page.getByTestId("overview-enrol");
    await expect(cta).toHaveText("Enrol the first laptop");
    await expect(cta).toHaveAttribute("href", consolePath(seed, "/devices?enrol=1"));
    await expect(page.getByTestId("overview-monitor")).toHaveCount(0);
    await cta.click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/devices", search: "?enrol=1" });
  });

  test("four stat cards from the door's totals, no comparison line the door cannot back", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview() } });
    await openConsole(page, seed);
    const cards = page.getByTestId("overview-page").locator("[data-slot=stat-card]");
    await expect(cards.locator("dt")).toHaveText(["AI services seen", "People using AI", "Would have blocked", "Devices"]);
    await expect(cards.locator("dd span")).toHaveText(["3", "2", "4", "2"]);
  });

  test("shows the services table with bytes in human words and count badges", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview() } });
    await openConsole(page, seed);
    const table = page.getByRole("table", { name: "AI services in use" });
    await expect(table.getByTestId("overview-service-row")).toHaveText([/ChatGPT/, /Claude/, /GitHub Copilot/]);
    await expect(dataRows(table).first()).toContainText("1.5 MB");
    await expect(table.locator("[data-slot=count-badge]")).toHaveText(["2", "2", "1", "1", "1", "1"]);
    await expect(table.getByRole("columnheader", { name: "Would block", exact: true })).toBeVisible();
  });

  test("names the services column Blocked in Enforce", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview({ clientMode: "enforce" }) } });
    await openConsole(page, seed);
    await expect(page.getByRole("table", { name: "AI services in use" }).getByRole("columnheader", { name: "Blocked", exact: true })).toBeVisible();
  });

  test("⋮ View details opens 'People using X', named from the activity door filtered to that service", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { "GET /guard/overview": { body: overview() }, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed);
    await page.getByRole("button", { name: "Actions for ChatGPT", exact: true }).click();
    await menuItem(page, "View details").click();
    const dialog = page.getByRole("dialog", { name: "People using ChatGPT" });
    const list = dialog.getByTestId("service-people");
    await expect(list).toContainText("Ada Park");
    await expect(list).toContainText("Grace Ho");
    await expect(list).toContainText("adas-mbp");
    await expect(list.getByRole("list", { name: "People using ChatGPT" }).getByRole("listitem")).toHaveCount(2);
    const read = calls.find((call) => call.method === "GET" && call.path === "/guard/activity");
    expect([read?.query.get("serviceId"), read?.query.get("limit")]).toEqual(["openai-chatgpt", "200"]);
    await expect(dialog.getByRole("link", { name: "Open in Activity" })).toHaveAttribute("href", consolePath(seed, "/activity?serviceId=openai-chatgpt"));
  });

  test("the views are the door's own lists; a Latest row opens that decision in Activity", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview() }, ...ACTIVITY_SIDE, "GET /guard/activity": { body: activity() } });
    await openConsole(page, seed);
    await expect(page.getByTestId("overview-service-row")).toHaveCount(3);
    await page.getByRole("tab", { name: "Apps", exact: true }).click();
    await expect(page.getByRole("table", { name: "Apps that reached AI services" }).getByText("com.google.Chrome")).toBeVisible();
    await page.getByRole("tab", { name: "Blocks", exact: true }).click();
    await expect(page.getByRole("table", { name: "Rules that blocked the most" }).getByText("Content rule")).toBeVisible();
    await page.getByRole("tab", { name: "Latest", exact: true }).click();
    const latest = dataRows(page.getByRole("table", { name: "Latest decisions" }));
    await expect(latest).toHaveCount(1);
    await latest.first().click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/activity", search: "?event=gev_00000000000000a1" });
    await expect(page.getByRole("dialog", { name: "ChatGPT" }).getByTestId("activity-details")).toBeVisible();
  });

  test("switching to 30 days re-asks the door", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /guard/overview": (call) => ({ body: overview(call.query.get("days") === "30" ? { windowDays: 30 } : {}) }),
    });
    await openConsole(page, seed);
    const totals = page.locator("[data-slot=stat-row]");
    await expect(totals).toHaveAttribute("aria-label", "Totals for the last 7 days");
    expect(overviewCalls(calls)[0]?.query.get("days")).toBe("7");
    await page.getByRole("tab", { name: "30 days", exact: true }).click();
    await expect.poll(() => overviewCalls(calls).some((call) => call.query.get("days") === "30")).toBe(true);
    await expect(totals).toHaveAttribute("aria-label", "Totals for the last 30 days");
    await expect(page.getByRole("tab", { name: "30 days", exact: true })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("empty states, Reset and lapsed grants", () => {
  test("the Overview of an org with no events says so in every view", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/overview": { body: overview({ services: [], topBlocks: [], topApps: [], recent: [] }) } });
    await openConsole(page, seed);
    await expect(page.getByTestId("overview-services-empty")).toContainText("No AI service reached yet");
    await page.getByRole("tab", { name: "Apps", exact: true }).click();
    await expect(page.getByTestId("overview-apps-empty")).toContainText("No app reached an AI service in this window.");
    await page.getByRole("tab", { name: "Blocks", exact: true }).click();
    await expect(page.getByTestId("overview-blocks-empty")).toContainText("Nothing was blocked in this window.");
    await page.getByRole("tab", { name: "Latest", exact: true }).click();
    await expect(page.getByTestId("overview-recent-empty")).toContainText("No events yet");
  });
});

test.describe("the Overview on the seeded registry", () => {
  test("shows the seeded services (ChatGPT, Claude) and the monitor line", async ({ page, seed }) => {
    await openConsole(page, seed);
    await expect(page.getByTestId("overview-monitor")).toContainText("Monitoring only: rules aren't enforced yet");
    const table = page.getByRole("table", { name: "AI services in use" });
    await expect(table.getByRole("button", { name: "ChatGPT, people using it", exact: true })).toBeVisible();
    await expect(table.getByRole("button", { name: "Claude, people using it", exact: true })).toBeVisible();
  });
});
