import { expect, openConsole, test } from "./support/console.ts";

const PAGES = [
  { route: "/", testId: "overview-page" },
  { route: "/activity", testId: "activity-page" },
  { route: "/rules", testId: "rules-page" },
  { route: "/requests", testId: "requests-page" },
  { route: "/devices", testId: "devices-page" },
  { route: "/people", testId: "people-page" },
  { route: "/services", testId: "services-page" },
  { route: "/settings", testId: "settings-page" },
];

test.describe("the Guard console follows the theme", () => {
  test("no element outside a brand mark carries a raw colour in its inline style, on any of the eight pages", async ({ page, seed }) => {
    for (const { route, testId } of PAGES) {
      await openConsole(page, seed, route);
      await expect(page.getByTestId(testId), route).toBeVisible();
      const raw = await page.evaluate(() =>
        [...document.querySelectorAll("[style]")]
          .filter((node) => node.closest("svg") === null)
          .map((node) => node.getAttribute("style") ?? "")
          .filter((style) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/.test(style)),
      );
      expect(raw, route).toEqual([]);
    }
  });
});
