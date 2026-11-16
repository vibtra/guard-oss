import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import type { FastifyBaseLogger, FastifyRequest } from "fastify";

export const REQUEST_ID_HEADER = "x-request-id";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export const uuidv7 = (): string => {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const requestIdFor = (req: IncomingMessage): string => {
  const raw = req.headers[REQUEST_ID_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && SAFE_REQUEST_ID.test(value) ? value : uuidv7();
};

const LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export const registryLogLevel = (env: NodeJS.ProcessEnv = process.env): string => {
  const level = (env.LOG_LEVEL ?? "").trim().toLowerCase();
  return LOG_LEVELS.has(level) ? level : "info";
};

const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}…` : text);

export type ErrorDepth = "type" | "message" | "stack";

export const errorFields = (error: unknown, depth: ErrorDepth = "message"): Record<string, unknown> => {
  if (!(error instanceof Error)) return { type: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    type: error.name,
    ...(typeof code === "string" ? { code } : {}),
    ...(depth === "type" ? {} : { message: clip(error.message) }),
    ...(depth === "stack" && error.stack !== undefined ? { stack: error.stack } : {}),
  };
};

const elapsedMs = (start: number): number => Math.round((performance.now() - start) * 1000) / 1000;

export const timed = async <T>(log: FastifyBaseLogger, step: string, fn: () => Promise<T>): Promise<T> => {
  const start = performance.now();
  try {
    const value = await fn();
    log.debug({ step, duration_ms: elapsedMs(start) }, "step");
    return value;
  } catch (error) {
    log.warn({ step, duration_ms: elapsedMs(start), err: errorFields(error) }, "step failed");
    throw error;
  }
};

export interface RequestActor {
  orgId?: string;
  deviceId?: string;
}

const actors = new WeakMap<FastifyRequest, RequestActor>();
const sentBytes = new WeakMap<FastifyRequest, number>();

export const noteActor = (req: FastifyRequest, actor: RequestActor): void => {
  actors.set(req, { ...actors.get(req), ...actor });
};

export const actorOf = (req: FastifyRequest): RequestActor => actors.get(req) ?? {};

export const noteSentBytes = (req: FastifyRequest, payload: unknown): void => {
  if (typeof payload === "string") sentBytes.set(req, Buffer.byteLength(payload));
  else if (Buffer.isBuffer(payload)) sentBytes.set(req, payload.length);
};

export const sentBytesOf = (req: FastifyRequest, contentLength: unknown): number | undefined => {
  const header = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (Number.isFinite(header) && header >= 0) return header;
  return sentBytes.get(req);
};

const PINO_LEVELS: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Number.POSITIVE_INFINITY };

export const bootLog = (level: "debug" | "info" | "warn" | "error" | "fatal", msg: string, fields: Record<string, unknown> = {}): void => {
  const value = PINO_LEVELS[level] ?? PINO_LEVELS.info!;
  if (value < (PINO_LEVELS[registryLogLevel()] ?? PINO_LEVELS.info!)) return;
  process.stdout.write(`${JSON.stringify({ level: value, time: Date.now(), pid: process.pid, ...fields, msg })}\n`);
};
