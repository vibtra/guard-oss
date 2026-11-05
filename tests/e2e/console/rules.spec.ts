import type { Locator, Page } from "@playwright/test";
import { CSRF_COOKIE, CSRF_HEADER } from "@vibtra/console-api";
import { GUARD_STARTER_CONTENT_RULES, type GuardRulesPage, GuardRulesUpdate } from "@vibtra/guard-contract";
import { choose, consolePath, expect, menuItem, openConsole, routeOf, test } from "./support/console.ts";
import { type Answer, type Call, type Doors, answerDoors, refused } from "./support/doors.ts";
import * as fixtures from "./support/fixtures.ts";

const savedBy = (base: GuardRulesPage): ((call: Call) => Answer) => {
  let minted = 0;
  const mint = (prefix: "gsr" | "gcr"): string => {
    minted += 1;
    return `${prefix}_${(0x10000000 + minted).toString(16)}`;
  };
  return (call) => {
    const sent = GuardRulesUpdate.parse(call.body);
    return {
      body: fixtures.rulesPage({
        ...base,
        document: {
          version: sent.baseVersion + 1,
          defaultAction: sent.document.defaultAction,
          ...(sent.document.surfaceBlocks === undefined ? {} : { surfaceBlocks: sent.document.surfaceBlocks }),
          serviceRules: sent.document.serviceRules.map((rule) => ({ ...rule, ruleId: rule.ruleId ?? mint("gsr") })),
          contentRules: sent.document.contentRules.map((rule) => ({ ...rule, ruleId: rule.ruleId ?? mint("gcr") })),
        },
      }),
    };
  };
};

const rulesDoors = (head: GuardRulesPage, more: Doors = {}): Doors => ({
  "GET /guard/rules": { body: head },
  "PUT /guard/rules": savedBy(head),
  "POST /guard/rules/test": { body: fixtures.testResult() },
  ...more,
});

const puts = (calls: Call[]): GuardRulesUpdate[] =>
  calls.filter((call) => call.method === "PUT" && call.path === "/guard/rules").map((call) => GuardRulesUpdate.parse(call.body));

const ruleTests = (calls: Call[]): unknown[] => calls.filter((call) => call.method === "POST" && call.path === "/guard/rules/test").map((call) => call.body);

const sheet = (page: Page, name: string): Locator => page.getByRole("dialog", { name, exact: true });

const rowOf = (page: Page, name: string): Locator => page.getByRole("row").filter({ has: page.getByRole("button", { name: `${name}, edit`, exact: true }) });

const card = (dialog: Locator, name: string): Locator =>
  dialog.locator("[data-slot='radio-card']").filter({ has: dialog.page().getByRole("radio", { name, exact: true }) });

const SWITCHES = ["Block the Claude website", "Block the Claude macOS app", "Block the ChatGPT website", "Block the ChatGPT macOS app (ChatGPT and Codex)"];

test.describe("the services tab", () => {
  test("round-trips the document: a new service rule from the sheet is saved at once with the baseVersion it was loaded at", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules");
    await expect(page.getByRole("button", { name: "DeepSeek, edit", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Any other AI service, edit", exact: true })).toBeVisible();

    await page.getByTestId("add-service-rule").click();
    const dialog = sheet(page, "Add a service rule");
    await expect(dialog.locator("select")).toHaveCount(0);
    await choose(dialog.getByRole("combobox", { name: "Service", exact: true }), "ChatGPT");
    await choose(dialog.getByRole("combobox", { name: "Status for everyone", exact: true }), /^No rule/);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await choose(dialog.getByRole("combobox", { name: "Exception 1: who", exact: true }), "Engineering");
    await choose(dialog.getByRole("combobox", { name: "Exception 1: status", exact: true }), "Ask IT");
    await dialog.getByRole("button", { name: "Add rule", exact: true }).click();

    await expect.poll(() => puts(calls).length).toBe(1);
    const put = calls.find((call) => call.method === "PUT");
    const csrf = (await page.context().cookies()).find((cookie) => cookie.name === CSRF_COOKIE)?.value;
    expect(put?.path).toBe("/guard/rules");
    expect(csrf).toBeTruthy();
    expect(put?.headers[CSRF_HEADER]).toBe(csrf);
    const body = puts(calls)[0];
    expect(body?.baseVersion).toBe(3);
    expect(body?.document.serviceRules).toEqual([
      { ruleId: "gsr_0000bbbb", serviceId: "deepseek-chat", audience: { kind: "org" }, action: "block", enabled: true, note: "Data leaves Australia" },
      { serviceId: "openai-chatgpt", audience: { kind: "groups", groupIds: ["team_eng"] }, action: "ask", enabled: true },
    ]);
    expect(body?.document.contentRules[0]?.ruleId).toBe("gcr_0000aaaa");

    await expect(page.getByTestId("rules-saved")).toContainText("v4");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "ChatGPT, edit", exact: true })).toBeVisible();
  });

  test("a row opens its sheet from the address; an unchanged Save sends nothing", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules");
    await page.getByRole("button", { name: "DeepSeek, edit", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?service=deepseek-chat");

    const dialog = sheet(page, "DeepSeek");
    await expect(dialog.getByRole("combobox", { name: "Status for everyone", exact: true })).toHaveText("Block");
    await expect(dialog.getByLabel("Why (shown on the block page)", { exact: true })).toHaveValue("Data leaves Australia");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(() => routeOf(page, seed).search).toBe("");
    expect(puts(calls)).toHaveLength(0);
  });

  test("a stale base answers 409: the page says the rules changed and offers a reload; the sheet says nothing was saved", async ({ page, seed }) => {
    let head = fixtures.rulesPage();
    await answerDoors(
      page,
      rulesDoors(head, {
        "GET /guard/rules": () => ({ body: head }),
        "PUT /guard/rules": refused(409, "STALE_BASE", "The rules moved"),
      }),
    );
    await openConsole(page, seed, "/rules?service=__default__");
    const dialog = sheet(page, "When no rule names a service");
    await card(dialog, "Block").click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    const stale = page.getByTestId("rules-stale");
    await expect(stale).toContainText("The rules changed since you opened this page; reload");
    await expect(dialog.getByRole("alert")).toContainText("nothing was saved");

    head = fixtures.rulesPage({ document: { ...head.document, version: 4, defaultAction: "block" } });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await stale.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(page.getByTestId("rules-saved")).toContainText("v4");
    await expect(rowOf(page, "Any other AI service").getByTestId("rule-status")).toHaveAttribute("data-status", "block");
    await expect(stale).toHaveCount(0);
  });

  test("the default row's sheet saves the document's default", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules");
    await page.getByRole("button", { name: "Any other AI service, edit", exact: true }).click();
    const dialog = sheet(page, "When no rule names a service");
    await card(dialog, "Ask IT").click();
    await expect(dialog.getByRole("radio", { name: "Ask IT", exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    await expect.poll(() => puts(calls).length).toBe(1);
    expect(puts(calls)[0]?.document.defaultAction).toBe("ask");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(rowOf(page, "Any other AI service").getByTestId("rule-status")).toHaveAttribute("data-status", "ask");
  });

  test("Remove every rule for a service asks first, then saves the document without them", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?service=deepseek-chat");
    const dialog = sheet(page, "DeepSeek");
    const removeAll = dialog.getByRole("button", { name: "Remove every rule for this service…", exact: true });
    const confirm = page.getByRole("alertdialog", { name: "Remove every rule for DeepSeek?", exact: true });

    await removeAll.click();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(puts(calls)).toHaveLength(0);

    await removeAll.click();
    await confirm.getByRole("button", { name: "Remove rules", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(1);
    expect(puts(calls)[0]?.document.serviceRules).toEqual([]);
    expect(puts(calls)[0]?.document.contentRules.map((rule) => rule.ruleId)).toEqual(["gcr_0000aaaa"]);
    await expect(page.getByTestId("service-rules-empty")).toBeVisible();
  });

  test("a row the contract would refuse is caught on the page: the problem names the field and nothing is sent", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?service=deepseek-chat");
    const dialog = sheet(page, "DeepSeek");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await choose(dialog.getByRole("combobox", { name: "Exception 1: who", exact: true }), "Named people");
    const emails = Array.from({ length: 501 }, (_, i) => `p${i}@fernwood.example`).join("\n");
    await dialog.getByLabel("Exception 1: email addresses", { exact: true }).fill(emails);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();

    const said = "The rule for DeepSeek was not saved. Check who it applies to.";
    await expect(page.getByTestId("rules-problem")).toHaveText(said);
    await expect(dialog.getByRole("alert")).toHaveText(said);
    expect(puts(calls)).toHaveLength(0);
  });

  test("shows each service's requests and share blocked when the Overview door answers, and leaves the column out when it does not", async ({ page, seed }) => {
    let overviewAnswers = true;
    const overview = fixtures.overview({
      clientMode: "enforce",
      services: [{ serviceId: "deepseek-chat", name: "DeepSeek", category: "chat", people: 1, devices: 1, events: 40, blocked: 10, bytes: 0 }],
    });
    await answerDoors(
      page,
      rulesDoors(fixtures.rulesPage(), {
        "GET /guard/overview": () => (overviewAnswers ? { body: overview } : refused(500, "INTERNAL", "Something went wrong")),
      }),
    );
    await openConsole(page, seed, "/rules");
    await expect(page.getByRole("columnheader", { name: "Requests, 7 days", exact: true })).toBeVisible();
    await expect(page.getByTestId("service-usage")).toHaveText("4025% blocked");

    overviewAnswers = false;
    const overviewRefused = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/guard/overview"));
    await page.reload();
    await overviewRefused;
    await expect(page.getByRole("button", { name: "DeepSeek, edit", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Requests, 7 days", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("service-usage")).toHaveCount(0);
  });

  test("says would be blocked in Monitor", async ({ page, seed }) => {
    const overview = fixtures.overview({
      services: [{ serviceId: "deepseek-chat", name: "DeepSeek", category: "chat", people: 1, devices: 1, events: 40, blocked: 10, bytes: 0 }],
    });
    await answerDoors(page, rulesDoors(fixtures.rulesPage(), { "GET /guard/overview": { body: overview } }));
    await openConsole(page, seed, "/rules");
    await expect(page.getByTestId("service-usage")).toHaveText("4025% would be blocked");
  });
});

test.describe("the content tab", () => {
  test("Starters adds the contract's starter content rules that are not there yet, and saves", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content");
    await expect(page.getByRole("button", { name: "Tax file numbers, edit", exact: true })).toBeVisible();
    await page.getByTestId("add-starters").click();

    await expect.poll(() => puts(calls).length).toBe(1);
    const sent = puts(calls)[0]?.document.contentRules ?? [];
    expect(sent).toHaveLength(GUARD_STARTER_CONTENT_RULES.length);
    expect(sent[0]?.ruleId).toBe("gcr_0000aaaa");
    expect(sent.slice(1).map((rule) => rule.name)).toEqual(GUARD_STARTER_CONTENT_RULES.filter((starter) => starter.name !== "Tax file numbers").map((starter) => starter.name));
    expect(sent.map((rule) => rule.name)).toContain("Payment card numbers");
    expect(sent.find((rule) => rule.name === "Bulk email addresses")?.detector).toEqual({ kind: "email-bulk", threshold: 10 });
    await expect(page.getByTestId("add-starters")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Payment card numbers, edit", exact: true })).toBeVisible();
  });

  test("a content rule's keyword detector is validated in its sheet and saved", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content");
    await expect(page.getByRole("button", { name: "Tax file numbers, edit", exact: true })).toBeVisible();
    await page.getByTestId("add-content-rule").click();

    const dialog = sheet(page, "Add a content rule");
    await dialog.getByLabel("Name", { exact: true }).fill("Codenames");
    await dialog.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Add at least one keyword");
    expect(puts(calls)).toHaveLength(0);

    await dialog.getByLabel("Keywords", { exact: true }).fill("Falcon\nOsprey");
    await dialog.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(1);
    const rule = puts(calls)[0]?.document.contentRules.at(-1);
    expect(rule?.name).toBe("Codenames");
    expect(rule?.detector).toEqual({ kind: "keyword", keywords: ["Falcon", "Osprey"], wholeWord: false });
    await expect(page.getByText("Keywords: Falcon, Osprey", { exact: true })).toBeVisible();
  });

  test("a TFN rule's context gate survives an edit and save, and the switch turns it off", async ({ page, seed }) => {
    const plain = fixtures.rulesPage();
    const head = fixtures.rulesPage({
      document: {
        ...plain.document,
        contentRules: [
          { ruleId: "gcr_0000aaaa", name: "Tax file numbers", detector: { kind: "au-tfn", requireContext: true }, services: "*", audience: { kind: "org" }, action: "block", enabled: true },
        ],
      },
    });
    const { calls } = await answerDoors(page, rulesDoors(head));
    await openConsole(page, seed, "/rules?tab=content");
    const row = page.getByRole("button", { name: "Tax file numbers, edit", exact: true });
    const dialog = sheet(page, "Tax file numbers");
    const gate = dialog.getByRole("switch", { name: "Only with a context word nearby", exact: true });

    await row.click();
    await expect(gate).toBeChecked();
    await dialog.getByLabel("Why (shown on the block page)", { exact: true }).fill("Never paste a TFN");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(1);
    expect(puts(calls)[0]?.document.contentRules[0]?.detector).toEqual({ kind: "au-tfn", requireContext: true });
    expect(puts(calls)[0]?.document.contentRules[0]?.note).toBe("Never paste a TFN");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await row.click();
    await gate.click();
    await expect(gate).not.toBeChecked();
    await expect(dialog.getByTestId("detector-context-warning")).toContainText("1 in 11");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(2);
    expect(puts(calls)[1]?.document.contentRules[0]?.detector).toEqual({ kind: "au-tfn" });
  });

  test("Delete asks first and Cancel keeps it; Delete saves without it; Turn off saves it off", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content");
    const actions = rowOf(page, "Tax file numbers").getByRole("button", { name: "Actions for Tax file numbers", exact: true });
    const confirm = page.getByRole("alertdialog", { name: "Delete “Tax file numbers”?", exact: true });

    await actions.click();
    await menuItem(page, "Turn off").click();
    await expect.poll(() => puts(calls).length).toBe(1);
    expect(puts(calls)[0]?.document.contentRules[0]?.enabled).toBe(false);
    await expect(page.getByTestId("content-action")).toHaveText("Off");

    await actions.click();
    await menuItem(page, "Delete…").click();
    await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    expect(puts(calls)).toHaveLength(1);

    await actions.click();
    await menuItem(page, "Delete…").click();
    await confirm.getByRole("button", { name: "Delete rule", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(2);
    expect(puts(calls)[1]?.document.contentRules).toEqual([]);
    await expect(page.getByTestId("content-rules-empty")).toBeVisible();
  });
});

test.describe("the rules page's other states", () => {
  test("in monitor mode the page says so and links to Settings; enforce shows no such line", async ({ page, seed }) => {
    let clientMode: GuardRulesPage["clientMode"] = "monitor";
    await answerDoors(page, rulesDoors(fixtures.rulesPage(), { "GET /guard/rules": () => ({ body: fixtures.rulesPage({ clientMode }) }) }));
    await openConsole(page, seed, "/rules");
    const banner = page.getByTestId("rules-monitor");
    await expect(banner).toContainText("Monitoring only: rules are not enforced.");
    await expect(banner).toContainText("Connections Guard cannot inspect are still blocked unless you allow them under Uninspectable TLS in Settings.");
    const link = banner.getByRole("link", { name: "Switch to enforce in Settings", exact: true });
    await expect(link).toHaveAttribute("href", consolePath(seed, "/settings"));
    await link.click();
    await expect.poll(() => routeOf(page, seed).pathname).toBe("/settings");

    clientMode = "enforce";
    await openConsole(page, seed, "/rules");
    await expect(page.getByRole("button", { name: "DeepSeek, edit", exact: true })).toBeVisible();
    await expect(page.getByTestId("rules-monitor")).toHaveCount(0);
  });

  test("an empty document says what to do in both tabs; a refused save that is not stale is a toast, not the stale line", async ({ page, seed }) => {
    const empty = fixtures.rulesPage({ document: { version: 0, defaultAction: "allow", serviceRules: [], contentRules: [] }, updatedAt: undefined, updatedBy: undefined });
    await answerDoors(page, rulesDoors(empty, { "PUT /guard/rules": refused(400, "VALIDATION", "No") }));
    await openConsole(page, seed, "/rules");
    await expect(page.getByTestId("service-rules-empty")).toBeVisible();
    await expect(page.getByTestId("rules-saved")).toHaveCount(0);

    await page.getByRole("button", { name: "Any other AI service, edit", exact: true }).click();
    const dialog = sheet(page, "When no rule names a service");
    await card(dialog, "Block").click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("The rules were not saved");
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "The rules were not saved" })).toContainText("No. Try again.");
    await expect(page.getByTestId("rules-stale")).toHaveCount(0);

    await openConsole(page, seed, "/rules?tab=content");
    await expect(page.getByTestId("content-rules-empty")).toBeVisible();
  });

  test("a failed read shows the error with a retry", async ({ page, seed }) => {
    let failing = true;
    await answerDoors(
      page,
      rulesDoors(fixtures.rulesPage(), {
        "GET /guard/rules": () => (failing ? refused(500, "INTERNAL", "Something went wrong") : { body: fixtures.rulesPage() }),
      }),
    );
    await openConsole(page, seed, "/rules");
    await expect(page.getByText("Something went wrong", { exact: true })).toBeVisible();
    const retry = page.getByRole("button", { name: "Try again", exact: true });
    await expect(retry).toBeVisible();

    failing = false;
    await retry.click();
    await expect(page.getByRole("button", { name: "DeepSeek, edit", exact: true })).toBeVisible();
  });
});

test.describe("would this be blocked?", () => {
  test("posts the service, person, text and file names and renders the verdict with the monitor-mode line", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content&rule=gcr_0000aaaa");
    const box = page.getByTestId("rules-test-box");
    await box.getByLabel("As", { exact: true }).fill("Grace@Fernwood.example");
    await box.getByLabel("What they would send", { exact: true }).fill("My TFN is 123 456 782");
    await box.getByLabel("Files they would attach", { exact: true }).fill("payroll.xlsx, notes.pdf");
    await box.getByTestId("test-run").click();

    const verdict = box.getByTestId("test-verdict");
    await expect(verdict).toHaveAttribute("data-verdict", "blocked");
    await expect(verdict).toContainText("Blocked");
    await expect(verdict).toContainText("123***782");
    await expect(verdict.getByTestId("test-monitor")).toHaveText("In monitor mode this would be recorded, not blocked.");
    expect(ruleTests(calls)).toEqual([{ serviceId: "openai-chatgpt", personEmail: "grace@fernwood.example", text: "My TFN is 123 456 782", filenames: ["payroll.xlsx", "notes.pdf"] }]);
  });

  test("tests a bare host, and marks a match a grant lets past", async ({ page, seed }) => {
    const grantedPast = fixtures.testResult({
      verdict: "allowed",
      enforced: true,
      content: [{ ruleId: "gcr_0000aaaa", ruleName: "Tax file numbers", matchType: "au-tfn", count: 2, action: "block", excepted: true }],
    });
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage(), { "POST /guard/rules/test": { body: grantedPast } }));
    await openConsole(page, seed, "/rules?tab=content&rule=gcr_0000aaaa");
    const box = page.getByTestId("rules-test-box");
    await choose(box.getByRole("combobox", { name: "Service", exact: true }), "Another host…");
    await box.getByLabel("Host to test", { exact: true }).fill("Chat.OpenAI.com");
    await box.getByTestId("test-run").click();

    const verdict = box.getByTestId("test-verdict");
    await expect(verdict.getByTestId("test-excepted")).toBeVisible();
    await expect(verdict.getByTestId("test-monitor")).toHaveCount(0);
    expect(ruleTests(calls)).toEqual([{ host: "chat.openai.com" }]);
  });

  test("taste pass: a test box without a host says so and focuses the field; the verdict is announced", async ({ page, seed }) => {
    const { calls } = await answerDoors(
      page,
      rulesDoors(fixtures.rulesPage(), { "POST /guard/rules/test": { body: fixtures.testResult({ verdict: "blocked", explanation: "Blocked by DeepSeek → block." }) } }),
    );
    await openConsole(page, seed, "/rules?tab=content&rule=gcr_0000aaaa");
    const box = page.getByTestId("rules-test-box");
    await expect(box.getByTestId("test-announce")).toHaveAttribute("role", "status");
    await choose(box.getByRole("combobox", { name: "Service", exact: true }), "Another host…");
    const run = box.getByTestId("test-run");
    await expect(run).toBeEnabled();
    await run.click();

    const host = box.getByLabel("Host to test", { exact: true });
    await expect(box.getByRole("alert")).toContainText("Type the host to check");
    await expect(host).toHaveAttribute("aria-invalid", "true");
    await expect(host).toHaveAttribute("aria-describedby", "test-host-problem");
    await expect(host).toBeFocused();
    expect(ruleTests(calls)).toHaveLength(0);

    await host.fill("chat.deepseek.com");
    await run.click();
    await expect(box.getByTestId("test-verdict")).toBeVisible();
    await expect(box.getByTestId("test-announce")).toHaveText("Blocked: Blocked by DeepSeek → block.");
  });

  test("taste pass: a content rule for Groups with none ticked marks the group list and focuses it", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content&rule=__new__");
    const dialog = sheet(page, "Add a content rule");
    await dialog.getByLabel("Name", { exact: true }).fill("Cards");
    await choose(dialog.getByRole("combobox", { name: "Detects", exact: true }), "Payment card number");
    await choose(dialog.getByRole("combobox", { name: "Who", exact: true }), "Groups");
    await dialog.getByRole("button", { name: "Add rule", exact: true }).click();

    const problem = dialog.getByRole("alert");
    await expect(problem).toHaveText("Pick at least one group.");
    await expect(problem).toHaveAttribute("id", "crule-audience-kind-error");
    const first = dialog.getByRole("checkbox", { name: "Engineering", exact: true });
    await expect(first).toHaveAttribute("aria-invalid", "true");
    await expect(first).toHaveAttribute("aria-describedby", "crule-audience-kind-error");
    await expect(first).toBeFocused();
    expect(puts(calls)).toHaveLength(0);

    await dialog.getByRole("list", { name: "Groups", exact: true }).getByText("Engineering", { exact: true }).click();
    await expect(first).toBeChecked();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });

  test("the service sheet's box starts on that service; Enter in a field checks without saving the sheet", async ({ page, seed }) => {
    const { calls } = await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?service=deepseek-chat");
    const box = page.getByTestId("rules-test-box");
    await expect(box.getByRole("combobox", { name: "Service", exact: true })).toHaveText("DeepSeek");
    await box.getByLabel("Files they would attach", { exact: true }).press("Enter");

    await expect(box.getByTestId("test-verdict")).toBeVisible();
    expect(ruleTests(calls)).toEqual([{ serviceId: "deepseek-chat" }]);
    expect(puts(calls)).toHaveLength(0);
    expect(routeOf(page, seed).search).toBe("?service=deepseek-chat");
    await expect(sheet(page, "DeepSeek")).toBeVisible();
  });
});

test.describe("the test box's refusals", () => {
  test("a refusal from the registry is shown with its message", async ({ page, seed }) => {
    await answerDoors(
      page,
      rulesDoors(fixtures.rulesPage(), { "POST /guard/rules/test": refused(400, "VALIDATION", "That address is not a member of this organisation") }),
    );
    await openConsole(page, seed, "/rules?tab=content&rule=gcr_0000aaaa");
    const box = page.getByTestId("rules-test-box");
    await box.getByTestId("test-run").click();

    await expect(box.getByRole("alert")).toContainText("That address is not a member of this organisation");
    await expect(box.getByTestId("test-verdict")).toHaveCount(0);
    await expect(box.getByTestId("test-announce")).toHaveText("");
  });

  test("anything else thrown reads as 'The test did not run', with what was thrown as the detail", async ({ page, seed }) => {
    await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules?tab=content&rule=gcr_0000aaaa");
    const box = page.getByTestId("rules-test-box");
    await expect(box).toBeVisible();
    await page.evaluate(() => {
      const read = Response.prototype.text;
      Response.prototype.text = function (this: Response): Promise<string> {
        return this.url.endsWith("/guard/rules/test") ? Promise.reject(new TypeError("boom")) : read.call(this);
      };
    });
    await box.getByTestId("test-run").click();

    const alert = box.getByRole("alert");
    await expect(alert).toContainText("The test did not run");
    await alert.getByText("Details for IT", { exact: true }).click();
    await expect(alert.getByText("TypeError: boom", { exact: true })).toBeVisible();
    await expect(box.getByTestId("test-verdict")).toHaveCount(0);
  });
});

test.describe("the app and website switches", () => {
  test("each switch saves at once, leaving service and content rules alone", async ({ page, seed }) => {
    const original = fixtures.rulesPage();
    const { calls } = await answerDoors(page, rulesDoors(original));
    await openConsole(page, seed, "/rules");
    for (const [index, name] of SWITCHES.entries()) {
      const toggle = page.getByRole("switch", { name, exact: true });
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect.poll(() => puts(calls).length).toBe(index + 1);
      await expect(toggle).toBeChecked();
    }

    const last = puts(calls)[3];
    expect(last?.document.surfaceBlocks).toEqual({ "claude-web": true, "claude-macos": true, "chatgpt-web": true, "chatgpt-macos": true });
    expect(last?.document.serviceRules).toEqual(original.document.serviceRules);
    expect(last?.document.contentRules).toEqual(original.document.contentRules);

    await page.getByRole("switch", { name: "Block the Claude website", exact: true }).click();
    await expect.poll(() => puts(calls).length).toBe(5);
    expect(puts(calls)[4]?.document.surfaceBlocks).toEqual({ "claude-macos": true, "chatgpt-web": true, "chatgpt-macos": true });
    expect(puts(calls).map((sent) => sent.baseVersion)).toEqual([3, 4, 5, 6, 7]);
  });

  test("when laptops need upgrading first, the page says so and the switch stays off", async ({ page, seed }) => {
    await answerDoors(
      page,
      rulesDoors(fixtures.rulesPage(), { "PUT /guard/rules": refused(409, "GUARD_UPGRADE_REQUIRED", "Upgrade all active Guard agents before enabling surface blocks") }),
    );
    await openConsole(page, seed, "/rules");
    const toggle = page.getByRole("switch", { name: "Block the Claude website", exact: true });
    await toggle.click();

    const said = "Upgrade all active Guard agents before enabling surface blocks.";
    await expect(page.getByTestId("surface-blocks").locator("[data-slot='settings-row-problem']")).toHaveText(said);
    await expect(toggle).toHaveAccessibleDescription(/Upgrade all active Guard agents before enabling surface blocks\.$/);
    await expect(toggle).not.toBeChecked();
    await expect(page.locator("[data-sonner-toast]").filter({ hasText: "The Claude website was not blocked" })).toContainText(said);
    await expect(page.getByTestId("rules-problem")).toHaveCount(0);
    await expect(page.getByTestId("rules-stale")).toHaveCount(0);
  });

  test("offers every surface switch, the ChatGPT Mac app as one merged ChatGPT and Codex control", async ({ page, seed }) => {
    await answerDoors(page, rulesDoors(fixtures.rulesPage()));
    await openConsole(page, seed, "/rules");
    for (const name of SWITCHES) await expect(page.getByRole("switch", { name, exact: true })).toBeEnabled();
    await expect(page.getByTestId("surface-blocks").getByRole("switch")).toHaveCount(SWITCHES.length);
  });
});

test.describe("the seeded registry", () => {
  test("lists the seeded DeepSeek service rule and the seeded Tax file numbers content rule", async ({ page, seed }) => {
    await openConsole(page, seed, "/rules");
    const deepseek = rowOf(page, "DeepSeek");
    await expect(deepseek.getByTestId("rule-status")).toHaveAttribute("data-status", "block");
    await expect(deepseek).toContainText("Data leaves Australia");

    await page.getByRole("button", { name: "DeepSeek, edit", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?service=deepseek");
    const deepseekSheet = sheet(page, "DeepSeek");
    await expect(deepseekSheet.getByRole("combobox", { name: "Status for everyone", exact: true })).toHaveText("Block");
    await deepseekSheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("navigation", { name: "Rule views" }).getByRole("link", { name: "Content", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe("?tab=content");
    const taxFileNumbers = rowOf(page, "Tax file numbers");
    await expect(taxFileNumbers.getByTestId("content-action")).toHaveAttribute("data-status", "block");
    await expect(taxFileNumbers).toContainText("Every AI service");
    await expect(taxFileNumbers).toContainText("Everyone");

    await page.getByRole("button", { name: "Tax file numbers, edit", exact: true }).click();
    await expect.poll(() => routeOf(page, seed).search).toBe(`?tab=content&rule=${seed.rules.taxFileNumbers}`);
    const tfnSheet = sheet(page, "Tax file numbers");
    await expect(tfnSheet.getByRole("combobox", { name: "Detects", exact: true })).toHaveText("Tax file number");
    await tfnSheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
