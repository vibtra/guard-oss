const MAX_RETURN_LENGTH = 1024;

export const sanitizeReturnPath = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || value.length > MAX_RETURN_LENGTH) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
};
