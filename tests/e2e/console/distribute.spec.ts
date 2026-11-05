import type { Page } from "@playwright/test";
import { GuardDevicesPage, GuardEnrolLinksPage } from "@vibtra/guard-contract";
import { expect, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, refused, type Doors } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const GUIDE = "https://github.com/vibtra/guard-oss/blob/main/docs/guide/self-signing.md";

const fleet = (extra: Doors = {}): Doors => ({
  "GET /guard/devices": { body: fixtures.devices() },
  "GET /guard/devices/enrol-links": { body: fixtures.enrolLinks() },
  "GET /guard/overview": { body: fixtures.overview() },
  ...extra,
});

const sheetOf = (page: Page) => page.getByRole("dialog", { name: "Distribute Guard to your Macs" });

const quoted = (value: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

test.describe("Distribute Guard to your Macs", () => {
  test("offers self-signing now and the Vibtra-signed download later, lists every prerequisite and links the guide", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await page.getByTestId("distribute-open").click();
    const sheet = sheetOf(page);
    await expect(sheet).toBeVisible();

    const self = sheet.getByRole("radio", { name: "Sign it yourself" });
    await expect(self).toBeChecked();
    const vibtra = sheet.getByRole("radio", { name: "Download a Vibtra-signed copy" });
    await expect(vibtra).toBeDisabled();
    await expect(vibtra).not.toBeChecked();
    await expect(sheet.getByRole("radiogroup", { name: "How your Macs get Guard" })).toContainText("Not available yet");

    const needs = sheet.getByRole("list", { name: "What you need" }).getByRole("listitem");
    await expect(needs).toHaveCount(6);
    await expect(needs.nth(0)).toContainText("paid Apple Developer Program membership for your organisation");
    await expect(needs.nth(1)).toContainText("Account Holder");
    await expect(needs.nth(1)).toContainText("does not use Apple’s cloud-managed certificates yet");
    await expect(needs.nth(2)).toContainText("App Store Connect API key with the Admin role");
    await expect(needs.nth(3)).toContainText("Jamf Pro, Kandji or Microsoft Intune");
    await expect(needs.nth(4)).toContainText("A Mac with Xcode, Go and xcodegen");
    await expect(needs.nth(5)).toContainText("re-sign for every Guard release");

    const guides = sheet.getByRole("link", { name: /opens in a new tab$/ });
    await expect(guides).toHaveCount(4);
    for (const anchor of ["#what-you-need-once", "#sign-one-release", "#deliver-it-to-your-macs", "#if-a-step-fails"]) {
      await expect(sheet.locator(`a[href="${GUIDE}${anchor}"]`)).toHaveAttribute("target", "_blank");
    }

    const failures = sheet.getByRole("list", { name: "If a step fails" }).getByRole("listitem");
    expect(await failures.count()).toBeGreaterThanOrEqual(6);
    await expect(sheet.getByRole("list", { name: "If a step fails" })).toContainText("The --out folder already exists, or is inside the checkout");
    for (const item of await failures.all()) {
      const [problem, recovery] = await item.locator(":scope > div > span").allTextContents();
      expect(problem?.length ?? 0).toBeGreaterThan(0);
      expect(recovery ?? "").toMatch(/^(Ask|Make|Read|Clone|Pass|The profile)/);
    }
  });

  test("fills the exact commands from the team, prefix, tag, the organisation and this server, and marks a wrong field with how to fix it", async ({ page, seed }) => {
    await answerDoors(page, fleet({ "GET /people": { body: fixtures.people() } }));
    await openConsole(page, seed, "/devices");
    await page.getByTestId("distribute-open").click();
    const sheet = sheetOf(page);
    const commands = sheet.getByTestId("distribute-commands");
    await expect(commands.getByTestId("distribute-incomplete")).toBeVisible();
    await expect(commands.getByRole("group")).toHaveCount(0);

    const team = sheet.getByRole("textbox", { name: "Team ID", exact: true });
    const prefix = sheet.getByRole("textbox", { name: "Bundle ID prefix", exact: true });
    const tag = sheet.getByRole("textbox", { name: "Guard release tag", exact: true });
    await team.fill("ab12cd34ef");
    await prefix.fill("com acme");
    await tag.fill("guard-v0.2.0");
    await expect(prefix).toHaveAttribute("aria-invalid", "true");
    await expect(prefix).toHaveAttribute("aria-describedby", "distribute-prefix-error");
    await expect(sheet.locator("#distribute-prefix-error")).toHaveText(/^Enter a reverse-DNS name on a domain you own, such as com\.acme\.guard/);
    await expect(team).not.toHaveAttribute("aria-invalid", "true");
    await expect(commands.getByTestId("distribute-incomplete")).toBeVisible();

    await prefix.fill("com.acme.guard");
    await team.focus();
    await expect(prefix).not.toHaveAttribute("aria-invalid", "true");
    await expect(prefix).toHaveAttribute("aria-describedby", "distribute-prefix-hint");

    const clone = commands.getByRole("group", { name: "Get the release", exact: true });
    await expect(clone).toContainText("git clone --branch guard-v0.2.0 https://github.com/vibtra/guard-oss.git guard-v0.2.0 && cd guard-v0.2.0");
    const sign = commands.getByRole("group", { name: "Sign command", exact: true });
    await expect(sign).toHaveText(
      new RegExp(
        `^Sign command${[
          "python3 guard/mac/tools/sign-guard.py --team AB12CD34EF --bundle-prefix com.acme.guard",
          '--key-id "$ASC_KEY_ID" --issuer-id "$ASC_ISSUER_ID" --key-file "$ASC_KEY_FILE"',
          "--tag guard-v0.2.0 --out ../guard-v0.2.0-signed",
          `--organization ${quoted(seed.orgName)}`,
        ]
          .join(" ")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
      ),
    );
    await expect(sign.getByRole("button", { name: "Copy the sign command" })).toBeVisible();

    const deliver = sheet.getByTestId("distribute-deliver");
    await expect(deliver).toContainText("com.acme.guard.mobileconfig");
    await expect(deliver).toContainText("Guard-guard-v0.2.0-AB12CD34EF-arm64.zip");
    await expect(deliver.getByRole("group", { name: "Enrol server", exact: true })).toContainText(fixtures.devices().serverUrl);

    await team.fill("AB12");
    await prefix.focus();
    await expect(team).toHaveAttribute("aria-invalid", "true");
    await expect(sheet.locator("#distribute-team-error")).toHaveText("Enter the 10 letters and digits shown as Team ID under Membership details at developer.apple.com.");
    await expect(commands.getByTestId("distribute-incomplete")).toBeVisible();
    await expect(deliver).toContainText("<bundle ID prefix>.mobileconfig");

    await deliver.getByTestId("distribute-enrol").click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Enrol a laptop" })).toBeVisible();
  });

  test("with no laptop yet the Devices page offers it first; ?distribute=1 opens it and Close clears the address", async ({ page, seed }) => {
    await answerDoors(
      page,
      fleet({
        "GET /guard/devices": { body: GuardDevicesPage.parse({ ...fixtures.devices(), rows: [] }) },
        "GET /guard/devices/enrol-links": { body: GuardEnrolLinksPage.parse({ rows: [] }) },
      }),
    );
    await openConsole(page, seed, "/devices");
    const banner = page.getByTestId("distribute-banner");
    await expect(banner).toContainText("A Vibtra-signed download comes later.");
    await banner.getByRole("button", { name: "Set up distribution", exact: true }).click();
    await expect(sheetOf(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheetOf(page)).toHaveCount(0);

    await openConsole(page, seed, "/devices?distribute=1");
    await expect(sheetOf(page)).toBeVisible();
    await sheetOf(page).getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(sheetOf(page)).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed).search).toBe("");
  });

  test("once laptops are enrolled there is no banner; a failed devices read still opens it and says how to get the enrol step back", async ({ page, seed }) => {
    await answerDoors(page, fleet());
    await openConsole(page, seed, "/devices");
    await expect(page.getByRole("button", { name: /^adas-mbp/ })).toBeVisible();
    await expect(page.getByTestId("distribute-banner")).toHaveCount(0);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await answerDoors(page, fleet({ "GET /guard/devices": refused(500, "INTERNAL", "Something went wrong") }));
    await openConsole(page, seed, "/devices");
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    await page.getByTestId("distribute-open").click();
    const deliver = sheetOf(page).getByTestId("distribute-deliver");
    await expect(deliver.getByTestId("distribute-no-server")).toHaveText(
      "Unable to read this server’s address, so the enrol step cannot be shown. Close this, choose Try again on the Devices page, then open it again.",
    );
    await expect(deliver.getByTestId("distribute-enrol")).toHaveCount(0);
  });
});
