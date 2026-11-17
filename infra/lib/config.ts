import { z } from "zod";

const SecretArn = z
  .string()
  .regex(/^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:.+$/, "expected a Secrets Manager secret ARN");

const CertificateArn = z
  .string()
  .regex(/^arn:aws[a-z-]*:acm:[a-z0-9-]+:\d{12}:certificate\/.+$/, "expected an ACM certificate ARN");

const Bool = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);

export const RegistryContext = z.object({
  region: z.string().min(1).default("ap-southeast-2"),
  account: z.string().regex(/^\d{12}$/).optional(),

  domainName: z.string().min(3).default("vibtra.app"),

  contactEmail: z.string().min(3).default("sam@vibtra.app"),

  imageTag: z.string().min(1).default("latest"),
  ecrRepositoryName: z.string().min(2).default("vibtra-registry"),

  hostedZoneId: z.string().regex(/^Z[A-Z0-9]+$/).optional(),
  hostedZoneName: z.string().min(3).optional(),

  certificateArn: CertificateArn.optional(),

  edgeCertificateArn: CertificateArn.optional(),

  googleClientId: z.string().default(""),
  googleClientSecretArn: SecretArn.optional(),

  vaultKeyPreviousSecretArn: SecretArn.optional(),

  cpu: z.coerce.number().int().positive().default(512),
  memoryLimitMiB: z.coerce.number().int().positive().default(1024),
  desiredCount: z.coerce.number().int().min(1).default(1),
  maxCapacity: z.coerce.number().int().min(1).default(1),

  postgresVersion: z.string().regex(/^\d+\.\d+$/).default("16.13"),
  dbInstanceClass: z.string().default("t4g.small"),
  dbAllocatedStorageGiB: z.coerce.number().int().min(20).default(20),
  backupRetentionDays: z.coerce.number().int().min(1).default(7),

  logRetentionDays: z.coerce.number().int().min(1).default(90),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),

  enableExecuteCommand: Bool.default(false),
});

export type RegistryContext = z.infer<typeof RegistryContext>;

export const wwwHostFor = (domainName: string): string => `www.${domainName}`;

const KEYS = Object.keys(RegistryContext.shape) as (keyof RegistryContext)[];

export interface ContextReader {
  tryGetContext(key: string): unknown;
}

export const readRegistryContext = (node: ContextReader): RegistryContext => {
  const raw: Record<string, unknown> = {};
  for (const key of KEYS) {
    const value = node.tryGetContext(key);
    if (value !== undefined && value !== "") raw[key] = value;
  }
  if (raw["account"] === undefined && process.env["CDK_DEFAULT_ACCOUNT"] !== undefined) {
    raw["account"] = process.env["CDK_DEFAULT_ACCOUNT"];
  }
  const parsed = RegistryContext.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`vibtra infra: bad CDK context — ${detail}`);
  }
  if ((parsed.data.hostedZoneId === undefined) !== (parsed.data.hostedZoneName === undefined)) {
    throw new Error(
      "vibtra infra: hostedZoneId and hostedZoneName are given together or not at all — a Route 53 A record needs both, " +
        "and importing a zone from only one of them requires an account lookup this app deliberately never does.",
    );
  }
  assertEdgeCertificateIsInUsEast1(parsed.data);
  return parsed.data;
};

export const CLOUDFRONT_CERTIFICATE_REGION = "us-east-1";

const assertEdgeCertificateIsInUsEast1 = (ctx: RegistryContext): void => {
  if (ctx.edgeCertificateArn === undefined) return;
  const region = ctx.edgeCertificateArn.split(":")[3];
  if (region !== CLOUDFRONT_CERTIFICATE_REGION) {
    throw new Error(
      `vibtra infra: edgeCertificateArn is in ${region ?? "an unreadable region"}, and CloudFront accepts a viewer ` +
        `certificate only from ${CLOUDFRONT_CERTIFICATE_REGION} ('Requirements for using SSL/TLS certificates with ` +
        "CloudFront': the certificate must be requested or imported in US East (N. Virginia)). Either request one there " +
        `and pass its ARN, or drop the flag and let the VibtraRegistryEdgeCertificate stack request it in ` +
        `${CLOUDFRONT_CERTIFICATE_REGION} (docs/deploy-registry-aws.md §1.3). certificateArn, the LOAD BALANCER's ` +
        "certificate, is the one that belongs in the registry's own region.",
    );
  }
};
