import type { Locator, Page } from "@playwright/test";
import { MEMBER, SIGNED_OUT, consolePath, expect, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, type Doors } from "./support/doors.ts";
import { ADA, DAY, deviceRow, devices, iso, policyRequests } from "./support/fixtures.ts";

const GUARD_DOCS_URL = "https://github.com/vibtra/guard-oss#readme";
const ADMIN_ONLY_NOTICE = "That page is for organisation admins";

interface Destination {
  label: string;
  route: string;
  testId: string;
  place: "sidebar" | "gear";
}

const DESTINATIONS: readonly Destination[] = [
  { label: "Overview", route: "/", testId: "overview-page", place: "sidebar" },
  { label: "Activity", route: "/activity", testId: "activity-page", place: "sidebar" },
  { label: "Rules", route: "/rules", testId: "rules-page", place: "sidebar" },
  { label: "Requests", route: "/requests", testId: "requests-page", place: "sidebar" },
  { label: "Devices", route: "/devices", testId: "devices-page", place: "sidebar" },
  { label: "People", route: "/people", testId: "people-page", place: "sidebar" },
  { label: "AI services", route: "/services", testId: "services-page", place: "sidebar" },
  { label: "Settings", route: "/settings", testId: "settings-page", place: "gear" },
];

const ROWS = DESTINATIONS.filter((destination) => destination.place === "sidebar");

const GROUPS_WITH_COUNTS = [
  { label: "Protect", rows: ["Overview", "Activity", "Rules", "Requests, 1"] },
  { label: "Fleet", rows: ["Devices, 2", "People"] },
  { label: "Catalogue", rows: ["AI services"] },
];

const MAIN_CONSOLE_NOUNS = ["New session", "Spaces", "Sessions", "Workboxes", "App boxes", "Connections", "Builder"];

const MAIN_CONSOLE_WORDS = [/\bchats?\b/, /\bconnectors?\b/, /\bconnections?\b/, /\bworkbox(es)?\b/, /\bapp box(es)?\b/, /\bbuilder\b/, /\bmodels?\b/, /\bspaces?\b/, /\bsessions?\b/];

const sidebarNav = (page: Page): Locator => page.getByRole("navigation", { name: "Guard", exact: true });
const topBar = (page: Page): Locator => page.locator("[data-slot=topbar]");
const barTitle = (page: Page): Locator => topBar(page).getByRole("heading", { level: 1 });
const gear = (page: Page): Locator => topBar(page).getByRole("link", { name: "Settings", exact: true });
const inbox = (page: Page, name: string | RegExp): Locator => topBar(page).getByRole("button", typeof name === "string" ? { name, exact: true } : { name });
const row = (page: Page, label: string): Locator => sidebarNav(page).getByRole("link", { name: new RegExp(`^${label}\\b`) });
const litRows = (page: Page): Locator => sidebarNav(page).locator("[aria-current]");
const linkTo = (page: Page, destination: Destination): Locator => (destination.place === "gear" ? gear(page) : row(page, destination.label));
const signInFor = (address: string): string => `/login?return=${encodeURIComponent(address)}`;

const chromeWords = async (page: Page): Promise<string> => {
  const chrome = page.locator("[data-slot=sidebar], [data-slot=topbar]");
  const text = await chrome.allTextContents();
  const names = await chrome.locator("[aria-label]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label") ?? ""));
  return [...text, ...names].join(" ").toLowerCase();
};

const countDoors = (): Doors => {
  const fleet = devices();
  const retired = deviceRow({ deviceId: "gdev_00000000000000c3", hostname: "old-air", status: "revoked", revokedAt: iso(-DAY), revokedBy: ADA.email });
  return {
    "GET /policy-requests": { body: policyRequests() },
    "GET /guard/devices": { body: { ...fleet, rows: [...fleet.rows, retired] } },
  };
};

test.describe("the Guard shell", () => {
  test("draws the wordmark, the workspace block and the seven rows in three groups, with their counts", async ({ page, seed }) => {
    await answerDoors(page, countDoors());
    await openConsole(page, seed);
    await expect(page.getByTestId("overview-page")).toBeVisible();
    await expect(page.locator("[data-slot=guard-wordmark]")).toHaveText("Guardby Vibtra");
    await expect(page.getByRole("button", { name: `${seed.orgName}, organisation`, exact: true })).toBeVisible();
    const groups = sidebarNav(page).getByRole("group");
    await expect(groups).toHaveCount(GROUPS_WITH_COUNTS.length);
    for (const [index, group] of GROUPS_WITH_COUNTS.entries()) {
      await expect(groups.nth(index)).toHaveAccessibleName(group.label);
      await expect(groups.nth(index).getByRole("link")).toHaveText(group.rows);
    }
    await expect(row(page, "Overview")).toHaveAttribute("aria-current", "page");
    await expect(litRows(page)).toHaveCount(1);
    const text = (await page.locator("body").textContent()) ?? "";
    for (const noun of MAIN_CONSOLE_NOUNS) expect(text, noun).not.toContain(noun);
  });

  test("puts the title, Docs, the inbox, the gear and the avatar in the top bar", async ({ page, seed }) => {
    await answerDoors(page, countDoors());
    await openConsole(page, seed, "/devices");
    await expect(barTitle(page)).toHaveText("Devices");
    const docs = topBar(page).getByRole("link", { name: /^Docs/ });
    await expect(docs).toHaveAttribute("href", GUARD_DOCS_URL);
    await expect(docs).toHaveAttribute("target", "_blank");
    await expect(gear(page)).toBeVisible();
    await expect(gear(page)).not.toHaveAttribute("aria-current");
    await expect(topBar(page).getByRole("button", { name: `${seed.orgName}, ${seed.people.ada.name}, account menu`, exact: true })).toBeVisible();
    await expect(inbox(page, "Inbox, 1 open request")).toBeVisible();
    await expect(sidebarNav(page).getByRole("link")).toHaveCount(ROWS.length);
    await expect(sidebarNav(page).getByRole("link", { name: /Settings/ })).toHaveCount(0);
  });

  test("lights the gear and titles the bar while in Settings", async ({ page, seed }) => {
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(barTitle(page)).toHaveText("Settings");
    await expect(gear(page)).toHaveAttribute("aria-current", "page");
    await expect(sidebarNav(page).getByRole("link")).toHaveCount(ROWS.length);
    await expect(litRows(page)).toHaveCount(0);
    await expect(page).toHaveTitle("Settings · Vibtra Guard");
  });

  test("the inbox lists the open request and View requests goes to Requests", async ({ page, seed }) => {
    await answerDoors(page, countDoors());
    await openConsole(page, seed);
    await inbox(page, "Inbox, 1 open request").click();
    const popover = page.locator("[data-slot=inbox-popover]");
    await expect(popover).toContainText('sending what the rule "Tax file numbers" blocks to ChatGPT');
    await popover.getByRole("link", { name: "View requests", exact: true }).click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/requests", search: "" });
    await expect(page.getByTestId("requests-page")).toBeVisible();
    await expect(popover).toBeHidden();
  });

  test("routes /people to its page", async ({ page, seed }) => {
    await openConsole(page, seed, "/people");
    await expect(page.getByTestId("people-page")).toBeVisible();
    await expect(barTitle(page)).toHaveText("People");
    await expect(row(page, "People")).toHaveAttribute("aria-current", "page");
    await expect(litRows(page)).toHaveCount(1);
  });

  test.describe("as a member", () => {
    test.use({ storageState: MEMBER });

    test("a member sees the admin-only notice in place of every page", async ({ page, seed }) => {
      for (const { route, testId } of [...DESTINATIONS, { route: "/rules/", testId: "rules-page" }]) {
        await openConsole(page, seed, route);
        await expect(page.getByTestId("admin-only"), route).toContainText(ADMIN_ONLY_NOTICE);
        await expect(page.getByTestId(testId), route).toHaveCount(0);
        await expect(sidebarNav(page), route).toBeAttached();
        await expect(sidebarNav(page).getByRole("link"), route).toHaveCount(0);
        await expect(inbox(page, /^Inbox/), route).toHaveCount(0);
        await expect(gear(page), route).toHaveCount(0);
      }
    });
  });

  test.describe("signed out", () => {
    test.use({ storageState: SIGNED_OUT });

    test("a signed-out person is sent to the apex /login with this console's address", async ({ page, seed }) => {
      const address = consolePath(seed, "/rules");
      await page.goto(address, { waitUntil: "commit" });
      await expect(page).toHaveURL(signInFor(address));
    });
  });
});

test.describe("the Guard console's inventory", () => {
  test("is exactly the eight destinations, in order, at their routes", async ({ page, seed }) => {
    await openConsole(page, seed, "/nowhere");
    await expect(page.getByTestId("not-found")).toBeVisible();
    const links = sidebarNav(page).getByRole("link");
    await expect(links).toHaveText(ROWS.map((destination) => new RegExp(`^${destination.label}(, \\d+)?$`)));
    for (const [index, destination] of ROWS.entries()) await expect(links.nth(index)).toHaveAttribute("href", consolePath(seed, destination.route));
    await expect(gear(page)).toHaveAttribute("href", consolePath(seed, "/settings"));
    for (const destination of DESTINATIONS) {
      await linkTo(page, destination).click();
      await expect.poll(() => routeOf(page, seed), destination.label).toEqual({ pathname: destination.route, search: "" });
      await expect(page.getByTestId(destination.testId)).toBeVisible();
      await expect(barTitle(page)).toHaveText(destination.label);
      await expect(linkTo(page, destination)).toHaveAttribute("aria-current", "page");
      await expect(litRows(page), destination.label).toHaveCount(destination.place === "sidebar" ? 1 : 0);
    }
  });

  test("names nothing from the main console's other surfaces", async ({ page, seed }) => {
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("settings-page")).toBeVisible();
    await expect(barTitle(page)).toHaveText("Settings");
    await expect(sidebarNav(page).getByRole("link")).toHaveCount(ROWS.length);
    const words = await chromeWords(page);
    for (const destination of DESTINATIONS) expect(words, destination.label).toContain(destination.label.toLowerCase());
    for (const banned of MAIN_CONSOLE_WORDS) expect(words, String(banned)).not.toMatch(banned);
  });

  test("lights the destination an address belongs to, and nothing for a 404", async ({ page, seed }) => {
    await openConsole(page, seed, "/services");
    await expect(page.getByTestId("services-page")).toBeVisible();
    await expect(row(page, "AI services")).toHaveAttribute("aria-current", "page");
    await expect(litRows(page)).toHaveCount(1);
    await openConsole(page, seed, "/nowhere");
    await expect(page.getByTestId("not-found")).toContainText("There is nothing at this address");
    await expect(barTitle(page)).toHaveText("Not found");
    await expect(sidebarNav(page).getByRole("link")).toHaveCount(ROWS.length);
    await expect(litRows(page)).toHaveCount(0);
    await expect(gear(page)).not.toHaveAttribute("aria-current");
  });

  test.describe("as a member", () => {
    test.use({ storageState: MEMBER });

    test("canVisit: an unknown address is the router's 404, not the admin-only notice", async ({ page, seed }) => {
      await openConsole(page, seed, "/nowhere");
      await expect(page.getByTestId("not-found")).toContainText("There is nothing at this address");
      await expect(page.getByTestId("admin-only")).toHaveCount(0);
      await expect(sidebarNav(page).getByRole("link")).toHaveCount(0);
    });
  });
});

test.describe("basenameFromPath", () => {
  test("/<handle>/guard and every route under it → /<handle>/guard", async ({ page, seed }) => {
    for (const destination of DESTINATIONS) {
      await openConsole(page, seed, destination.route);
      await expect(page.getByTestId(destination.testId), destination.route).toBeVisible();
      await expect(barTitle(page), destination.route).toHaveText(destination.label);
    }
  });

  test("/<handle>/guard/ → /<handle>/guard", async ({ page, seed }) => {
    await page.goto(`${consolePath(seed)}/`);
    await expect(page.getByTestId("overview-page")).toBeVisible();
    await expect(barTitle(page)).toHaveText("Overview");
    await expect(row(page, "Overview")).toHaveAttribute("aria-current", "page");
    await expect(row(page, "Rules")).toHaveAttribute("href", consolePath(seed, "/rules"));
  });
});

test.describe("addresses", () => {
  test.use({ storageState: SIGNED_OUT });

  test("composes /<handle>/guard + the route", async ({ page, seed }) => {
    for (const address of [consolePath(seed), `${consolePath(seed, "/devices")}?enrol=1`]) {
      await page.goto(address, { waitUntil: "commit" });
      await expect(page).toHaveURL(signInFor(address));
    }
  });
});
