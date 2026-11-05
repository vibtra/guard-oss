import {
  ORG_HANDLE_MAX_LENGTH,
  ORG_HANDLE_MIN_LENGTH,
  RESERVED_ORG_HANDLES,
  isReservedOrgHandle,
  orgHandleProblem,
} from "@vibtra/console-api";

export { RESERVED_ORG_HANDLES, isReservedOrgHandle, orgHandleProblem };

export const handleSeedOf = (source: string): string => {
  const atSign = source.indexOf("@");
  const local = atSign === -1 ? source : source.slice(0, atSign);
  const firstDot = local.indexOf(".");
  const head = firstDot === -1 ? local : local.slice(0, firstDot);
  const folded = head
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return folded === "" ? "org" : folded;
};

const bounded = (seed: string): string => {
  const cut = seed.slice(0, ORG_HANDLE_MAX_LENGTH).replace(/-+$/g, "");
  if (cut.length >= ORG_HANDLE_MIN_LENGTH) return cut;
  return `${cut}-org`.slice(0, ORG_HANDLE_MAX_LENGTH);
};

const MAX_ATTEMPTS = 50;

export const deriveOrgHandle = async (
  source: string,
  taken: (candidate: string) => Promise<boolean>,
  orgId?: string,
): Promise<string> => {
  const base = bounded(handleSeedOf(source));
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${base.slice(0, ORG_HANDLE_MAX_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (orgHandleProblem(candidate) !== undefined) continue;
    if (await taken(candidate)) continue;
    return candidate;
  }
  const fromId = orgId === undefined ? undefined : bounded(handleSeedOf(orgId.replace(/_/g, "-")));
  if (fromId !== undefined && orgHandleProblem(fromId) === undefined && !(await taken(fromId))) return fromId;
  throw new Error(
    `could not derive a free org handle from ${JSON.stringify(source)} after ${MAX_ATTEMPTS} attempts`,
  );
};

export const handleOf = async (
  orgs: { getOrg(orgId: string): Promise<{ handle?: string } | undefined> } | undefined,
  orgId: string,
): Promise<string | undefined> => (orgs === undefined ? undefined : (await orgs.getOrg(orgId))?.handle);

export const fallbackHandleOf = (orgId: string): string => bounded(handleSeedOf(orgId.replace(/_/g, "-")));
