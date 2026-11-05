import { readFileSync } from "node:fs";

const NAMED = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "hey.com",
  "duck.com",
  "tutanota.com",
  "tuta.io",
  "yandex.com",
  "yandex.ru",
] as const;

let loaded: ReadonlySet<string> | undefined;

const load = (): ReadonlySet<string> => {
  if (loaded !== undefined) return loaded;
  const all = new Set<string>(NAMED);
  try {
    const list = JSON.parse(readFileSync(new URL("./vendor/free-email-domains/domains.json", import.meta.url), "utf8")) as unknown;
    if (Array.isArray(list)) for (const d of list) if (typeof d === "string" && d !== "") all.add(d.toLowerCase());
  } catch {
  }
  loaded = all;
  return all;
};

const SUFFIX_LIKE: ReadonlySet<string> = new Set([
  "net.ua",
  "za.com",
  "au.com",
  "au.ru",
  "co.cc",
  "go.ro",
  "go.ru",
  "us.to",
  "uk.to",
  "us.af",
  "biz.st",
  "pro.hu",
  "ua.fm",
]);

const BRANDS: ReadonlySet<string> = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "yahoo",
  "ymail",
  "icloud",
  "aol",
  "protonmail",
  "gmx",
  "yandex",
]);
const BRAND_UNDER_SUFFIX = /^([a-z0-9-]+)\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

export const isPublicEmailDomain = (domain: string): boolean => {
  const d = domain.trim().toLowerCase().replace(/\.+$/, "");
  const set = load();
  if (set.has(d)) return true;
  const brandUnderSuffix = (name: string): boolean => {
    const brand = BRAND_UNDER_SUFFIX.exec(name)?.[1];
    return brand !== undefined && BRANDS.has(brand);
  };
  if (brandUnderSuffix(d)) return true;
  const labels = d.split(".");
  for (let i = 1; i <= labels.length - 2; i += 1) {
    const parent = labels.slice(i).join(".");
    if (set.has(parent) && !SUFFIX_LIKE.has(parent)) return true;
    if (brandUnderSuffix(parent)) return true;
  }
  return false;
};

export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = {
  has: (d: string) => isPublicEmailDomain(d),
  get size() {
    return load().size;
  },
  forEach: (cb: (value: string, key: string, set: ReadonlySet<string>) => void) => load().forEach(cb),
  entries: () => load().entries(),
  keys: () => load().keys(),
  values: () => load().values(),
  [Symbol.iterator]: () => load()[Symbol.iterator](),
} as ReadonlySet<string>;

export const NAMED_PUBLIC_DOMAINS: readonly string[] = NAMED;
