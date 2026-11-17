import type { MailAdapter } from "./mailer.js";
import { resendMailAdapter } from "./resend.js";

export const BUILT_IN_MAIL_ADAPTERS: readonly MailAdapter[] = [resendMailAdapter];
