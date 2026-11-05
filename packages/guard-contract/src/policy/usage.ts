// SPDX-License-Identifier: Apache-2.0
import { type Envelope, type NextAction, POLICY_VERSION } from "./envelope.js";

const DOCS_BASE = "https://vibtra.app/docs/policy";
const docsFor = (code: string): string => `${DOCS_BASE}/${code}`;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newDecisionId(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b)): string {
	let time = "";
	let t = now;
	for (let i = 0; i < 10; i++) {
		time = ALPHABET[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = random(new Uint8Array(16));
	let rand = "";
	for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
	return `pd_${time}${rand}`;
}

export interface EnvelopeContext {
	orgId: string;
	sessionId?: string;
	actorId?: string;
	revision?: string;
	orgName?: string;
	now?: Date;
	id?: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,127}$/;
const safeId = (value: string | undefined): string | undefined => (value !== undefined && SAFE_ID.test(value) ? value : undefined);

function head(ctx: EnvelopeContext): Pick<Envelope, "version" | "id" | "time" | "orgId" | "sessionId" | "actorId"> {
	const now = ctx.now ?? new Date();
	const sessionId = safeId(ctx.sessionId);
	const actorId = safeId(ctx.actorId);
	return {
		version: POLICY_VERSION,
		id: ctx.id ?? newDecisionId(now.getTime()),
		time: now.toISOString(),
		orgId: safeId(ctx.orgId) ?? "org_unknown",
		...(sessionId ? { sessionId } : {}),
		...(actorId ? { actorId } : {}),
	};
}

const policies = (id: string, ctx: EnvelopeContext, setting?: string) => [{ id, ...(ctx.revision ? { revision: ctx.revision } : {}), ...(setting ? { setting } : {}) }];

const requestNext = (command: string, kind: string, subject: string, text: string): NextAction => ({
	kind: "request",
	text,
	command: `${command} --why "<what it is for>"`,
	mcp: { tool: "vibtra_request", arguments: { kind, subject } },
});

export type UsageCode =
	| "SESSION_HOURS_USED_UP"
	| "CONCURRENCY_LIMIT"
	| "SPENDING_CAP_REACHED"
	| "FREE_BUDGET_EXHAUSTED"
	| "APP_BOX_LIMIT"
	| "APP_BOX_HOURS_USED_UP"
	| "MEMBER_LIMIT";

export interface UsageAct {
	planName: string;
	operation?: "start" | "wake" | "join";
	profile?: string;
	allowance?: string;
	resetsOn?: string;
	paid?: boolean;
}

const LIMIT_OF: Record<UsageCode, "session-hours" | "concurrency" | "spend-cap" | "free-budget" | "app-boxes" | "app-box-hours" | "members"> = {
	SESSION_HOURS_USED_UP: "session-hours",
	CONCURRENCY_LIMIT: "concurrency",
	SPENDING_CAP_REACHED: "spend-cap",
	FREE_BUDGET_EXHAUSTED: "free-budget",
	APP_BOX_LIMIT: "app-boxes",
	APP_BOX_HOURS_USED_UP: "app-box-hours",
	MEMBER_LIMIT: "members",
};

const POLICY_OF: Record<UsageCode, string> = {
	SESSION_HOURS_USED_UP: "plan.sessionHours",
	CONCURRENCY_LIMIT: "plan.concurrentWorkspaces",
	SPENDING_CAP_REACHED: "billing.spendingCap",
	FREE_BUDGET_EXHAUSTED: "plan.freeBudget",
	APP_BOX_LIMIT: "plan.appBoxes",
	APP_BOX_HOURS_USED_UP: "plan.appBoxAwakeHours",
	MEMBER_LIMIT: "plan.userLimit",
};

export function usageEnvelope(code: UsageCode, act: UsageAct, ctx: EnvelopeContext): Envelope {
	const plan = act.planName.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 40) || "this";
	const allowance = act.allowance ? act.allowance.replace(/[\r\n]/g, " ").slice(0, 80) : undefined;
	const resets = act.resetsOn && /^\d{4}-\d{2}-\d{2}$/.test(act.resetsOn) ? act.resetsOn : undefined;
	const upgrade = requestNext("vibtra request plan upgrade", "plan", "upgrade", "Ask an admin to upgrade the plan; say what it is for.");
	const raiseCap = requestNext("vibtra request spending-cap raise", "spending-cap", "raise", "Ask IT to raise the monthly spending cap; say what it is for.");
	let message: string;
	let text: string;
	let next: NextAction[];
	switch (code) {
		case "SESSION_HOURS_USED_UP":
			text = `the ${plan} plan's ${allowance ?? "session-hours"} are used up${resets ? ` until ${resets}` : ""}`;
			message = `This organisation has used the ${plan} plan's ${allowance ?? "session-hours"} for this month, so no workspace can run until ${resets ?? "the month rolls over"}. Ask an admin to upgrade the plan.`;
			next = [upgrade];
			break;
		case "CONCURRENCY_LIMIT":
			text = `the ${plan} plan runs ${allowance ?? "a limited number of workspaces"} at a time, and that many are running`;
			message = `The ${plan} plan runs ${allowance ?? "a limited number of workspaces"} at a time and that many are running now. Wait for a teammate's session to stop, or ask an admin to upgrade the plan.`;
			next = [{ kind: "ask-person", text: "Wait for a teammate's session to stop, or ask them to stop it." }, upgrade];
			break;
		case "SPENDING_CAP_REACHED":
			text = `IT's monthly spending cap${allowance ? ` (${allowance})` : ""} is reached`;
			message = `IT's monthly spending cap${allowance ? ` of ${allowance}` : ""} is reached, so nothing new starts until IT raises it or the month rolls over${resets ? ` on ${resets}` : ""}. Ask IT to raise the cap.`;
			next = [raiseCap];
			break;
		case "FREE_BUDGET_EXHAUSTED":
			text = `Vibtra's free capacity for this month is used up${resets ? ` until ${resets}` : ""}`;
			message = `Vibtra's free capacity for this month is used up, so Free workspaces cannot start. Upgrade, or wait until ${resets ?? "the 1st of next month"}.`;
			next = [upgrade, { kind: "ask-person", text: `Wait until ${resets ?? "the 1st of next month"}, when the free capacity resets.` }];
			break;
		case "APP_BOX_LIMIT":
			text = `the ${plan} plan's ${allowance ?? "app boxes"} are all in use`;
			message = `The ${plan} plan's ${allowance ?? "app boxes"} are all in use, so another one cannot be created. Remove one, or ask an admin to upgrade the plan.`;
			next = [upgrade];
			break;
		case "APP_BOX_HOURS_USED_UP":
			text = `the ${plan} plan's ${allowance ?? "app-box awake hours"} are used up${resets ? ` until ${resets}` : ""}`;
			message = `The ${plan} plan's ${allowance ?? "app-box awake hours"} for this month are used up, so the app box cannot wake until ${resets ?? "the month rolls over"}. ${act.paid ? "Ask IT to raise the spending cap." : "Ask an admin to upgrade the plan."}`;
			next = [act.paid ? raiseCap : upgrade];
			break;
		case "MEMBER_LIMIT":
			text = `the ${plan} plan's ${allowance ?? "people"} are all taken`;
			message = `This organisation already has the ${plan} plan's ${allowance ?? "people"}, so nobody else can join. Ask an admin to upgrade the plan.`;
			next = [upgrade];
			break;
	}
	const operation = act.operation ?? (code === "MEMBER_LIMIT" ? "join" : "start");
	const profile = act.profile && /^[a-z0-9-]{1,32}$/.test(act.profile) ? act.profile : undefined;
	return {
		...head(ctx),
		subject: { family: "session", ...(profile ? { profile } : {}), operation, limit: LIMIT_OF[code] },
		decision: "deny",
		reasons: [{ code, text: text.slice(0, 500), policy: POLICY_OF[code] }],
		policies: policies(POLICY_OF[code], ctx, allowance),
		message: message.length > 600 ? `${message.slice(0, 599)}…` : message,
		next,
		docs: docsFor(code),
	};
}
