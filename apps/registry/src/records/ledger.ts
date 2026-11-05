import { z } from "zod";
import { VibtraError } from "../errors.js";

export const REGISTRY_SCHEMA_VERSION = 1;

const REGISTRY_ACTOR_IDPS = ["google", "okta", "stub", "local", "oidc"] as const;
const RegistryActorIdp = z.enum(REGISTRY_ACTOR_IDPS);

export const RegistryActor = z.object({
  email: z.string().min(1),
  idp: RegistryActorIdp,
});
export type RegistryActor = z.infer<typeof RegistryActor>;

const REGISTRY_SOURCES = ["client", "attested"] as const;
const RegistrySource = z.enum(REGISTRY_SOURCES);

const ToolName = z.string().min(1).max(64);

const ReceiptOutcome = z.enum(["LIVE", "FAILED"]);

const ReceiptAudience = z.object({
  kind: z.string().min(1),
  subjects: z.array(z.string()),
});

const recordBase = {
  schemaVersion: z.number().int().min(1),
  recordId: z.string().min(1),
  recordedAt: z.string(),
  orgId: z.string().min(1),
  toolId: z.string().min(1),
  actor: RegistryActor,
  source: RegistrySource,
  traceId: z.string().optional(),
};

const RegistryToolCreated = z.object({
  ...recordBase,
  type: z.literal("tool.created"),
  name: ToolName,
  template: z.string().optional(),
});

const RegistryToolRenamed = z.object({
  ...recordBase,
  type: z.literal("tool.renamed"),
  name: ToolName,
  previousName: ToolName.optional(),
});

export const RegistryToolDeployed = z.object({
  ...recordBase,
  type: z.literal("tool.deployed"),
  deployId: z.string().min(1),
  outcome: ReceiptOutcome,
  url: z.string().optional(),
  target: z.string().optional(),
  audience: ReceiptAudience.optional(),
  connections: z.array(z.string()).optional(),
  grantId: z.string().min(1).optional(),
});
export type RegistryToolDeployed = z.infer<typeof RegistryToolDeployed>;

const RegistryToolArchived = z.object({
  ...recordBase,
  type: z.literal("tool.archived"),
  reason: z.string().optional(),
});

const RegistryToolReverted = z.object({
  ...recordBase,
  type: z.literal("tool.reverted"),
  restorePoint: z.string().min(1),
  replacedPoint: z.string().optional(),
  fileCount: z.number().int().min(0),
});

const RegistryToolAccessed = z.object({
  ...recordBase,
  type: z.literal("tool.accessed"),
  email: z.string().min(1),
  outcome: z.enum(["allowed", "refused"]),
  reason: z.string().optional(),
});

const RegistryToolOwnerChanged = z.object({
  ...recordBase,
  type: z.literal("tool.owner_changed"),
  owner: z.string().min(1),
  previousOwner: z.string().min(1).optional(),
  reason: z.string().optional(),
});

const REGISTRY_PROMPT_MODES = ["plan", "build"] as const;
const RegistryPromptMode = z.enum(REGISTRY_PROMPT_MODES);

const promptPolicyBase = {
  ...recordBase,
  toolId: z.string().min(1).optional(),
  providerId: z.string().min(1),
  piiCounts: z.record(z.number().int().positive()),
  mode: RegistryPromptMode,
};

const RegistryPromptBlocked = z.object({
  ...promptPolicyBase,
  type: z.literal("prompt.blocked"),
  verdict: z.literal("block"),
});

const RegistryPromptWarned = z.object({
  ...promptPolicyBase,
  type: z.literal("prompt.warned"),
  verdict: z.literal("warn"),
});

const connectorBase = {
  ...recordBase,
  toolId: z.string().min(1).optional(),
  provider: z.string().min(1),
  connectionId: z.string().min(1),
  scopes: z.array(z.string()),
};

const RegistryConnectorConnected = z.object({
  ...connectorBase,
  type: z.literal("connector.connected"),
});

const RegistryConnectorRemoved = z.object({
  ...connectorBase,
  type: z.literal("connector.removed"),
});

const RegistryConnectorRescoped = z.object({
  ...connectorBase,
  type: z.literal("connector.rescoped"),
  scopeKind: z.string().min(1),
  subjectCount: z.number().int().min(0),
  previousScopeKind: z.string().min(1),
  previousSubjectCount: z.number().int().min(0),
});

const RegistryPolicyRefused = z.object({
  ...recordBase,
  toolId: z.string().min(1).optional(),
  type: z.literal("policy.refused"),
  capability: z.string().min(1),
  rule: z.string().min(1),
  policySource: z.enum(["local", "org"]),
  subject: z.string().min(1).optional(),
});

const RegistryPackageRequested = z.object({
  ...recordBase,
  toolId: z.string().min(1).optional(),
  type: z.literal("package.requested"),
  packageName: z.string().min(1),
  range: z.string().min(1),
  requestId: z.string().min(1),
});

const RegistryPackageAllowed = z.object({
  ...recordBase,
  toolId: z.string().min(1).optional(),
  type: z.literal("package.allowed"),
  packageName: z.string().min(1),
  range: z.string().min(1),
  requestId: z.string().min(1).optional(),
});

const AGENT_TRIGGER_SWITCH_OUTCOMES = ["vendor", "gate-only", "unconfirmed"] as const;
const AgentTriggerSwitchOutcome = z.enum(AGENT_TRIGGER_SWITCH_OUTCOMES);

const RegistryAgentPaused = z.object({
  ...recordBase,
  type: z.literal("agent.paused"),
  triggers: AgentTriggerSwitchOutcome,
  reason: z.string().max(500).optional(),
});

const RegistryAgentResumed = z.object({
  ...recordBase,
  type: z.literal("agent.resumed"),
  triggers: AgentTriggerSwitchOutcome,
});

const RegistryAgentKilled = z.object({
  ...recordBase,
  type: z.literal("agent.killed"),
  triggers: AgentTriggerSwitchOutcome,
  leasesRevoked: z.number().int().min(0),
  leasesUnconfirmed: z.number().int().min(0),
  clientDisabled: z.boolean(),
  reason: z.string().max(500).optional(),
});

const RegistryAgentBreakerReset = z.object({
  ...recordBase,
  type: z.literal("agent.breaker_reset"),
  reason: z.string().max(500).optional(),
});

const AGENT_LIMITS_CHANGES = ["set", "reset"] as const;
const AgentLimitValues = z.object({
  maxRunsPerDay: z.number().int().min(1).optional(),
  maxActionsPerRun: z.number().int().min(1).optional(),
  maxSpendUsdPerDay: z.number().positive().optional(),
});

const RegistryAgentLimitsChanged = z.object({
  ...recordBase,
  type: z.literal("agent.limits_changed"),
  change: z.enum(AGENT_LIMITS_CHANGES),
  before: AgentLimitValues,
  after: AgentLimitValues,
  reason: z.string().max(500).optional(),
});

export const RegistryReceiptRecorded = z.object({
  ...recordBase,
  type: z.literal("receipt.recorded"),
  receiptId: z.string().min(1),
  deployId: z.string().min(1),
  outcome: ReceiptOutcome,
});
export type RegistryReceiptRecorded = z.infer<typeof RegistryReceiptRecorded>;

const REGISTRY_RECORD_TYPES = [
  "tool.created",
  "tool.renamed",
  "tool.deployed",
  "tool.archived",
  "tool.reverted",
  "tool.accessed",
  "tool.owner_changed",
  "prompt.blocked",
  "prompt.warned",
  "connector.connected",
  "connector.removed",
  "connector.rescoped",
  "policy.refused",
  "package.requested",
  "package.allowed",
  "receipt.recorded",
  "agent.paused",
  "agent.resumed",
  "agent.killed",
  "agent.breaker_reset",
  "agent.limits_changed",
] as const;
export type RegistryRecordType = (typeof REGISTRY_RECORD_TYPES)[number];

export const RegistryRecord = z.discriminatedUnion("type", [
  RegistryToolCreated,
  RegistryToolRenamed,
  RegistryToolDeployed,
  RegistryToolArchived,
  RegistryToolReverted,
  RegistryToolAccessed,
  RegistryToolOwnerChanged,
  RegistryPromptBlocked,
  RegistryPromptWarned,
  RegistryConnectorConnected,
  RegistryConnectorRemoved,
  RegistryConnectorRescoped,
  RegistryPolicyRefused,
  RegistryPackageRequested,
  RegistryPackageAllowed,
  RegistryReceiptRecorded,
  RegistryAgentPaused,
  RegistryAgentResumed,
  RegistryAgentKilled,
  RegistryAgentBreakerReset,
  RegistryAgentLimitsChanged,
]);
export type RegistryRecord = z.infer<typeof RegistryRecord>;

const isRegistryRecordType = (t: string): t is RegistryRecordType =>
  (REGISTRY_RECORD_TYPES as readonly string[]).includes(t);

const RegistryEnvelope = z.object({
  schemaVersion: z.number().int().min(1),
  type: z.string().min(1),
  recordId: z.string().min(1),
});

type RegistryReadResult =
  | { kind: "record"; record: RegistryRecord }
  | { kind: "unknown"; type: string; schemaVersion: number; recordId: string; raw: unknown }
  | { kind: "malformed"; detail: string };

const zodDetail = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

export const parseRegistryRecord = (value: unknown): RegistryReadResult => {
  const envelope = RegistryEnvelope.safeParse(value);
  if (!envelope.success) {
    return { kind: "malformed", detail: `no registry envelope: ${zodDetail(envelope.error)}` };
  }
  const { type, schemaVersion, recordId } = envelope.data;
  if (!isRegistryRecordType(type)) {
    return { kind: "unknown", type, schemaVersion, recordId, raw: value };
  }
  const record = RegistryRecord.safeParse(value);
  if (record.success) return { kind: "record", record: record.data };
  if (schemaVersion > REGISTRY_SCHEMA_VERSION) {
    return { kind: "unknown", type, schemaVersion, recordId, raw: value };
  }
  return { kind: "malformed", detail: zodDetail(record.error) };
};

export const parseRegistryLine = (line: string): RegistryReadResult => {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "malformed", detail: "empty line" };
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    return { kind: "malformed", detail: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  return parseRegistryRecord(value);
};

export const serializeRegistryRecord = (record: RegistryRecord): string => {
  const parsed = RegistryRecord.safeParse(record);
  if (!parsed.success) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "Refusing to write an invalid registry record",
      detail: zodDetail(parsed.error),
    });
  }
  return JSON.stringify(parsed.data);
};
