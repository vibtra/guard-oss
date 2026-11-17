import { VibtraError } from "../errors.js";

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

const MAIL_OFF: Mailer = Object.freeze({ enabled: false });

export interface MailLog {
  warn(fields: Record<string, unknown>, msg: string): void;
}

type MailEnv = Readonly<Record<string, string>>;

interface MailAdapterContext {
  env: MailEnv;
  from: string | undefined;
  fetch: MailFetch;
  log: MailLog;
}

export interface MailAdapter {
  readonly name: string;
  readonly env?: readonly string[];
  create(ctx: MailAdapterContext): MailTransport;
}

export type MailSelection = { kind: "off" } | { kind: "adapter"; name: string; from: string | undefined };

export const MAIL_OFF_NAME = "none";

export const MAIL_ADAPTER_NAME = /^[a-z][a-z0-9-]{0,39}$/;

const MAIL_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export const mailAdapterEnvNames = (adapters: readonly MailAdapter[]): string[] => [...new Set(adapters.flatMap((adapter) => adapter.env ?? []))];

const refuseAdapters = (message: string, detail: string): VibtraError => new VibtraError({ code: "VALIDATION", message, detail });

const mailAdapterIndex = (builtIn: readonly MailAdapter[], adapters: readonly MailAdapter[]): ReadonlyMap<string, MailAdapter> => {
  const reserved = [MAIL_OFF_NAME, ...builtIn.map((adapter) => adapter.name)];
  const index = new Map<string, MailAdapter>(builtIn.map((adapter) => [adapter.name, adapter]));
  for (const adapter of adapters) {
    if (!MAIL_ADAPTER_NAME.test(adapter.name)) {
      throw refuseAdapters(
        "A registered mail adapter has a name this registry cannot select",
        `${JSON.stringify(adapter.name)}: a mail adapter name is lower-case letters, digits and dashes, starting with a letter, at most 40 characters, so VIBTRA_MAIL_ADAPTER can name it.`,
      );
    }
    if (reserved.includes(adapter.name)) {
      throw refuseAdapters(
        "A registered mail adapter reuses a built-in name",
        `${JSON.stringify(adapter.name)} is built in (${reserved.join(", ")}). Give your adapter its own name and select it with VIBTRA_MAIL_ADAPTER.`,
      );
    }
    if (index.has(adapter.name)) {
      throw refuseAdapters(
        "Two mail adapters were registered under one name",
        `${JSON.stringify(adapter.name)} was registered twice, so VIBTRA_MAIL_ADAPTER=${adapter.name} would be ambiguous. Register it once.`,
      );
    }
    const badEnv = (adapter.env ?? []).filter((name) => !MAIL_ENV_NAME.test(name));
    if (badEnv.length > 0) {
      throw refuseAdapters(
        "A registered mail adapter declares a setting that is not an environment variable name",
        `${adapter.name} declares ${badEnv.map((name) => JSON.stringify(name)).join(", ")}: each name is upper-case letters, digits and underscores, starting with a letter.`,
      );
    }
    index.set(adapter.name, adapter);
  }
  return index;
};

const enabled = (adapter: string, transport: MailTransport, log: MailLog): Mailer => ({
  enabled: true,
  adapter,
  async send(message) {
    try {
      return await transport.send(message);
    } catch (err: unknown) {
      log.warn({ adapter, err_type: err instanceof Error ? err.name : "failed" }, "mail not sent");
      return false;
    }
  },
});

const envFor = (adapter: MailAdapter, env: MailEnv): MailEnv =>
  Object.fromEntries((adapter.env ?? []).flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]] as const])));

export interface CreateMailerOptions {
  selection: MailSelection;
  builtIn: readonly MailAdapter[];
  adapters: readonly MailAdapter[];
  env: MailEnv;
  fetch: MailFetch;
  log: MailLog;
}

export const createMailer = (options: CreateMailerOptions): Mailer => {
  const registered = mailAdapterIndex(options.builtIn, options.adapters);
  const { selection } = options;
  if (selection.kind === "off") return MAIL_OFF;
  const adapter = registered.get(selection.name);
  if (adapter === undefined) {
    throw refuseAdapters(
      `VIBTRA_MAIL_ADAPTER names a mail adapter this registry does not have: ${selection.name}`,
      `the adapters are: ${[MAIL_OFF_NAME, ...registered.keys()].join(", ")}. Register yours through RegistryCliOptions.mailAdapters or RegistryEnterprise.mailAdapters, or pick one of these.`,
    );
  }
  const transport = adapter.create({ env: envFor(adapter, options.env), from: selection.from, fetch: options.fetch, log: options.log });
  return enabled(adapter.name, transport, options.log);
};
