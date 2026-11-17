import type { Locator, Page } from "@playwright/test";
import {
  ConsoleInvitationCreated,
  ConsolePeoplePage,
  OnboardingPage,
  OnboardingSettings,
  type OnboardingRow,
  type OnboardingStage,
} from "@vibtra/console-api";
import { GuardActivityPage, GuardSettingsPage } from "@vibtra/guard-contract";
import { adminApi, choose, expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, refused, type Call, type Doors } from "./support/doors.ts";
import { ADA, DAY, GRACE, HOUR, devices, iso, settings } from "./support/fixtures.ts";

test.use({ locale: "en-US" });

const ONBOARDING = "/people/onboarding";
const ONBOARDING_SETTINGS = "/people/onboarding/settings";
const resendPath = (invitationId: string): string => `/people/invitations/${encodeURIComponent(invitationId)}/resend`;

const BO = { userId: "usr_bo", email: "bo@fernwood.example", name: "Bo Tran" };
const LEE = { invitationId: "inv_lee", email: "lee@example.com" };
const SAM = { invitationId: "inv_sam", email: "sam@example.com" };

const roster = (mayManage = true): ConsolePeoplePage =>
  ConsolePeoplePage.parse({
    rows: [
      { issuer: "x", subject: ADA.userId, email: ADA.email, name: ADA.name, role: "admin", orgRole: "owner", createdAt: iso(-90 * DAY), isYou: true },
      { issuer: "x", subject: BO.userId, email: BO.email, name: BO.name, role: "member", orgRole: "member", createdAt: iso(-60 * DAY), mayManage },
      { issuer: "x", subject: GRACE.userId, email: GRACE.email, name: GRACE.name, role: "member", orgRole: "member", createdAt: iso(-30 * DAY), mayManage },
    ],
    total: 3,
    mayManage,
    mailEnabled: false,
  });

const person = (who: { userId: string; email: string; name: string }, stage: OnboardingStage, sinceMs: number, chase = false): OnboardingRow => ({
  kind: "person",
  userId: who.userId,
  email: who.email,
  name: who.name,
  role: "member",
  stage,
  stageSince: iso(-sinceMs),
  chase,
});

const invite = (who: { invitationId: string; email: string }, sinceMs: number, chase: boolean, lastSentMs = sinceMs): OnboardingRow => ({
  kind: "invite",
  invitationId: who.invitationId,
  email: who.email,
  role: "member",
  stage: "invited",
  stageSince: iso(-sinceMs),
  chase,
  lastSentAt: iso(-lastSentMs),
  expiresAt: iso(7 * DAY),
});

const funnel = (rows: OnboardingRow[] = [person(ADA, "protected", 40 * DAY), person(BO, "late", 5 * HOUR), person(GRACE, "tampered", 2 * DAY), invite(LEE, 9 * DAY, true), invite(SAM, 2 * DAY, false)]): OnboardingPage =>
  OnboardingPage.parse({ rows, chaseAfterDays: 7 });

const resent = (who: { invitationId: string; email: string }, emailed: boolean): ConsoleInvitationCreated =>
  ConsoleInvitationCreated.parse({ invitationId: who.invitationId, email: who.email, role: "member", expiresAt: iso(7 * DAY), emailed });

const doors = (extra: Doors = {}, page: () => OnboardingPage = () => funnel(), mayManage = true): Doors => ({
  "GET /people": { body: roster(mayManage) },
  "GET /groups": { body: { rows: [] } },
  "GET /guard/devices": { body: devices() },
  "GET /guard/activity": { body: GuardActivityPage.parse({ rows: [] }) },
  [`GET ${ONBOARDING}`]: () => ({ body: page() }),
  ...extra,
});

const peopleRow = (page: Page, label: string): Locator => page.getByRole("row").filter({ has: page.getByRole("button", { name: label, exact: true }) });

const chaseRow = (page: Page, email: string): Locator => page.getByTestId("chase-list").getByRole("row").filter({ hasText: email });

const stageIn = (row: Locator): Locator => row.getByTestId("stage");

const openLabels = (page: Page): Promise<(string | null)[]> =>
  page.getByRole("button", { name: /, (details|invitation)$/ }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));

const posts = (calls: readonly Call[], path: string): number => calls.filter((call) => call.method === "POST" && call.path === path).length;

const toast = (page: Page, kind: "success" | "error", words: string): Locator => page.locator(`[data-sonner-toast][data-type="${kind}"]`).filter({ hasText: words });

test.describe("the onboarding funnel on People", () => {
  test("each person and pending invitation shows its stage and how long it has been there", async ({ page, seed }) => {
    await answerDoors(page, doors());
    await openConsole(page, seed, "/people");
    await expect(stageIn(peopleRow(page, `${ADA.name}, details`))).toHaveAttribute("data-stage", "protected");
    await expect(stageIn(peopleRow(page, `${ADA.name}, details`))).toContainText("Protected");
    await expect(stageIn(peopleRow(page, `${ADA.name}, details`))).toContainText("40 days");
    await expect(stageIn(peopleRow(page, `${BO.name}, details`))).toContainText("Late");
    await expect(stageIn(peopleRow(page, `${BO.name}, details`))).toContainText("5 hours");
    await expect(stageIn(peopleRow(page, `${GRACE.name}, details`))).toContainText("Tampered");
    const lee = peopleRow(page, `${LEE.email}, invitation`);
    await expect(lee).toContainText("Invitation pending");
    await expect(stageIn(lee)).toContainText("Invited");
    await expect(stageIn(lee)).toContainText("9 days");
  });

  test("Late and Tampered are called out above the list, and Show narrows the list to them", async ({ page, seed }) => {
    await answerDoors(page, doors());
    await openConsole(page, seed, "/people");
    const bar = page.getByTestId("attention");
    await expect(bar).toContainText("1 Mac failed an integrity check. 1 Mac has stopped syncing.");
    await bar.getByRole("button", { name: "Show Tampered", exact: true }).click();
    await expect.poll(() => openLabels(page)).toEqual([`${GRACE.name}, details`]);
    await page.getByRole("button", { name: "Filter, 1 selected", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Stage/ }).hover();
    await page.getByRole("menuitemcheckbox", { name: /^Late/ }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(() => openLabels(page)).toEqual([`${BO.name}, details`, `${GRACE.name}, details`]);
  });

  test("filtering by Invited lists only the pending invitations", async ({ page, seed }) => {
    await answerDoors(page, doors());
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Stage/ }).hover();
    await page.getByRole("menuitemcheckbox", { name: /^Invited/ }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(() => openLabels(page)).toEqual([`${LEE.email}, invitation`, `${SAM.email}, invitation`]);
  });

  test("with no Late or Tampered Mac there is no call-out", async ({ page, seed }) => {
    await answerDoors(page, doors({}, () => funnel([person(ADA, "protected", DAY), invite(LEE, DAY, false)])));
    await openConsole(page, seed, "/people");
    await expect(stageIn(peopleRow(page, `${ADA.name}, details`))).toContainText("Protected");
    await expect(page.getByTestId("attention")).toHaveCount(0);
  });
});

test.describe("the chase list", () => {
  test("lists only who is stuck, oldest first, and re-sends by email when mail is on", async ({ page, seed }) => {
    let current = funnel([invite(LEE, 9 * DAY, true), invite(SAM, 12 * DAY, true), person(BO, "signed_in", 8 * DAY, true), person(GRACE, "protected", DAY)]);
    const { calls } = await answerDoors(
      page,
      doors(
        {
          [`POST ${resendPath(LEE.invitationId)}`]: () => {
            current = funnel([invite(LEE, 9 * DAY, true, 0), invite(SAM, 12 * DAY, true), person(BO, "signed_in", 8 * DAY, true), person(GRACE, "protected", DAY)]);
            return { body: resent(LEE, true) };
          },
        },
        () => current,
      ),
    );
    await openConsole(page, seed, "/people");
    await page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: /^Chase/ }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=chase");
    const list = page.getByTestId("chase-list");
    await expect(list).toContainText("not enrolled a Mac after 7 days");
    await expect(list.getByRole("row").filter({ hasText: "@" })).toHaveText([new RegExp(SAM.email), new RegExp(BO.email), new RegExp(LEE.email)]);
    await expect(list).not.toContainText(GRACE.email);
    await expect(stageIn(chaseRow(page, BO.email))).toContainText("Signed in");
    await expect(chaseRow(page, BO.email).getByTestId("chase-resend")).toHaveCount(0);
    await expect(chaseRow(page, LEE.email)).toContainText("9 days ago");

    await chaseRow(page, LEE.email).getByRole("button", { name: `Re-send the invitation to ${LEE.email}`, exact: true }).click();
    await expect(toast(page, "success", `Invitation sent again to ${LEE.email}.`)).toBeVisible();
    expect(posts(calls, resendPath(LEE.invitationId))).toBe(1);
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(0);
    await expect(chaseRow(page, LEE.email)).toContainText("just now");
    await expect(page.getByTestId("resend-link")).toHaveCount(0);
  });

  test("with mail off, re-send hands the admin the link to send and never says it emailed", async ({ page, seed }) => {
    await answerDoors(page, doors({ [`POST ${resendPath(LEE.invitationId)}`]: { body: resent(LEE, false) } }));
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, LEE.email).getByTestId("chase-resend").click();
    const dialog = page.getByRole("dialog", { name: "Send this link yourself", exact: true });
    await expect(dialog).toContainText(`nothing was sent. Send ${LEE.email} this link.`);
    await expect(dialog.getByLabel("Invitation link", { exact: true })).toHaveValue(`${new URL(page.url()).origin}/login?invitation=${LEE.invitationId}`);
    await expect(toast(page, "success", "Invitation sent again")).toHaveCount(0);
  });

  test("a refused re-send says why and sends nothing else", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      doors({ [`POST ${resendPath(LEE.invitationId)}`]: refused(409, "CONFLICT", "This invitation was already accepted") }),
    );
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, LEE.email).getByTestId("chase-resend").click();
    await expect(toast(page, "error", `The invitation to ${LEE.email} was not sent again`)).toContainText("This invitation was already accepted.");
    expect(posts(calls, resendPath(LEE.invitationId))).toBe(1);
  });

  test("a person who may not manage people sees the chase list but no re-send", async ({ page, seed }) => {
    await answerDoors(page, doors({}, () => funnel(), false));
    await openConsole(page, seed, "/people?tab=chase");
    await expect(chaseRow(page, LEE.email)).toBeVisible();
    await expect(page.getByTestId("chase-resend")).toHaveCount(0);
  });

  test("nobody stuck says so", async ({ page, seed }) => {
    await answerDoors(page, doors({}, () => funnel([person(ADA, "protected", DAY), invite(SAM, 2 * DAY, false)])));
    await openConsole(page, seed, "/people?tab=chase");
    await expect(page.getByTestId("chase-list")).toContainText("Nobody is stuck");
  });

  test("a failed chase read shows the error and Try again", async ({ page, seed }) => {
    await answerDoors(page, doors({ [`GET ${ONBOARDING}`]: refused(500, "INTERNAL", "The onboarding read failed") }));
    await openConsole(page, seed, "/people?tab=chase");
    await expect(page.getByText("The onboarding read failed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
  });
});

test.describe("a pending invitation's sheet", () => {
  test("opens at ?invitation=, gives the link to copy, and re-sends", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, doors({ [`POST ${resendPath(SAM.invitationId)}`]: { body: resent(SAM, true) } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${SAM.email}, invitation`, exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?invitation=${SAM.invitationId}`);
    const sheet = page.getByTestId("invitation-sheet");
    await expect(sheet.getByLabel("Invitation link", { exact: true })).toHaveValue(`${new URL(page.url()).origin}/login?invitation=${SAM.invitationId}`);
    await sheet.getByTestId("invitation-resend").click();
    await expect(toast(page, "success", `Invitation sent again to ${SAM.email}.`)).toBeVisible();
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(1);
  });

  test("the row's ⋮ re-sends too", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, doors({ [`POST ${resendPath(SAM.invitationId)}`]: { body: resent(SAM, true) } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `Actions for ${SAM.email}`, exact: true }).click();
    await menuItem(page, "Re-send invitation").click();
    await expect(toast(page, "success", `Invitation sent again to ${SAM.email}.`)).toBeVisible();
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(1);
  });
});

test.describe("the chase-after setting", () => {
  test("an admin changes it in Settings and it is saved", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /registration": refused(404, "NOT_FOUND", "No operator"),
      "GET /guard/settings": { body: GuardSettingsPage.parse({ ...settings(), devices: 2 }) },
      [`GET ${ONBOARDING_SETTINGS}`]: { body: OnboardingSettings.parse({ chaseAfterDays: 7 }) },
      [`PUT ${ONBOARDING_SETTINGS}`]: (call) => ({ body: OnboardingSettings.parse(call.body) }),
    });
    await openConsole(page, seed, "/settings");
    const select = page.getByRole("combobox", { name: "Chase after", exact: true });
    await expect(select).toHaveText(/7 days/);
    await choose(select, "14 days");
    await expect(toast(page, "success", "after 14 days are on the chase list")).toBeVisible();
    expect(calls.filter((call) => call.method === "PUT" && call.path === ONBOARDING_SETTINGS).map((call) => call.body)).toEqual([{ chaseAfterDays: 14 }]);
  });
});

test.describe("onboarding on the seeded registry", () => {
  test("invite someone, find them Invited on People and in the chase tab, then re-send their invitation", async ({ page, seed }) => {
    const email = `onboard-${Date.now().toString(36)}@fernwood.example`;
    await openConsole(page, seed, "/people");
    await page.getByTestId("invite-open").click();
    await page.getByTestId("invite-form").getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("dialog", { name: "Invite people", exact: true }).getByRole("button", { name: "Create invitation", exact: true }).click();
    await expect(page.getByText("Invitation ready", { exact: true })).toBeVisible();
    const link = await page.getByTestId("invite-made").getByLabel("Invitation link", { exact: true }).inputValue();
    expect(link).toMatch(/\/login\?invitation=/);
    await page.getByRole("button", { name: "Done", exact: true }).click();

    const row = peopleRow(page, `${email}, invitation`);
    await expect(stageIn(row)).toHaveAttribute("data-stage", "invited");
    await expect(stageIn(row)).toContainText("under an hour");

    await page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: /^Chase/ }).click();
    await expect(page.getByTestId("chase-list")).toContainText("not enrolled a Mac after");
    await expect(chaseRow(page, email)).toHaveCount(0);

    const api = await adminApi(seed);
    const lastSent = async (): Promise<number> => {
      const read = await api.read(OnboardingPage, ONBOARDING);
      const mine = read.rows.find((r) => r.kind === "invite" && r.email === email);
      return mine?.kind === "invite" && mine.lastSentAt !== undefined ? Date.parse(mine.lastSentAt) : Number.NaN;
    };
    const before = await lastSent();

    await page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: /^People/ }).click();
    await page.getByRole("button", { name: `${email}, invitation`, exact: true }).click();
    await page.getByTestId("invitation-resend").click();
    const dialog = page.getByRole("dialog", { name: "Send this link yourself", exact: true });
    await expect(dialog.getByLabel("Invitation link", { exact: true })).toHaveValue(link);
    await expect.poll(lastSent).toBeGreaterThan(Number.isNaN(before) ? 0 : before);
  });
});
