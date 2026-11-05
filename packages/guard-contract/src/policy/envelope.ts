// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { privacyProblems } from "./privacy.js";

export const POLICY_VERSION = "vibtra.policy/v1" as const;

export const DECISIONS = ["allow", "deny", "pending", "approved", "declined", "expired"] as const;
export type Decision = (typeof DECISIONS)[number];

export const REFUSING_DECISIONS: readonly Decision[] = ["deny", "declined", "expired"];
export const REQUEST_DECISIONS: readonly Decision[] = ["pending", "approved", "declined", "expired"];

export const FAMILIES = ["package", "connection", "file", "deploy", "model", "preview", "session"] as const;
export type Family = (typeof FAMILIES)[number];

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
export const DECISION_ID = /^pd_[A-Za-z0-9]{8,64}$/;
export const REASON_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const POLICY_ID = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const NO_QUERY = /^[^?#]*$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const ENVELOPE_HOST: RegExp = HOST;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const HTTPS_URL = /^https:\/\/[^\s/@]+(\/[^\s]*)?$/;

const id = z.string().regex(ID);
const instant = z.string().regex(INSTANT);
const text = (max: number) => z.string().min(1).max(max);
const url = z.string().max(2048).regex(HTTPS_URL);

export const PackageSubjectSchema = z
	.object({
		family: z.literal("package"),
		ecosystem: z.enum(["npm", "pypi", "cargo", "go", "rubygems", "other"]),
		name: text(214),
		version: z.string().min(1).max(64).optional(),
		range: z.string().min(1).max(64).optional(),
		path: z.string().min(1).max(512).regex(NO_QUERY).optional(),
	})
	.strict();

export const ConnectionSubjectSchema = z
	.object({
		family: z.literal("connection"),
		host: z.string().regex(HOST).optional(),
		port: z.number().int().min(1).max(65535).optional(),
		scheme: z.enum(["https", "http", "wss", "ws", "tcp", "dns"]).optional(),
		method: z.string().regex(/^[A-Z]{1,16}$/).optional(),
		path: z.string().max(1024).regex(NO_QUERY).optional(),
		connectionId: id.optional(),
		connectionName: text(200).optional(),
		access: z.enum(["read", "write"]).optional(),
		action: text(500).optional(),
	})
	.strict()
	.refine((s) => s.host !== undefined || s.connectionId !== undefined || s.connectionName !== undefined || s.action !== undefined, {
		message: "a connection subject names a host, a connection or an action",
	});

export const FileSubjectSchema = z
	.object({
		family: z.literal("file"),
		path: z.string().min(1).max(1024),
		operation: z.enum(["read", "write", "create", "delete", "execute", "mount"]),
		mount: z.string().min(1).max(256).optional(),
	})
	.strict();

export const DeploySubjectSchema = z
	.object({
		family: z.literal("deploy"),
		toolId: id.optional(),
		toolName: text(200).optional(),
		provider: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
		audience: z.enum(["me", "people", "groups", "org"]).optional(),
		stage: z.enum(["intake", "credential", "checks", "install", "audience", "publish"]).optional(),
	})
	.strict();

export const ModelSubjectSchema = z
	.object({
		family: z.literal("model"),
		provider: z.string().regex(/^[a-z0-9-]{1,32}$/),
		model: z.string().min(1).max(128).optional(),
		auth: z.enum(["api-key", "oauth", "gateway", "none"]).optional(),
		host: z.string().regex(HOST).optional(),
	})
	.strict();

export const PreviewSubjectSchema = z
	.object({
		family: z.literal("preview"),
		previewId: id.optional(),
		operation: z.enum(["start", "call", "share", "stop"]),
		connectionId: id.optional(),
	})
	.strict();

export const SessionSubjectSchema = z
	.object({
		family: z.literal("session"),
		profile: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
		operation: z.enum(["start", "attach", "resume", "end", "join", "wake"]),
		limit: z.enum(["profile", "session-hours", "concurrency", "spend-cap", "free-budget", "app-boxes", "app-box-hours", "members"]).optional(),
	})
	.strict();

export const SubjectSchema = z.discriminatedUnion("family", [
	PackageSubjectSchema,
	ConnectionSubjectSchema.innerType(),
	FileSubjectSchema,
	DeploySubjectSchema,
	ModelSubjectSchema,
	PreviewSubjectSchema,
	SessionSubjectSchema,
]);
export type Subject = z.infer<typeof SubjectSchema>;
export type PackageSubject = z.infer<typeof PackageSubjectSchema>;
export type ConnectionSubject = z.infer<typeof ConnectionSubjectSchema>;
export type DeploySubject = z.infer<typeof DeploySubjectSchema>;

export const ReasonSchema = z
	.object({
		code: z.string().regex(REASON_CODE),
		text: text(500),
		policy: z.string().regex(POLICY_ID).optional(),
	})
	.strict();
export type Reason = z.infer<typeof ReasonSchema>;

export const PolicyRefSchema = z
	.object({
		id: z.string().regex(POLICY_ID),
		revision: z.string().min(1).max(64).optional(),
		setting: z.string().min(1).max(200).optional(),
	})
	.strict();
export type PolicyRef = z.infer<typeof PolicyRefSchema>;

export const NEXT_KINDS = ["run", "request", "wait", "retry", "use", "open", "ask-person"] as const;
export type NextKind = (typeof NEXT_KINDS)[number];
const COMMAND_KINDS: readonly NextKind[] = ["run", "request", "wait"];

export const NextActionSchema = z
	.object({
		kind: z.enum(NEXT_KINDS),
		text: text(300),
		command: z.string().min(1).max(500).optional(),
		mcp: z
			.object({ tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), arguments: z.record(z.unknown()) })
			.strict()
			.optional(),
		url: url.optional(),
	})
	.strict()
	.refine((n) => !COMMAND_KINDS.includes(n.kind) || n.command !== undefined, { message: "run, request and wait actions carry a command" })
	.refine((n) => n.kind !== "open" || n.url !== undefined, { message: "an open action carries a url" });
export type NextAction = z.infer<typeof NextActionSchema>;

export const REQUEST_STATUSES = ["pending", "approved", "declined", "expired", "cancelled", "superseded"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const REQUEST_KINDS = ["package", "connector", "share", "external-action", "egress-host", "model", "policy-change", "package-registry", "image-change", "spending-cap", "plan", "history-exception"] as const;

export const RequestRefSchema = z
	.object({
		id,
		status: z.enum(REQUEST_STATUSES),
		kind: z.enum(REQUEST_KINDS).optional(),
		decider: text(200).optional(),
		requestedAt: instant.optional(),
		decidedAt: instant.optional(),
		expiresAt: instant.optional(),
		url: url.optional(),
	})
	.strict();
export type RequestRef = z.infer<typeof RequestRefSchema>;

export const HISTORY_ACTIONS = ["http:request", "connection:use", "package:install", "net:connect", "grant", "history:gap", "session:start"] as const;
export const HISTORY_RULE_KINDS = ["egress-after-read", "rate-limit", "install-after-read", "advanced"] as const;
export const HISTORY_FACTS_MAX = 5;

export const HistoryFactSchema = z
	.object({
		action: z.enum(HISTORY_ACTIONS),
		connectionId: id.optional(),
		connectionName: text(200).optional(),
		dataClass: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/).optional(),
		host: z.string().regex(HOST).optional(),
		at: instant,
		agoS: z.number().int().min(0),
	})
	.strict();
export type HistoryFactRef = z.infer<typeof HistoryFactSchema>;

export const HistoryDetailSchema = z
	.object({
		rule: z.object({ id: z.string().regex(POLICY_ID), title: text(200).optional(), kind: z.enum(HISTORY_RULE_KINDS).optional() }).strict(),
		facts: z.array(HistoryFactSchema).max(HISTORY_FACTS_MAX).optional(),
		count: z.number().int().min(0).optional(),
		max: z.number().int().min(1).optional(),
		windowS: z.number().int().min(1).optional(),
		retryAfterS: z.number().int().min(0).optional(),
	})
	.strict();
export type HistoryDetail = z.infer<typeof HistoryDetailSchema>;

const STATUS_FOR: Partial<Record<Decision, RequestStatus>> = { pending: "pending", approved: "approved", declined: "declined", expired: "expired" };

const EnvelopeObject = z
	.object({
		version: z.literal(POLICY_VERSION),
		id: z.string().regex(DECISION_ID),
		time: instant,
		orgId: id,
		sessionId: id.optional(),
		actorId: id.optional(),
		subject: SubjectSchema,
		decision: z.enum(DECISIONS),
		reasons: z.array(ReasonSchema).max(20),
		policies: z.array(PolicyRefSchema).max(20),
		message: text(600),
		next: z.array(NextActionSchema).max(8),
		request: RequestRefSchema.optional(),
		docs: url.optional(),
		masked: z.array(z.string().regex(/^[a-z][A-Za-z0-9_.]{0,63}$/)).max(20).optional(),
		history: HistoryDetailSchema.optional(),
	})
	.strict();

export const EnvelopeSchema = EnvelopeObject.superRefine((env, ctx) => {
	if (env.subject.family === "connection") {
		const parsed = ConnectionSubjectSchema.safeParse(env.subject);
		if (!parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["subject"], message: parsed.error.issues[0]?.message ?? "bad connection subject" });
	}
	if (REFUSING_DECISIONS.includes(env.decision)) {
		if (env.reasons.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reasons"], message: `a ${env.decision} carries at least one reason` });
		if (env.next.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["next"], message: `a ${env.decision} carries at least one next action` });
	}
	for (const name of env.masked ?? []) {
		let at: unknown = env;
		for (const key of name.split(".")) at = at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined;
		if (at !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["masked"], message: `${name} is listed as masked but is present` });
	}
	if (env.decision === "pending" && env.next.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["next"], message: "a pending decision says how to wait" });
	const status = STATUS_FOR[env.decision];
	if (status !== undefined) {
		if (env.request === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request"], message: `a ${env.decision} decision names its request` });
		else if (env.request.status !== status) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["request", "status"], message: `a ${env.decision} decision's request is ${status}` });
	}
});
export type Envelope = z.infer<typeof EnvelopeObject>;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const issues = (error: z.ZodError): string[] => error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

export function validateEnvelope(value: unknown): ValidationResult<Envelope> {
	const parsed = EnvelopeSchema.safeParse(value);
	if (!parsed.success) return { ok: false, errors: issues(parsed.error) };
	const privacy = privacyProblems(parsed.data);
	if (privacy.length > 0) return { ok: false, errors: privacy };
	return { ok: true, value: parsed.data };
}
