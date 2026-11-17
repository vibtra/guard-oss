import type { HostedConfig } from "../config.js";
import { VibtraError } from "../errors.js";
import { MAIL_OFF_NAME, type MailSelection } from "./mailer.js";
import { RESEND_ADAPTER_NAME } from "./resend.js";

type MailSettings = Pick<HostedConfig, "mailAdapter" | "resendApiKey" | "mailFrom">;

const refuse = (message: string, detail: string): never => {
  throw new VibtraError({ code: "VALIDATION", message, detail: `${detail} No value is echoed.` });
};

const offSelection = (settings: MailSettings, chosen: boolean): MailSelection => {
  if (settings.resendApiKey !== undefined) {
    refuse(
      "RESEND_API_KEY is set but VIBTRA_MAIL_ADAPTER=none",
      "mail is switched off, so this registry would never use the key. Unset RESEND_API_KEY, or unset VIBTRA_MAIL_ADAPTER (or set it to resend) to send through Resend.",
    );
  }
  if (settings.mailFrom !== undefined) {
    if (chosen) {
      refuse(
        "REGISTRY_MAIL_FROM is set but VIBTRA_MAIL_ADAPTER=none",
        "a sender with no transport behind it sends nothing. Unset REGISTRY_MAIL_FROM, or pick a mail adapter with VIBTRA_MAIL_ADAPTER.",
      );
    }
    refuse(
      "REGISTRY_MAIL_FROM is set but RESEND_API_KEY is not",
      "a sender with no transport behind it sends nothing, so this registry would ignore it entirely — a knob " +
        "that reads as live and does nothing is worse than an absent one. Set RESEND_API_KEY too, pick another " +
        "mail adapter with VIBTRA_MAIL_ADAPTER, or unset REGISTRY_MAIL_FROM.",
    );
  }
  return { kind: "off" };
};

const resendSelection = (settings: MailSettings): MailSelection => {
  if (settings.resendApiKey === undefined) {
    return refuse(
      "VIBTRA_MAIL_ADAPTER=resend, but RESEND_API_KEY is not set",
      "the Resend adapter sends with the key Resend issues. Set RESEND_API_KEY and REGISTRY_MAIL_FROM, or unset VIBTRA_MAIL_ADAPTER to keep mail off.",
    );
  }
  if (settings.mailFrom === undefined) {
    return refuse(
      "Mail is half configured",
      "RESEND_API_KEY is set but REGISTRY_MAIL_FROM is not. Resend sends only from a domain it has verified, " +
        "so this registry would call the API for every invitation and be refused. Set REGISTRY_MAIL_FROM to the " +
        'verified sender (e.g. "Vibtra <no-reply@vibtra.app>"), or unset RESEND_API_KEY and keep the ' +
        "copy-the-link path.",
    );
  }
  return { kind: "adapter", name: RESEND_ADAPTER_NAME, from: settings.mailFrom };
};

export const mailSelectionOf = (settings: MailSettings): MailSelection => {
  const chosen = settings.mailAdapter;
  if (chosen === undefined) return settings.resendApiKey === undefined ? offSelection(settings, false) : resendSelection(settings);
  if (chosen === MAIL_OFF_NAME) return offSelection(settings, true);
  if (chosen === RESEND_ADAPTER_NAME) return resendSelection(settings);
  if (settings.resendApiKey !== undefined) {
    return refuse(
      `RESEND_API_KEY is set but VIBTRA_MAIL_ADAPTER=${chosen}`,
      `mail goes through the ${chosen} adapter, so this registry would never use the key. Unset RESEND_API_KEY, or set VIBTRA_MAIL_ADAPTER=resend.`,
    );
  }
  return { kind: "adapter", name: chosen, from: settings.mailFrom };
};
