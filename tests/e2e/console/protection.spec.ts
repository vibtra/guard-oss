import type { Locator, Page } from "@playwright/test";
import { ConsoleGroupsPage, ConsolePeoplePage, OnboardingPage } from "@vibtra/console-api";
import { GuardProtectionApplied, GuardProtectionPreview, GuardProtectionRollout, type GuardClientMode } from "@vibtra/guard-contract";
import { expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { answerDoors, refused, type Call, type Doors } from "./support/doors.ts";
import { ADA, BO, DAY, DEE, DEVICE_ID, DEVICE_ID_2, GRACE, MIN, PROTECTION_DIGEST, devices, iso, overview, protection } from "./support/fixtures.ts";

test.use({ locale: "en-US" });

const PROTECTION = "/people/protection";
const PREVIEW = "/people/protection/preview";
const APPLY = "/people/protection/apply";
const ROLLOUT = "/people/protection/rollout";
const FRESH_DIGEST = "e2".repeat(32);

const roster = (): ConsolePeoplePage =>
  ConsolePeoplePage.parse({
    rows: [ADA, BO, GRACE, DEE].map((who, i) => ({ issuer: "x", subject: who.userId, email: who.email, name: who.name, role: i === 0 ? "admin" : "member", createdAt: iso(-(90 - i) * DAY), isYou: i === 0 })),
    total: 4,
  });

const groups = (): ConsoleGroupsPage =>
  ConsoleGroupsPage.parse({
    rows: [
      {
        id: "grp_finance",
        name: "Finance",
        members: [
          { email: BO.email, name: BO.name },
          { email: GRACE.email.toUpperCase(), name: GRACE.name },
          { email: DEE.email, name: DEE.name },
          { email: "new.starter@fernwood.example", name: null },
        ],
        memberCount: 4,
        usedBy: { tools: 0, connections: 0 },
        createdAt: iso(-20 * DAY),
      },
      { id: "grp_eng", name: "Engineering", members: [{ email: ADA.email, name: ADA.name }], memberCount: 1, usedBy: { tools: 0, connections: 0 }, createdAt: iso(-20 * DAY) },
    ],
  });

type Moved = { who: { userId: string; email: string; name: string }; from: GuardClientMode; to: GuardClientMode; effect: string };

const preview = (moved: Moved[], summary: string, revision = 4, peopleDigest = PROTECTION_DIGEST): GuardProtectionPreview =>
  GuardProtectionPreview.parse({ revision, peopleDigest, summary, people: moved.map((m) => ({ ...m.who, from: m.from, to: m.to, effect: m.effect })) });

const BLOCKED = "Matches will now be blocked";
const INSPECTED = "Guard starts inspecting their AI traffic; matches will now be blocked";

const financeToEnforce = (revision = 4, digest = PROTECTION_DIGEST): GuardProtectionPreview =>
  preview(
    [
      { who: BO, from: "monitor", to: "enforce", effect: BLOCKED },
      { who: GRACE, from: "monitor", to: "enforce", effect: BLOCKED },
      { who: DEE, from: "off", to: "enforce", effect: INSPECTED },
    ],
    "Changes 3 people: 2 from Monitor to Enforce, 1 from Off to Enforce.",
    revision,
    digest,
  );

const rollout = (graceApplied: boolean): GuardProtectionRollout =>
  GuardProtectionRollout.parse({
    revision: 5,
    applied: graceApplied ? 2 : 1,
    pending: graceApplied ? 0 : 1,
    people: [
      { ...BO, mode: "enforce", devices: [{ deviceId: DEVICE_ID, hostname: "bos-mbp", state: "applied", clientMode: "enforce", lastSeenAt: iso(-MIN) }] },
      { ...GRACE, mode: "enforce", devices: [{ deviceId: DEVICE_ID_2, hostname: "graces-air", state: graceApplied ? "applied" : "pending", clientMode: graceApplied ? "enforce" : "monitor", lastSeenAt: iso(-40 * MIN) }] },
      { ...DEE, mode: "enforce", devices: [] },
    ],
  });

const doors = (extra: Doors = {}): Doors => ({
  "GET /people": { body: roster() },
  "GET /groups": { body: groups() },
  "GET /guard/devices": { body: devices() },
  [`GET ${PROTECTION}`]: { body: protection() },
  ...extra,
});

const posted = (calls: readonly Call[], path: string): unknown[] => calls.filter((call) => call.method === "POST" && call.path === path).map((call) => call.body);

const sortedIds = (body: unknown): unknown => {
  const changes = (body as { changes: { userIds?: string[] }[] }).changes;
  return { ...(body as object), changes: changes.map((change) => (change.userIds === undefined ? change : { ...change, userIds: [...change.userIds].sort() })) };
};

const table = (page: Page): Locator => page.getByRole("table", { name: "Protection for each person", exact: true });

const rowOf = (page: Page, name: string): Locator => table(page).getByRole("row").filter({ has: page.getByRole("checkbox", { name: `Select ${name}`, exact: true }) });

const modeTab = (page: Page, label: string): Locator => page.getByRole("tablist", { name: "Mode", exact: true }).getByRole("tab", { name: new RegExp(`^${label}`) });

const setTo = async (page: Page, mode: string): Promise<void> => {
  await page.getByRole("button", { name: "Set to…", exact: true }).click();
  await menuItem(page, new RegExp(`^${mode}`)).click();
};

const pickFinance = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Select a group", exact: true }).click();
  await menuItem(page, /^Finance/).click();
};

test.describe("the Protection tab", () => {
  test("shows the default, each person's mode and who set it, and counts by mode that filter the list", async ({ page, seed }) => {
    await answerDoors(page, doors());
    await openConsole(page, seed, "/people?tab=protection");
    const card = page.getByTestId("protection-default");
    await expect(card).toContainText("Default: Monitor");
    await expect(card).toContainText("2 of 4 people follow the default.");
    await expect(modeTab(page, "All")).toHaveText("All4");
    await expect(modeTab(page, "Enforce")).toHaveText("Enforce1");
    await expect(modeTab(page, "Monitor")).toHaveText("Monitor2");
    await expect(modeTab(page, "Off")).toHaveText("Off1");
    await expect(rowOf(page, "Ada Park").getByTestId("mode-pill")).toHaveText("Enforce");
    await expect(rowOf(page, "Ada Park").getByTestId("mode-source")).toContainText(GRACE.email);
    await expect(rowOf(page, "Bo Tran").getByTestId("mode-pill")).toHaveText("Monitor");
    await expect(rowOf(page, "Bo Tran").getByTestId("mode-source")).toHaveText("Follows the default");
    await expect(rowOf(page, "Dee Shah").getByTestId("mode-pill")).toHaveText("Off");

    await modeTab(page, "Off").click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=protection&mode=off");
    await expect(table(page).getByRole("checkbox", { name: /^Select (?!everyone)/ })).toHaveCount(1);
    await expect(rowOf(page, "Dee Shah")).toBeVisible();
  });

  test("Adam picks Finance, the preview says what happens to each person, apply sends exactly that, and the rollout counts the Macs", async ({ page, seed }) => {
    let graceDone = false;
    let page2 = false;
    const { calls } = await answerDoors(
      page,
      doors({
        [`GET ${PROTECTION}`]: () => ({ body: page2 ? protection({ revision: 5, people: protection().people.map((p) => (p.userId === ADA.userId ? p : { ...p, mode: "enforce", source: "set", setBy: ADA.email, setAt: iso(0) })) }) : protection() }),
        [`POST ${PREVIEW}`]: { body: financeToEnforce() },
        [`POST ${APPLY}`]: () => {
          page2 = true;
          return { body: GuardProtectionApplied.parse({ revision: 5, applied: 3, unchanged: 0 }) };
        },
        [`GET ${ROLLOUT}`]: () => ({ body: rollout(graceDone) }),
      }),
    );
    await openConsole(page, seed, "/people?tab=protection");
    await expect(page.getByRole("button", { name: "Set to…", exact: true })).toBeDisabled();
    await pickFinance(page);
    await expect(page.getByTestId("protection-selected")).toContainText("3 selected");
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "1 member has not joined yet and is not included." })).toBeVisible();
    for (const name of ["Bo Tran", "Grace Ho", "Dee Shah"]) await expect(page.getByRole("checkbox", { name: `Select ${name}`, exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Select Ada Park", exact: true })).not.toBeChecked();

    await setTo(page, "Enforce");
    const dialog = page.getByRole("dialog", { name: "Set 3 people to Enforce?", exact: true });
    await expect(dialog.getByTestId("preview-summary")).toHaveText("Changes 3 people: 2 from Monitor to Enforce, 1 from Off to Enforce.");
    const effects = dialog.getByTestId("effect");
    await expect(effects.getByTestId("effect-words")).toHaveText([BLOCKED, INSPECTED]);
    await expect(effects.getByTestId("effect-people")).toHaveText(["Bo Tran, Grace Ho", "Dee Shah"]);
    await expect(effects.first()).toHaveAttribute("data-from", "monitor");
    await expect(dialog.getByTestId("preview-notice")).toContainText("Guard starts blocking for 3 people.");
    expect(posted(calls, PREVIEW).map(sortedIds)).toEqual([{ changes: [{ userIds: [BO.userId, DEE.userId, GRACE.userId], mode: "enforce" }] }]);
    expect(posted(calls, APPLY)).toEqual([]);

    await dialog.getByRole("button", { name: "Set to Enforce", exact: true }).click();
    await expect.poll(() => posted(calls, APPLY).map(sortedIds)).toEqual([{ changes: [{ userIds: [BO.userId, DEE.userId, GRACE.userId], mode: "enforce" }], revision: 4, peopleDigest: PROTECTION_DIGEST }]);
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=protection&rollout=5");

    const panel = page.getByTestId("rollout");
    await expect(panel.getByTestId("rollout-line")).toHaveText("1 of 2 Macs now blocking");
    await expect(panel.getByTestId("rollout-pending")).toContainText("1 pending, last seen 40 min ago.");
    await expect(panel.getByTestId("rollout-no-mac")).toHaveText("1 person has no Mac yet. Their Mac gets the change when they enrol.");
    await panel.getByRole("button", { name: "Show the pending Macs", exact: true }).click();
    await expect(panel.getByRole("list", { name: "Pending Macs", exact: true })).toContainText("graces-air");
    await expect(panel.getByTestId("rollout-state")).toHaveText("In progress");
    graceDone = true;
    await expect(panel.getByTestId("rollout-line")).toHaveText("All 2 Macs are now blocking", { timeout: 15_000 });
    await expect(panel.getByTestId("rollout-state")).toHaveText("Every Mac has it");
    expect(calls.filter((call) => call.path === ROLLOUT).every((call) => call.query.get("revision") === "5")).toBe(true);
    await expect(page.getByRole("button", { name: "Set to…", exact: true })).toBeDisabled();
    await expect(rowOf(page, "Grace Ho").getByTestId("mode-pill")).toHaveText("Enforce");

    await panel.getByRole("button", { name: "Close the rollout", exact: true }).click();
    await expect(page.getByTestId("rollout")).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=protection");
  });

  test("when someone changed protection after the preview, nothing is applied: it previews again and asks for a new confirm", async ({ page, seed }) => {
    let previews = 0;
    let applies = 0;
    const { calls } = await answerDoors(
      page,
      doors({
        [`POST ${PREVIEW}`]: () => {
          previews += 1;
          return { body: previews === 1 ? financeToEnforce() : financeToEnforce(6, FRESH_DIGEST) };
        },
        [`POST ${APPLY}`]: () => {
          applies += 1;
          return applies === 1
            ? refused(409, "STALE_BASE", "Someone changed protection since this preview", "the revision is now 6 and this change was previewed at 4; nothing changed. Preview it again.")
            : { body: GuardProtectionApplied.parse({ revision: 7, applied: 3, unchanged: 0 }) };
        },
        [`GET ${ROLLOUT}`]: { body: rollout(true) },
      }),
    );
    await openConsole(page, seed, "/people?tab=protection");
    await pickFinance(page);
    await setTo(page, "Enforce");
    const dialog = page.getByRole("dialog", { name: "Set 3 people to Enforce?", exact: true });
    await dialog.getByRole("button", { name: "Set to Enforce", exact: true }).click();
    await expect(dialog.getByTestId("preview-stale")).toContainText("nothing was applied");
    await expect(dialog.getByTestId("effect")).toHaveCount(2);
    expect(posted(calls, PREVIEW).map(sortedIds)).toEqual([0, 1].map(() => ({ changes: [{ userIds: [BO.userId, DEE.userId, GRACE.userId], mode: "enforce" }] })));
    expect(posted(calls, APPLY)).toHaveLength(1);

    await dialog.getByRole("button", { name: "Set to Enforce", exact: true }).click();
    await expect.poll(() => posted(calls, APPLY).map(sortedIds)[1]).toEqual({ changes: [{ userIds: [BO.userId, DEE.userId, GRACE.userId], mode: "enforce" }], revision: 6, peopleDigest: FRESH_DIGEST });
    await expect(dialog).toHaveCount(0);
  });

  test("a person who left since they were picked is named, and the change can be previewed without them", async ({ page, seed }) => {
    let left = false;
    const { calls } = await answerDoors(
      page,
      doors({
        [`GET ${PROTECTION}`]: () => ({ body: left ? protection({ people: protection().people.filter((p) => p.userId !== DEE.userId) }) : protection() }),
        [`POST ${PREVIEW}`]: (call) =>
          (call.body as { changes: { userIds: string[] }[] }).changes[0]?.userIds.includes(DEE.userId) === true
            ? { body: financeToEnforce() }
            : {
                body: preview(
                  [
                    { who: BO, from: "monitor", to: "enforce", effect: BLOCKED },
                    { who: GRACE, from: "monitor", to: "enforce", effect: BLOCKED },
                  ],
                  "Changes 2 people: 2 from Monitor to Enforce.",
                  5,
                ),
              },
        [`POST ${APPLY}`]: () => {
          left = true;
          return refused(422, "NOT_A_MEMBER", "Some of these people are not members of this organisation", `nothing changed; not members: ${DEE.userId}`);
        },
      }),
    );
    await openConsole(page, seed, "/people?tab=protection");
    await pickFinance(page);
    await setTo(page, "Enforce");
    const dialog = page.getByRole("dialog", { name: "Set 3 people to Enforce?", exact: true });
    await dialog.getByRole("button", { name: "Set to Enforce", exact: true }).click();
    await expect(dialog.getByTestId("preview-left")).toContainText("Dee Shah is no longer in the organisation, so nothing changed.");
    await dialog.getByRole("button", { name: "Preview without them", exact: true }).click();
    const again = page.getByRole("dialog", { name: "Set 2 people to Enforce?", exact: true });
    await expect(again.getByTestId("effect-people")).toHaveText(["Bo Tran, Grace Ho"]);
    expect(posted(calls, PREVIEW).map(sortedIds).at(-1)).toEqual({ changes: [{ userIds: [BO.userId, GRACE.userId], mode: "enforce" }] });
  });

  test("a row's menu puts one person back on the default or turns Guard off for them; Cancel writes nothing", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      doors({
        [`POST ${PREVIEW}`]: (call) =>
          JSON.stringify(call.body).includes('"clear":true')
            ? { body: preview([{ who: ADA, from: "enforce", to: "monitor", effect: "Matches will be recorded, no longer blocked" }], "Changes 1 person: 1 from Enforce to Monitor.") }
            : { body: preview([{ who: BO, from: "monitor", to: "off", effect: "Guard stops checking their AI traffic; nothing is recorded" }], "Changes 1 person: 1 from Monitor to Off.") },
      }),
    );
    await openConsole(page, seed, "/people?tab=protection");
    await page.getByRole("button", { name: "Change Ada Park", exact: true }).click();
    await menuItem(page, "Back to the default (Monitor)").click();
    const back = page.getByRole("dialog", { name: "Put Ada Park back on the default (Monitor)?", exact: true });
    await expect(back.getByTestId("effect-words")).toHaveText(["Matches will be recorded, no longer blocked"]);
    await back.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(back).toHaveCount(0);

    await page.getByRole("button", { name: "Change Bo Tran", exact: true }).click();
    await expect(menuItem(page, "Back to the default (Monitor)")).toHaveCount(0);
    await menuItem(page, "Set to Off").click();
    const off = page.getByRole("dialog", { name: "Turn Guard off for Bo Tran?", exact: true });
    await expect(off.getByTestId("effect-words")).toHaveText(["Guard stops checking their AI traffic; nothing is recorded"]);
    await expect(off.getByRole("button", { name: "Turn off", exact: true })).toHaveAttribute("data-variant", "danger");
    await off.getByRole("button", { name: "Cancel", exact: true }).click();

    expect(posted(calls, PREVIEW)).toEqual([{ changes: [{ userIds: [ADA.userId], clear: true }] }, { changes: [{ userIds: [BO.userId], mode: "off" }] }]);
    expect(posted(calls, APPLY)).toEqual([]);
  });

  test("the default can be Off: the preview names who stops being checked and who keeps their own mode", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      doors({
        [`POST ${PREVIEW}`]: {
          body: preview(
            [
              { who: BO, from: "monitor", to: "off", effect: "Guard stops checking their AI traffic; nothing is recorded" },
              { who: GRACE, from: "monitor", to: "off", effect: "Guard stops checking their AI traffic; nothing is recorded" },
            ],
            "The organisation default changes from Monitor to Off. Changes 2 people: 2 from Monitor to Off.",
          ),
        },
        [`POST ${APPLY}`]: { body: GuardProtectionApplied.parse({ revision: 5, applied: 2, unchanged: 0 }) },
        [`GET ${ROLLOUT}`]: { body: rollout(true) },
      }),
    );
    await openConsole(page, seed, "/people?tab=protection");
    await page.getByRole("button", { name: "Change default", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Default mode", exact: true });
    await expect(sheet.getByRole("radio")).toHaveCount(3);
    await expect(sheet.getByRole("radio", { name: "Monitor", exact: true })).toBeChecked();
    await sheet.locator("[data-slot=radio-card]").filter({ has: page.getByRole("radio", { name: "Off", exact: true }) }).click();
    await sheet.getByRole("button", { name: "Preview", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Change the default to Off?", exact: true });
    await expect(dialog.getByTestId("effect-people")).toHaveText(["Bo Tran, Grace Ho"]);
    await expect(dialog.getByTestId("preview-kept").getByRole("listitem")).toHaveText([
      /1 person set to Enforce on their own keeps blocking\.\s*Show them/,
      /1 person set to Off on their own stays off\.\s*Show them/,
    ]);
    await expect(dialog.getByRole("button", { name: "Change the default", exact: true })).toHaveAttribute("data-variant", "danger");
    await dialog.getByRole("button", { name: "Change the default", exact: true }).click();
    await expect.poll(() => posted(calls, APPLY)).toEqual([{ changes: [{ default: "off" }], revision: 4, peopleDigest: PROTECTION_DIGEST }]);
    expect(posted(calls, PREVIEW)).toEqual([{ changes: [{ default: "off" }] }]);
  });
});

test.describe("counts by mode", () => {
  test("the Overview counts people by mode, calls Off not in scope, and each count opens the list filtered to it", async ({ page, seed }) => {
    await answerDoors(page, doors({ "GET /guard/overview": { body: overview() } }));
    await openConsole(page, seed);
    const modes = page.getByTestId("overview-modes");
    await expect(modes).toContainText("Protection for 4 people");
    await expect(modes.getByTestId("overview-mode")).toHaveText([/^1\s*Enforce$/, /^2\s*Monitor$/, /^1\s*Off · not in scope$/]);
    await expect(page.getByTestId("overview-monitor")).toHaveCount(0);
    await modes.getByRole("link", { name: /Off · not in scope/ }).click();
    await expect.poll(() => routeOf(page, seed)).toEqual({ pathname: "/people", search: "?tab=protection&mode=off" });
    await expect(rowOf(page, "Dee Shah")).toBeVisible();
    await expect(rowOf(page, "Bo Tran")).toHaveCount(0);
  });

  test("a person whose Guard is off is Not in scope in the funnel and is not chased", async ({ page, seed }) => {
    const funnel = OnboardingPage.parse({
      rows: [
        { kind: "person", userId: DEE.userId, email: DEE.email, name: DEE.name, role: "member", stage: "not_in_scope", stageSince: iso(-2 * DAY), chase: false },
        { kind: "person", userId: BO.userId, email: BO.email, name: BO.name, role: "member", stage: "signed_in", stageSince: iso(-9 * DAY), chase: true },
      ],
      chaseAfterDays: 7,
    });
    const people = ConsolePeoplePage.parse({
      rows: [
        { issuer: "x", subject: DEE.userId, email: DEE.email, name: DEE.name, role: "member", createdAt: iso(-30 * DAY), stage: "not_in_scope", stageSince: iso(-2 * DAY), chase: false, mayManage: true },
        { issuer: "x", subject: BO.userId, email: BO.email, name: BO.name, role: "member", createdAt: iso(-30 * DAY), stage: "signed_in", stageSince: iso(-9 * DAY), chase: true, mayManage: true },
      ],
      total: 2,
      mayManage: true,
    });
    await answerDoors(page, doors({ "GET /people": { body: people }, "GET /people/onboarding": { body: funnel } }));
    await openConsole(page, seed, "/people");
    const dee = page.getByRole("row").filter({ has: page.getByRole("button", { name: "Dee Shah, details", exact: true }) });
    await expect(dee.getByTestId("stage")).toHaveAttribute("data-stage", "not_in_scope");
    await expect(dee.getByTestId("stage")).toContainText("Not in scope");
    await page.getByRole("link", { name: /^Chase/ }).click();
    await expect(page.getByTestId("chase-list")).toContainText(BO.email);
    await expect(page.getByTestId("chase-list")).not.toContainText(DEE.email);
  });
});
