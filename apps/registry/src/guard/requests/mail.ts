import type { Mailer } from "../../mail/mailer.js";
import { policyRequestArrivalMail } from "../../mail/templates.js";
import { subjectWords } from "./service.js";
import type { PolicyRequestRow } from "./store.js";

export interface ArrivalMailOrgs {
  getOrg(orgId: string): Promise<{ name: string; handle?: string } | undefined>;
  listAdmins(orgId: string): Promise<Array<{ email: string }>>;
}

const normalEmail = (email: string): string => email.trim().toLowerCase();

export const mailRequestArrival = async (
  orgs: ArrivalMailOrgs | undefined,
  mailer: Mailer | undefined,
  baseUrl: string,
  row: PolicyRequestRow,
  requester: { userId: string; email: string },
): Promise<number> => {
  if (mailer === undefined || !mailer.enabled || orgs === undefined) return 0;
  try {
    const org = await orgs.getOrg(row.orgId);
    const me = normalEmail(requester.email);
    const to = (await orgs.listAdmins(row.orgId)).map((a) => normalEmail(a.email));
    let sent = 0;
    for (const address of [...new Set(to)].filter((e) => e !== "" && e !== me)) {
      const ok = await mailer.send(
        policyRequestArrivalMail({ baseUrl, handle: org?.handle, orgName: org?.name ?? row.orgId, to: address, requesterEmail: requester.email, words: subjectWords(row), requestId: row.id, kind: row.kind }),
      );
      if (ok) sent += 1;
    }
    return sent;
  } catch {
    return 0;
  }
};
