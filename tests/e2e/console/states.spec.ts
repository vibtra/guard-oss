import type { Page } from "@playwright/test";
import { expect, openConsole, test } from "./support/console.ts";
import { answerDoors, refused } from "./support/doors.ts";
import { ORG_DOMAIN } from "./support/env.ts";
import type { Seed } from "./support/seed.ts";

interface PageCase {
  name: string;
  route: string;
  door: string;
  ready: (page: Page, seed: Seed) => Promise<void>;
}

const SKELETON = "[data-slot='page-skeleton'], [data-slot='door-skeleton']";
const DOOR_ERROR = "[data-slot='door-error']";

const CASES: readonly PageCase[] = [
  {
    name: "Overview",
    route: "/",
    door: "GET /guard/overview",
    ready: async (page) => {
      const services = page.getByTestId("overview-service-row");
      await expect(services.getByText("ChatGPT", { exact: true })).toBeVisible();
      await expect(services.getByText("Claude", { exact: true })).toBeVisible();
    },
  },
  {
    name: "Activity",
    route: "/activity",
    door: "GET /guard/activity",
    ready: async (page) => {
      const table = page.getByRole("table", { name: "Activity" });
      await expect(table.getByText("Grace Ho", { exact: true }).first()).toBeVisible();
      await expect(table.getByText("Tax file numbers", { exact: true }).first()).toBeVisible();
    },
  },
  {
    name: "Rules",
    route: "/rules",
    door: "GET /guard/rules",
    ready: async (page) => {
      await expect(page.getByText("Data leaves Australia", { exact: true })).toBeVisible();
    },
  },
  {
    name: "Requests",
    route: "/requests",
    door: "GET /policy-requests",
    ready: async (page) => {
      const table = page.getByRole("table", { name: "Requests to review" });
      await expect(table.getByText("ChatGPT · Tax file numbers", { exact: true }).first()).toBeVisible();
      await expect(table.getByText("graces-air", { exact: true }).first()).toBeVisible();
    },
  },
  {
    name: "Devices",
    route: "/devices",
    door: "GET /guard/devices",
    ready: async (page) => {
      await expect(page.getByRole("table", { name: "Devices" }).getByText("graces-air", { exact: true })).toBeVisible();
    },
  },
  {
    name: "AI services",
    route: "/services",
    door: "GET /guard/services",
    ready: async (page) => {
      await expect(page.getByRole("table", { name: "AI services" }).getByText("Acme AI", { exact: true })).toBeVisible();
    },
  },
  {
    name: "Settings",
    route: "/settings",
    door: "GET /guard/settings",
    ready: async (page, seed) => {
      const settings = page.getByTestId("settings-page");
      const domain = settings.locator("[data-slot=settings-row]").filter({ has: page.getByText("Domain", { exact: true }) });
      await expect(domain.getByText(ORG_DOMAIN, { exact: true })).toBeVisible();
      await expect(settings.getByText(`/${seed.handle}`, { exact: true })).toBeVisible();
    },
  },
];

for (const { name, route, door, ready } of CASES) {
  test.describe(`${name} renders its four states`, () => {
    test("loading: a skeleton while the door has not answered", async ({ page, seed }) => {
      await answerDoors(page, { [door]: "pending" });
      await openConsole(page, seed, route);
      await expect(page.locator(SKELETON).first()).toBeVisible();
    });

    test("ready: the view model the registry sent, nothing invented", async ({ page, seed }) => {
      await openConsole(page, seed, route);
      await ready(page, seed);
    });

    test("error: the refusal's code and sentence, and Try again", async ({ page, seed }) => {
      await answerDoors(page, { [door]: refused(500, "GUARD_BROKEN", "The guard store did not answer") });
      await openConsole(page, seed, route);
      const panel = page.locator(DOOR_ERROR);
      await expect(panel.getByText("The guard store did not answer", { exact: true })).toBeVisible();
      await expect(panel.getByText("GUARD_BROKEN", { exact: true })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    });

    test("signed out: a sign-in link to the apex /login, never an empty table", async ({ page, seed }) => {
      await answerDoors(page, { [door]: refused(401, "UNAUTHENTICATED", "Sign in") });
      await openConsole(page, seed, route);
      const panel = page.locator(DOOR_ERROR);
      await expect(panel.getByText("Your session has ended", { exact: true })).toBeVisible();
      await expect(panel.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", /^\/login/);
      await expect(page.locator("[data-slot='data-table']")).toHaveCount(0);
    });
  });
}
