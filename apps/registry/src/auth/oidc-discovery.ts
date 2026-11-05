// SPDX-License-Identifier: AGPL-3.0-only
import { VibtraError } from "../errors.js";
import { oidcDiscoveryUrl } from "./better-auth.js";

export interface OidcDiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  delayMs?: number;
  log?: (line: string) => void;
}

const REQUIRED = ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const;

export const waitForOidcDiscovery = async (issuer: string, options: OidcDiscoveryOptions = {}): Promise<void> => {
  const doFetch = options.fetch ?? globalThis.fetch;
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 2_000;
  const url = oidcDiscoveryUrl(issuer);
  let last = "no answer";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        last = `HTTP ${res.status}`;
      } else {
        const doc = (await res.json()) as Record<string, unknown>;
        const missing = REQUIRED.filter((key) => typeof doc[key] !== "string" || doc[key] === "");
        if (doc.issuer !== issuer) {
          throw new VibtraError({
            code: "VALIDATION",
            message: "REGISTRY_OIDC_ISSUER does not match the provider's issuer",
            detail: `The discovery document at ${url} names issuer ${JSON.stringify(doc.issuer)}. Set REGISTRY_OIDC_ISSUER to exactly that value.`,
          });
        }
        if (missing.length > 0) {
          throw new VibtraError({
            code: "VALIDATION",
            message: "The identity provider's discovery document is incomplete",
            detail: `${url} has no ${missing.join(", ")}. Sign-in needs all three.`,
          });
        }
        return;
      }
    } catch (error) {
      if (error instanceof VibtraError) throw error;
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      options.log?.(`waiting for the identity provider at ${url} (${last})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new VibtraError({
    code: "VALIDATION",
    message: "The identity provider is unreachable",
    detail: `${url} did not answer with a discovery document (${last}). Check REGISTRY_OIDC_ISSUER and that this server can reach it.`,
  });
};
