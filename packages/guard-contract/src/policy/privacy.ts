// SPDX-License-Identifier: Apache-2.0

const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
	{ name: "an Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
	{ name: "an OpenAI-style key", re: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/ },
	{ name: "a GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
	{ name: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
	{ name: "an AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ name: "a Stripe key", re: /\b[rs]k_(live|test)_[A-Za-z0-9]{16,}/ },
	{ name: "a Vibtra door token", re: /\bvbt_[A-Za-z0-9_-]{16,}/ },
	{ name: "a JSON Web Token", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
	{ name: "a private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
	{ name: "a bearer credential", re: /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{16,}/ },
	{ name: "an authorization header", re: /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:/i },
	{ name: "a credential in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
	{ name: "a credential in a query string", re: /[?&](access_token|token|api_key|apikey|key|secret|password|sig|signature)=[^&\s]+/i },
];

const SECRET_KEYS = /^(authorization|cookie|password|passwd|secret|token|access_?token|refresh_?token|api_?key|private_?key|client_?secret|credential|credentials|headers?|body)$/i;

export function privacyProblems(value: unknown, options: { keys?: boolean } = {}): string[] {
	const checkKeys = options.keys ?? true;
	const problems: string[] = [];
	const walk = (node: unknown, path: string): void => {
		if (typeof node === "string") {
			for (const { name, re } of SECRET_PATTERNS) if (re.test(node)) problems.push(`${path || "(root)"}: looks like ${name}; an envelope never carries a secret value`);
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((item, i) => walk(item, `${path}[${i}]`));
			return;
		}
		if (node !== null && typeof node === "object") {
			for (const [key, child] of Object.entries(node)) {
				const at = path ? `${path}.${key}` : key;
				if (checkKeys && SECRET_KEYS.test(key)) problems.push(`${at}: a field named "${key}" would carry a value; an envelope never does`);
				walk(child, at);
			}
		}
	};
	walk(value, "");
	return problems;
}
