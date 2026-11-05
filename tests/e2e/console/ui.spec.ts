import { type Locator, type Page, expect, test } from "@playwright/test";
import { motion } from "@vibtra/ui";
import { FIXTURE_URL } from "./support/env.ts";

test.use({ baseURL: FIXTURE_URL, storageState: { cookies: [], origins: [] }, contextOptions: { reducedMotion: "no-preference" } });

type Row = { state: string | null; text: string; cls: string };
type Probe = Window & { __events: unknown[][]; __rows: Row[][] };

const LOOPS = ["v-shimmer-text", "v-spin-ring", "v-spin-ring-slow", "v-blink", "v-caret", "v-pulse", "v-pulse-soft", "v-pulse-quick", "v-ping", "v-jiggle", "v-ants"];

const open = async (page: Page, scene: string, query = ""): Promise<void> => {
  await page.goto(`/?scene=${scene}${query}`);
  const main = page.locator(`main[data-scene="${scene}"]`);
  if (scene === "dialog") await expect(main).toBeAttached();
  else await expect(main).toBeVisible();
};

const events = (page: Page): Promise<unknown[][]> => page.evaluate(() => (window as unknown as Probe).__events);

const classContains = (locator: Locator, text: string): Promise<void> =>
  expect(locator).toHaveAttribute("class", new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const rowsOf = (section: Locator): Promise<Row[]> =>
  section.locator("[data-slot=activity-line-row]").evaluateAll((rows) =>
    rows.map((row) => ({ state: row.getAttribute("data-state"), text: row.textContent ?? "", cls: row.getAttribute("class") ?? "" })),
  );

const recordRows = (page: Page, testId: string): Promise<void> =>
  page.evaluate((id) => {
    const probe = window as unknown as Probe;
    const host = document.querySelector(`[data-testid="${CSS.escape(id)}"]`);
    if (host === null) throw new Error(`no section ${id}`);
    probe.__rows = [];
    const snap = (): void => {
      probe.__rows.push(
        [...host.querySelectorAll("[data-slot=activity-line-row]")].map((row) => ({ state: row.getAttribute("data-state"), text: row.textContent ?? "", cls: row.getAttribute("class") ?? "" })),
      );
    };
    new MutationObserver(snap).observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  }, testId);

const recorded = (page: Page): Promise<Row[][]> => page.evaluate(() => (window as unknown as Probe).__rows);

const loopingClasses = (section: Locator): Promise<string[]> =>
  section.evaluate((root, loops) => {
    const found: string[] = [];
    for (const element of root.querySelectorAll("*")) {
      for (const token of (element.getAttribute("class") ?? "").split(/\s+/)) if (loops.includes(token)) found.push(token);
    }
    return found;
  }, LOOPS);

const milliseconds = (value: string): number => {
  const text = value.trim();
  if (text.endsWith("ms")) return Number(text.slice(0, -2));
  if (text.endsWith("s")) return Number(text.slice(0, -1)) * 1000;
  return Number.NaN;
};

test.describe("ActivityLine", () => {
  test("draws the bar, the target and the shimmering action", async ({ page }) => {
    await open(page, "activity");
    const live = page.getByTestId("live");
    await classContains(live.locator("[data-slot=activity-bar]"), "bg-hue-orange-600");
    await expect(live).toContainText("Lunch poll");
    await expect(live.locator("[data-slot=shimmer-text]")).toHaveAttribute("data-shimmer", "true");
    const rows = await rowsOf(live);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.cls).toContain("v-rise-in");
  });

  test("an icon replaces the bar", async ({ page }) => {
    await open(page, "activity");
    const icon = page.getByTestId("icon");
    await expect(icon.getByTestId("activity-icon")).toHaveCount(1);
    await expect(icon.locator("[data-slot=activity-bar]")).toHaveCount(0);
    await expect(icon.locator("[data-slot=shimmer-text]")).not.toHaveAttribute("data-shimmer", /.*/);
  });

  test("a new key replaces the row: the old one exits, then only the new one remains", async ({ page }) => {
    await open(page, "activity");
    const live = page.getByTestId("live");
    await recordRows(page, "live");
    await page.getByRole("button", { name: "Next activity", exact: true }).click();
    await expect.poll(() => rowsOf(live)).toEqual([expect.objectContaining({ state: "current", text: expect.stringContaining("Reading package.json…") })]);
    const during = (await recorded(page)).find((rows) => rows.length === 2);
    expect(during, "a frame with the leaving row and the new row together").toBeDefined();
    const leaving = during?.find((row) => row.state === "leaving");
    expect(leaving?.text).toContain("Writing src/app/index.html…");
    expect(leaving?.cls).toContain("v-exit-up");
    expect(during?.find((row) => row.state === "current")?.text).toContain("Reading package.json…");
  });

  test("the same key updates in place with no exit", async ({ page }) => {
    await open(page, "activity");
    const live = page.getByTestId("live");
    await recordRows(page, "live");
    await page.getByRole("button", { name: "Same activity", exact: true }).click();
    await expect(live).toContainText("Writing src/app/app.js…");
    expect(await rowsOf(live)).toHaveLength(1);
    expect((await recorded(page)).every((rows) => rows.length <= 1 && rows.every((row) => row.state === "current"))).toBe(true);
  });

  test("null clears the line after the exit", async ({ page }) => {
    await open(page, "activity");
    const live = page.getByTestId("live");
    await recordRows(page, "live");
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(live.locator("[data-slot=activity-line]")).toHaveCount(0);
    const seen = await recorded(page);
    expect(seen.some((rows) => rows.length === 1 && rows[0]?.state === "leaving")).toBe(true);
  });
});

test.describe("StatusStrip", () => {
  test("shows the sentence and ticks every tenth while working", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-30T08:00:00Z") });
    await open(page, "status");
    await page.clock.pauseAt(new Date("2026-09-30T08:00:05Z"));
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const ticking = page.getByTestId("ticking");
    await expect(ticking).toContainText("Vibtra is building");
    const timer = ticking.locator("[data-slot=status-timer]");
    await expect(timer).toHaveText("0.0s");
    await page.clock.runFor(motion.timerTick);
    await expect(timer).toHaveText("0.1s");
    await page.clock.runFor(36_600);
    await expect(timer).toHaveText("36.7s");
    await page.clock.runFor(33_500);
    await expect(timer).toHaveText("1m 10.2s");
  });

  test("hides the timer and the ring when idle", async ({ page }) => {
    await open(page, "status");
    const idle = page.getByTestId("idle");
    await expect(idle).toContainText("What do you want to do?");
    await expect(idle.locator("[data-slot=status-timer]")).toHaveCount(0);
    await expect(idle.locator("[data-slot=working-ring]")).toHaveCount(0);
  });

  test("shows the ring while working and takes a fixed elapsed value", async ({ page }) => {
    await open(page, "status");
    const fixed = page.getByTestId("fixed");
    await expect(fixed.locator("[data-slot=working-ring]")).toHaveCount(1);
    await expect(fixed.locator("[data-slot=status-timer]")).toHaveText("9.5s");
  });
});

test.describe("WorkLog", () => {
  test("starts collapsed and toggles open and closed", async ({ page }) => {
    await open(page, "worklog");
    const section = page.getByTestId("collapsed");
    const toggle = section.getByRole("button", { name: /Worked for 2m 40s/ });
    const body = section.locator("[data-slot=work-log] > [data-slot=work-log-collapse]");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(body).toHaveAttribute("data-state", "closed");
    await expect(body).toHaveAttribute("inert", /.*/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(body).toHaveAttribute("data-state", "open");
    await expect(body).not.toHaveAttribute("inert", /.*/);
    await classContains(body, "v-expand");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  test("draws the tree: rail, pill rows by kind, prose inline", async ({ page }) => {
    await open(page, "worklog");
    const section = page.getByTestId("open");
    await expect(section.locator("[data-slot=work-log-tree]")).toHaveCount(1);
    const rows = section.locator("[data-slot=work-log-row]");
    expect(await rows.evaluateAll((all) => all.map((row) => row.getAttribute("data-kind")))).toEqual(["read", "run", "think"]);
    expect(await rows.evaluateAll((all) => all.every((row) => row.querySelector("svg") !== null))).toBe(true);
    await expect(section.getByText("I'll make one shared poll.", { exact: true })).toBeVisible();
    await expect(section.getByText("Thought for 2 seconds", { exact: true })).toBeVisible();
  });

  test("a row with detail expands on its own", async ({ page }) => {
    await open(page, "worklog");
    const section = page.getByTestId("open");
    const row = section.getByRole("button", { name: "Ran Lunch poll", exact: true });
    await expect(row).toHaveAttribute("aria-expanded", "false");
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    const controls = await row.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    await expect(page.locator(`[id="${controls}"]`)).toHaveAttribute("data-state", "open");
    await expect(section.getByRole("button", { name: "Read skill file", exact: true })).not.toHaveAttribute("aria-expanded", /.*/);
  });

  test("is controllable", async ({ page }) => {
    await open(page, "worklog");
    const section = page.getByTestId("controlled");
    const toggle = section.getByRole("button", { name: /Worked for 5s/ });
    await toggle.click();
    await expect.poll(() => events(page)).toEqual([["openChange", true]]);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await section.getByRole("button", { name: "Open from outside", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  test("ThreadStatusRow: waiting shimmers; answered carries the check", async ({ page }) => {
    await open(page, "worklog");
    const section = page.getByTestId("thread-status");
    await expect(section.locator("[data-slot=shimmer-text]")).toHaveText("Waiting for answer…");
    await section.getByRole("button", { name: "Answer", exact: true }).click();
    await expect(section.locator("[data-slot=shimmer-text]")).toHaveCount(0);
    await expect(section.locator("[data-tone=done] svg")).toHaveCount(1);
    await expect(section.getByText("Question answered: The organiser", { exact: true })).toBeVisible();
  });
});

const selected = (page: Page): Locator => page.locator("[data-slot=decision-option][data-selected]");
const other = (page: Page): Locator => page.getByPlaceholder("Something else…");
const hints = (page: Page): Promise<string[]> => page.locator("[data-slot=kbd-hint]").allTextContents();

test.describe("DecisionCard", () => {
  test("draws a question's detail under its prompt and an option's detail after its label", async ({ page }) => {
    await open(page, "decision", "&q=details");
    await expect(page.locator("[data-slot=decision-question-detail]")).toHaveText("Pick one.");
    await expect(page.locator("[data-slot=decision-option-detail]")).toHaveText(["The organiser"]);
  });

  test("starts on option 1", async ({ page }) => {
    await open(page, "decision");
    await expect(selected(page)).toContainText("The organiser");
  });

  for (const [key, label] of [
    ["1", "The organiser"],
    ["2", "Anyone on the team"],
    ["3", "Nobody, it closes on a timer"],
  ] as const) {
    test(`number key ${key} selects that option`, async ({ page }) => {
      await open(page, "decision");
      await page.keyboard.press(key);
      await expect(selected(page)).toContainText(label);
    });
  }

  test("a number past the options focuses 'Something else…'; beyond that is ignored", async ({ page }) => {
    await open(page, "decision");
    await page.keyboard.press("4");
    await expect(other(page)).toBeFocused();
    await expect(page.locator("[data-slot=decision-other][data-selected]")).toHaveCount(1);
    await page.keyboard.press("9");
    await expect(page.locator("[data-slot=decision-other][data-selected]")).toHaveCount(1);
    await expect(selected(page)).toHaveCount(0);
  });

  test("↵ submits the selected option", async ({ page }) => {
    await open(page, "decision");
    await page.keyboard.press("2");
    await page.keyboard.press("Enter");
    const answer = { questionId: "q1", optionId: "b", text: "Anyone on the team" };
    await expect.poll(() => events(page)).toEqual([
      ["answer", answer],
      ["complete", [answer]],
    ]);
  });

  test("↑/↓ move the selection", async ({ page }) => {
    await open(page, "decision");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(selected(page)).toContainText("Nobody");
    await page.keyboard.press("ArrowUp");
    await expect(selected(page)).toContainText("Anyone");
  });

  test("typing in 'Something else…' types (numbers included) and ↵ submits the text", async ({ page }) => {
    await open(page, "decision", "&on=answer");
    await other(page).focus();
    await other(page).pressSequentially("Whoever made it 2 days ago");
    await expect(other(page)).toHaveValue("Whoever made it 2 days ago");
    await page.keyboard.press("Enter");
    await expect.poll(() => events(page)).toEqual([["answer", { questionId: "q1", text: "Whoever made it 2 days ago" }]]);
  });

  test("↵ on an empty 'Something else…' does not submit", async ({ page }) => {
    await open(page, "decision", "&on=answer");
    await page.keyboard.press("4");
    await expect(other(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(other(page)).toBeFocused();
    expect(await events(page)).toEqual([]);
  });

  test("esc skips", async ({ page }) => {
    await open(page, "decision", "&on=skip,chat");
    await page.keyboard.press("Escape");
    await expect.poll(() => events(page)).toEqual([["skip", "q1", 0]]);
  });

  test("⇧esc chats instead", async ({ page }) => {
    await open(page, "decision", "&on=skip,chat");
    await page.keyboard.press("Shift+Escape");
    await expect.poll(() => events(page)).toEqual([["chat"]]);
  });

  test("⌘^→ and ⌘^← cycle the questions and show n/m", async ({ page }) => {
    await open(page, "decision", "&q=three");
    const progress = page.locator("[data-slot=decision-progress]");
    await expect(progress).toHaveText("1/3");
    await page.keyboard.press("Meta+Control+ArrowRight");
    await expect(progress).toHaveText("2/3");
    await expect(page.getByText("Second?", { exact: true })).toBeVisible();
    await page.keyboard.press("Meta+Control+ArrowLeft");
    await page.keyboard.press("Meta+Control+ArrowLeft");
    await expect(progress).toHaveText("3/3");
    await page.keyboard.press("Meta+ArrowRight");
    await expect(progress).toHaveText("3/3");
  });

  test("answering advances to the next question and completes after the last", async ({ page }) => {
    await open(page, "decision", "&q=three");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Second?", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByText("Third?", { exact: true })).toBeVisible();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    const first = { questionId: "q1", optionId: "a", text: "A1" };
    const third = { questionId: "q3", optionId: "a", text: "A3" };
    await expect.poll(() => events(page)).toEqual([
      ["answer", first],
      ["skip", "q2", 1],
      ["answer", third],
      ["complete", [first, third]],
    ]);
  });

  test("leaves keys typed into another page field alone", async ({ page }) => {
    await open(page, "decision", "&outside=1");
    const field = page.getByRole("textbox", { name: "Another field", exact: true });
    await field.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.keyboard.press("2");
    await expect(field).toBeFocused();
    await expect(selected(page)).toContainText("The organiser");
    expect(await events(page)).toEqual([]);
  });

  test("clicking an option answers it; hints show only for callbacks given", async ({ page }) => {
    await open(page, "decision", "&on=answer");
    await page.getByText("Nobody, it closes on a timer", { exact: true }).click();
    await expect.poll(() => events(page)).toEqual([["answer", { questionId: "q1", optionId: "c", text: "Nobody, it closes on a timer" }]]);
    const words = await hints(page);
    expect(words.some((hint) => hint.startsWith("Skip"))).toBe(false);
    expect(words.some((hint) => hint.startsWith("Chat instead"))).toBe(false);
    expect(words.some((hint) => hint.startsWith("Select"))).toBe(true);
  });

  test("reuses as plan approval with its own labels", async ({ page }) => {
    await open(page, "decision", "&q=plan&on=answer,skip");
    await expect(page.locator("[data-slot=decision-other]")).toHaveCount(0);
    expect(await hints(page)).toContain("Keep planningesc");
    await page.keyboard.press("Enter");
    await expect.poll(() => events(page)).toEqual([["answer", { questionId: "plan", optionId: "approve", text: "Approve and build" }]]);
  });

  test("a request wait with no options shows only its prompt and chat instead", async ({ page }) => {
    await open(page, "decision", "&q=wait&on=chat");
    await expect(page.getByText("Waiting for IT to approve Slack", { exact: true })).toBeVisible();
    await expect(page.locator("[data-slot=decision-option]")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Shift+Escape");
    await expect.poll(() => events(page)).toEqual([["chat"]]);
  });

  test("stops listening when unmounted or keyboard is off", async ({ page }) => {
    await open(page, "decision", "&keys=0&on=skip");
    await page.keyboard.press("Escape");
    expect(await events(page)).toEqual([]);
    await page.getByRole("button", { name: "Keyboard on", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect.poll(() => events(page)).toEqual([["skip", "q1", 0]]);
    await page.getByRole("button", { name: "Unmount", exact: true }).click();
    await expect(page.locator("[data-slot=decision-option]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    expect(await events(page)).toEqual([["skip", "q1", 0]]);
  });
});

test.describe("the follow pill, the touched strip and the active frame", () => {
  test("FollowPill names who is followed and stops", async ({ page }) => {
    await open(page, "build");
    const section = page.getByTestId("follow");
    await expect(section).toContainText("Following Vibtra");
    await classContains(section.locator("[data-slot=follow-pill]"), "v-drop-in");
    const stop = section.getByRole("button", { name: "Stop following", exact: true });
    await expect(stop).toHaveText("Stop");
    await stop.click();
    await expect.poll(() => events(page)).toEqual([["stop"]]);
  });

  test("TouchedStrip colours by position, outlines the active card and badges it", async ({ page }) => {
    await open(page, "build");
    const section = page.getByTestId("touched");
    const cards = section.locator("[data-slot=step-card]");
    await expect(cards).toHaveCount(3);
    await classContains(cards.nth(0), "bg-hue-orange-200");
    await expect(cards.nth(1)).toHaveAttribute("data-selected", "true");
    await classContains(cards.nth(1), "var(--v-hue-teal-600)");
    await classContains(cards.nth(2), "bg-hue-sky-200");
    await expect(section.getByTestId("badge")).toHaveCount(1);
    await classContains(section.locator("[data-slot=touched-card]").first(), "v-grow-in");
    await cards.nth(2).click();
    await expect.poll(() => events(page)).toEqual([["select", "c"]]);
  });

  test("ActiveFrame is a hairline when inactive, the step colour when active, a gradient for several", async ({ page }) => {
    await open(page, "build");
    const section = page.getByTestId("frame");
    const frame = section.locator("[data-slot=active-frame]");
    await expect(frame).not.toHaveAttribute("data-active", /.*/);
    await expect(section.locator(".hairline")).toHaveCount(1);
    await page.getByRole("button", { name: "One step", exact: true }).click();
    await expect.poll(() => section.locator("[data-slot=active-frame] > span").first().evaluate((span) => (span as HTMLElement).style.backgroundColor)).toContain("--v-hue-teal-600");
    await page.getByRole("button", { name: "Several steps", exact: true }).click();
    const gradient = section.locator("[data-slot=active-frame-gradient]");
    await expect
      .poll(() => gradient.evaluate((node) => (node as HTMLElement).style.getPropertyValue("--v-frame-gradient")))
      .toContain("conic-gradient(from 0deg, var(--v-hue-orange-600), var(--v-hue-teal-600), var(--v-hue-pink-600), var(--v-hue-orange-600))");
    await classContains(gradient, "v-spin-ring-slow");
    await expect(section.getByText("code", { exact: true })).toBeVisible();
  });
});

test.describe("the Ona-shaped primitives", () => {
  test("the list card draws rows with a tile, the title and tags, the description and a right slot", async ({ page }) => {
    await open(page, "ona");
    const list = page.getByRole("list", { name: "Connections", exact: true });
    await classContains(list, "rounded-xl");
    await classContains(list, "border-border");
    await classContains(list.getByText("Reporting warehouse", { exact: true }), "leading-pair");
    await classContains(list.getByText("db.fernwood.example · added by Ada", { exact: true }), "text-secondary-foreground");
    const add = page.getByRole("button", { name: "Add connection", exact: true });
    await classContains(add, "bg-secondary");
    await add.click();
    await expect.poll(() => events(page)).toEqual([["add-connection"]]);
  });

  test("the list card makes the whole row a link when given one, keeping the right slot its own control", async ({ page }) => {
    await open(page, "ona");
    const link = page.getByRole("link", { name: "Ticketing", exact: true });
    await expect(link).toHaveAttribute("href", "#connections-c1");
    await classContains(link, "after:absolute");
    await expect(page.getByRole("button", { name: "Test", exact: true })).toBeVisible();
  });

  test("the resource card draws the icon, title, sub-line, status, meta and a corner control; the + tile is a real button", async ({ page }) => {
    await open(page, "ona");
    const card = page.locator("[data-slot='resource-card']").filter({ hasText: "open-tickets.apps.example" });
    await classContains(card, "rounded-xl");
    await classContains(card, "border-[0.5px]");
    await expect(card.getByText("Awake", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Actions", exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Promote from a workbox/ }).click();
    await expect.poll(() => events(page)).toEqual([["promote"]]);
  });

  test("pills: the status pill, the tag, the outline chip, the mono badge and the dot with its halo", async ({ page }) => {
    await open(page, "ona");
    const pills = page.getByTestId("pills");
    await classContains(pills.getByText("me", { exact: true }), "h-(--v-chip-h)");
    await classContains(pills.getByText("me", { exact: true }), "bg-ok-bg");
    await classContains(pills.getByText("MCP", { exact: true }), "h-(--v-tag-h)");
    await classContains(pills.getByText("Linear", { exact: true }), "rounded-md");
    await classContains(pills.getByText("us-east-1", { exact: true }), "font-mono");
    const dot = pills.locator("[data-slot='status-dot'] > span").first();
    await classContains(dot, "size-2");
    await classContains(dot, "shadow-[0_0_0_2.5px_var(--v-ok-bg)]");
    await expect(pills.getByText("Running", { exact: true })).toBeVisible();
  });

  test("the table bleeds edge to edge and pads its outer cells back", async ({ page }) => {
    await open(page, "ona");
    const section = page.getByTestId("table");
    const shell = section.locator("[data-slot='table-container']");
    await expect(shell).toHaveAttribute("data-bleed", /.*/);
    await classContains(shell, "-ml-(--v-content-pad)");
    const head = section.getByRole("columnheader", { name: "Name", exact: true });
    await classContains(head, "h-(--v-table-th-h)");
    await classContains(head, "font-medium");
    await classContains(head, "first:pl-(--v-content-pad)");
    await expect(section.getByRole("columnheader", { name: "Actions", exact: true })).toHaveCount(1);
  });

  test("the empty state draws the page form with the glyph and the box form with a 0.5px edge", async ({ page }) => {
    await open(page, "ona");
    const section = page.getByTestId("empty");
    await expect(section.locator("[data-slot='vibtra-empty-glyph']")).toHaveCount(1);
    await classContains(section.getByText("No app boxes yet", { exact: true }), "text-xl");
    await classContains(section.getByText("Promote one from a workbox.", { exact: true }), "text-md");
    await classContains(section.locator("[data-slot='empty-card']").filter({ hasText: "Nothing waiting" }), "border-[0.5px]");
    await classContains(section.getByText("Requests appear here.", { exact: true }), "text-muted-foreground");
  });

  test("the metric card draws the big numbers and a progress bar with its value", async ({ page }) => {
    await open(page, "ona");
    const section = page.getByTestId("metric");
    await classContains(section.getByText("128", { exact: true }), "text-2xl");
    await expect(section.getByRole("progressbar", { name: "Session-hours", exact: true })).toHaveAttribute("aria-valuenow", "128");
  });

  test("the dialog is 600 at lg, with Cancel left and the primary right", async ({ page }) => {
    await open(page, "dialog");
    const dialog = page.getByRole("dialog", { name: "Invite people", exact: true });
    await expect(dialog).toHaveAttribute("data-size", "lg");
    await classContains(dialog, "var(--v-modal-wide-w)");
    await classContains(dialog.getByText("Invite people", { exact: true }), "text-lg");
    await classContains(dialog.locator("[data-slot='dialog-footer']"), "justify-between");
    await classContains(page.locator("[data-slot='dialog-overlay']"), "backdrop-scrim");
  });
});

test.describe("the button", () => {
  test("a busy button keeps its label as its accessible name", async ({ page }) => {
    await open(page, "button");
    const busy = page.getByRole("button", { name: "Create link", exact: true });
    await expect(busy).toHaveAttribute("aria-busy", "true");
    await expect(busy).toBeDisabled();
    await expect(busy).toHaveAccessibleName("Create link");
    await expect(page.getByTestId("buttons").getByRole("button")).toHaveCount(2);
  });
});

test.describe("reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("mounts no looping animation anywhere, and still draws the ring and the frame", async ({ page }) => {
    await open(page, "motion");
    const section = page.getByTestId("everything");
    const avatars = section.locator("[data-slot=working-avatar]");
    await expect(avatars).toHaveCount(2);
    for (const avatar of await avatars.all()) await expect(avatar).toHaveAttribute("data-motion", "reduced");
    expect(await loopingClasses(section)).toEqual([]);
    await expect(section.locator("[data-slot=working-ring]")).toHaveCount(2);
    await expect(section.locator("[data-slot=active-frame-gradient]")).toHaveCount(1);
  });

  test("the stylesheet switches every loop off and caps transitions at a frame", async ({ page }) => {
    await open(page, "motion");
    const probes = page.getByTestId("loop-probes");
    const names = await probes.locator("[data-loop]").evaluateAll((spans) => spans.map((span) => [span.getAttribute("data-loop"), getComputedStyle(span).animationName]));
    expect(names).toEqual(LOOPS.map((loop) => [loop, "none"]));
    await expect.poll(() => probes.getByTestId("transition-probe").evaluate((span) => getComputedStyle(span).transitionDuration)).toBe("0.001s");
  });
});

test.describe("full motion", () => {
  test("runs the loops", async ({ page }) => {
    await open(page, "motion");
    const section = page.getByTestId("everything");
    const avatars = section.locator("[data-slot=working-avatar]");
    await expect(avatars).toHaveCount(2);
    for (const avatar of await avatars.all()) await expect(avatar).toHaveAttribute("data-motion", "full");
    const found = new Set(await loopingClasses(section));
    for (const loop of ["v-shimmer-text", "v-spin-ring", "v-spin-ring-slow", "v-blink"]) expect(found.has(loop), loop).toBe(true);
    const names = await page.getByTestId("loop-probes").locator("[data-loop]").evaluateAll((spans) => spans.map((span) => getComputedStyle(span).animationName));
    expect(names.filter((name) => name === "none")).toEqual([]);
    await expect.poll(() => page.getByTestId("transition-probe").evaluate((span) => getComputedStyle(span).transitionDuration)).toBe("0.5s");
  });

  test("the theme carries every measured motion value, the glide curve and the shimmer's gradient and sweep", async ({ page }) => {
    await open(page, "motion");
    const want: Record<string, number> = {
      "--v-motion-enter": 200,
      "--v-motion-exit": 100,
      "--v-motion-expand": 160,
      "--v-motion-hover": 200,
      "--v-motion-grow": 200,
      "--v-motion-glide": 180,
      "--v-motion-drop": 300,
      "--v-loop-caret": 800,
      "--v-loop-pulse": 1000,
      "--v-loop-pulse-soft": 2000,
      "--v-loop-pulse-quick": 850,
      "--v-loop-ping": 1500,
      "--v-loop-jiggle": 800,
      "--v-loop-blink": 4000,
      "--v-loop-ants": 2000,
      "--v-loop-ring": 3000,
      "--v-loop-ring-slow": 5000,
      "--v-loop-shimmer": 2500,
    };
    const declared = await page.evaluate((names) => names.map((name) => getComputedStyle(document.documentElement).getPropertyValue(name)), Object.keys(want));
    expect(Object.fromEntries(Object.keys(want).map((name, i) => [name, milliseconds(declared[i] ?? "")]))).toEqual(want);
    const glide = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--v-ease-glide"));
    expect(glide.replace(/\s+/g, "").replace(/(^|[(,])0\./g, "$1.")).toBe("cubic-bezier(.2,0,0,1)");

    const shimmer = page.getByTestId("everything").locator(".v-shimmer-text").first();
    const muted = await page.getByTestId("muted-probe").evaluate((span) => getComputedStyle(span).color);
    const ink = await page.getByTestId("ink-probe").evaluate((span) => getComputedStyle(span).color);
    expect(await shimmer.evaluate((span) => getComputedStyle(span).backgroundImage)).toBe(`linear-gradient(90deg, ${muted} 30%, ${ink} 50%, ${muted} 70%)`);
    const sweep = await shimmer.evaluate((span) => {
      const name = getComputedStyle(span).animationName;
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSKeyframesRule && rule.name === name) {
            return [rule.findRule("0%")?.style.getPropertyValue("background-position-x"), rule.findRule("100%")?.style.getPropertyValue("background-position-x")];
          }
        }
      }
      return [];
    });
    expect(sweep).toEqual(["200%", "-200%"]);
  });
});
