// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { type Decision, type Envelope, EnvelopeSchema, type ValidationResult, validateEnvelope } from "./envelope.js";
import { privacyProblems } from "./privacy.js";

const WORD: Record<Decision, string> = {
	allow: "allowed",
	deny: "blocked",
	pending: "waiting on IT",
	approved: "approved",
	declined: "declined",
	expired: "expired",
};

const firstCommand = (env: Pick<Envelope, "next">): string | undefined => env.next.find((n) => n.command !== undefined)?.command;

export function renderLine(env: Envelope): string {
	const cmd = firstCommand(env);
	return `vibtra: ${WORD[env.decision]} — ${env.message}${cmd ? ` Next: run \`${cmd}\`.` : ""} (decision ${env.id})`;
}

export const DECISION_HEADER = "x-vibtra-policy-decision";

export const HttpJsonRefusalSchema = z
	.object({
		status: z.number().int().min(400).max(599),
		headers: z.object({ "content-type": z.literal("application/json"), [DECISION_HEADER]: z.string() }).strict(),
		body: z
			.object({
				error: z.string().startsWith("vibtra: "),
				reason: z.string().min(1),
				policy: EnvelopeSchema,
			})
			.strict(),
	})
	.strict()
	.superRefine((r, ctx) => {
		if (r.headers[DECISION_HEADER] !== r.body.policy.id) ctx.addIssue({ code: "custom", path: ["headers", DECISION_HEADER], message: "the header names the body's decision id" });
		if (r.body.reason !== r.body.policy.message) ctx.addIssue({ code: "custom", path: ["body", "reason"], message: "reason is the envelope's message" });
		if (r.body.policy.decision === "allow" || r.body.policy.decision === "approved") ctx.addIssue({ code: "custom", path: ["body", "policy", "decision"], message: "an HTTP refusal carries a refusing or pending decision" });
	});

export const HttpTextRefusalSchema = z
	.object({
		status: z.number().int().min(400).max(599),
		headers: z.object({ "content-type": z.literal("text/plain; charset=utf-8"), [DECISION_HEADER]: z.string().regex(/^pd_[A-Za-z0-9]{8,64}$/) }).strict(),
		text: z.string().regex(/^vibtra: [^\n]+\n/),
	})
	.strict();

export const CHANNELS = ["envelope", "http"] as const;
export type Channel = (typeof CHANNELS)[number];

const shape = (schema: z.ZodTypeAny, value: unknown): string[] => {
	const r = schema.safeParse(value);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
};

const embedded = (envs: unknown[], where: string): string[] =>
	envs.flatMap((env, i) => {
		const r = validateEnvelope(env);
		return r.ok ? [] : r.errors.map((e) => `${where}[${i}] ${e}`);
	});

export function validateChannel(channel: Channel, value: unknown): ValidationResult<unknown> {
	if (channel === "envelope") return validateEnvelope(value);
	const v = value as Record<string, any>;
	const isText = v !== null && typeof v === "object" && "text" in v;
	const errors = shape(isText ? HttpTextRefusalSchema : HttpJsonRefusalSchema, value);
	if (errors.length === 0) {
		if (isText) {
			const line = String(v.text).split("\n")[1] ?? "";
			let env: unknown;
			try {
				env = JSON.parse(line);
			} catch {
				errors.push("text: the second line is the envelope as JSON");
			}
			if (env !== undefined) {
				errors.push(...embedded([env], "text"));
				if ((env as { id?: string }).id !== v.headers[DECISION_HEADER]) errors.push("headers: the decision header names the envelope id");
			}
		} else errors.push(...embedded([v.body.policy], "body.policy"));
	}
	errors.push(...privacyProblems(value, { keys: false }));
	return errors.length === 0 ? { ok: true, value } : { ok: false, errors: [...new Set(errors)] };
}
