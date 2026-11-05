import { createServer } from "node:http";
import type { Locator, Page, Request, Route } from "@playwright/test";
import {
  CONSOLE_API_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  ConsolePolicyDecided,
  ConsolePolicyGrantsPage,
  ConsolePolicyRequestsPage,
  ORG_HANDLE_HEADER,
} from "@vibtra/console-api";
import { consolePath, expect, menuItem, openConsole, test } from "./support/console.ts";
import { answerDoors, refused } from "./support/doors.ts";
import { REGISTRY_URL } from "./support/env.ts";
import { activity, deviceRow, devices, event, iso, people, policyGrants, policyRequests, services } from "./support/fixtures.ts";
import { SESSION_COOKIE } from "./support/registry.ts";
import type { Seed } from "./support/seed.ts";

const SKELETON = "[data-slot='page-skeleton'], [data-slot='door-skeleton']";
const DOOR_ERROR = "[data-slot='door-error']";
const REDACTION_NOTE = "A connection string in this sentence had its user and password removed before it was shown.";
const GRANT_ACTIONS = "Actions for ChatGPT · Tax file numbers, Grace Ho";
const GRANT_REVOKE = "POST /policy-grants/pgr_guard_1/revoke";
const REASON = "Use the workspace";

const door = (path: string) => (url: URL): boolean => url.pathname === `${CONSOLE_API_PREFIX}${path}`;

const holdDoor = async (page: Page, path: string): Promise<Route[]> => {
  const held: Route[] = [];
  await page.route(door(path), async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    held.push(route);
  });
  return held;
};

const nth = async (held: readonly Route[], index: number): Promise<Route> => {
  await expect.poll(() => held.length).toBeGreaterThan(index);
  const route = held[index];
  if (route === undefined) throw new Error(`the door was asked ${held.length} times, not ${index + 1}`);
  return route;
};

const openDetails = async (page: Page): Promise<Locator> => {
  const details = page.locator(DOOR_ERROR).locator("details");
  await details.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
  return details;
};

const csrfCookie = async (page: Page): Promise<string> => {
  const cookie = (await page.context().cookies()).find((candidate) => candidate.name === CSRF_COOKIE);
  if (cookie === undefined || cookie.value === "") throw new Error(`the registry set no ${CSRF_COOKIE} cookie`);
  return cookie.value;
};

const watchSkeletons = async (page: Page): Promise<Locator> => {
  await page.evaluate((selector) => {
    const root = document.documentElement;
    root.dataset.e2eSkeletons = "0";
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null)) {
            root.dataset.e2eSkeletons = String(Number(root.dataset.e2eSkeletons) + 1);
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, SKELETON);
  return page.locator("html");
};

const chooseDecline = async (page: Page): Promise<Locator> => {
  const sheet = page.getByRole("dialog", { name: "Review request" });
  await sheet.getByText("Decline", { exact: true }).click();
  await sheet.getByLabel("Reason", { exact: true }).fill(REASON);
  return sheet.getByRole("button", { name: "Decline request", exact: true });
};

const openGrants = async (page: Page, seed: Seed): Promise<void> => {
  await openConsole(page, seed, "/requests");
  await page.getByRole("tab", { name: "Grants", exact: true }).click();
};

const revokeGrant = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: GRANT_ACTIONS, exact: true }).click();
  await menuItem(page, "Revoke…").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke exception", exact: true }).click();
};

const DECLINED: ConsolePolicyDecided = ConsolePolicyDecided.parse({ request: { ...policyRequests().requests[0], status: "declined", decisionNote: REASON } });

const LAPSED: ConsolePolicyGrantsPage = ConsolePolicyGrantsPage.parse({ grants: policyGrants().grants.map((grant) => ({ ...grant, live: false, revokedAt: iso() })) });

const BLOCKED_ONLY = activity({ rows: [event()], nextCursor: undefined, total: 1 });

const cutShort = async (): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    const cors = { "access-control-allow-origin": request.headers.origin ?? REGISTRY_URL, "access-control-allow-credentials": "true" };
    if (request.method === "OPTIONS") {
      response.writeHead(204, { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": request.headers["access-control-request-headers"] ?? "*" });
      response.end();
      return;
    }
    response.writeHead(200, { ...cors, "content-type": "application/json", "content-length": "4096" });
    response.write('{"document":{', () => response.socket?.end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the cut-short server did not get a port");
  return {
    url: `http://127.0.0.1:${address.port}/cut-short`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

test.describe("call", () => {
  test("a fetch that throws is NETWORK, status 0, with the cause as the detail", async ({ page, seed }) => {
    await page.route(door("/guard/rules"), (route) => route.abort());
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("Could not reach the registry", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("NETWORK");
    await expect(panel.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await expect((await openDetails(page)).locator("p").first()).toHaveText("Failed to fetch");
  });

  test("a refusal keeps the registry's code, sentence, detail and body: the code, the sentence and the detail are drawn", async ({ page, seed }) => {
    await answerDoors(page, {
      "GET /guard/rules": refused(409, "GUARD_UPGRADE_REQUIRED", "Two laptops run an agent too old for these rules", "Update adas-mbp and graces-air, then open this page again"),
    });
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("Two laptops run an agent too old for these rules", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("GUARD_UPGRADE_REQUIRED");
    await expect((await openDetails(page)).locator("p").first()).toHaveText("Update adas-mbp and graces-air, then open this page again");
  });

  test("a refusal keeps the registry's code, sentence, detail and body: a 401 is signed out", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": refused(401, "UNAUTHENTICATED", "Sign in", "the session expired") });
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("Your session has ended", { exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", /^\/login/);
    await expect(panel.getByRole("button", { name: "Try again" })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("the session expired");
  });

  test("a refusal that is not the error shape says the status; a non-JSON body carries no body: a 502 page of HTML", async ({ page, seed }) => {
    await page.route(door("/guard/rules"), (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad Gateway</html>" }));
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("The registry answered 502", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("INTERNAL");
    await expect(panel.locator("details")).toHaveCount(0);
  });

  test("a refusal that is not the error shape says the status; a non-JSON body carries no body: a 403 without the error shape", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": { status: 403, body: { reason: "admin_only" } } });
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("The registry refused this request (403). Try again, or sign in again if it keeps happening.", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("INTERNAL");
  });

  test("an answer this build cannot read is VALIDATION, naming the field and saying to upgrade both together: a field of the wrong type", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/devices": { body: { ...devices(), rows: [{ ...deviceRow(), hostname: 42 }] } } });
    await openConsole(page, seed, "/devices");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("This console does not understand the registry's answer", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("VALIDATION");
    const detail = (await openDetails(page)).locator("p").first();
    await expect(detail).toContainText("must be upgraded together");
    await expect(detail).toContainText("rows.0.hostname: Expected string, received number");
  });

  test("an answer this build cannot read is VALIDATION, naming the field and saying to upgrade both together: a body that is not JSON", async ({ page, seed }) => {
    await page.route(door("/guard/rules"), (route) => route.fulfill({ status: 200, contentType: "application/json", body: "not json" }));
    await openConsole(page, seed, "/rules");
    await expect(page.locator(DOOR_ERROR).locator("code")).toHaveText("VALIDATION");
    await expect((await openDetails(page)).locator("p").first()).toContainText("(root): Required");
  });

  test("asks under /api/console with credentials, and sends the org handle from the address", async ({ page, seed }) => {
    const finished: Request[] = [];
    page.on("requestfinished", (request) => {
      if (new URL(request.url()).pathname.startsWith(`${CONSOLE_API_PREFIX}/`)) finished.push(request);
    });
    await openConsole(page, seed, "/devices");
    await expect(page.getByRole("table", { name: "Devices" }).getByText("graces-air", { exact: true })).toBeVisible();
    await expect
      .poll(() => finished.map((request) => new URL(request.url()).pathname))
      .toEqual(expect.arrayContaining([`${CONSOLE_API_PREFIX}/session`, `${CONSOLE_API_PREFIX}/guard/devices`, `${CONSOLE_API_PREFIX}/guard/devices/enrol-links`]));
    for (const request of finished) {
      const headers = await request.allHeaders();
      expect(headers[ORG_HANDLE_HEADER], request.url()).toBe(seed.handle);
      expect(headers.accept, request.url()).toBe("application/json");
      expect(headers.cookie ?? "", request.url()).toContain(`${SESSION_COOKIE}=`);
    }
  });

  test("sends no org handle when the console runs on the apex, an address with no handle", async ({ page, seed }) => {
    await page.route(
      (url) => url.pathname === "/",
      async (route) => route.fulfill({ response: await route.fetch({ url: new URL(consolePath(seed), REGISTRY_URL).toString() }) }),
    );
    const asked: Request[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.startsWith(`${CONSOLE_API_PREFIX}/`)) asked.push(request);
    });
    await page.goto("/");
    await expect.poll(() => asked.map((request) => new URL(request.url()).pathname)).toContain(`${CONSOLE_API_PREFIX}/session`);
    for (const request of asked) {
      const headers = await request.allHeaders();
      expect(headers[ORG_HANDLE_HEADER], request.url()).toBeUndefined();
      expect(headers.accept, request.url()).toBe("application/json");
    }
  });
});

test.describe("send and write", () => {
  test("with no CSRF cookie a write is DEPLOY_AUTH_EXPIRED and nothing is sent", async ({ page, seed }) => {
    const pending = encodeURIComponent(seed.requests.pending);
    const { calls } = await answerDoors(page, { [`POST /policy-requests/${pending}/decline`]: { body: DECLINED } });
    await openConsole(page, seed, `/requests?request=${pending}`);
    const submit = await chooseDecline(page);
    await page.context().clearCookies({ name: CSRF_COOKIE });
    await expect.poll(() => page.evaluate(() => document.cookie)).not.toContain(`${CSRF_COOKIE}=`);
    await submit.click();
    await expect(page.getByText(/^Sign in again to make this change\./)).toBeVisible();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("echoes the CSRF cookie in the header; a body is JSON with its content type, a DELETE without one has neither: a decline with a body", async ({ page, seed }) => {
    const pending = encodeURIComponent(seed.requests.pending);
    const { calls } = await answerDoors(page, { [`POST /policy-requests/${pending}/decline`]: { body: DECLINED } });
    await openConsole(page, seed, `/requests?request=${pending}`);
    const submit = await chooseDecline(page);
    const csrf = await csrfCookie(page);
    await submit.click();
    await expect.poll(() => calls.filter((call) => call.method === "POST").length).toBe(1);
    const post = calls.find((call) => call.method === "POST");
    expect(post?.path).toBe(`/policy-requests/${pending}/decline`);
    expect(post?.headers[CSRF_HEADER]).toBe(csrf);
    expect(post?.headers["content-type"]).toBe("application/json");
    expect(post?.body).toEqual({ note: REASON });
  });

  test("echoes the CSRF cookie in the header; a body is JSON with its content type, a DELETE without one has neither: a DELETE with no body", async ({ page, seed }) => {
    const path = `/guard/services/${encodeURIComponent(seed.customServiceId)}`;
    const { calls } = await answerDoors(page, { [`DELETE ${path}`]: { body: services() } });
    await openConsole(page, seed, "/services");
    await page.getByRole("button", { name: "Actions for Acme AI", exact: true }).click();
    await menuItem(page, "Delete…").click();
    const csrf = await csrfCookie(page);
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete service", exact: true }).click();
    await expect(page.getByText("Acme AI left the catalogue.", { exact: true })).toBeVisible();
    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path)).toEqual([path]);
    expect(deletes[0]?.headers[CSRF_HEADER]).toBe(csrf);
    expect(deletes[0]?.headers["content-type"]).toBeUndefined();
    expect(deletes[0]?.body).toBeUndefined();
  });
});

test.describe("the doors' addresses", () => {
  test("queryOf drops empty values and encodes the rest: the Activity search asks ?limit=50&q=a%20b%26c", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {});
    await openConsole(page, seed, "/activity");
    const asked = () => calls.filter((call) => call.method === "GET" && call.path === "/guard/activity").map((call) => call.search);
    await expect.poll(asked).toEqual(["?limit=50"]);
    await page.getByRole("searchbox", { name: "Search activity" }).fill("a b&c");
    await expect.poll(asked).toContain("?limit=50&q=a%20b%26c");
  });

  test("the policy desk's doors: filters, one path segment per id, the decision bodies: Needs review and Reviewed ask kind=guard", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {});
    await openConsole(page, seed, "/requests");
    const asked = () => calls.filter((call) => call.method === "GET" && call.path === "/policy-requests").map((call) => call.search);
    await expect.poll(asked).toContain("?kind=guard&status=pending");
    expect(asked()).not.toContain("?kind=guard");
    await page.getByRole("tab", { name: "Reviewed", exact: true }).click();
    await expect.poll(asked).toContain("?kind=guard");
  });

  test("the policy desk's doors: filters, one path segment per id, the decision bodies: a decline is one path segment per id with the note as its body", async ({ page, seed }) => {
    const slashed = ConsolePolicyRequestsPage.parse({ requests: [{ ...policyRequests().requests[0], id: "preq/1" }] });
    const { calls } = await answerDoors(page, {
      "GET /people": { body: people() },
      "GET /policy-requests": { body: slashed },
      "POST /policy-requests/preq%2F1/decline": { body: DECLINED },
    });
    await openConsole(page, seed, `/requests?request=${encodeURIComponent("preq/1")}`);
    await (await chooseDecline(page)).click();
    await expect
      .poll(() => calls.filter((call) => call.method === "POST").map((call) => ({ path: call.path, body: call.body })))
      .toEqual([{ path: "/policy-requests/preq%2F1/decline", body: { note: REASON } }]);
  });

  test("the policy desk's doors: filters, one path segment per id, the decision bodies: Revoke… posts to the grant's revoke door", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, { "GET /people": { body: people() }, "GET /policy-grants": { body: policyGrants() }, [GRANT_REVOKE]: { body: {} } });
    await openGrants(page, seed);
    await revokeGrant(page);
    await expect(page.getByText("Revoked. Their laptop drops it at its next check-in.", { exact: true })).toBeVisible();
    expect(calls.filter((call) => call.method === "POST").map((call) => ({ path: call.path, body: call.body }))).toEqual([{ path: "/policy-grants/pgr_guard_1/revoke", body: {} }]);
  });

  test("the Guard doors go under /guard and parse through the contract: Devices reads /api/console/guard/devices", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {});
    await openConsole(page, seed, "/devices");
    await expect(page.getByRole("table", { name: "Devices" }).getByText("graces-air", { exact: true })).toBeVisible();
    expect(calls.some((call) => call.method === "GET" && call.path === "/guard/devices")).toBe(true);
  });

  test("the Guard doors go under /guard and parse through the contract: rows that are not rows are VALIDATION", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/devices": { body: { ...devices(), rows: "not rows" } } });
    await openConsole(page, seed, "/devices");
    await expect(page.locator(DOOR_ERROR).locator("code")).toHaveText("VALIDATION");
    await expect((await openDetails(page)).locator("p").first()).toContainText("rows: Expected array, received string");
  });
});

test.describe("useDoor", () => {
  test("wraps anything that is not a ConsoleApiError as INTERNAL, keeping what was thrown as the detail", async ({ page, seed }) => {
    const server = await cutShort();
    try {
      await page.route(door("/guard/rules"), (route) => route.continue({ url: server.url }));
      await openConsole(page, seed, "/rules");
      const panel = page.locator(DOOR_ERROR);
      await expect(panel.getByText("Something went wrong reading this page", { exact: true })).toBeVisible();
      await expect(panel.locator("code")).toHaveText("INTERNAL");
      await expect((await openDetails(page)).locator("p").first()).toHaveText(/\S/);
    } finally {
      await server.close();
    }
  });

  test("passes a ConsoleApiError through unchanged", async ({ page, seed }) => {
    await answerDoors(page, { "GET /guard/rules": refused(404, "GUARD_OFF", "Guard is off") });
    await openConsole(page, seed, "/rules");
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("Guard is off", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("GUARD_OFF");
    await expect(panel.locator("details")).toHaveCount(0);
  });
});

test.describe("useDoor between the question and the answer", () => {
  test("holds the answer already on screen across a reload", async ({ page, seed }) => {
    await answerDoors(page, { "GET /people": { body: people() }, [GRANT_REVOKE]: { body: {} } });
    const grants = await holdDoor(page, "/policy-grants");
    await openGrants(page, seed);
    await (await nth(grants, 0)).fulfill({ json: policyGrants() });
    const state = page.getByTestId("grant-state");
    await expect(state).toHaveText("Active");
    const skeletons = await watchSkeletons(page);
    await revokeGrant(page);
    const reload = await nth(grants, 1);
    await expect(state).toHaveText("Active");
    await expect(page.locator(SKELETON)).toHaveCount(0);
    await reload.fulfill({ json: LAPSED });
    await expect(state).toHaveText("Lapsed");
    await expect(skeletons).toHaveAttribute("data-e2e-skeletons", "0");
  });

  test("goes back to loading when the request itself changes", async ({ page, seed }) => {
    const asks = await holdDoor(page, "/guard/activity");
    await openConsole(page, seed, "/activity");
    await (await nth(asks, 0)).fulfill({ json: activity() });
    await expect(page.getByText(/^2 of 3 events/)).toBeVisible();
    await page.getByRole("tab", { name: "Blocked", exact: true }).click();
    const blocked = await nth(asks, 1);
    expect(new URL(blocked.request().url()).searchParams.get("action")).toBe("blocked");
    await expect(page.locator(SKELETON).first()).toBeVisible();
    await expect(page.getByText(/^2 of 3 events/)).toHaveCount(0);
    await blocked.fulfill({ json: BLOCKED_ONLY });
    await expect(page.getByText("1 of 1 event", { exact: true })).toBeVisible();
  });

  test("replaces the held answer with the refusal rather than leaving it underneath", async ({ page, seed }) => {
    await answerDoors(page, { "GET /people": { body: people() }, [GRANT_REVOKE]: { body: {} } });
    const grants = await holdDoor(page, "/policy-grants");
    await openGrants(page, seed);
    await (await nth(grants, 0)).fulfill({ json: policyGrants() });
    await expect(page.getByTestId("grant-state")).toHaveText("Active");
    await revokeGrant(page);
    await (await nth(grants, 1)).fulfill({ status: 403, json: { code: "FORBIDDEN", message: "Not yours to read" } });
    const panel = page.locator(DOOR_ERROR);
    await expect(panel.getByText("Not yours to read", { exact: true })).toBeVisible();
    await expect(panel.locator("code")).toHaveText("FORBIDDEN");
    await expect(page.getByTestId("grant-state")).toHaveCount(0);
  });

  test("shows the skeleton again when the retry comes FROM an error", async ({ page, seed }) => {
    const asks = await holdDoor(page, "/guard/activity");
    await openConsole(page, seed, "/activity");
    await (await nth(asks, 0)).fulfill({ status: 500, json: { code: "GUARD_BROKEN", message: "The guard store did not answer" } });
    const panel = page.locator(DOOR_ERROR);
    await panel.getByRole("button", { name: "Try again", exact: true }).click();
    const retry = await nth(asks, 1);
    await expect(page.locator(SKELETON).first()).toBeVisible();
    await expect(panel).toHaveCount(0);
    await retry.fulfill({ json: activity() });
    await expect(page.getByText(/^2 of 3 events/)).toBeVisible();
  });

  test("never lets a superseded answer land", async ({ page, seed }) => {
    const asks = await holdDoor(page, "/guard/activity");
    await openConsole(page, seed, "/activity");
    const slow = await nth(asks, 0);
    await page.getByRole("tab", { name: "Blocked", exact: true }).click();
    await (await nth(asks, 1)).fulfill({ json: BLOCKED_ONLY });
    await expect(page.getByText("1 of 1 event", { exact: true })).toBeVisible();
    await slow.fulfill({ json: activity() });
    await (await slow.request().response())?.finished();
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())), 100)));
    await expect(page.getByText("1 of 1 event", { exact: true })).toBeVisible();
    await expect(page.getByText(/^2 of 3 events/)).toHaveCount(0);
  });
});

type Note = "shown" | "absent" | "unasserted";

interface Redaction {
  detail: string;
  shown: string;
  secrets: readonly string[];
  note: Note;
}

const masked = (detail: string, shown: string, secrets: readonly string[]): Redaction => ({ detail, shown, secrets, note: "shown" });
const untouched = (detail: string): Redaction => ({ detail, shown: detail, secrets: [], note: "absent" });

const REDACTIONS: readonly { title: string; cases: readonly Redaction[] }[] = [
  {
    title: "removes the user and the password from a Postgres connection string, and keeps everything else",
    cases: [
      masked(
        "OpenBao could not sign in with postgres://svc:hunter2@db.internal:5432/payroll — check the user exists.",
        "OpenBao could not sign in with postgres://***@db.internal:5432/payroll — check the user exists.",
        ["hunter2", "svc:hunter2"],
      ),
    ],
  },
  {
    title: "takes a bare user with no password, and a token pasted into an https URL",
    cases: [
      masked("mysql://root@10.0.0.4/reporting", "mysql://***@10.0.0.4/reporting", ["root@"]),
      masked("tried https://ghp_notarealtoken@api.example.com/v3/repos", "tried https://***@api.example.com/v3/repos", ["ghp_notarealtoken"]),
    ],
  },
  {
    title: "takes every one of them when a sentence carries more than one",
    cases: [masked("primary postgres://a:one@h1/db failed over to postgres://b:two@h2/db", "primary postgres://***@h1/db failed over to postgres://***@h2/db", ["a:one@", "b:two@"])],
  },
  {
    title: "leaves a sentence with no credentialled URL exactly as the registry wrote it",
    cases: [
      untouched("«Payroll extract» is scoped to 2 people; this tool's audience must be within them."),
      untouched("VIBTRA_DEPLOY_CRED_CLOUDFLARE_TOKEN is not set on this deployment."),
      untouched("ada@fernwood.example is not in this organisation."),
      untouched("open https://db.internal:5432/payroll to check"),
    ],
  },
  {
    title: "leaves an op:// reference whole, because a reference is a name and an admin has to read it",
    cases: [untouched("reads its token from op://Engineering/Vercel/token at every deploy")],
  },
  {
    title: "is idempotent, so a sentence redacted twice is not redacted differently",
    cases: [{ detail: "postgres://***@db/payroll", shown: "postgres://***@db/payroll", secrets: [], note: "unasserted" }],
  },
  {
    title: "says whether it changed anything, so the panel can admit it did",
    cases: [masked("postgres://svc:hunter2@db/payroll", "postgres://***@db/payroll", ["hunter2"]), untouched("nothing was stored"), untouched("https://api.example.com/v3")],
  },
  {
    title: "masks the value of a `password=` query parameter, and keeps the host, the database and the other parameters",
    cases: [masked("postgresql://db.internal/payroll?user=svc&password=hunter2", "postgresql://db.internal/payroll?user=svc&password=***", ["hunter2"])],
  },
  {
    title: "takes `pwd=` too, whatever case the vendor's own documentation uses",
    cases: [
      masked("sqlserver://sql.internal/hr?user=sa&PWD=hunter2&encrypt=true", "sqlserver://sql.internal/hr?user=sa&PWD=***&encrypt=true", ["hunter2"]),
      masked("postgresql://h/db?PassWord=hunter2", "postgresql://h/db?PassWord=***", ["hunter2"]),
      masked("sqlserver://sql.internal/hr?user=sa&PWD=hunter2", "sqlserver://sql.internal/hr?user=sa&PWD=***", ["hunter2"]),
    ],
  },
  {
    title: "leaves the bare words alone in prose, because the fence is the query of a URL",
    cases: [
      untouched("the password= parameter is empty"),
      untouched("pwd= is the ODBC spelling of the same field"),
      untouched("add the password= parameter to the DSN and retry"),
      untouched("open https://db.internal:5432/payroll then set the password= parameter"),
    ],
  },
  {
    title: "does not claim to have removed a query parameter that holds nothing",
    cases: [untouched("postgresql://db.internal/payroll?user=svc&password="), untouched("postgresql://db.internal/payroll?user=svc&sslmode=require")],
  },
  {
    title: "eats the punctuation touching a value rather than risk leaving its last character",
    cases: [
      masked("postgresql://h/db?password=hunter2.", "postgresql://h/db?password=***", ["hunter2"]),
      masked("(postgresql://h/db?password=hunter2)", "(postgresql://h/db?password=***", ["hunter2"]),
      masked("postgresql://h/db?user=svc&password=hunter2).", "postgresql://h/db?user=svc&password=***", ["hunter2"]),
    ],
  },
  {
    title: "is idempotent over its own output, with both spellings in the same URL",
    cases: [
      masked(
        "postgresql://svc:hunter2@db.internal/payroll?user=svc&password=hunter2 — check the user exists.",
        "postgresql://***@db.internal/payroll?user=svc&password=*** — check the user exists.",
        ["hunter2"],
      ),
      {
        detail: "postgresql://***@db.internal/payroll?user=svc&password=*** — check the user exists.",
        shown: "postgresql://***@db.internal/payroll?user=svc&password=*** — check the user exists.",
        secrets: [],
        note: "unasserted",
      },
    ],
  },
  {
    title: "leaves an op:// reference whole even when it is followed by a query",
    cases: [untouched("reads op://Engineering/Postgres/dsn?password=notasecret at every deploy")],
  },
];

test.describe("redactCredentials", () => {
  for (const { title, cases } of REDACTIONS) {
    test.describe(title, () => {
      for (const { detail, shown, secrets, note } of cases) {
        test(detail, async ({ page, seed }) => {
          await answerDoors(page, { "GET /guard/rules": refused(500, "GUARD_BROKEN", "The guard store did not answer", detail) });
          await openConsole(page, seed, "/rules");
          const details = await openDetails(page);
          await expect(details.locator("p").first()).toHaveText(shown);
          for (const secret of secrets) await expect(page.locator("body")).not.toContainText(secret);
          if (note === "shown") await expect(details.getByText(REDACTION_NOTE)).toBeVisible();
          if (note === "absent") await expect(details.getByText(REDACTION_NOTE)).toHaveCount(0);
        });
      }
    });
  }
});
