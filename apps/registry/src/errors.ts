const ERROR_CODES = [
  "CHECK_FAILED",
  "DEPLOY_AUTH_EXPIRED",
  "REGISTRY_LIMIT_EXCEEDED",
  "POLICY_REFUSED",
  "UPSTREAM_REFUSED",
  "VALIDATION",
  "INTERNAL",
] as const;

export type VibtraErrorCode = (typeof ERROR_CODES)[number];

export interface VibtraErrorShape {
  code: VibtraErrorCode;
  message: string;
  detail?: string;
  traceId?: string;
}

export class VibtraError extends Error implements VibtraErrorShape {
  code: VibtraErrorCode;
  detail?: string;
  traceId?: string;
  constructor(shape: VibtraErrorShape, options?: { cause?: unknown }) {
    super(shape.message, options);
    this.name = "VibtraError";
    this.code = shape.code;
    this.detail = shape.detail;
    this.traceId = shape.traceId;
  }
  toJSON(): VibtraErrorShape {
    return { code: this.code, message: this.message, detail: this.detail, traceId: this.traceId };
  }
}

export const toVibtraError = (e: unknown, fallback: VibtraErrorCode = "INTERNAL"): VibtraError => {
  if (e instanceof VibtraError) return e;
  const detail = fallback === "VALIDATION" ? "The registry could not read this request." : "The registry logged the cause under this response's traceId.";
  return new VibtraError({ code: fallback, message: "Something went wrong", detail }, { cause: e });
};
