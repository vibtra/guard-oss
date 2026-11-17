import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ONBOARDING_STAGES, type InviteDelivery, type OnboardingStage } from "@vibtra/console-api";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Onboarding = {
  StageChip: ComponentType<{ stage: OnboardingStage; since: string; now?: number }>;
  AttentionBar: ComponentType<{ late: number; tampered: number; onShow: (stage: "late" | "tampered") => void }>;
};
type Sent = { kind: "invitation"; email: string; role: "owner" | "admin" | "member"; orgName: string; again: boolean } | { kind: "reminder"; email: string };
type Delivery = {
  deliveryWords: (delivery: InviteDelivery, sent: Sent) => { title: string; description: string };
  SentResult: ComponentType<{ delivery: InviteDelivery; email: string; label: string; link: string | undefined; expiresAt?: string }>;
};

let onboarding: ConsoleModule<Onboarding>;
let delivery: ConsoleModule<Delivery>;

beforeAll(async () => {
  onboarding = await loadConsoleModule<Onboarding>("/src/people/onboarding.tsx");
  delivery = await loadConsoleModule<Delivery>("/src/people/delivery.tsx");
});

afterAll(async () => {
  await onboarding?.close();
  await delivery?.close();
});

const NOW = Date.parse("2026-11-17T12:00:00Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const html = <P extends object>(component: ComponentType<P>, props: P): string => renderToStaticMarkup(createElement(component, props));

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, "").replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e);

const buttonNames = (markup: string): string[] => [...markup.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => textOf(m[1] ?? "").trim());

const fieldValue = (markup: string, label: string): string | undefined => {
  const target = [...markup.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)].find((m) => textOf(m[2] ?? "").trim() === label)?.[1];
  if (target === undefined) return undefined;
  const input = new RegExp(`<input\\b[^>]*id="${target}"[^>]*>`).exec(markup)?.[0];
  const value = input === undefined ? undefined : /value="([^"]*)"/.exec(input)?.[1];
  return value === undefined ? undefined : textOf(value);
};

const chip = (stage: OnboardingStage, since = ago(3 * DAY)): string => textOf(html(onboarding.module.StageChip, { stage, since, now: NOW }));

const LABELS: Record<OnboardingStage, string> = {
  invited: "Invited",
  signed_in: "Signed in",
  enrolled: "Enrolled",
  certificate_trusted: "Certificate trusted",
  protected: "Protected",
  late: "Late",
  tampered: "Tampered",
};

describe("the People stage chip", () => {
  it.each(ONBOARDING_STAGES)("reads %s, how long, and in text a screen reader or keyboard user reaches, what it means and since when", (stage) => {
    const since = ago(3 * DAY);
    const text = chip(stage, since);
    expect(text.startsWith(`${LABELS[stage]}for 3 days. `)).toBe(true);
    const absolute = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(since));
    expect(text.endsWith(` Since ${absolute}.`)).toBe(true);
  });

  it("says what Late and Tampered mean, not only their names", () => {
    expect(chip("late")).toContain("The Mac was protected, and has stopped syncing.");
    expect(chip("tampered")).toContain("The Mac failed an integrity check.");
  });

  it("keeps the meaning out of a title attribute only a mouse can reach", () => {
    expect(html(onboarding.module.StageChip, { stage: "late", since: ago(DAY), now: NOW })).not.toContain("title=");
  });

  it("says time in stage in hours under a day and in whole days after", () => {
    const stay = (sinceMs: number): string => /for ([^.]*)\./.exec(chip("invited", ago(sinceMs)))?.[1] ?? "";
    expect(stay(20 * 60_000)).toBe("under an hour");
    expect(stay(HOUR)).toBe("1 hour");
    expect(stay(23 * HOUR + 59 * 60_000)).toBe("23 hours");
    expect(stay(DAY)).toBe("1 day");
    expect(stay(8 * DAY - 1)).toBe("7 days");
  });
});

describe("the People attention bar", () => {
  const bar = (late: number, tampered: number): string => html(onboarding.module.AttentionBar, { late, tampered, onShow: () => undefined });

  it("is absent when nobody is Late or Tampered", () => {
    expect(bar(0, 0)).toBe("");
  });

  it("counts people, Tampered first, and offers to show each", () => {
    const markup = bar(2, 1);
    expect(textOf(markup)).toBe("1 person’s Mac failed an integrity check. 2 people’s Macs stopped syncing.Show TamperedShow Late");
    expect(buttonNames(markup)).toEqual(["Show Tampered", "Show Late"]);
  });

  it("names only Late when nobody is Tampered", () => {
    const markup = bar(1, 0);
    expect(textOf(markup)).toBe("1 person’s Mac stopped syncing.Show Late");
    expect(buttonNames(markup)).toEqual(["Show Late"]);
  });
});

describe("what the console says after an invitation, re-send or reminder", () => {
  const invitation: Sent = { kind: "invitation", email: "lee@example.com", role: "member", orgName: "Fernwood", again: false };
  const reminder: Sent = { kind: "reminder", email: "bo@example.com" };

  it("emailed: confirms the email", () => {
    expect(delivery.module.deliveryWords("emailed", invitation)).toEqual({
      title: "Invitation sent",
      description: "We emailed lee@example.com an invitation. They join Fernwood as a member when they sign in with that address.",
    });
    expect(delivery.module.deliveryWords("emailed", { ...invitation, again: true }).title).toBe("Invitation sent again");
    expect(delivery.module.deliveryWords("emailed", reminder)).toEqual({ title: "Reminder sent", description: "We emailed bo@example.com the download and enrol links again." });
  });

  it("mail off: says email is not set up and to send the link, never that it emailed", () => {
    for (const sent of [invitation, reminder]) {
      const said = delivery.module.deliveryWords("mail_off", sent);
      expect(said.title).toBe("Send this link yourself");
      expect(said.description.startsWith(`Email is not set up on this server, so nothing was sent. Send ${sent.email} this link.`)).toBe(true);
      expect(said.description).not.toMatch(/we emailed/i);
    }
  });

  it("send failed: says the email could not be sent and to send the link", () => {
    for (const sent of [invitation, reminder]) {
      const said = delivery.module.deliveryWords("send_failed", sent);
      expect(said.title).toBe("The email was not sent");
      expect(said.description.startsWith(`The email could not be sent. Send ${sent.email} this link instead.`)).toBe(true);
      expect(said.description).not.toMatch(/we emailed/i);
    }
  });

  it("emailed: shows no link, only the confirmation", () => {
    const markup = html(delivery.module.SentResult, { delivery: "emailed", email: "lee@example.com", label: "Invitation link", link: undefined });
    expect(fieldValue(markup, "Invitation link")).toBeUndefined();
    expect(markup).not.toContain("<input");
    expect(buttonNames(markup)).toEqual([]);
    expect(textOf(markup)).toBe("It is on its way to lee@example.com.");
  });

  it("mail off or send failed: shows the server's link under its label with Copy link", () => {
    const link = "https://guard.example/login?invitation=inv_1&t=abc";
    for (const kind of ["mail_off", "send_failed"] as const) {
      const markup = html(delivery.module.SentResult, { delivery: kind, email: "lee@example.com", label: "Invitation link", link });
      expect(fieldValue(markup, "Invitation link")).toBe(link);
      expect(buttonNames(markup)).toEqual(["Copy link"]);
      expect(textOf(markup)).toContain("Anyone with this link can use it. Send it only to them.");
    }
  });
});
