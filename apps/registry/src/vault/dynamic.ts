import { z } from "zod";
import { SqlTlsMode } from "./connector.js";

const DYNAMIC_ENGINES = ["postgres", "mysql"] as const;
export const DynamicEngine = z.enum(DYNAMIC_ENGINES);
export type DynamicEngine = z.infer<typeof DynamicEngine>;

export const DynamicAccess = z.enum(["ro", "rw"]);
export type DynamicAccess = z.infer<typeof DynamicAccess>;

const IDENTIFIER = /^[A-Za-z0-9_]{1,63}$/;

export const DynamicConfig = z
  .object({
    engine: DynamicEngine,
    access: DynamicAccess,
    schemas: z.array(z.string().regex(IDENTIFIER)).min(1).max(32),
    maxTtlDays: z.number().int().min(1).max(90),
    host: z.string().min(1),
    port: z.string().regex(/^[1-9]\d{0,4}$/),
    database: z.string().min(1),
    tls: SqlTlsMode,
    appHost: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9._-]+(?::[1-9]\d{0,4})?$/, {
        message: "an application host is a hostname, optionally with :port",
      })
      .refine((v) => {
        const port = v.includes(":") ? v.slice(v.indexOf(":") + 1) : undefined;
        return port === undefined || Number(port) <= 65535;
      }, { message: "an application host's port must be 1..65535" })
      .optional(),
    roleNames: z.array(z.string().min(1)).min(1).max(2),
    rootRotatedAt: z.string().nullable(),
  })
  .strict();
export type DynamicConfig = z.infer<typeof DynamicConfig>;

export const ToolDatabaseLease = z
  .object({
    connectionId: z.string().min(1),
    leaseId: z.string().min(1),
    expiresAt: z.string().min(1),
    renewedAt: z.string().min(1).nullable(),
  })
  .strict();
export type ToolDatabaseLease = z.infer<typeof ToolDatabaseLease>;
