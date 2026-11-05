# @vibtra/guard-contract

The shared contract of **Vibtra Guard v0** (GitHub issue #24): an open-source Mac agent on each work laptop plus a
slim admin console. Three halves build against this one package and nothing else:

| Half | Where | Reads from here |
|---|---|---|
| the registry's Guard doors | `apps/registry/src/guard/` | every schema; `./signing` to sign bundles |
| the slim console | `apps/guard-console/` | the console view models (`console.ts`), the rules document, the catalogue |
| the laptop agent (Rust) | `guard/agent/` | mirrors `ids.ts`, `sync.ts`, `bundle.ts`, `events.ts`, `catalogue.ts`'s matcher and `detectors.ts`; pinned by `src/detectors.vectors.json` and `pnpm --filter @vibtra/guard-contract contract:json` |

Licence: **Apache-2.0** (like `guard/`): the contract is what the open agent speaks, so it is
offered under the agent's licence. It imports `zod` and nothing else; the AGPL registry and console import it, never
the reverse (`scripts/lib/ee-boundary.mjs`).

## What is in it

| File | What | OSS shape it mirrors |
|---|---|---|
| `ids.ts` | every fixed name: prefixes, ports, id grammars, limits | — |
| `sync.ts` | enrol · preflight · ruledownload · eventupload · postflight · requests | **Santa** sync protocol (Apache-2.0); Fleet's enroll secret → node key |
| `bundle.ts` | the per-person rule bundle, settings, the ES256 JWS envelope, canonical JSON | **OPA bundle** + **TUF** `signed`/`signatures` |
| `signing.ts` | sign/verify (Node only, `@vibtra/guard-contract/signing`) | RFC 7515/7518 ES256, as `apps/registry/src/hosts/x509.ts` |
| `catalogue.ts` | the AI-services catalogue seed (~45 services: domains, bundle ids, CLI names) and the host matcher | **CrowdSec hub** / **EasyList** feed shape |
| `rules.ts` | the rules document: service rules × audience → allow/block/ask; content rules (detector × services × audience) | the org policy document (`PUT /policies`) |
| `detectors.ts` | AU TFN/ABN/ACN/Medicare (checksums), card (Luhn), secrets, bulk emails, keywords, file types | **Presidio** recognisers (MIT) and **gitleaks** rules (MIT), ported with attribution |
| `compile.ts` | compile the document for ONE person (audiences resolved server-side); decideFlow / decideContent / decideRequest | OPA: compile server-side, evaluate locally |
| `events.ts` | the event: who, app, service, rule, action, counts, a redacted snippet at most — never content | Santa eventupload; PostHog-shaped metadata rows |
| `requests.ts` | a Guard ask on the policy desk (kind `guard`) and its grant | Teleport access requests |
| `console.ts` | the slim console's doors and view models, with the banned-field walk | `@vibtra/console-api`'s law: the registry computes, the SPA renders |
| `staff-notice.ts` | the staff notice template (NSW Workplace Surveillance Act 2005 s 10/12 shape) | — |
| `vectors.ts` | loads `detectors.vectors.json` and other fixture files for tests (Node only, `@vibtra/guard-contract/vectors`) | — |

## Rules of the road (made checkable here)

- **Only AI domains are decrypted**: `isInterceptedHost` is "some enabled catalogue row matches it"; nothing else.
- **A unique CA per laptop; the key never leaves it**: the sync carries `GuardCaFacts` (fingerprint, subject, expiry) and
  has no field for a key.
- **No content stored server-side**: `GuardEvent` has rule id, match type, counts and an optional redacted snippet
  (`redactMatch`: `123***782`), bounded to `GUARD_SNIPPET_MAX`; the registry parses every upload through it.
- **Deterministic pattern rules only**: every detector is a regex plus a checksum or a list.
- **Key-shaped test values are split**: in `detectors.vectors.json` and `guard/agent-go/testdata/provider-requests.json`
  every value shaped like a vendor key has `~~` after its first character and in its middle, so secret scanners do not
  match the files. Every loader removes `~~` before parsing: `vectors.ts` for TypeScript, and the Rust and Swift tests
  do the same. `tests/integration/guard-contract/fixture-split.test.ts` fails on an unsplit value.

See `docs/guard.md` for the end-to-end protocol and the lane briefs.
