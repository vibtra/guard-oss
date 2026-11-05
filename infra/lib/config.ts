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

  enableExecuteCommand: Bool.default(false),

  openbaoEnabled: Bool.default(false),

  openbaoImage: z.string().min(3).default("openbao/openbao:2.6.2"),

  openbaoSealPluginDir: z.string().min(1).optional(),

  openbaoNamespaceName: z.string().min(3).default("vibtra.internal"),
  openbaoServiceName: z.string().min(1).default("openbao"),

  openbaoDesiredCount: z.coerce.number().int().min(1).default(1),
  openbaoCpu: z.coerce.number().int().positive().default(512),
  openbaoMemoryLimitMiB: z.coerce.number().int().positive().default(1024),

  openbaoTlsSecretArn: SecretArn.optional(),
  openbaoTlsDisable: Bool.default(false),

  openbaoDbSecretArn: SecretArn.optional(),

  openbaoRoleId: z.string().min(8).optional(),
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
  assertOpenBaoContextIsCoherent(parsed.data);
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

const OPENBAO_2_6_IMAGE = /^[^\s@]+:2\.6\.\d+(?:@sha256:[0-9a-f]{64})?$/;

const assertOpenBaoContextIsCoherent = (ctx: RegistryContext): void => {
  if (ctx.openbaoEnabled && ctx.openbaoTlsSecretArn === undefined && !ctx.openbaoTlsDisable) {
    throw new Error(
      "vibtra infra: openbaoEnabled needs either -c openbaoTlsSecretArn=… (a Secrets Manager secret whose JSON has " +
        "`certificate` and `private_key` for openbao.<openbaoNamespaceName>) or an explicit -c openbaoTlsDisable=true. " +
        "Every transit/decrypt response on this connection carries a customer credential in the clear, so plaintext " +
        "inside the VPC is a decision somebody makes by name. docs/deploy-registry-aws.md §8 has the openssl command.",
    );
  }
  if (ctx.openbaoTlsSecretArn !== undefined && ctx.openbaoTlsDisable) {
    throw new Error(
      "vibtra infra: openbaoTlsSecretArn and openbaoTlsDisable=true contradict each other — the first supplies a " +
        "listener certificate, the second says not to serve TLS at all. Pass one.",
    );
  }
  for (const [key, value] of [
    ["openbaoRoleId", ctx.openbaoRoleId],
    ["openbaoTlsSecretArn", ctx.openbaoTlsSecretArn],
    ["openbaoDbSecretArn", ctx.openbaoDbSecretArn],
  ] as const) {
    if (value !== undefined && !ctx.openbaoEnabled) {
      throw new Error(`vibtra infra: ${key} describes an OpenBao this stack is not creating — add -c openbaoEnabled=true.`);
    }
  }
  if (ctx.openbaoEnabled && ctx.openbaoDbSecretArn === undefined) {
    throw new Error(
      "vibtra infra: openbaoEnabled needs -c openbaoDbSecretArn=… — a Secrets Manager secret whose JSON has " +
        '`username` and `password` for the least-privilege `openbao` role. Without it OpenBao connects as the RDS ' +
        "MASTER user, which is the registry's own user, so each service can read and drop the other's tables. " +
        'Create the role first: docs/deploy-registry-aws.md §8, "The database role OpenBao connects as", carries the ' +
        "CREATE ROLE openbao, the CREATE TABLE openbao_kv_store / openbao_ha_locks DDL and the exact GRANTs, and it " +
        "is a required pre-step of §8.2 rather than an option.",
    );
  }
  if (ctx.openbaoEnabled && ctx.openbaoSealPluginDir === undefined && !OPENBAO_2_6_IMAGE.test(ctx.openbaoImage)) {
    throw new Error(
      `vibtra infra: openbaoImage=${ctx.openbaoImage} is not a provable openbao/openbao:2.6.<patch> reference, and ` +
        "2.7 is where the built-in awskms seal is REMOVED — the node would never unseal and the registry could open " +
        'no credential at all. Stage the external provider from openbao-plugins and pass -c openbaoSealPluginDir=… ' +
        '(the in-container directory), which is what makes the stack emit `plugin_directory` and the ' +
        '`plugin "kms" "awskms"` stanza beside seal.awskms. docs/deploy-registry-aws.md §8, "Upgrading past 2.6.x", ' +
        "is the procedure, and it ends in proving unseal on a throwaway instance before production. A bare " +
        "@sha256 reference is refused for the same reason: 2.6.x cannot be read out of it — pin it as " +
        "openbao/openbao:2.6.<patch>@sha256:… instead.",
    );
  }
};
