import { VibtraError } from "../errors.js";
import type { MailAdapter, MailFetch, MailLog, MailTransport } from "./mailer.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const MAIL_TIMEOUT_MS = 10_000;

interface ResendTransportOptions {
  apiKey: string;
  from: string;
  fetch: MailFetch;
  log: MailLog;
}

const createResendTransport = (options: ResendTransportOptions): MailTransport => ({
  async send(message) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MAIL_TIMEOUT_MS);
    try {
      const res = await options.fetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: options.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        }),
        signal: abort.signal,
      });
      if (res.ok) return true;
      options.log.warn({ adapter: "resend", status: res.status }, "mail refused");
      return false;
    } catch (err: unknown) {
      options.log.warn({ adapter: "resend", err_type: err instanceof Error ? err.name : "failed" }, "mail not sent");
      return false;
    } finally {
      clearTimeout(timer);
    }
  },
});

export const RESEND_ADAPTER_NAME = "resend";

export const RESEND_API_KEY_VARIABLE = "RESEND_API_KEY";

export const resendMailAdapter: MailAdapter = {
  name: RESEND_ADAPTER_NAME,
  env: [RESEND_API_KEY_VARIABLE],
  create({ env, from, fetch, log }) {
    const apiKey = env[RESEND_API_KEY_VARIABLE];
    if (apiKey === undefined || from === undefined) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "The Resend mail adapter needs RESEND_API_KEY and REGISTRY_MAIL_FROM",
        detail: "Set both, or pick another mail adapter with VIBTRA_MAIL_ADAPTER. No value is echoed.",
      });
    }
    return createResendTransport({ apiKey, from, fetch, log });
  },
};
