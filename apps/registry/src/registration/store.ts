import { randomBytes } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VibtraError } from "../errors.js";
import { isBareMailDomain } from "../config.js";
import { UNSAFE_IN_ADDRESS } from "../tenancy/claim.js";

export const ALLOWLIST_KINDS = ["email", "domain"] as const;
export type AllowlistKind = (typeof ALLOWLIST_KINDS)[number];

export const AllowlistRow = z.object({
  id: z.string().min(1),
  subject: z.string().min(1).max(254),
  kind: z.enum(ALLOWLIST_KINDS),
  note: z.string().max(200).optional(),
  addedBy: z.string().min(1),
  addedAt: z.string().min(1),
});
export type AllowlistRow = z.infer<typeof AllowlistRow>;

export interface AllowlistAddition {
  subject: string;
  kind: AllowlistKind;
  note?: string | undefined;
  addedBy: string;
}

export interface RegistrationAllowlistStore {
  list(): Promise<AllowlistRow[]>;
  add(addition: AllowlistAddition): Promise<AllowlistRow | undefined>;
  remove(id: string): Promise<boolean>;
  isAllowed(email: string): Promise<boolean>;
}

export const mintAllowlistId = (): string => `al_${randomBytes(8).toString("hex")}`;

export const classifyAllowlistSubject = (raw: string): { subject: string; kind: AllowlistKind } => {
  const subject = raw.trim().toLowerCase();
  if (subject === "") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "Type an email address or a domain to allow.",
      detail: "the allowlist subject was empty or whitespace only",
    });
  }
  if (subject.includes("@")) {
    const parts = subject.split("@");
    const local = parts.length === 2 ? (parts[0] ?? "") : "";
    const host = parts.length === 2 ? (parts[1] ?? "") : "";
    if (parts.length !== 2 || local === "" || UNSAFE_IN_ADDRESS.test(subject) || !isBareMailDomain(host)) {
      throw new VibtraError({
        code: "VALIDATION",
        message: `${raw.trim()} is not one email address, so it was not added. Use one address, like ada@acme.example.`,
        detail:
          'an allowlisted address must have exactly one "@", something on both sides of it, no whitespace, and a ' +
          "bare mail domain on the right. An ambiguous address is refused rather than repaired: there is no honest " +
          "way to guess which half of it the person owns, and this list decides who may create an organisation.",
      });
    }
    return { subject, kind: "email" };
  }
  if (!isBareMailDomain(subject)) {
    throw new VibtraError({
      code: "VALIDATION",
      message: `${raw.trim()} is not an email address or a domain, so it was not added. Use an address or a domain, like acme.example.`,
      detail:
        "a domain here is a bare mail domain: letters, digits, dots and hyphens, with at least one dot, e.g. " +
        "acme.example. A scheme, a path, a port or whitespace would make a row that matches nothing.",
    });
  }
  return { subject, kind: "domain" };
};

export const allowlistSubjectsFor = (email: string): readonly string[] => {
  const wanted = email.trim().toLowerCase();
  const parts = wanted.split("@");
  if (parts.length !== 2) return [];
  const local = parts[0] ?? "";
  const host = parts[1] ?? "";
  if (local === "" || host === "") return [];
  return [wanted, host];
};

const AllowlistFile = z.object({ registrationAllowlist: z.array(AllowlistRow).default([]) });

export const createFileRegistrationAllowlistStore = async (
  file: string,
): Promise<RegistrationAllowlistStore> => {
  let rows: AllowlistRow[] = [];
  try {
    rows = AllowlistFile.parse(JSON.parse(await readFile(file, "utf8"))).registrationAllowlist;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ registrationAllowlist: rows }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  return {
    async list() {
      return rows.map((r) => ({ ...r })).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    },
    async add(addition) {
      if (rows.some((r) => r.subject === addition.subject)) return undefined;
      const row = AllowlistRow.parse({
        id: mintAllowlistId(),
        subject: addition.subject,
        kind: addition.kind,
        ...(addition.note === undefined || addition.note === "" ? {} : { note: addition.note }),
        addedBy: addition.addedBy,
        addedAt: new Date().toISOString(),
      });
      rows.push(row);
      await persist();
      return { ...row };
    },
    async remove(id) {
      const before = rows.length;
      rows = rows.filter((r) => r.id !== id);
      if (rows.length === before) return false;
      await persist();
      return true;
    },
    async isAllowed(email) {
      const wanted = allowlistSubjectsFor(email);
      if (wanted.length === 0) return false;
      const [address, host] = wanted as [string, string];
      return rows.some(
        (row) => (row.kind === "email" && row.subject === address) || (row.kind === "domain" && row.subject === host),
      );
    },
  };
};
