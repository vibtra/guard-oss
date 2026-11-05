import { z } from "zod";

export const CONNECTION_SCOPE_KINDS = ["org", "people", "apps", "groups"] as const;
export const ConnectionScopeKind = z.enum(CONNECTION_SCOPE_KINDS);
export type ConnectionScopeKind = z.infer<typeof ConnectionScopeKind>;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export const ConnectionScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org") }).strict(),
  z
    .object({
      kind: z.literal("people"),
      emails: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("apps"),
      toolIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("groups"),
      groupIds: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type ConnectionScope = z.infer<typeof ConnectionScope>;

export interface StoredScope {
  kind: string;
  subjects: string[];
}

export const scopeToStored = (scope: ConnectionScope): StoredScope => {
  switch (scope.kind) {
    case "org":
      return { kind: "org", subjects: [] };
    case "people":
      return { kind: "people", subjects: scope.emails.map(normalizeEmail) };
    case "apps":
      return { kind: "apps", subjects: [...scope.toolIds] };
    case "groups":
      return { kind: "groups", subjects: [...scope.groupIds] };
    default: {
      const exhaustive: never = scope;
      throw new Error(`unhandled scope kind: ${JSON.stringify(exhaustive)}`);
    }
  }
};

export const scopeFromStored = (stored: StoredScope): ConnectionScope | undefined => {
  const parsed = ConnectionScope.safeParse(
    stored.kind === "org"
      ? { kind: "org" }
      : stored.kind === "people"
        ? { kind: "people", emails: stored.subjects }
        : stored.kind === "apps"
          ? { kind: "apps", toolIds: stored.subjects }
          : stored.kind === "groups"
            ? { kind: "groups", groupIds: stored.subjects }
            : { kind: stored.kind },
  );
  return parsed.success ? parsed.data : undefined;
};

export const scopeSummary = (scope: ConnectionScope): string => {
  switch (scope.kind) {
    case "org":
      return "Everyone in the org";
    case "people":
      return `${scope.emails.length} named ${scope.emails.length === 1 ? "person" : "people"}`;
    case "apps":
      return `${scope.toolIds.length} named app${scope.toolIds.length === 1 ? "" : "s"}`;
    case "groups":
      return `${scope.groupIds.length} group${scope.groupIds.length === 1 ? "" : "s"}`;
    default: {
      const exhaustive: never = scope;
      return `unknown scope (${JSON.stringify((exhaustive as { kind?: unknown }).kind)})`;
    }
  }
};

export const scopeSubjects = (scope: ConnectionScope): string[] => scopeToStored(scope).subjects;
