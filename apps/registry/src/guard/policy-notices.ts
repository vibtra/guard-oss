// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

export const GUARD_POLICY_CHANNEL = "guard_policy";
const NOTICE_MAX_BYTES = 7_900;

export type GuardPolicyNotice =
  | { readonly org: string; readonly rules: number }
  | { readonly org: string; readonly people: Readonly<Record<string, number>> }
  | { readonly org: string; readonly peopleChanged: true };

const Payload = z.union([
  z.object({ org: z.string().min(1), rules: z.number().int().min(0) }).strict(),
  z.object({ org: z.string().min(1), people: z.record(z.string(), z.number().int().min(0)) }).strict(),
  z.object({ org: z.string().min(1), peopleChanged: z.literal(true) }).strict(),
  z.object({ ping: z.string().min(1) }).strict(),
]);

export const protectionNotice = (org: string, set: ReadonlyArray<{ userId: string; revision: number }>, defaultMoved: boolean): GuardPolicyNotice =>
  defaultMoved ? { org, peopleChanged: true } : { org, people: Object.fromEntries(set.map((p) => [p.userId, p.revision])) };

export const noticePayload = (notice: GuardPolicyNotice): string => {
  const payload = JSON.stringify(notice);
  return Buffer.byteLength(payload, "utf8") <= NOTICE_MAX_BYTES ? payload : JSON.stringify({ org: notice.org, peopleChanged: true });
};

export const pingPayload = (nonce: string): string => JSON.stringify({ ping: nonce });

export const parseNoticePayload = (raw: string): GuardPolicyNotice | { ping: string } | undefined => {
  try {
    const parsed = Payload.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export interface GuardNoticeSink {
  notice(notice: GuardPolicyNotice): void;
  live(): void;
  lost(reason: string): void;
  restored(): void;
  off(reason: string): void;
}

export interface GuardNoticeFeed {
  start(sink: GuardNoticeSink): void;
  close(): Promise<void>;
}

export const createInProcessNotices = (): { publish(notice: GuardPolicyNotice): void; feed: GuardNoticeFeed } => {
  const sinks = new Set<GuardNoticeSink>();
  return {
    publish: (notice) => {
      for (const sink of sinks) sink.notice(notice);
    },
    feed: {
      start: (sink) => {
        sinks.add(sink);
        sink.live();
      },
      close: async () => {
        sinks.clear();
      },
    },
  };
};
