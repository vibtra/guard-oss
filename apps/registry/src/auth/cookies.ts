export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === "") continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
};

export interface CookieAttributes {
  path: string;
  maxAgeSeconds: number;
  secure: boolean;
}

export const serializeCookie = (name: string, value: string, attrs: CookieAttributes): string =>
  [
    `${name}=${value}`,
    `Path=${attrs.path}`,
    `Max-Age=${attrs.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(attrs.secure ? ["Secure"] : []),
  ].join("; ");

export const expireCookie = (name: string, path: string, secure: boolean): string =>
  serializeCookie(name, "", { path, maxAgeSeconds: 0, secure });
