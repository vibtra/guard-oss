import type { Locator, Page } from "@playwright/test";
import {
  ConsoleInvitationCreated,
  ConsolePeoplePage,
  OnboardingPage,
  OnboardingReminder,
  OnboardingSettingsPage,
  type InviteDelivery,
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
const remindPath = (userId: string): string => `/people/${encodeURIComponent(userId)}/onboarding/remind`;

const BO = { userId: "usr_bo", email: "bo@fernwood.example", name: "Bo Tran" };
const LEE = { invitationId: "inv_lee", email: "lee@example.com" };
const SAM = { invitationId: "inv_sam", email: "sam@example.com" };

const roster = (mayManage: boolean, funnelPage: OnboardingPage): ConsolePeoplePage => {
  const placed = new Map(funnelPage.rows.flatMap((row) => (row.kind === "person" ? [[row.userId, { stage: row.stage, stageSince: row.stageSince, chase: row.chase }] as const] : [])));
  const rows = [
    { issuer: "x", subject: ADA.userId, email: ADA.email, name: ADA.name, role: "admin", orgRole: "owner", createdAt: iso(-90 * DAY), isYou: true },
    { issuer: "x", subject: BO.userId, email: BO.email, name: BO.name, role: "member", orgRole: "member", createdAt: iso(-60 * DAY), mayManage },
    { issuer: "x", subject: GRACE.userId, email: GRACE.email, name: GRACE.name, role: "member", orgRole: "member", createdAt: iso(-30 * DAY), mayManage },
  ].map((row) => ({ ...row, ...placed.get(row.subject) }));
  return ConsolePeoplePage.parse({ rows, total: rows.length, mayManage, mailEnabled: false });
};

const person = (who: { userId: string; email: string; name: string }, stage: OnboardingStage, sinceMs: number, chase = false, lastSentMs?: number): OnboardingRow => ({
  kind: "person",
  userId: who.userId,
  email: who.email,
  name: who.name,
  role: "member",
  stage,
  stageSince: iso(-sinceMs),
  chase,
  ...(lastSentMs === undefined ? {} : { lastSentAt: iso(-lastSentMs) }),
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

const linkFor = (invitationId: string, sent: number): string => `https://guard.example/login?invitation=${invitationId}&sent=${sent}`;

const resent = (who: { invitationId: string; email: string }, delivery: InviteDelivery, sent = 1): ConsoleInvitationCreated =>
  ConsoleInvitationCreated.parse({
    invitationId: who.invitationId,
    email: who.email,
    role: "member",
    expiresAt: iso(7 * DAY),
    delivery,
    ...(delivery === "emailed" ? {} : { inviteUrl: linkFor(who.invitationId, sent) }),
  });

const enrolUrl = (userId: string): string => `https://guard.example/guard/enrol/${userId}-token`;

const reminded = (who: { userId: string; email: string }, delivery: InviteDelivery): OnboardingReminder =>
  OnboardingReminder.parse({ userId: who.userId, email: who.email, lastSentAt: iso(0), delivery, ...(delivery === "emailed" ? {} : { enrolUrl: enrolUrl(who.userId) }) });

const doors = (extra: Doors = {}, page: () => OnboardingPage = () => funnel(), mayManage = true): Doors => ({
  "GET /people": () => ({ body: roster(mayManage, page()) }),
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
    await expect(bar).toContainText("1 person’s Mac failed an integrity check. 1 person’s Mac stopped syncing.");
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
            return { body: resent(LEE, "emailed") };
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
    await expect(list.getByRole("row").filter({ hasText: "@" })).toHaveText([new RegExp(SAM.email), new RegExp(LEE.email), new RegExp(BO.email)]);
    await expect(list).not.toContainText(GRACE.email);
    await expect(stageIn(chaseRow(page, BO.email))).toContainText("Signed in");
    await expect(chaseRow(page, BO.email).getByTestId("chase-resend")).toHaveCount(0);
    await expect(chaseRow(page, BO.email).getByRole("button", { name: `Send a reminder to ${BO.email}`, exact: true })).toBeVisible();
    await expect(list).toContainText("gives you a link to send them yourself");
    await expect(chaseRow(page, LEE.email)).toContainText("9 days ago");

    await chaseRow(page, LEE.email).getByRole("button", { name: `Re-send the invitation to ${LEE.email}`, exact: true }).click();
    await expect(toast(page, "success", `We emailed ${LEE.email} the invitation again.`)).toBeVisible();
    expect(posts(calls, resendPath(LEE.invitationId))).toBe(1);
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(0);
    await expect(chaseRow(page, LEE.email)).toContainText("just now");
    await expect(page.getByTestId("sent-link")).toHaveCount(0);
    await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(0);
  });

  test("with mail off, each re-send hands the admin the server's new link and never says it emailed", async ({ page, seed }) => {
    let sent = 0;
    await answerDoors(page, doors({ [`POST ${resendPath(LEE.invitationId)}`]: () => ({ body: resent(LEE, "mail_off", ++sent) }) }));
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, LEE.email).getByTestId("chase-resend").click();
    const dialog = page.getByRole("dialog", { name: "Send this link yourself", exact: true });
    await expect(dialog).toContainText(`Email is not set up on this server, so nothing was sent. Send ${LEE.email} this link.`);
    await expect(dialog).not.toContainText(/we emailed/i);
    const field = dialog.getByLabel("Invitation link", { exact: true });
    await expect(field).toHaveValue(linkFor(LEE.invitationId, 1));
    const old = await field.inputValue();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await chaseRow(page, LEE.email).getByTestId("chase-resend").click();
    await expect(field).toHaveValue(linkFor(LEE.invitationId, 2));
    expect(await field.inputValue()).not.toBe(old);
    await expect(toast(page, "success", "Invitation sent again")).toHaveCount(0);
  });

  test("when the email fails, re-send says so and gives the link instead", async ({ page, seed }) => {
    await answerDoors(page, doors({ [`POST ${resendPath(LEE.invitationId)}`]: { body: resent(LEE, "send_failed") } }));
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, LEE.email).getByTestId("chase-resend").click();
    const dialog = page.getByRole("dialog", { name: "The email was not sent", exact: true });
    await expect(dialog).toContainText(`The email could not be sent. Send ${LEE.email} this link instead.`);
    await expect(dialog.getByLabel("Invitation link", { exact: true })).toHaveValue(linkFor(LEE.invitationId, 1));
  });

  test("an admin reminds a signed-in person by email, and Last sent moves", async ({ page, seed }) => {
    let current = funnel([person(BO, "signed_in", 8 * DAY, true, 3 * DAY), invite(LEE, 9 * DAY, true)]);
    const { calls } = await answerDoors(
      page,
      doors(
        {
          [`POST ${remindPath(BO.userId)}`]: () => {
            current = funnel([person(BO, "signed_in", 8 * DAY, true, 0), invite(LEE, 9 * DAY, true)]);
            return { body: reminded(BO, "emailed") };
          },
        },
        () => current,
      ),
    );
    await openConsole(page, seed, "/people?tab=chase");
    await expect(chaseRow(page, BO.email)).toContainText("3 days ago");
    await expect(chaseRow(page, LEE.email).getByTestId("chase-remind")).toHaveCount(0);
    await chaseRow(page, BO.email).getByRole("button", { name: `Send a reminder to ${BO.email}`, exact: true }).click();
    await expect(toast(page, "success", `We emailed ${BO.email} the download and enrol links again.`)).toBeVisible();
    expect(posts(calls, remindPath(BO.userId))).toBe(1);
    await expect(chaseRow(page, BO.email)).toContainText("just now");
    await expect(page.getByLabel("Enrol link", { exact: true })).toHaveCount(0);
  });

  test("with mail off, a reminder hands the admin the enrol link", async ({ page, seed }) => {
    await answerDoors(page, doors({ [`POST ${remindPath(BO.userId)}`]: { body: reminded(BO, "mail_off") } }, () => funnel([person(BO, "signed_in", 8 * DAY, true)])));
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, BO.email).getByTestId("chase-remind").click();
    const dialog = page.getByRole("dialog", { name: "Send this link yourself", exact: true });
    await expect(dialog).toContainText(`Email is not set up on this server, so nothing was sent. Send ${BO.email} this link.`);
    await expect(dialog.getByLabel("Enrol link", { exact: true })).toHaveValue(enrolUrl(BO.userId));
    await expect(toast(page, "success", "Reminder sent")).toHaveCount(0);
  });

  test("a refused reminder says why", async ({ page, seed }) => {
    await answerDoors(
      page,
      doors({ [`POST ${remindPath(BO.userId)}`]: refused(409, "CONFLICT", "Bo has already enrolled a Mac") }, () => funnel([person(BO, "signed_in", 8 * DAY, true)])),
    );
    await openConsole(page, seed, "/people?tab=chase");
    await chaseRow(page, BO.email).getByTestId("chase-remind").click();
    await expect(toast(page, "error", `No reminder was sent to ${BO.email}`)).toContainText("Bo has already enrolled a Mac.");
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

  test("a person who may not manage people gets no chase tab, no invitations, no re-send, no reminder and no invitation link", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, doors({}, () => funnel([invite(LEE, 9 * DAY, true), person(BO, "signed_in", 8 * DAY, true)]), false));
    await openConsole(page, seed, "/people?tab=chase");
    await expect(stageIn(peopleRow(page, `${BO.name}, details`))).toContainText("Signed in");
    await expect(page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: /^Chase/ })).toHaveCount(0);
    await expect(page.getByTestId("chase-list")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Re-send the invitation|Send a reminder) to / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `${LEE.email}, invitation`, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Actions for ${LEE.email}`, exact: true })).toHaveCount(0);
    await expect(menuItem(page, "Copy invitation link")).toHaveCount(0);
    await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("onboarding-error")).toHaveCount(0);
    expect(calls.filter((call) => call.path === ONBOARDING)).toEqual([]);
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
  test("opens from the row without putting the invitation in the URL, shows no link, and re-sends", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, doors({ [`POST ${resendPath(SAM.invitationId)}`]: { body: resent(SAM, "emailed") } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${SAM.email}, invitation`, exact: true }).click();
    const sheet = page.getByTestId("invitation-sheet");
    await expect(sheet).toContainText("Re-sending makes a new link. Links sent before stop working.");
    expect(page.url()).not.toContain("invitation");
    await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(0);
    await sheet.getByTestId("invitation-resend").click();
    await expect(toast(page, "success", `We emailed ${SAM.email} the invitation again.`)).toBeVisible();
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(1);
    await expect(page.getByLabel("Invitation link", { exact: true })).toHaveCount(0);
  });

  test("re-sending an expired invitation follows the new one and gives the server's link", async ({ page, seed }) => {
    const RENEWED = { invitationId: "inv_sam_renewed", email: SAM.email };
    let current = funnel([invite(SAM, 20 * DAY, true)]);
    await answerDoors(
      page,
      doors(
        {
          [`POST ${resendPath(SAM.invitationId)}`]: () => {
            current = funnel([invite(RENEWED, 20 * DAY, true, 0)]);
            return { body: resent(RENEWED, "mail_off") };
          },
        },
        () => current,
      ),
    );
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${SAM.email}, invitation`, exact: true }).click();
    await page.getByTestId("invitation-sheet").getByTestId("invitation-resend").click();
    const dialog = page.getByRole("dialog", { name: "Send this link yourself", exact: true });
    await expect(dialog.getByLabel("Invitation link", { exact: true })).toHaveValue(linkFor(RENEWED.invitationId, 1));
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByTestId("invitation-sheet")).toContainText("just now");
    expect(page.url()).not.toContain("invitation");
  });

  test("the row's ⋮ re-sends too", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, doors({ [`POST ${resendPath(SAM.invitationId)}`]: { body: resent(SAM, "emailed") } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `Actions for ${SAM.email}`, exact: true }).click();
    await expect(menuItem(page, "Copy invitation link")).toHaveCount(0);
    await menuItem(page, "Re-send invitation").click();
    await expect(toast(page, "success", `We emailed ${SAM.email} the invitation again.`)).toBeVisible();
    expect(posts(calls, resendPath(SAM.invitationId))).toBe(1);
  });
});

test.describe("the chase-after setting", () => {
  test("an admin changes it in Settings and it is saved", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /registration": refused(404, "NOT_FOUND", "No operator"),
      "GET /guard/settings": { body: GuardSettingsPage.parse({ ...settings(), devices: 2 }) },
      [`GET ${ONBOARDING_SETTINGS}`]: { body: OnboardingSettingsPage.parse({ chaseAfterDays: 7, mayEdit: true }) },
      [`PUT ${ONBOARDING_SETTINGS}`]: (call) => ({ body: OnboardingSettingsPage.parse({ ...(call.body as object), mayEdit: true }) }),
    });
    await openConsole(page, seed, "/settings");
    const select = page.getByRole("combobox", { name: "Chase after", exact: true });
    await expect(select).toHaveText(/7 days/);
    await choose(select, "14 days");
    await expect(toast(page, "success", "after 14 days are on the chase list")).toBeVisible();
    expect(calls.filter((call) => call.method === "PUT" && call.path === ONBOARDING_SETTINGS).map((call) => call.body)).toEqual([{ chaseAfterDays: 14 }]);
  });

  test("without mayEdit it is shown read-only", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, {
      "GET /registration": refused(404, "NOT_FOUND", "No operator"),
      "GET /guard/settings": { body: GuardSettingsPage.parse({ ...settings(), devices: 2 }) },
      [`GET ${ONBOARDING_SETTINGS}`]: { body: OnboardingSettingsPage.parse({ chaseAfterDays: 10, mayEdit: false }) },
    });
    await openConsole(page, seed, "/settings");
    await expect(page.getByTestId("chase-after-days")).toHaveText("10 days");
    await expect(page.getByText("Only an admin can change this.")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Chase after", exact: true })).toHaveCount(0);
    expect(calls.filter((call) => call.method === "PUT" && call.path === ONBOARDING_SETTINGS)).toEqual([]);
  });
});

test.describe("onboarding on the seeded registry", () => {
  test("invite someone, find them Invited on People and in the chase tab, then re-send their invitation", async ({ page, seed }) => {
    const email = `onboard-${Date.now().toString(36)}@fernwood.example`;
    await openConsole(page, seed, "/people");
    await page.getByTestId("invite-open").click();
    await page.getByTestId("invite-form").getByLabel("Email", { exact: true }).fill(email);
    await page.getByRole("dialog", { name: "Invite people", exact: true }).getByRole("button", { name: "Create invitation", exact: true }).click();
    await expect(page.getByText("Send this link yourself", { exact: true })).toBeVisible();
    await expect(page.getByTestId("invite-made")).toHaveAttribute("data-delivery", "mail_off");
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
    await expect(dialog.getByLabel("Invitation link", { exact: true })).toHaveValue(/\/login\?invitation=/);
    await expect.poll(lastSent).toBeGreaterThan(Number.isNaN(before) ? 0 : before);
  });
});
