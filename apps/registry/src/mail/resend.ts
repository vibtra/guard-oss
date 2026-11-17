import type { MailFetch, MailLog, MailTransport } from "./mailer.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

const MAIL_TIMEOUT_MS = 10_000;

export interface ResendTransportOptions {
  apiKey: string;
  from: string;
  fetch: MailFetch;
  log: MailLog;
}

export const createResendTransport = (options: ResendTransportOptions): MailTransport => ({
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
