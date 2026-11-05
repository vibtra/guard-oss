import type { Locator, Page } from "@playwright/test";
import { ConsolePolicyDecided, ConsolePolicyGrantsPage, ConsolePolicyRequestsPage } from "@vibtra/console-api";
import { adminApi, agentFor, choose, expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, type Doors } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const opener = (page: Page, name: string | RegExp): Locator =>
  page.getByRole("button", typeof name === "string" ? { name, exact: true } : { name });
const actionsOf = (row: Locator): Locator => row.getByRole("button", { name: /^Actions for/ });

const desk = (extra: Doors = {}): Doors => ({
  "GET /policy-requests": { body: fixtures.policyRequests() },
  "GET /people": { body: fixtures.people() },
  ...extra,
});

const decided = (status: "approved" | "declined"): ConsolePolicyDecided =>
  ConsolePolicyDecided.parse({ request: { ...fixtures.policyRequests().requests[0], status } });

test.describe("Requests", () => {
  test("reads the desk filtered to kind=guard and pending, opens the decide sheet from the row, and Approve posts {grant: {days: 7}}", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, desk({ "POST /policy-requests/preq_guard_1/approve": { body: decided("approved") } }));
    await openConsole(page, seed, "/requests");
    const ask = opener(page, /Grace Ho/);
    await expect(ask).toBeVisible();
    const reads = calls.filter((c) => c.method === "GET" && c.path === "/policy-requests");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map((c) => [c.query.get("kind"), c.query.get("status")])).toEqual(reads.map(() => ["guard", "pending"]));
    await expect(page.getByRole("tab", { name: /Needs review/ })).toHaveText("Needs review1");

    await ask.click();
    const sheet = page.getByTestId("decide-sheet");
    await expect(sheet).toContainText("graces-air · Google Chrome");
    await expect(sheet).toContainText("Tax file number");
    await expect.poll(() => routeOf(page, seed).search).toBe("?request=preq_guard_1");
    await page.getByRole("button", { name: "Approve for 7 days", exact: true }).click();
    await expect
      .poll(() => calls.find((c) => c.method === "POST" && c.path === "/policy-requests/preq_guard_1/approve")?.body)
      .toEqual({ grant: { days: 7 } });
  });

  test("an hour for everyone sends hours and the org scope, and the row is decided in place", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, desk({ "POST /policy-requests/preq_guard_1/approve": { body: decided("approved") } }));
    await openConsole(page, seed, "/requests?request=preq_guard_1");
    const sheet = page.getByTestId("decide-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("select")).toHaveCount(0);
    await choose(page.getByRole("combobox", { name: "For", exact: true }), "1 hour");
    await choose(page.getByRole("combobox", { name: "Who", exact: true }), "Everyone");
    await page.getByLabel("Note", { exact: true }).fill("for the audit");
    await page.getByRole("button", { name: "Approve for 1 hour", exact: true }).click();
    await expect
      .poll(() => calls.find((c) => c.method === "POST" && c.path.endsWith("/approve"))?.body)
      .toEqual({ grant: { hours: 1, scope: "org" }, note: "for the audit" });
    await expect(page.getByTestId("desk-status")).toHaveAttribute("data-status", "approved");
    await expect(sheet).toHaveCount(0);
  });

  test("Decline needs a reason and sends it", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, desk({ "POST /policy-requests/preq_guard_1/decline": { body: decided("declined") } }));
    await openConsole(page, seed, "/requests");
    await opener(page, /Grace Ho/).click();
    const sheet = page.getByTestId("decide-sheet");
    await expect(sheet).toBeVisible();
    const decline = page.getByRole("radio", { name: /^Decline/ });
    await page.locator("[data-slot=radio-card]").filter({ has: decline }).click();
    await expect(decline).toBeChecked();
    const submit = page.getByRole("button", { name: "Decline request", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    const reason = page.getByLabel("Reason", { exact: true });
    await expect(sheet.getByRole("alert")).toContainText("Say why you are declining");
    await expect(reason).toHaveAttribute("aria-invalid", "true");
    await expect(reason).toHaveAttribute("aria-describedby", "decline-note-error");
    await expect(reason).toBeFocused();
    expect(calls.some((c) => c.path.endsWith("/decline"))).toBe(false);
    await reason.fill("Use the workspace");
    await submit.click();
    await expect.poll(() => calls.find((c) => c.method === "POST" && c.path.endsWith("/decline"))?.body).toEqual({ note: "Use the workspace" });
  });

  test("the row menu reviews or copies", async ({ page, seed }) => {
    await answerDoors(page, desk());
    await openConsole(page, seed, "/requests");
    await actionsOf(page.getByRole("row").filter({ has: opener(page, /Grace Ho/) })).click();
    await expect(menuItem(page, "Copy ID")).toBeVisible();
    await menuItem(page, "Review").click();
    await expect(page.getByTestId("decide-sheet")).toBeVisible();
    await expect.poll(() => routeOf(page, seed).search).toBe("?request=preq_guard_1");
  });

  test("Reviewed keeps the decided asks, and a decided ask opens read-only", async ({ page, seed }) => {
    const pending = fixtures.policyRequests();
    const reviewed = ConsolePolicyRequestsPage.parse({
      requests: [
        ...pending.requests,
        { ...pending.requests[0], id: "preq_guard_9", status: "declined", decisionNote: "Use the workspace", decidedAt: fixtures.iso() },
      ],
    });
    await answerDoors(page, {
      "GET /policy-requests": (call) => ({ body: call.query.get("status") === "pending" ? pending : reviewed }),
      "GET /people": { body: fixtures.people() },
    });
    await openConsole(page, seed, "/requests");
    await expect(opener(page, /Grace Ho/)).toBeVisible();
    await page.getByRole("tab", { name: "Reviewed", exact: true }).click();
    await expect
      .poll(() => page.getByTestId("desk-status").evaluateAll((pills) => pills.map((pill) => pill.getAttribute("data-status"))))
      .toEqual(["declined"]);
    await opener(page, /Grace Ho/).click();
    await expect(page.getByTestId("decide-sheet")).toContainText("Use the workspace");
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close", exact: true }).filter({ hasText: /^Close$/ })).toBeVisible();
  });

  test("Grants lists only guard grants and revokes behind a confirmation", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      desk({ "GET /policy-grants": { body: fixtures.policyGrants() }, "POST /policy-grants/pgr_guard_1/revoke": { body: {} } }),
    );
    await openConsole(page, seed, "/requests");
    await page.getByRole("tab", { name: "Grants", exact: true }).click();
    await expect(page.getByTestId("grant-state")).toHaveCount(1);
    const grant = page.getByRole("row").filter({ has: page.getByTestId("grant-state") });
    await expect(grant).toContainText("ChatGPT · Tax file numbers");
    await actionsOf(grant).click();
    await menuItem(page, "Revoke…").click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    await confirm.getByRole("button", { name: "Revoke exception", exact: true }).click();
    await expect.poll(() => calls.filter((c) => c.method === "POST" && c.path === "/policy-grants/pgr_guard_1/revoke").length).toBe(1);
  });
});

test.describe("empty states, Reset and lapsed grants", () => {
  test("Requests: Needs review empty says Nothing waiting; Reviewed empty says No requests reviewed yet; Grants empty says No grants", async ({ page, seed }) => {
    await answerDoors(page, {
      "GET /policy-requests": { body: { requests: [] } },
      "GET /people": { body: fixtures.people() },
      "GET /policy-grants": { body: { grants: [] } },
    });
    await openConsole(page, seed, "/requests");
    await expect(page.getByTestId("desk-empty")).toContainText("Nothing waiting");
    await page.getByRole("tab", { name: "Reviewed", exact: true }).click();
    await expect(page.getByTestId("desk-empty")).toContainText("No requests reviewed yet");
    await page.getByRole("tab", { name: "Grants", exact: true }).click();
    await expect(page.getByTestId("grants-empty")).toContainText("No grants");
  });

  test("a lapsed grant is badged and offers no Revoke; an org-wide grant reads Everyone", async ({ page, seed }) => {
    const [grant] = fixtures.policyGrants().grants;
    const grants = ConsolePolicyGrantsPage.parse({
      grants: [
        { ...grant, id: "pgr_guard_old", live: false, expiresAt: fixtures.iso(-fixtures.MIN) },
        { ...grant, id: "pgr_guard_org", scope: "org", userId: undefined, expiresAt: undefined },
      ],
    });
    await answerDoors(page, desk({ "GET /policy-grants": { body: grants } }));
    await openConsole(page, seed, "/requests");
    await page.getByRole("tab", { name: "Grants", exact: true }).click();
    const rows = page.getByRole("row").filter({ has: page.getByTestId("grant-state") });
    await expect(rows).toHaveCount(2);
    const old = rows.filter({ has: page.locator("[data-live=false]") });
    await expect(old.getByText("Lapsed", { exact: true })).toBeVisible();
    await actionsOf(old).click();
    await expect(menuItem(page, "Copy ID")).toBeVisible();
    await expect(menuItem(page, "Revoke…")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const everyone = rows.filter({ has: page.locator("[data-live=true]") });
    await expect(everyone.getByText("Everyone", { exact: true })).toBeVisible();
    await expect(everyone).toContainText("Until revoked");
  });
});

test.describe("Requests on the seeded registry", () => {
  test("Grace's pending ask is listed and opens the decide sheet", async ({ page, seed }) => {
    await openConsole(page, seed, "/requests");
    await opener(page, 'Grace Ho: sending what the rule "Tax file numbers" blocks to ChatGPT, review').click();
    const sheet = page.getByTestId("decide-sheet");
    await expect(sheet).toContainText("graces-air · Google Chrome");
    await expect(sheet).toContainText("Tax file number");
    await expect.poll(() => routeOf(page, seed).search).toBe(`?request=${seed.requests.pending}`);
    await expect(page.getByRole("button", { name: "Approve for 7 days", exact: true })).toBeVisible();
  });

  test("an ask filed from graces-air is approved on the page and the registry holds it approved", async ({ page, seed }) => {
    const filed = await agentFor(seed.devices.gracesAir).ask({ serviceId: "xai-grok", app: "Google Chrome" });
    const requestId = filed.request.requestId;
    const { calls } = await answerDoors(page, {});
    await openConsole(page, seed, "/requests");
    await opener(page, "Grace Ho: using Grok from their laptop, review").click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?request=${requestId}`);
    await expect(page.getByTestId("decide-sheet")).toContainText("graces-air · Google Chrome");
    await page.getByRole("button", { name: "Approve for 7 days", exact: true }).click();
    await expect(page.getByTestId("decide-sheet")).toHaveCount(0);
    expect(calls.find((c) => c.method === "POST" && c.path === `/policy-requests/${requestId}/approve`)?.body).toEqual({ grant: { days: 7 } });
    const admin = await adminApi(seed);
    const listed = await admin.read(ConsolePolicyRequestsPage, "/policy-requests?kind=guard");
    expect(listed.requests.find((row) => row.id === requestId)?.status).toBe("approved");
  });
});
