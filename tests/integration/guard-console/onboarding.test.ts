import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ONBOARDING_STAGES, type ConsoleInvitationCreated, type OnboardingStage } from "@vibtra/console-api";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Onboarding = {
  StageChip: ComponentType<{ stage: OnboardingStage; since: string; now?: number }>;
  AttentionBar: ComponentType<{ late: number; tampered: number; onShow: (stage: "late" | "tampered") => void }>;
};
type Invite = {
  invitationOutcome: (made: Pick<ConsoleInvitationCreated, "email" | "role" | "emailed">, orgName: string) => { title: string; description: string };
  InvitationLink: ComponentType<{ link: string; expiresAt: string | undefined; emailed: boolean }>;
};

let onboarding: ConsoleModule<Onboarding>;
let invite: ConsoleModule<Invite>;

beforeAll(async () => {
  onboarding = await loadConsoleModule<Onboarding>("/src/people/onboarding.tsx");
  invite = await loadConsoleModule<Invite>("/src/people/InviteSheet.tsx");
});

afterAll(async () => {
  await onboarding?.close();
  await invite?.close();
});

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const html = <P extends object>(component: ComponentType<P>, props: P): string => renderToStaticMarkup(createElement(component, props));

const chip = (stage: OnboardingStage, since = ago(3 * DAY)): string => html(onboarding.module.StageChip, { stage, since, now: NOW });

const LABELS: Record<OnboardingStage, string> = {
  invited: "Invited",
  signed_in: "Signed in",
  enrolled: "Enrolled",
  certificate_trusted: "Certificate trusted",
  protected: "Protected",
  late: "Late",
  tampered: "Tampered",
};

const TONES: Record<OnboardingStage, string> = {
  invited: "muted",
  signed_in: "neutral",
  enrolled: "neutral",
  certificate_trusted: "neutral",
  protected: "ok",
  late: "warn",
  tampered: "bad",
};

describe("the People stage chip", () => {
  it.each(ONBOARDING_STAGES)("names the %s stage, says how long the person has been in it, and colours it", (stage) => {
    const markup = chip(stage);
    expect(markup).toContain(`data-stage="${stage}"`);
    expect(markup).toMatch(new RegExp(`data-tone="${TONES[stage]}"[^>]*>(<[^>]+>)*${LABELS[stage]}<`));
    expect(markup).toMatch(/data-testid="stage-stay"[^>]*>(<[^>]+>[^<]*<\/span>)?3 days</);
  });

  it("only Late and Tampered stand out from the rest", () => {
    const loud = ONBOARDING_STAGES.filter((stage) => /font-\[600\]/.test(chip(stage)));
    expect(loud).toEqual(["late", "tampered"]);
  });

  it("says time in stage in hours under a day and in whole days after", () => {
    const stay = (sinceMs: number): string => (/data-testid="stage-stay"[^>]*>(?:<span[^>]*>for <\/span>)?([^<]*)</.exec(chip("invited", ago(sinceMs))) ?? [])[1] ?? "";
    expect(stay(20 * 60_000)).toBe("under an hour");
    expect(stay(HOUR)).toBe("1 hour");
    expect(stay(23 * HOUR + 59 * 60_000)).toBe("23 hours");
    expect(stay(DAY)).toBe("1 day");
    expect(stay(8 * DAY - 1)).toBe("7 days");
  });
});

describe("the People attention bar", () => {
  const bar = (late: number, tampered: number): string => html(onboarding.module.AttentionBar, { late, tampered, onShow: () => undefined });

  it("is absent when no Mac is Late or Tampered", () => {
    expect(bar(0, 0)).toBe("");
  });

  it("counts Tampered first and Late second, and offers to show each", () => {
    const markup = bar(2, 1);
    expect(markup).toContain("1 Mac failed an integrity check. 2 Macs have stopped syncing.");
    expect(markup.indexOf("Show Tampered")).toBeGreaterThan(-1);
    expect(markup.indexOf("Show Late")).toBeGreaterThan(markup.indexOf("Show Tampered"));
    expect(markup).toContain("border-g-pill-bad-line");
  });

  it("is a warning, not an alarm, when Macs are only Late", () => {
    const markup = bar(1, 0);
    expect(markup).toContain("1 Mac has stopped syncing.");
    expect(markup).not.toContain("Show Tampered");
    expect(markup).toContain("border-g-pill-warn-line");
    expect(markup).not.toContain("border-g-pill-bad-line");
  });
});

describe("the invite sheet with mail on and off", () => {
  it("with mail on, says the invitation was emailed", () => {
    const said = invite.module.invitationOutcome({ email: "lee@example.com", role: "member", emailed: true }, "Fernwood");
    expect(said.title).toBe("Invitation sent");
    expect(said.description).toBe("We emailed lee@example.com. They join Fernwood as a member when they sign in with that address.");
  });

  it("with mail off, never claims an email went out and tells the admin to send the link", () => {
    for (const emailed of [false, undefined]) {
      const said = invite.module.invitationOutcome({ email: "lee@example.com", role: "admin", ...(emailed === undefined ? {} : { emailed }) }, "Fernwood");
      expect(said.title).toBe("Invitation ready");
      expect(said.description).toContain("nothing was sent. Send lee@example.com this link.");
      expect(said.description).toContain("as an admin");
      expect(said.description).not.toMatch(/emailed/i);
    }
  });

  it("shows the invitation link with a copy button either way, and with mail on calls it the fallback", () => {
    const off = html(invite.module.InvitationLink, { link: "https://guard.example/login?invitation=inv%201", expiresAt: undefined, emailed: false });
    const on = html(invite.module.InvitationLink, { link: "https://guard.example/login?invitation=inv%201", expiresAt: undefined, emailed: true });
    for (const markup of [off, on]) {
      expect(markup).toMatch(/<input[^>]*value="https:\/\/guard\.example\/login\?invitation=inv%201"/);
      expect(markup).toContain("Copy link");
    }
    expect(off).not.toContain("If the email does not arrive");
    expect(on).toContain("If the email does not arrive, send this instead.");
  });
});
