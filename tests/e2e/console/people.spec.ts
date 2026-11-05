import type { Locator, Page } from "@playwright/test";
import {
  ConsoleGroupDetail,
  ConsoleGroupMemberRequest,
  ConsoleGroupRow,
  ConsoleGroupsPage,
  ConsoleInvitationCreated,
  ConsolePeoplePage,
  ConsoleSession,
  type ConsoleGroupMember,
  type ConsoleInviteRole,
} from "@vibtra/console-api";
import { GuardActivityPage } from "@vibtra/guard-contract";
import { adminApi, choose, expect, menuItem, openConsole, pick, routeOf, test } from "./support/console.ts";
import { answerDoors, refused, type Answer, type Call, type Doors } from "./support/doors.ts";
import { ADA, DAY, DEVICE_ID_2, GRACE, devices, event, iso, people } from "./support/fixtures.ts";

test.use({ locale: "en-US" });

type Role = "owner" | "admin" | "member";

const BO = { userId: "usr_bo", email: "bo@fernwood.example", name: "Bo Tran" };
const FINANCE = "grp_finance";
const LEGAL = "grp_new";

const rowOf = (page: Page, name: string): Locator =>
  page.getByRole("row").filter({ has: page.getByRole("button", { name: `${name}, details`, exact: true }) });

const groupRowOf = (page: Page, name: string): Locator =>
  page.getByRole("row").filter({ has: page.getByRole("button", { name: `${name}, members`, exact: true }) });

const openNames = (page: Page): Promise<(string | null)[]> =>
  page.getByRole("button", { name: /, details$/ }).evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));

const cellUnder = async (row: Locator, header: string): Promise<Locator> => {
  await expect(row).toBeVisible();
  const headers = (await row.page().getByRole("columnheader").allInnerTexts()).map((text) => text.trim());
  expect(headers).toContain(header);
  return row.getByRole("cell").nth(headers.indexOf(header));
};

const toast = (page: Page, kind: "success" | "error", words: string): Locator =>
  page.locator(`[data-sonner-toast][data-type="${kind}"]`).filter({ hasText: words });

const roleSelect = (page: Page): Locator => page.getByTestId("person-role").getByRole("combobox", { includeHidden: true });

const bodies = (calls: readonly Call[], method: string, path: string): unknown[] =>
  calls.filter((call) => call.method === method && call.path === path).map((call) => call.body);

const addedOn = (subject: string): string => {
  const row = people().rows.find((person) => person.subject === subject);
  if (row === undefined) throw new Error(`the people fixture has no ${subject}`);
  return new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(row.createdAt));
};

const asMember = (person: { email: string; name: string }): ConsoleGroupMember => ({ email: person.email, name: person.name });

const memberFor = (call: Call): ConsoleGroupMember => {
  const { email } = ConsoleGroupMemberRequest.parse(call.body);
  return { email, name: [ADA, GRACE].find((person) => person.email === email)?.name ?? null };
};

const groupRow = (id: string, name: string, members: readonly ConsoleGroupMember[]): ConsoleGroupRow =>
  ConsoleGroupRow.parse({ id, name, members, memberCount: members.length, usedBy: { tools: 0, connections: 0 }, createdAt: iso(-10 * DAY), createdBy: ADA.email });

const groupsAnswer = (...rows: ConsoleGroupRow[]): Answer => ({ body: ConsoleGroupsPage.parse({ rows }) });

const groupAnswer = (row: ConsoleGroupRow): Answer => ({ body: ConsoleGroupDetail.parse({ row }) });

const directoryDoors = (extra: Doors = {}): Doors => ({
  "GET /people": { body: people() },
  "GET /groups": groupsAnswer(groupRow(FINANCE, "Finance", [asMember(GRACE)])),
  "GET /guard/devices": { body: devices() },
  ...extra,
});

const wire = (role: Role): "admin" | "member" => (role === "member" ? "member" : "admin");

const roster = (opts: { grace?: Role; bo?: Role; mayManage?: boolean; mailEnabled?: boolean; without?: string } = {}): ConsolePeoplePage => {
  const mayManage = opts.mayManage ?? true;
  const bo = opts.bo ?? "admin";
  const grace = opts.grace ?? "member";
  const rows = [
    { issuer: "x", subject: ADA.userId, email: ADA.email, name: ADA.name, role: "admin", orgRole: "owner", createdAt: iso(-90 * DAY), isYou: true, mayManage: false },
    { issuer: "x", subject: BO.userId, email: BO.email, name: BO.name, role: wire(bo), orgRole: bo, createdAt: iso(-60 * DAY), mayManage },
    {
      issuer: "x",
      subject: GRACE.userId,
      email: GRACE.email,
      name: GRACE.name,
      role: wire(grace),
      orgRole: grace,
      createdAt: iso(-30 * DAY),
      mayManage,
      doorTokens: [{ tokenId: "tok_1", name: "CI token" }],
    },
  ].filter((row) => row.subject !== opts.without);
  return ConsolePeoplePage.parse({ rows, total: rows.length, mayManage, mailEnabled: opts.mailEnabled ?? false });
};

const rosterDoors = (directory: () => ConsolePeoplePage, extra: Doors = {}): Doors => ({
  "GET /people": () => ({ body: directory() }),
  "GET /groups": groupsAnswer(),
  "GET /guard/devices": { body: devices() },
  "GET /guard/activity": { body: GuardActivityPage.parse({ rows: [] }) },
  ...extra,
});

const invitation = (emailed: boolean, role: ConsoleInviteRole): ConsoleInvitationCreated =>
  ConsoleInvitationCreated.parse({ invitationId: "inv_123", email: "lee@example.com", role, expiresAt: iso(7 * DAY), emailed });

test.describe("People", () => {
  test("lists each person with their access, groups, laptops and when they were added; Name sorts both ways", async ({ page, seed }) => {
    await answerDoors(page, directoryDoors());
    await openConsole(page, seed, "/people");
    const grace = rowOf(page, GRACE.name);
    await expect(grace).toContainText(GRACE.email);
    await expect(await cellUnder(grace, "Role")).toHaveText("Member");
    await expect(await cellUnder(grace, "Groups")).toHaveText("Finance");
    await expect(await cellUnder(grace, "Devices")).toHaveText("1");
    await expect(await cellUnder(grace, "Added")).toHaveText(addedOn(GRACE.userId));
    await expect(await cellUnder(rowOf(page, ADA.name), "Role")).toHaveText("Admin");
    await expect.poll(() => openNames(page)).toEqual([`${ADA.name}, details`, `${GRACE.name}, details`]);

    await page.getByRole("button", { name: "Name", exact: true }).click();
    await expect.poll(() => openNames(page)).toEqual([`${GRACE.name}, details`, `${ADA.name}, details`]);

    await page.getByRole("searchbox", { name: "Search people…", exact: true }).fill("nobody");
    await expect(page.getByText("No people match “nobody”")).toBeVisible();
    await page.getByRole("button", { name: "Clear search", exact: true }).click();
    await expect.poll(() => openNames(page)).toEqual([`${GRACE.name}, details`, `${ADA.name}, details`]);
  });

  test("a row opens the person sheet at ?person=: overview, their laptops, their activity", async ({ page, seed }) => {
    const graceEvent = event({ person: GRACE, deviceId: DEVICE_ID_2, hostname: "graces-air" });
    const { calls } = await answerDoors(page, directoryDoors({ "GET /guard/activity": { body: GuardActivityPage.parse({ rows: [graceEvent] }) } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${GRACE.name}, details`, exact: true }).click();
    const sheet = page.getByTestId("person-sheet");
    await expect(sheet).toContainText("General information");
    await expect.poll(() => routeOf(page, seed).search).toBe(`?person=${GRACE.userId}`);
    await expect(sheet).toContainText("Finance");

    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    const device = sheet.getByTestId("person-device");
    await expect(device).toContainText("graces-air");
    await expect(device.getByTestId("device-status")).toHaveText("Quiet");

    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await expect(sheet.getByTestId("sheet-event")).toContainText("ChatGPT");
    const scopes = calls.filter((call) => call.path === "/guard/activity").map((call) => call.query.get("personUserId"));
    expect(scopes.length).toBeGreaterThan(0);
    expect(scopes).toEqual(scopes.map(() => GRACE.userId));

    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await device.click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/devices", search: `?device=${DEVICE_ID_2}` });
  });

  test("without the groups and devices doors the columns say — rather than guess", async ({ page, seed }) => {
    await answerDoors(page, directoryDoors({ "GET /groups": refused(403, "admin_only", "No"), "GET /guard/devices": refused(500, "INTERNAL", "No") }));
    await openConsole(page, seed, "/people?tab=groups");
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
    await page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: "People", exact: true }).click();
    const grace = rowOf(page, GRACE.name);
    await expect(await cellUnder(grace, "Groups")).toHaveText("—");
    await expect(await cellUnder(grace, "Devices")).toHaveText("—");
  });

  test("a failed people read shows the error and Try again", async ({ page, seed }) => {
    let reads = 0;
    await answerDoors(
      page,
      directoryDoors({
        "GET /people": () => {
          reads += 1;
          return reads === 1 ? refused(500, "INTERNAL", "The directory did not answer") : { body: people() };
        },
      }),
    );
    await openConsole(page, seed, "/people");
    await expect(page.getByText("The directory did not answer")).toBeVisible();
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect(rowOf(page, GRACE.name)).toBeVisible();
    await expect(page.getByText("The directory did not answer")).toHaveCount(0);
  });
});

test.describe("Groups", () => {
  test("lists the groups with their member counts; a row opens the group sheet; Remove and Add use the group doors", async ({ page, seed }) => {
    let members: ConsoleGroupMember[] = [asMember(GRACE)];
    const removeGrace = `/groups/${FINANCE}/members/${encodeURIComponent(GRACE.email)}`;
    const { calls } = await answerDoors(
      page,
      directoryDoors({
        "GET /groups": () => groupsAnswer(groupRow(FINANCE, "Finance", members)),
        [`DELETE ${removeGrace}`]: () => {
          members = members.filter((entry) => entry.email !== GRACE.email);
          return groupAnswer(groupRow(FINANCE, "Finance", members));
        },
        [`POST /groups/${FINANCE}/members`]: (call) => {
          members = [...members, memberFor(call)];
          return groupAnswer(groupRow(FINANCE, "Finance", members));
        },
      }),
    );
    await openConsole(page, seed, "/people?tab=groups");
    await expect(await cellUnder(groupRowOf(page, "Finance"), "People")).toHaveText("1");
    await page.getByRole("button", { name: "Finance, members", exact: true }).click();
    const sheet = page.getByTestId("group-sheet");
    await expect(sheet.getByTestId("group-member")).toHaveCount(1);
    await expect.poll(() => routeOf(page, seed).search).toBe(`?tab=groups&group=${FINANCE}`);

    await sheet.getByRole("button", { name: `Remove ${GRACE.name}`, exact: true }).click();
    await expect(sheet.getByText("Nobody in this group yet")).toBeVisible();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([removeGrace]);
    await toast(page, "success", `${GRACE.name} removed from Finance`).getByRole("button", { name: "Undo", exact: true, includeHidden: true }).click();
    await expect(sheet.getByTestId("group-member")).toHaveCount(1);
    expect(bodies(calls, "POST", `/groups/${FINANCE}/members`)).toEqual([{ email: GRACE.email }]);

    const person = sheet.getByRole("combobox", { name: "Person to add", exact: true });
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet.getByRole("alert")).toHaveText("Choose a person to add.");
    await expect(person).toHaveAttribute("aria-invalid", "true");
    await expect(person).toBeFocused();
    await pick(person, "ada", /Ada Park/);
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet.getByTestId("group-member")).toHaveCount(2);
    expect(bodies(calls, "POST", `/groups/${FINANCE}/members`)).toEqual([{ email: GRACE.email }, { email: ADA.email }]);
  });

  test("Add group needs a name, makes the group, then adds each person picked", async ({ page, seed }) => {
    const finance = groupRow(FINANCE, "Finance", [asMember(GRACE)]);
    let legal: ConsoleGroupMember[] | undefined;
    const { calls } = await answerDoors(
      page,
      directoryDoors({
        "GET /groups": () => (legal === undefined ? groupsAnswer(finance) : groupsAnswer(finance, groupRow(LEGAL, "Legal", legal))),
        "POST /groups": () => {
          legal = [];
          return groupAnswer(groupRow(LEGAL, "Legal", legal));
        },
        [`POST /groups/${LEGAL}/members`]: (call) => {
          legal = [...(legal ?? []), memberFor(call)];
          return groupAnswer(groupRow(LEGAL, "Legal", legal));
        },
      }),
    );
    await openConsole(page, seed, "/people?tab=groups");
    await page.getByTestId("add-group-open").click();
    const form = page.getByTestId("add-group");
    const submit = page.getByRole("dialog", { name: "Add group", exact: true }).getByRole("button", { name: "Add group", exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    const name = form.getByLabel("Name", { exact: true });
    await expect(form.getByRole("alert")).toHaveText("Give the group a name.");
    await expect(name).toHaveAttribute("aria-invalid", "true");
    await expect(name).toHaveAccessibleDescription("Give the group a name.");
    await expect(name).toBeFocused();
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    await expect(form.getByRole("checkbox")).toHaveCount(2);

    await name.fill(" Legal ");
    const grace = form.getByRole("checkbox", { name: GRACE.name });
    await grace.click();
    await expect(grace).toBeChecked();
    await submit.click();
    await expect(page.getByRole("dialog", { name: "Legal", exact: true }).getByTestId("group-member")).toContainText(GRACE.name);
    expect(bodies(calls, "POST", "/groups")).toEqual([{ name: "Legal" }]);
    expect(bodies(calls, "POST", `/groups/${LEGAL}/members`)).toEqual([{ email: GRACE.email }]);
    await expect(toast(page, "success", "Legal is ready")).toBeVisible();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?tab=groups&group=${LEGAL}`);
  });

  test("no groups yet says what a group is for", async ({ page, seed }) => {
    await answerDoors(page, directoryDoors({ "GET /groups": groupsAnswer() }));
    await openConsole(page, seed, "/people?tab=groups");
    await expect(page.getByText("No groups yet")).toBeVisible();
    await expect(page.getByText("Make a group to give rules to some people and not others.")).toBeVisible();
  });
});

test.describe("roles in the person sheet", () => {
  test("shows a Role column, and member to admin saves at once through POST /people/:userId/role", async ({ page, seed }) => {
    let directory = roster();
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => directory, {
        [`POST /people/${GRACE.userId}/role`]: () => {
          directory = roster({ grace: "admin" });
          return { body: directory };
        },
      }),
    );
    await openConsole(page, seed, "/people");
    await expect(page.getByRole("columnheader", { name: "Role", exact: true })).toBeVisible();
    await expect(await cellUnder(rowOf(page, GRACE.name), "Role")).toHaveText("Member");
    await page.getByRole("button", { name: `${GRACE.name}, details`, exact: true }).click();
    const select = roleSelect(page);
    await expect(select).toContainText("Member");

    await choose(select, /^Admin/);
    await expect(toast(page, "success", `${GRACE.name} is now an admin.`)).toBeVisible();
    expect(bodies(calls, "POST", `/people/${GRACE.userId}/role`)).toEqual([{ role: "admin" }]);
    await expect(select).toContainText("Admin");
  });

  test("making an owner and demoting an admin ask first; Cancel writes nothing", async ({ page, seed }) => {
    let directory = roster();
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => directory, {
        [`POST /people/${BO.userId}/role`]: () => {
          directory = roster({ bo: "member" });
          return { body: directory };
        },
      }),
    );
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${BO.name}, details`, exact: true }).click();
    const select = roleSelect(page);
    const ask = page.getByRole("alertdialog");

    await choose(select, /^Owner/);
    await expect(ask).toContainText(`Make ${BO.name} an owner?`);
    await ask.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(ask).toBeHidden();
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    await expect(select).toBeFocused();
    await expect(select).toContainText("Admin");

    await choose(select, /^Member/);
    await expect(ask).toContainText(`Make ${BO.name} a member?`);
    await ask.getByRole("button", { name: "Make member", exact: true }).click();
    await expect(toast(page, "success", `${BO.name} is now a member.`)).toBeVisible();
    expect(bodies(calls, "POST", `/people/${BO.userId}/role`)).toEqual([{ role: "member" }]);
    await expect(ask).toBeHidden();
    await expect(select).toBeFocused();
    await expect(select).toContainText("Member");
  });

  test("says the door's refusal as it came", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => roster(), { [`POST /people/${BO.userId}/role`]: refused(403, "FORBIDDEN", "This organisation would be left with no owner") }),
    );
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${BO.name}, details`, exact: true }).click();
    await choose(roleSelect(page), /^Owner/);
    await page.getByRole("alertdialog").getByRole("button", { name: "Make owner", exact: true }).click();
    const said = toast(page, "error", `${BO.name}’s role was not changed`);
    await expect(said).toContainText("This organisation would be left with no owner.");
    expect(bodies(calls, "POST", `/people/${BO.userId}/role`)).toEqual([{ role: "owner" }]);
    await expect(roleSelect(page)).toContainText("Admin");
  });

  test("an admin is not offered Owner, and rows the door locks say why", async ({ page, seed }) => {
    const ada = await adminApi(seed);
    await answerDoors(page, rosterDoors(() => roster(), { "GET /session": { body: ConsoleSession.parse({ ...ada.session, orgRole: "admin" }) } }));
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${GRACE.name}, details`, exact: true }).click();
    await roleSelect(page).click();
    const owner = page.getByRole("listbox").getByRole("option", { name: /^Owner/ });
    await expect(owner).toHaveAttribute("aria-disabled", "true");
    await expect(owner).toContainText("Only an owner can make someone an owner.");

    await openConsole(page, seed, `/people?person=${ADA.userId}`);
    const select = roleSelect(page);
    await expect(select).toHaveAttribute("data-disabled");
    await expect(select).toHaveAccessibleDescription("You cannot change your own role. Ask another owner.");
    await expect(page.getByRole("dialog", { name: ADA.name, exact: true }).getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  });

  test("a member sees roles but no role control, no invite and no remove", async ({ page, seed }) => {
    await answerDoors(page, rosterDoors(() => roster({ mayManage: false })));
    await openConsole(page, seed, `/people?person=${GRACE.userId}`);
    const sheet = page.getByRole("dialog", { name: GRACE.name, exact: true });
    await expect(sheet.getByTestId("person-sheet")).toContainText("Member");
    await expect(sheet.getByTestId("person-role")).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(await cellUnder(rowOf(page, GRACE.name), "Role")).toHaveText("Member");
    await expect(page.getByTestId("invite-open")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  });
});

test.describe("remove from organisation", () => {
  test("the row's ⋮ asks first, names the tokens it revokes, then DELETEs /people/:userId", async ({ page, seed }) => {
    let directory = roster();
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => directory, {
        [`DELETE /people/${GRACE.userId}`]: () => {
          directory = roster({ without: GRACE.userId });
          return { body: directory };
        },
      }),
    );
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `Actions for ${GRACE.name}`, exact: true }).click();
    await menuItem(page, "Remove from organisation").click();
    const ask = page.getByRole("alertdialog");
    await expect(ask).toContainText(`Remove ${GRACE.name} from ${seed.orgName}?`);
    await expect(ask).toContainText("CI token");
    expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);

    await ask.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toast(page, "success", `${GRACE.name} was removed from ${seed.orgName}.`)).toBeVisible();
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`/people/${GRACE.userId}`]);
    await expect(rowOf(page, GRACE.name)).toHaveCount(0);
    await expect(rowOf(page, BO.name)).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${ADA.name}`, exact: true })).toHaveCount(0);
  });

  test("the sheet's ⋮ offers the same, and a refusal is said", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => roster(), { [`DELETE /people/${BO.userId}`]: refused(403, "FORBIDDEN", "You are not allowed to delete this member") }),
    );
    await openConsole(page, seed, `/people?person=${BO.userId}`);
    const sheet = page.getByRole("dialog", { name: BO.name, exact: true });
    await sheet.getByRole("button", { name: `Actions for ${BO.name}`, exact: true }).click();
    await menuItem(page, "Remove from organisation").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove", exact: true }).click();
    await expect(toast(page, "error", `${BO.name} was not removed`)).toContainText("You are not allowed to delete this member.");
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([`/people/${BO.userId}`]);
    await expect(sheet).toBeVisible();
  });
});

test.describe("invite people", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("without mail: Create invitation, then the link to send with Copy, never a claim that it was emailed", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rosterDoors(() => roster(), { "POST /people/invitations": { body: invitation(false, "admin") } }));
    await openConsole(page, seed, "/people");
    await page.getByTestId("invite-open").click();
    const form = page.getByTestId("invite-form");
    const submit = page.getByRole("dialog", { name: "Invite people", exact: true }).getByRole("button", { name: "Create invitation", exact: true });
    await submit.click();
    const email = form.getByLabel("Email", { exact: true });
    await expect(form.getByRole("alert")).toHaveText("Enter the email address to invite.");
    await expect(email).toBeFocused();
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);

    await email.fill(" Lee@Example.com ");
    const admin = form.getByRole("radio", { name: "Admin", exact: true });
    await form.locator("[data-slot='radio-card']").filter({ has: page.getByRole("radio", { name: "Admin", exact: true }) }).click();
    await expect(admin).toBeChecked();
    await submit.click();
    const result = page.getByTestId("invite-made");
    await expect(result).toBeVisible();
    expect(bodies(calls, "POST", "/people/invitations")).toEqual([{ email: "Lee@Example.com", role: "admin" }]);
    await expect(page.getByText("Invitation ready", { exact: true })).toBeVisible();
    await expect(page.getByText(/Email is not set up on this server, so nothing was sent\./)).toBeVisible();
    const link = `${new URL(page.url()).origin}/login?invitation=inv_123`;
    await expect(result.getByLabel("Invitation link", { exact: true })).toHaveValue(link);
    await expect(page.getByText(/We emailed/)).toHaveCount(0);

    await result.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  });

  test("with mail: Send invitation, and it says it emailed them", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rosterDoors(() => roster({ mailEnabled: true }), { "POST /people/invitations": { body: invitation(true, "member") } }));
    await openConsole(page, seed, "/people");
    await page.getByTestId("invite-open").click();
    await page.getByTestId("invite-form").getByLabel("Email", { exact: true }).fill("lee@example.com");
    await page.getByRole("dialog", { name: "Invite people", exact: true }).getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible();
    await expect(page.getByText(/We emailed lee@example\.com\./)).toBeVisible();
    expect(bodies(calls, "POST", "/people/invitations")).toEqual([{ email: "lee@example.com", role: "member" }]);
    await expect(page.getByTestId("invite-made").getByLabel("Invitation link", { exact: true })).toHaveValue(`${new URL(page.url()).origin}/login?invitation=inv_123`);
  });

  test("a refusal stays in the sheet as the door said it", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      rosterDoors(() => roster(), {
        "POST /people/invitations": refused(
          403,
          "FORBIDDEN",
          "This user is already invited to this organization",
          "Better Auth's organization plugin refused this: USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION",
        ),
      }),
    );
    await openConsole(page, seed, "/people");
    await page.getByTestId("invite-open").click();
    const form = page.getByTestId("invite-form");
    await form.getByLabel("Email", { exact: true }).fill("lee@example.com");
    await page.getByRole("dialog", { name: "Invite people", exact: true }).getByRole("button", { name: "Create invitation", exact: true }).click();
    const said = form.getByRole("alert");
    await expect(said).toContainText("lee@example.com was not invited. This user is already invited to this organization.");
    await expect(said).not.toContainText("Better Auth");
    expect(bodies(calls, "POST", "/people/invitations")).toEqual([{ email: "lee@example.com", role: "member" }]);
    await expect(page.getByTestId("invite-made")).toHaveCount(0);
  });
});

test.describe("People on the seeded registry", () => {
  test("lists the seeded people with their roles and groups; yourself has no ⋮", async ({ page, seed }) => {
    const { ada, bo, grace, dee } = seed.people;
    await openConsole(page, seed, "/people");
    for (const [person, role] of [[ada, "Owner"], [bo, "Admin"], [grace, "Member"], [dee, "Member"]] as const) {
      const row = rowOf(page, person.name);
      await expect(row).toContainText(person.email);
      await expect(await cellUnder(row, "Role")).toHaveText(role);
    }
    await expect(await cellUnder(rowOf(page, grace.name), "Groups")).toContainText("Finance");
    await expect(await cellUnder(rowOf(page, bo.name), "Groups")).toContainText("Engineering");
    await expect(page.getByRole("button", { name: `Actions for ${grace.name}`, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: `Actions for ${ada.name}`, exact: true })).toHaveCount(0);
  });

  test("the Groups tab lists Engineering and Finance, and Finance opens with its member", async ({ page, seed }) => {
    await openConsole(page, seed, "/people");
    await page.getByRole("navigation", { name: "People", exact: true }).getByRole("link", { name: "Groups", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=groups");
    await expect(groupRowOf(page, "Engineering")).toBeVisible();
    await page.getByRole("button", { name: "Finance, members", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?${new URLSearchParams({ tab: "groups", group: seed.groups.finance }).toString()}`);
    await expect(page.getByTestId("group-sheet").getByTestId("group-member").filter({ hasText: seed.people.grace.email })).toBeVisible();
  });

  test("a row opens the person sheet at ?person= with that person's laptop and activity", async ({ page, seed }) => {
    const { grace } = seed.people;
    const { gracesAir, adasMbp } = seed.devices;
    await openConsole(page, seed, "/people");
    await page.getByRole("button", { name: `${grace.name}, details`, exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?${new URLSearchParams({ person: grace.userId }).toString()}`);
    const sheet = page.getByTestId("person-sheet");
    await expect(sheet).toContainText(grace.email);

    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    const laptop = sheet.getByTestId("person-device").filter({ hasText: gracesAir.hostname });
    await expect(laptop).toBeVisible();

    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    const events = sheet.getByTestId("sheet-event");
    await expect(events.filter({ hasText: "Claude" }).first()).toBeVisible();
    await expect(events.filter({ hasText: "ChatGPT" }).first()).toBeVisible();
    await expect(events.filter({ hasText: adasMbp.hostname })).toHaveCount(0);

    await page.getByRole("tab", { name: "Devices", exact: true }).click();
    await laptop.click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/devices", search: `?${new URLSearchParams({ device: gracesAir.deviceId }).toString()}` });
  });

  test("Add group makes the group on the registry with the people picked", async ({ page, seed }) => {
    const { dee } = seed.people;
    const name = `Legal ${Date.now().toString(36)}`;
    await openConsole(page, seed, "/people?tab=groups");
    await page.getByTestId("add-group-open").click();
    const form = page.getByTestId("add-group");
    await form.getByLabel("Name", { exact: true }).fill(name);
    const deeBox = form.getByRole("checkbox", { name: dee.name });
    await deeBox.click();
    await expect(deeBox).toBeChecked();
    await page.getByRole("dialog", { name: "Add group", exact: true }).getByRole("button", { name: "Add group", exact: true }).click();
    await expect(toast(page, "success", `${name} is ready`)).toBeVisible();
    await expect(page.getByRole("dialog", { name, exact: true }).getByTestId("group-member")).toContainText(dee.name);

    const groups = await (await adminApi(seed)).read(ConsoleGroupsPage, "/groups");
    const made = groups.rows.find((row) => row.name === name);
    expect(made?.members?.map((entry) => entry.email)).toEqual([dee.email]);
    await expect.poll(() => routeOf(page, seed).search).toBe(`?${new URLSearchParams({ tab: "groups", group: made?.id ?? "" }).toString()}`);
  });
});
