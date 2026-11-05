import { describe, expect, it } from "vitest";
import { DECISION_HEADER, DECISION_ID, type Envelope, type UsageCode, privacyProblems, renderLine, usageEnvelope, validateChannel, validateEnvelope } from "@vibtra/guard-contract/policy";

const ctx = {
  orgId: "org_acme",
  sessionId: "3f0c2a1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b",
  actorId: "usr_42",
  revision: "rev_abcdefghijklmnopqrstuvwxyz",
  orgName: "Acme",
  now: new Date("2026-10-07T10:00:00.000Z"),
};

const httpJson = (env: Envelope, status: number) => ({
  status,
  headers: { "content-type": "application/json", [DECISION_HEADER]: env.id },
  body: { error: renderLine(env), reason: env.message, policy: env },
});

const httpText = (env: Envelope, status: number) => ({
  status,
  headers: { "content-type": "text/plain; charset=utf-8", [DECISION_HEADER]: env.id },
  text: `${renderLine(env)}\n${JSON.stringify(env)}\n`,
});

const packageDeny: Envelope = {
  version: "vibtra.policy/v1",
  id: "pd_01K6Q8Z3VJ4T7N2M5R8X0B6C01",
  time: "2026-10-03T04:12:01.000Z",
  orgId: "org_acme",
  sessionId: "bss_7f3a9c",
  actorId: "usr_42",
  subject: { family: "package", ecosystem: "npm", name: "recharts", range: "^2" },
  decision: "deny",
  reasons: [{ code: "PACKAGE_NOT_ALLOWED", text: "recharts is not on this session's allowed packages", policy: "deploy.allowedPackages" }],
  policies: [{ id: "deploy.allowedPackages", revision: "r42" }],
  message: "recharts@^2 is not on this workspace's allowed packages, so the company mirror did not serve it. Ask IT to allow it, or use a package that is already allowed.",
  next: [
    {
      kind: "request",
      text: "Ask IT to allow recharts@^2; say what it is for.",
      command: 'vibtra request package recharts@^2 --why "charts on the sales dashboard"',
      mcp: { tool: "vibtra_request", arguments: { kind: "package", subject: "recharts@^2" } },
    },
    { kind: "run", text: "See what is already allowed.", command: "vibtra policy packages --json" },
  ],
  docs: "https://vibtra.app/docs/policy/PACKAGE_NOT_ALLOWED",
};

describe("usage envelopes", () => {
  const codes: UsageCode[] = ["SESSION_HOURS_USED_UP", "CONCURRENCY_LIMIT", "SPENDING_CAP_REACHED", "FREE_BUDGET_EXHAUSTED", "APP_BOX_LIMIT", "APP_BOX_HOURS_USED_UP", "MEMBER_LIMIT"];

  it.each(codes)("%s is a valid deny with a session subject, a printable line and a next action on both HTTP forms", (code) => {
    const env = usageEnvelope(code, { planName: "Free", profile: "claude", allowance: "40 session-hours a month", resetsOn: "2026-11-01" }, ctx);
    const checked = validateEnvelope(env);
    expect(checked.ok, checked.ok ? "" : checked.errors.join("; ")).toBe(true);
    expect(env.subject.family).toBe("session");
    expect(env.reasons[0]?.code).toBe(code);
    expect(env.docs).toBe(`https://vibtra.app/docs/policy/${code}`);
    expect(env.next.length).toBeGreaterThan(0);
    expect(renderLine(env)).toMatch(/^vibtra: blocked — /);
    expect(validateChannel("http", httpJson(env, 409)).ok).toBe(true);
    expect(validateChannel("http", httpText(env, 409)).ok).toBe(true);
  });

  it.each<[UsageCode, string, string]>([
    [
      "SESSION_HOURS_USED_UP",
      "This organisation has used the Team plan's session-hours for this month, so no workspace can run until the month rolls over. Ask an admin to upgrade the plan.",
      "the Team plan's session-hours are used up",
    ],
    [
      "CONCURRENCY_LIMIT",
      "The Team plan runs a limited number of workspaces at a time and that many are running now. Wait for a teammate's session to stop, or ask an admin to upgrade the plan.",
      "the Team plan runs a limited number of workspaces at a time, and that many are running",
    ],
    ["SPENDING_CAP_REACHED", "IT's monthly spending cap is reached, so nothing new starts until IT raises it or the month rolls over. Ask IT to raise the cap.", "IT's monthly spending cap is reached"],
    ["FREE_BUDGET_EXHAUSTED", "Vibtra's free capacity for this month is used up, so Free workspaces cannot start. Upgrade, or wait until the 1st of next month.", "Vibtra's free capacity for this month is used up"],
    ["APP_BOX_LIMIT", "The Team plan's app boxes are all in use, so another one cannot be created. Remove one, or ask an admin to upgrade the plan.", "the Team plan's app boxes are all in use"],
    [
      "APP_BOX_HOURS_USED_UP",
      "The Team plan's app-box awake hours for this month are used up, so the app box cannot wake until the month rolls over. Ask an admin to upgrade the plan.",
      "the Team plan's app-box awake hours are used up",
    ],
    ["MEMBER_LIMIT", "This organisation already has the Team plan's people, so nobody else can join. Ask an admin to upgrade the plan.", "the Team plan's people are all taken"],
  ])("%s says what happened and what to do in the words people see", (code, message, reason) => {
    const env = usageEnvelope(code, { planName: "Team" }, ctx);
    expect(env.message).toBe(message);
    expect(env.reasons[0]?.text).toBe(reason);
  });

  it("fills the allowance and the reset date into the sentence", () => {
    const env = usageEnvelope("SESSION_HOURS_USED_UP", { planName: "Free", allowance: "40 session-hours a month", resetsOn: "2026-11-01" }, ctx);
    expect(env.message).toBe("This organisation has used the Free plan's 40 session-hours a month for this month, so no workspace can run until 2026-11-01. Ask an admin to upgrade the plan.");
    expect(env.policies).toEqual([{ id: "plan.sessionHours", revision: ctx.revision, setting: "40 session-hours a month" }]);
  });

  it("points a used-up Free plan at an upgrade and a reached cap at a cap request", () => {
    expect(usageEnvelope("SESSION_HOURS_USED_UP", { planName: "Free" }, ctx).next[0]?.command).toBe('vibtra request plan upgrade --why "<what it is for>"');
    expect(usageEnvelope("SPENDING_CAP_REACHED", { planName: "Team" }, ctx).next[0]?.command).toBe('vibtra request spending-cap raise --why "<what it is for>"');
    expect(usageEnvelope("APP_BOX_HOURS_USED_UP", { planName: "Team", paid: true }, ctx).next[0]?.command).toContain("spending-cap");
    expect(usageEnvelope("MEMBER_LIMIT", { planName: "Free" }, ctx).subject).toEqual({ family: "session", operation: "join", limit: "members" });
  });

  it("renders the member limit the metering service refuses a join with", () => {
    const env = usageEnvelope("MEMBER_LIMIT", { planName: "Free" }, { ...ctx, id: "pd_01K6Q8Z3VJ4T7N2M5R8X0B6C01" });
    expect(env).toEqual({
      version: "vibtra.policy/v1",
      id: "pd_01K6Q8Z3VJ4T7N2M5R8X0B6C01",
      time: "2026-10-07T10:00:00.000Z",
      orgId: "org_acme",
      sessionId: ctx.sessionId,
      actorId: "usr_42",
      subject: { family: "session", operation: "join", limit: "members" },
      decision: "deny",
      reasons: [{ code: "MEMBER_LIMIT", text: "the Free plan's people are all taken", policy: "plan.userLimit" }],
      policies: [{ id: "plan.userLimit", revision: ctx.revision }],
      message: "This organisation already has the Free plan's people, so nobody else can join. Ask an admin to upgrade the plan.",
      next: [
        {
          kind: "request",
          text: "Ask an admin to upgrade the plan; say what it is for.",
          command: 'vibtra request plan upgrade --why "<what it is for>"',
          mcp: { tool: "vibtra_request", arguments: { kind: "plan", subject: "upgrade" } },
        },
      ],
      docs: "https://vibtra.app/docs/policy/MEMBER_LIMIT",
    });
    expect(renderLine(env)).toBe(
      'vibtra: blocked — This organisation already has the Free plan\'s people, so nobody else can join. Ask an admin to upgrade the plan. Next: run `vibtra request plan upgrade --why "<what it is for>"`. (decision pd_01K6Q8Z3VJ4T7N2M5R8X0B6C01)',
    );
  });

  it("drops a session or org id that is not an id, and a plan name's punctuation", () => {
    const env = usageEnvelope("MEMBER_LIMIT", { planName: "Free <b>" }, { ...ctx, sessionId: "bad id with spaces", orgId: "org acme" });
    expect(env.sessionId).toBeUndefined();
    expect(env.orgId).toBe("org_unknown");
    expect(env.reasons[0]?.text).toBe("the Free b plan's people are all taken");
    expect(validateEnvelope(env).ok).toBe(true);
  });
});

describe("decision ids", () => {
  it("are well formed and sort by time", () => {
    const earlier = usageEnvelope("MEMBER_LIMIT", { planName: "Free" }, { ...ctx, now: new Date(1_700_000_000_000) }).id;
    const later = usageEnvelope("MEMBER_LIMIT", { planName: "Free" }, { ...ctx, now: new Date(1_700_000_000_001) }).id;
    expect(earlier).toMatch(DECISION_ID);
    expect(later).toMatch(DECISION_ID);
    expect(earlier < later).toBe(true);
  });
});

describe("privacy rules on prose", () => {
  it("the base envelope is valid", () => {
    expect(validateChannel("envelope", packageDeny).ok).toBe(true);
  });

  it.each([
    "This connection uses Basic authentication; ask IT for a token.",
    "The API expects Bearer authentication.",
    "Open https://example.com/callback?code=abc to finish.",
  ])("lets ordinary prose through: %s", (message) => {
    expect(validateChannel("envelope", { ...packageDeny, message }).ok).toBe(true);
    expect(privacyProblems(message)).toEqual([]);
  });

  it("refuses a token-shaped bearer value", () => {
    expect(validateChannel("envelope", { ...packageDeny, message: "Sent Bearer eyJhbGciOiJIUzI1NiJ9.abc123def456" }).ok).toBe(false);
  });

  it.each([
    ["an Anthropic key", "key sk-ant-abcdefgh1234"],
    ["a GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz"],
    ["a credential in a URL", "https://ada:hunter22@example.com/"],
    ["a credential in a query string", "https://example.com/?token=abc"],
  ])("names %s found in prose", (name, message) => {
    expect(privacyProblems({ message })).toEqual([`message: looks like ${name}; an envelope never carries a secret value`]);
  });
});

describe("the HTTP refusal channel", () => {
  it("refuses a header that does not name the envelope, and an allow", () => {
    const deny = httpJson(packageDeny, 403);
    expect(validateChannel("http", deny).ok).toBe(true);
    expect(validateChannel("http", { ...deny, headers: { ...deny.headers, [DECISION_HEADER]: "pd_00000000000000000000000000" } }).ok).toBe(false);
    const allow = { ...packageDeny, decision: "allow" as const };
    expect(validateChannel("http", httpJson(allow, 403)).ok).toBe(false);
  });

  it("refuses a text refusal whose second line is not the envelope", () => {
    expect(validateChannel("http", { ...httpText(packageDeny, 403), text: `${renderLine(packageDeny)}\nnot json\n` }).ok).toBe(false);
  });
});
