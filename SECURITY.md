# Security policy

Guard checks AI requests on a Mac against an organisation's policy and blocks supported requests before
they leave the device. The agent, the Network Extension and the signed policy they apply are where we most
want your reports.

## Reporting a vulnerability

Please report security issues privately. **Do not open a public GitHub issue.**

- **Email:** security@vibtra.app
- **GitHub:** private vulnerability reporting on this repository (Security → Report a vulnerability).

Include what you found, steps to reproduce, and what an attacker gains. A person will reply. We aim to
acknowledge a report within a few business days and to keep you updated until it is fixed. We are a small
team without an on-call rotation, so we do not publish fix times by severity yet; we would rather promise
what we can keep.

## Supported versions

| Version | Supported |
|---|---|
| The latest release | Yes |
| The release before it | Security fixes for a limited time after a new release |
| Older releases | No |

If you self-host, upgrade to get fixes.

## How Guard is built (what the code in this repository defends)

- **Only AI hosts are decrypted.** The Mac agent (`guard/agent-go`) is a local HTTPS proxy. It decrypts only
  hosts in its catalogue. A connection to any other host is tunnelled unread.
- **One certificate authority per Mac.** The Guard app makes its private key in the Mac's Secure Enclave and
  keeps it on a keychain group only Guard can use. The key cannot be copied off the Mac or out of a backup. The
  app signs only for Guard's own agent, signed by the same team. The backend sees only the certificate's
  fingerprint and expiry.
- **Cases where Guard cannot inspect are shown.** With no Secure Enclave, when no key can be made, or in a
  build not signed by the app's team, AI traffic passes through unchecked. The Mac shows that it is not
  protected, and the dashboard lists it as not protected. Through the network extension, a request Guard
  cannot check (a new certificate not trusted yet, or the app restarting or not responding) goes through
  unchecked after a few seconds, as in the
  [availability fail-open](docs/guide/coverage.md#availability-guard-fails-open). Clients that use
  `HTTPS_PROXY` instead wait up to about 90 seconds for a new certificate to be trusted, then go through
  unchecked, and wait or fail while the app is restarting or not responding.
- **Signed policy.** The agent applies a policy bundle and catalogue only after checking the backend's
  signature over them.
- **No content leaves the Mac.** Request bodies are checked in memory. An event carries the host, the app,
  the rule, a count and at most a short redacted fragment.
- **The Network Extension** (`guard/mac`) steers catalogued AI traffic to the agent and verifies the
  sending app's code signature where a rule needs it.
- **The backend and dashboard** (`apps/registry`, `apps/guard-console`). Sign-in, organisation scope, roles,
  CSRF checks, device enrolment and revocation, and approvals for blocked requests.

## In scope

- **Getting round a block**: a supported request that policy should block reaching the AI service from a Mac
  that Guard shows as protected.
- **Silent loss of protection**: AI traffic passing through unchecked because the Mac has no Secure Enclave,
  no key can be made, the build is unsigned or a new certificate is not trusted yet, with no notice on the Mac
  and no not-protected status on the dashboard.
- **Decryption outside the catalogue**: the agent reading traffic to a host not in its catalogue.
- **Content exposure**: a request body, or more than the redacted fragment, reaching a log, an event, the
  backend or a third party.
- **Certificate authority misuse**: the per-Mac key leaving the Secure Enclave, a program other than Guard's
  signed agent getting the app to sign with it, or the certificate being usable for hosts it should not cover.
- **Forged policy**: the agent applying a policy bundle or catalogue the backend did not sign.
- **Cross-tenant access**: one organisation reading or changing another's devices, policy, events or requests.
- **Approvals**: approving without the right role, approving your own request, or an approval outliving its
  time limit.
- **Enrolment**: enrolling or impersonating a device without a valid enrolment link, or a revoked device
  still syncing.
- **The backend and dashboard**: authentication, session and CSRF flaws.
- **Enterprise features (`ee/`)**: a forged or edited licence key being accepted.

## Out of scope

- **Documented limits.** Clients and routes not listed as verified in
  [guard/agent-go/surface-coverage.json](guard/agent-go/surface-coverage.json), and traffic to hosts not in
  the catalogue. AI traffic that passes through while Guard shows the Mac as not protected. The availability
  fail-open in [docs/guide/coverage.md](docs/guide/coverage.md#availability-guard-fails-open): the agent down
  or not answering, the app not started or quit, and a connection not answered within 3 seconds. A person with
  administrator rights on their own Mac who removes or disables Guard.
- Findings from automated scanners with no shown impact; missing headers with no exploit path; social
  engineering; physical attacks; denial of service by volume.
- Third-party services (Anthropic, OpenAI, Google and so on): report those to the vendor. Tell us too if
  Guard is affected.

## Testing rules (safe harbour)

If you make a good-faith effort to follow this policy, we will treat your research as authorised, work with
you to fix the issue, and not pursue or support legal action against you for it. If someone else brings
legal action over research that followed this policy, we will say it was authorised.

Good faith means:

- Test only against your own self-hosted copy, your own Macs, or your own organisation on Vibtra Cloud.
- Do not access, change or delete data that is not yours. If you reach someone else's data, stop and tell us.
- Stop once you have shown the issue. Do not keep access or move further in.
- Do not degrade the service for others.
- Give us reasonable time to fix it before you tell anyone else.

## Disclosure

We ask for coordinated disclosure. We will agree a disclosure date with you, publish an advisory with the
fix, and credit you unless you would rather not be named. We do not offer a bug bounty or payment at this
time; we offer a human reply, credit and a fix.

If you are unsure whether something is in scope, send it anyway.
