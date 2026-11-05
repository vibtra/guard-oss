export const CACHE_CONTROL_HASHED = "public, max-age=31536000, immutable";
export const CACHE_CONTROL_CONSOLE_UNHASHED = "public, max-age=3600";
export const CACHE_CONTROL_MISS = "no-store";

export const hasViteContentHash = (fileName: string): boolean =>
  /-[A-Za-z0-9_-]{8}(?:\.[A-Za-z0-9]+)+$/.test(fileName);
