import { VibtraError } from "../errors.js";
import { createResendTransport } from "./resend.js";

export type MailFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  send(message: MailMessage): Promise<boolean>;
}

export type Mailer =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly adapter: string; send(message: MailMessage): Promise<boolean> };

export const MAIL_OFF: Mailer = Object.freeze({ enabled: false });

export interface MailLog {
  warn(fields: Record<string, unknown>, msg: string): void;
}

export interface MailAdapterContext {
  from: string | undefined;
  fetch: MailFetch;
  log: MailLog;
}

export interface MailAdapter {
  readonly name: string;
  create(ctx: MailAdapterContext): MailTransport;
}

export type MailSelection =
  | { kind: "off" }
  | { kind: "resend"; apiKey: string; from: string }
  | { kind: "adapter"; name: string; from: string | undefined };

export const BUILT_IN_MAIL_ADAPTERS = ["none", "resend"] as const;

export const MAIL_ADAPTER_NAME = /^[a-z][a-z0-9-]{0,39}$/;

const refuseAdapters = (message: string, detail: string): VibtraError => new VibtraError({ code: "VALIDATION", message, detail });

export const mailAdapterIndex = (adapters: readonly MailAdapter[]): ReadonlyMap<string, MailAdapter> => {
  const index = new Map<string, MailAdapter>();
  for (const adapter of adapters) {
    if (!MAIL_ADAPTER_NAME.test(adapter.name)) {
      throw refuseAdapters(
        "A registered mail adapter has a name this registry cannot select",
        `${JSON.stringify(adapter.name)}: a mail adapter name is lower-case letters, digits and dashes, starting with a letter, at most 40 characters, so VIBTRA_MAIL_ADAPTER can name it.`,
      );
    }
    if ((BUILT_IN_MAIL_ADAPTERS as readonly string[]).includes(adapter.name)) {
      throw refuseAdapters(
        "A registered mail adapter reuses a built-in name",
        `${JSON.stringify(adapter.name)} is built in (${BUILT_IN_MAIL_ADAPTERS.join(", ")}). Give your adapter its own name and select it with VIBTRA_MAIL_ADAPTER.`,
      );
    }
    if (index.has(adapter.name)) {
      throw refuseAdapters(
        "Two mail adapters were registered under one name",
        `${JSON.stringify(adapter.name)} was registered twice, so VIBTRA_MAIL_ADAPTER=${adapter.name} would be ambiguous. Register it once.`,
      );
    }
    index.set(adapter.name, adapter);
  }
  return index;
};

const enabled = (adapter: string, transport: MailTransport): Mailer => ({
  enabled: true,
  adapter,
  send: (message) => transport.send(message),
});

export interface CreateMailerOptions {
  selection: MailSelection;
  adapters: readonly MailAdapter[];
  fetch: MailFetch;
  log: MailLog;
}

export const createMailer = (options: CreateMailerOptions): Mailer => {
  const registered = mailAdapterIndex(options.adapters);
  const { selection } = options;
  switch (selection.kind) {
    case "off":
      return MAIL_OFF;
    case "resend":
      return enabled("resend", createResendTransport({ apiKey: selection.apiKey, from: selection.from, fetch: options.fetch, log: options.log }));
    case "adapter": {
      const adapter = registered.get(selection.name);
      if (adapter === undefined) {
        const names = [...BUILT_IN_MAIL_ADAPTERS, ...registered.keys()];
        throw refuseAdapters(
          `VIBTRA_MAIL_ADAPTER names a mail adapter this registry does not have: ${selection.name}`,
          `the adapters are: ${names.join(", ")}. Register yours through RegistryCliOptions.mailAdapters or RegistryEnterprise.mailAdapters, or pick one of these.`,
        );
      }
      return enabled(adapter.name, adapter.create({ from: selection.from, fetch: options.fetch, log: options.log }));
    }
    default: {
      const unreachable: never = selection;
      return unreachable;
    }
  }
};
