import type { Locator, Page } from "@playwright/test";
import { GUARD_SECRET_RULE_IDS, GuardRulesDocument, type GuardRulesDocumentInput, type GuardRulesPage, GuardRulesUpdate } from "@vibtra/guard-contract";
import { choose, expect, openConsole, optionsOf, routeOf, test } from "./support/console.ts";
import { type Answer, type Call, answerDoors } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const GROUPS = [
  { id: "team_eng", name: "Engineering" },
  { id: "team_fin", name: "Finance" },
];

const SERVICES = [
  { serviceId: "openai-chatgpt", name: "ChatGPT", category: "chat" },
  { serviceId: "deepseek-chat", name: "DeepSeek", category: "chat" },
];

const head = (document: Partial<GuardRulesDocumentInput> = {}, groups = GROUPS): GuardRulesPage =>
  fixtures.rulesPage({
    groups,
    services: SERVICES,
    document: GuardRulesDocument.parse({ version: 3, defaultAction: "allow", serviceRules: [], contentRules: [], ...document }),
  });

const savedBy = (base: GuardRulesPage): ((call: Call) => Answer) => {
  let minted = 0;
  const mint = (prefix: "gsr" | "gcr"): string => {
    minted += 1;
    return `${prefix}_${(0x20000000 + minted).toString(16)}`;
  };
  return (call) => {
    const sent = GuardRulesUpdate.parse(call.body);
    return {
      body: fixtures.rulesPage({
        ...base,
        document: {
          version: sent.baseVersion + 1,
          defaultAction: sent.document.defaultAction,
          serviceRules: sent.document.serviceRules.map((rule) => ({ ...rule, ruleId: rule.ruleId ?? mint("gsr") })),
          contentRules: sent.document.contentRules.map((rule) => ({ ...rule, ruleId: rule.ruleId ?? mint("gcr") })),
        },
      }),
    };
  };
};

const openRules = async (page: Page, seed: Parameters<typeof openConsole>[1], base: GuardRulesPage, route: string): Promise<{ calls: Call[] }> => {
  const answered = await answerDoors(page, { "GET /guard/rules": { body: base }, "PUT /guard/rules": savedBy(base) });
  await openConsole(page, seed, route);
  return answered;
};

const puts = (calls: Call[]): GuardRulesUpdate[] =>
  calls.filter((call) => call.method === "PUT" && call.path === "/guard/rules").map((call) => GuardRulesUpdate.parse(call.body));

const lastPut = (calls: Call[]): GuardRulesUpdate["document"] | undefined => puts(calls).at(-1)?.document;

const addedContent = (calls: Call[], name: string) => lastPut(calls)?.contentRules.find((rule) => rule.name === name);

const sheet = (page: Page, name: string): Locator => page.getByRole("dialog", { name, exact: true });

const sheetsGone = async (page: Page): Promise<void> => {
  await expect(page.locator("[data-slot=form-sheet]")).toHaveCount(0);
};

const newContentRule = async (page: Page): Promise<Locator> => {
  await sheetsGone(page);
  await page.getByTestId("add-content-rule").click();
  const dialog = sheet(page, "Add a content rule");
  await expect(dialog).toBeVisible();
  return dialog;
};

const newServiceRule = async (page: Page): Promise<Locator> => {
  await sheetsGone(page);
  await page.getByTestId("add-service-rule").click();
  const dialog = sheet(page, "Add a service rule");
  await expect(dialog).toBeVisible();
  return dialog;
};

const button = (dialog: Locator, name: string): Locator => dialog.getByRole("button", { name, exact: true });
const combobox = (dialog: Locator, name: string): Locator => dialog.getByRole("combobox", { name, exact: true });
const nameField = (dialog: Locator): Locator => dialog.getByLabel("Name", { exact: true });
const detects = (dialog: Locator): Locator => combobox(dialog, "Detects");
const alertIn = (dialog: Locator): Locator => dialog.getByRole("alert");

const saveAndWait = async (page: Page, dialog: Locator, calls: Call[], label = "Add rule"): Promise<void> => {
  const before = puts(calls).length;
  await button(dialog, label).click();
  await expect.poll(() => puts(calls).length).toBe(before + 1);
  await sheetsGone(page);
};

const cancel = async (page: Page, dialog: Locator): Promise<void> => {
  await button(dialog, "Cancel").click();
  await sheetsGone(page);
};

const expectMarked = async (field: Locator, describedBy: string): Promise<void> => {
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(field).toHaveAttribute("aria-describedby", describedBy);
  await expect(field).toBeFocused();
};

test.describe("audienceOf", () => {
  test("every audience shape: everyone, groups (none, then one), people (empty, not an address, then mixed case and separators)", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");

    let dialog = await newContentRule(page);
    await nameField(dialog).fill("Everyone");
    await choose(detects(dialog), "Payment card number");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Everyone")?.audience).toEqual({ kind: "org" });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Some groups");
    await choose(detects(dialog), "Payment card number");
    await choose(combobox(dialog, "Who"), "Groups");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Pick at least one group.");
    await dialog.getByRole("list", { name: "Groups", exact: true }).getByRole("checkbox", { name: "Engineering", exact: true }).click();
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Some groups")?.audience).toEqual({ kind: "groups", groupIds: ["team_eng"] });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Named people");
    await choose(detects(dialog), "Payment card number");
    await choose(combobox(dialog, "Who"), "People");
    const emails = dialog.getByRole("textbox", { name: "People’s email addresses", exact: true });
    await emails.fill("  \n , ");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Name at least one person by email address.");
    await emails.fill("ada@x.example, nobody, grace@");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Not an email address: nobody, grace@");
    expect(puts(calls)).toHaveLength(2);
    await emails.fill("Ada@X.example\nada@x.example; grace@x.example");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Named people")?.audience).toEqual({ kind: "people", emails: ["ada@x.example", "grace@x.example"] });
  });

  test("audienceStateOf reads each kind back", async ({ page, seed }) => {
    const base = head({
      contentRules: [
        { ruleId: "gcr_0000dddd", name: "People rule", detector: { kind: "card-number" }, services: "*", audience: { kind: "people", emails: ["a@x.example", "b@x.example"] }, action: "block", enabled: true },
        { ruleId: "gcr_0000eeee", name: "Group rule", detector: { kind: "card-number" }, services: "*", audience: { kind: "groups", groupIds: ["team_eng"] }, action: "block", enabled: true },
      ],
    });
    await openRules(page, seed, base, "/rules?tab=content");

    await page.getByRole("button", { name: "People rule, edit", exact: true }).click();
    let dialog = sheet(page, "People rule");
    await expect(combobox(dialog, "Who")).toHaveText("People");
    await expect(dialog.getByRole("textbox", { name: "People’s email addresses", exact: true })).toHaveValue("a@x.example\nb@x.example");
    await cancel(page, dialog);

    await page.getByRole("button", { name: "Group rule, edit", exact: true }).click();
    dialog = sheet(page, "Group rule");
    await expect(combobox(dialog, "Who")).toHaveText("Groups");
    const groups = dialog.getByRole("list", { name: "Groups", exact: true });
    await expect(groups.getByRole("checkbox", { name: "Engineering", exact: true })).toBeChecked();
    await expect(groups.getByRole("checkbox", { name: "Finance", exact: true })).not.toBeChecked();
  });
});

test.describe("the service sheet", () => {
  test("a new rule: the service, a status for everyone and a group exception travel as two rows", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules");
    const dialog = await newServiceRule(page);
    await expect(dialog.locator("select")).toHaveCount(0);
    await choose(combobox(dialog, "Service"), "DeepSeek");
    await choose(combobox(dialog, "Status for everyone"), "Block");
    await button(dialog, "Add").click();
    await choose(combobox(dialog, "Exception 1: who"), "Finance");
    await choose(combobox(dialog, "Exception 1: status"), "Ask IT");
    await dialog.getByLabel("Why (shown on the block page)", { exact: true }).fill("  Data leaves Australia  ");
    await saveAndWait(page, dialog, calls);
    expect(lastPut(calls)?.serviceRules).toEqual([
      { serviceId: "deepseek-chat", audience: { kind: "org" }, action: "block", enabled: true, note: "Data leaves Australia" },
      { serviceId: "deepseek-chat", audience: { kind: "groups", groupIds: ["team_fin"] }, action: "ask", enabled: true, note: "Data leaves Australia" },
    ]);
  });

  test("an unpicked exception and a wrong address are refused on that row, marked and focused", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules");
    const dialog = await newServiceRule(page);
    await button(dialog, "Add").click();
    await button(dialog, "Add rule").click();
    const who = combobox(dialog, "Exception 1: who");
    await expect(alertIn(dialog)).toHaveText("Pick a group for each exception, or remove the empty one.");
    await expect(alertIn(dialog)).toHaveAttribute("id", "exception-0-error");
    await expectMarked(who, "exception-0-error");

    await choose(who, "Named people");
    const emails = dialog.getByRole("textbox", { name: "Exception 1: email addresses", exact: true });
    await emails.fill("ada@fernwood.example\nnot-an-address");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Not an email address: not-an-address");
    await expect(emails).toHaveAttribute("aria-describedby", "exception-0-error");
    await expect(emails).toBeFocused();
    expect(puts(calls)).toHaveLength(0);

    await emails.fill("ada@fernwood.example");
    await saveAndWait(page, dialog, calls);
    expect(lastPut(calls)?.serviceRules[1]).toMatchObject({ audience: { kind: "people", emails: ["ada@fernwood.example"] }, action: "allow" });
  });

  test("an existing service opens as status + exceptions, keeps ids, and Off keeps the row with its action", async ({ page, seed }) => {
    const base = head({
      serviceRules: [
        { ruleId: "gsr_0000aaaa", serviceId: "deepseek-chat", audience: { kind: "org" }, action: "block", enabled: true, note: "No" },
        { ruleId: "gsr_0000bbbb", serviceId: "deepseek-chat", audience: { kind: "groups", groupIds: ["team_eng"] }, action: "allow", enabled: false },
      ],
    });
    const { calls } = await openRules(page, seed, base, "/rules?service=deepseek-chat");
    let dialog = sheet(page, "DeepSeek");
    await expect(combobox(dialog, "Status for everyone")).toHaveText("Block");
    await expect(combobox(dialog, "Exception 1: status")).toHaveText("Off (kept, not applied)");
    await button(dialog, "Save").click();
    await sheetsGone(page);
    await expect.poll(() => routeOf(page, seed).search).toBe("");
    expect(puts(calls)).toHaveLength(0);

    await page.getByRole("button", { name: "DeepSeek, edit", exact: true }).click();
    dialog = sheet(page, "DeepSeek");
    await choose(combobox(dialog, "Status for everyone"), "Off (kept, not applied)");
    await button(dialog, "Remove exception 1").click();
    await saveAndWait(page, dialog, calls, "Save");
    expect(lastPut(calls)?.serviceRules).toEqual([
      { ruleId: "gsr_0000aaaa", serviceId: "deepseek-chat", audience: { kind: "org" }, action: "block", enabled: false, note: "No" },
    ]);
  });

  test("no rule for everyone is offered with the default's words, and the trigger shows the chosen status", async ({ page, seed }) => {
    await openRules(page, seed, head({ defaultAction: "block" }), "/rules");
    const dialog = await newServiceRule(page);
    const status = combobox(dialog, "Status for everyone");
    expect(await optionsOf(status)).toEqual(["No rule (the default: Block)", "Block", "Ask IT", "Allow", "Off (kept, not applied)"]);
    await expect(status).toHaveText("Block");
  });

  test("a new rule with no status and no exception says so under the status, which it marks and focuses", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules");
    const dialog = await newServiceRule(page);
    const status = combobox(dialog, "Status for everyone");
    await choose(status, "No rule (the default: Allow)");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Set a status for everyone or add an exception.");
    await expectMarked(status, "srule-status-error");
    expect(puts(calls)).toHaveLength(0);
  });

  test("an organisation with no groups says where to make them, and a new exception is for named people", async ({ page, seed }) => {
    await openRules(page, seed, head({}, []), "/rules");
    const dialog = await newServiceRule(page);
    await expect(dialog).toContainText("has no groups yet");
    await button(dialog, "Add").click();
    await expect(combobox(dialog, "Exception 1: who")).toHaveText("Named people");
  });
});

test.describe("the service sheet's model (draft.ts)", () => {
  test("a rule for several groups opens as one exception per group, the first keeping the id; unchanged notes stay their own", async ({ page, seed }) => {
    const base = head({
      serviceRules: [{ ruleId: "gsr_0000bbbb", serviceId: "deepseek-chat", audience: { kind: "groups", groupIds: ["team_eng", "team_fin"] }, action: "block", enabled: true, note: "Why" }],
    });
    const { calls } = await openRules(page, seed, base, "/rules?service=deepseek-chat");
    const dialog = sheet(page, "DeepSeek");
    await expect(combobox(dialog, "Exception 1: who")).toHaveText("Engineering");
    await expect(combobox(dialog, "Exception 2: who")).toHaveText("Finance");
    await expect(dialog.getByLabel("Why (shown on the block page)", { exact: true })).toHaveValue("Why");
    await choose(combobox(dialog, "Status for everyone"), "Allow");
    await saveAndWait(page, dialog, calls, "Save");
    const rows = lastPut(calls)?.serviceRules ?? [];
    const groupRow = (id: string) => rows.find((rule) => rule.audience.kind === "groups" && rule.audience.groupIds.includes(id));
    expect(groupRow("team_eng")).toMatchObject({ ruleId: "gsr_0000bbbb", audience: { kind: "groups", groupIds: ["team_eng"] }, action: "block", note: "Why" });
    expect(groupRow("team_fin")).toMatchObject({ audience: { kind: "groups", groupIds: ["team_fin"] }, action: "block", note: "Why" });
    expect(groupRow("team_fin")?.ruleId).toBeUndefined();
    expect(rows.filter((rule) => rule.audience.kind === "org").map((rule) => rule.action)).toEqual(["allow"]);
  });

  test("replaces one service's rows where they stood", async ({ page, seed }) => {
    const base = head({
      serviceRules: [
        { ruleId: "gsr_0000aaaa", serviceId: "openai-chatgpt", audience: { kind: "org" }, action: "allow", enabled: true },
        { ruleId: "gsr_0000bbbb", serviceId: "deepseek-chat", audience: { kind: "groups", groupIds: ["team_eng", "team_fin"] }, action: "block", enabled: true, note: "Why" },
        { ruleId: "gsr_0000cccc", serviceId: "*", audience: { kind: "people", emails: ["a@x.example"] }, action: "ask", enabled: true },
      ],
    });
    const { calls } = await openRules(page, seed, base, "/rules?service=deepseek-chat");
    await button(sheet(page, "DeepSeek"), "Remove every rule for this service…").click();
    const before = puts(calls).length;
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove rules", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(before + 1);
    expect(lastPut(calls)?.serviceRules.map((rule) => [rule.serviceId, rule.ruleId])).toEqual([
      ["openai-chatgpt", "gsr_0000aaaa"],
      ["*", "gsr_0000cccc"],
    ]);

    await sheetsGone(page);
    await page.getByRole("button", { name: "ChatGPT, edit", exact: true }).click();
    const chatgpt = sheet(page, "ChatGPT");
    await choose(combobox(chatgpt, "Status for everyone"), "Block");
    await saveAndWait(page, chatgpt, calls, "Save");
    expect(lastPut(calls)?.serviceRules.map((rule) => [rule.serviceId, rule.action, rule.ruleId])).toEqual([
      ["openai-chatgpt", "block", "gsr_0000aaaa"],
      ["*", "ask", "gsr_0000cccc"],
    ]);
  });
});

test.describe("the default sheet", () => {
  test("the radio cards choose; unchanged closes; changed hands the action back", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?service=__default__");
    let dialog = sheet(page, "When no rule names a service");
    await button(dialog, "Save").click();
    await sheetsGone(page);
    expect(puts(calls)).toHaveLength(0);

    await page.getByRole("button", { name: "Any other AI service, edit", exact: true }).click();
    dialog = sheet(page, "When no rule names a service");
    await dialog.locator("[data-slot='radio-card']").filter({ has: page.getByRole("radio", { name: "Block", exact: true }) }).click();
    await expect(dialog.getByRole("radio", { name: "Block", exact: true })).toBeChecked();
    await saveAndWait(page, dialog, calls, "Save");
    expect(lastPut(calls)?.defaultAction).toBe("block");
  });
});

test.describe("the content rule sheet", () => {
  test("a missing name is refused first, on the name field", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Give the rule a name people will recognise on the block page.");
    await expect(alertIn(dialog)).toHaveAttribute("id", "crule-name-error");
    await expectMarked(nameField(dialog), "crule-name-error");
    expect(puts(calls)).toHaveLength(0);
  });

  test("email-bulk thresholds: 1, 10001, 2.5 and ten are refused; 2 and 10000 are accepted", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const cases = [
      ["1", false],
      ["2", true],
      ["10000", true],
      ["10001", false],
      ["2.5", false],
      ["ten", false],
    ] as const;
    for (const [threshold, ok] of cases) {
      const dialog = await newContentRule(page);
      const name = `Bulk mail ${threshold}`;
      await nameField(dialog).fill(name);
      await choose(detects(dialog), "Bulk email addresses");
      const field = dialog.getByLabel("Fires at", { exact: true });
      await field.fill(threshold);
      if (ok) {
        await saveAndWait(page, dialog, calls);
        expect(addedContent(calls, name)?.detector, threshold).toEqual({ kind: "email-bulk", threshold: Number(threshold) });
      } else {
        const before = puts(calls).length;
        await button(dialog, "Add rule").click();
        await expect(alertIn(dialog), threshold).toHaveText("The threshold is a whole number from 2 to 10,000.");
        await expectMarked(field, "crule-detector-error");
        expect(puts(calls), threshold).toHaveLength(before);
        await cancel(page, dialog);
      }
    }
  });

  test("file types: dots and case are forgiven, duplicates dropped; a non-extension and an empty list are refused", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await nameField(dialog).fill("Sheets");
    await choose(detects(dialog), "File types");
    const field = dialog.getByRole("textbox", { name: "File extensions", exact: true });
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Add at least one file extension (xlsx, csv, pdf).");
    await expect(field).toBeFocused();
    await field.fill("xlsx, tar.gz, a-b");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Not a file extension: tar.gz, a-b");
    expect(puts(calls)).toHaveLength(0);
    await field.fill(".XLSX  csv,xlsx");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Sheets")?.detector).toEqual({ kind: "file-type", extensions: ["xlsx", "csv"] });
  });

  test("keywords: one per line, de-duplicated, at most 100 characters each; whole words travel", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await nameField(dialog).fill("Codenames");
    const keywords = dialog.getByRole("textbox", { name: "Keywords", exact: true });
    await keywords.fill("k".repeat(101));
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("A keyword is at most 100 characters.");
    expect(puts(calls)).toHaveLength(0);
    await keywords.fill("Falcon\n\nFalcon\nmerger ");
    await dialog.getByRole("switch", { name: "Whole words only", exact: true }).click();
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Codenames")?.detector).toEqual({ kind: "keyword", keywords: ["Falcon", "merger"], wholeWord: true });
  });

  test("secrets: none ticked means every pattern; ticked ones narrow it, and unticking takes one back", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    let dialog = await newContentRule(page);
    await nameField(dialog).fill("Keys");
    await choose(detects(dialog), "API key or secret");
    await expect(dialog.getByTestId("detector-secret").getByRole("checkbox")).toHaveCount(GUARD_SECRET_RULE_IDS.length);
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Keys")?.detector).toEqual({ kind: "secret" });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Some keys");
    await choose(detects(dialog), "API key or secret");
    const box = (id: string): Locator => dialog.getByTestId("detector-secret").getByRole("checkbox", { name: id, exact: true });
    await box("github-pat").click();
    await box("jwt").click();
    await box("github-pat").click();
    await box("aws-access-token").click();
    await expect(box("github-pat")).not.toBeChecked();
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Some keys")?.detector).toEqual({ kind: "secret", rules: ["jwt", "aws-access-token"] });
  });

  test("a new TFN, ACN or Medicare rule starts with the context gate on; turning it off warns; a plain detector carries only its kind", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const gate = (dialog: Locator): Locator => dialog.getByRole("switch", { name: "Only with a context word nearby", exact: true });

    let dialog = await newContentRule(page);
    await nameField(dialog).fill("ACNs");
    await choose(detects(dialog), "ACN");
    await expect(dialog.getByTestId("detector-context")).toContainText("ACN, company number");
    await expect(gate(dialog)).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId("detector-context-warning")).toHaveCount(0);
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "ACNs")?.detector).toEqual({ kind: "au-acn", requireContext: true });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Any ACN");
    await choose(detects(dialog), "ACN");
    await gate(dialog).click();
    await expect(dialog.getByTestId("detector-context-warning")).toContainText("1 in 10");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Any ACN")?.detector).toEqual({ kind: "au-acn" });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Tax file numbers");
    await choose(detects(dialog), "Tax file number");
    await expect(gate(dialog)).toHaveAttribute("aria-checked", "true");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Tax file numbers")?.detector).toEqual({ kind: "au-tfn", requireContext: true });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Medicare");
    await choose(detects(dialog), "Medicare number");
    await expect(dialog.getByTestId("detector-context")).toContainText("2123 45670 1");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Medicare")?.detector).toEqual({ kind: "au-medicare", requireContext: true });

    dialog = await newContentRule(page);
    await nameField(dialog).fill("Cards");
    await choose(detects(dialog), "Payment card number");
    await expect(gate(dialog)).toHaveCount(0);
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Cards")?.detector).toEqual({ kind: "card-number" });
  });

  test("a phone-number rule takes a threshold like the email one", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await nameField(dialog).fill("Call lists");
    await choose(detects(dialog), "Bulk phone numbers");
    await expect(dialog.getByTestId("detector-phone-bulk")).toContainText("phone numbers");
    await dialog.getByLabel("Fires at", { exact: true }).fill("25");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Call lists")?.detector).toEqual({ kind: "phone-bulk", threshold: 25 });
  });

  test("the services picker: off 'Every AI service' needs at least one ticked; the picked ones travel", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await nameField(dialog).fill("Cards");
    await choose(detects(dialog), "Payment card number");
    await dialog.getByRole("switch", { name: "Every AI service", exact: true }).click();
    const list = dialog.getByRole("list", { name: "Services", exact: true });
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Pick at least one service, or choose every AI service.");
    await expectMarked(list.getByRole("checkbox", { name: "ChatGPT", exact: true }), "crule-services-error");
    await list.getByRole("checkbox", { name: "DeepSeek", exact: true }).click();
    await expect(alertIn(dialog)).toHaveCount(0);
    await list.getByRole("checkbox", { name: "ChatGPT", exact: true }).click();
    await list.getByRole("checkbox", { name: "DeepSeek", exact: true }).click();
    await choose(combobox(dialog, "When it matches"), "Ask IT");
    await saveAndWait(page, dialog, calls);
    expect(addedContent(calls, "Cards")).toMatchObject({ services: ["openai-chatgpt"], action: "ask", audience: { kind: "org" } });
  });

  test("an audience refusal comes last, after the detector and services pass", async ({ page, seed }) => {
    const { calls } = await openRules(page, seed, head(), "/rules?tab=content");
    const dialog = await newContentRule(page);
    await nameField(dialog).fill("Medicare");
    await choose(detects(dialog), "Medicare number");
    await choose(combobox(dialog, "Who"), "People");
    await button(dialog, "Add rule").click();
    await expect(alertIn(dialog)).toHaveText("Name at least one person by email address.");
    const emails = dialog.getByRole("textbox", { name: "People’s email addresses", exact: true });
    await expect(emails).toHaveAttribute("aria-describedby", "crule-audience-kind-error");
    await expect(emails).toBeFocused();
    expect(puts(calls)).toHaveLength(0);
  });

  test("an existing rule opens with its detector, services and note, and keeps its id", async ({ page, seed }) => {
    const rule = {
      ruleId: "gcr_0000cccc",
      name: "Sheets",
      detector: { kind: "file-type" as const, extensions: ["xlsx", "csv"] },
      services: ["deepseek-chat"],
      audience: { kind: "people" as const, emails: ["ada@fernwood.example"] },
      action: "allow" as const,
      enabled: true,
      note: "Recorded only",
    };
    const { calls } = await openRules(page, seed, head({ contentRules: [rule] }), "/rules?tab=content");
    await page.getByRole("button", { name: "Sheets, edit", exact: true }).click();
    const dialog = sheet(page, "Sheets");
    await expect(dialog.getByRole("textbox", { name: "File extensions", exact: true })).toHaveValue("xlsx, csv");
    await expect(dialog.getByLabel("Why (shown on the block page)", { exact: true })).toHaveValue("Recorded only");
    await expect(dialog.getByRole("switch", { name: "Every AI service", exact: true })).toHaveAttribute("aria-checked", "false");
    await expect(dialog.getByRole("list", { name: "Services", exact: true }).getByRole("checkbox", { name: "DeepSeek", exact: true })).toBeChecked();
    await saveAndWait(page, dialog, calls, "Save");
    expect(lastPut(calls)?.contentRules).toEqual([rule]);
  });
});
