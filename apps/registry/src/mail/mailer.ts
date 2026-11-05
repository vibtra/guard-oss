export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const MAIL_TIMEOUT_MS = 10_000;

export type MailFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly enabled: boolean;
  send(message: MailMessage): Promise<boolean>;
}

export interface MailerOptions {
  apiKey?: string | undefined;
  from: string;
  fetchImpl?: MailFetch | undefined;
  log?: ((line: string) => void) | undefined;
}

export const createMailer = (options: MailerOptions): Mailer => {
  const apiKey = (options.apiKey ?? "").trim();
  if (apiKey === "") {
    return {
      enabled: false,
      async send() {
        return false;
      },
    };
  }
  const doFetch: MailFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    enabled: true,
    async send(message) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), MAIL_TIMEOUT_MS);
      try {
        const res = await doFetch(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
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
        options.log?.(`[mail] Resend refused a message (HTTP ${res.status})`);
        return false;
      } catch (err: unknown) {
        options.log?.(`[mail] could not send: ${err instanceof Error ? err.name : "failed"}`);
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
