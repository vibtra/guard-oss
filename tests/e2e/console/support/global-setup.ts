import { mkdirSync, writeFileSync } from "node:fs";
import { ConsoleGroupDetail, ConsolePeoplePage, ConsolePolicyDecided, ConsolePolicyGrantsPage } from "@vibtra/console-api";
import { GuardEnrolLink, GuardRulesPage, type GuardEvent, type GuardRulesUpdate, GuardServiceRow } from "@vibtra/guard-contract";
import { ADMIN_STATE, MEMBER_STATE, ORG_DOMAIN, REGISTRY_URL, SEED_FILE, STATE_DIR } from "./env.ts";
import { type Account, type AgentClient, ConsoleClient, SESSION_COOKIE, enrolDevice, eventId, signUp } from "./registry.ts";
import type { Seed, SeedDevice } from "./seed.ts";

const PEOPLE = {
  ada: { name: "Ada Park", email: `ada@${ORG_DOMAIN}` },
  grace: { name: "Grace Ho", email: `grace@${ORG_DOMAIN}` },
  bo: { name: "Bo Tran", email: `bo@${ORG_DOMAIN}` },
  dee: { name: "Dee Shah", email: `dee@${ORG_DOMAIN}` },
};

const RULES: GuardRulesUpdate["document"] = {
  defaultAction: "allow",
  serviceRules: [{ serviceId: "deepseek", audience: { kind: "org" }, action: "block", enabled: true, note: "Data leaves Australia" }],
  contentRules: [{ name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", audience: { kind: "org" }, action: "block", enabled: true }],
};

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

const chrome = { bundleId: "com.google.Chrome", name: "Google Chrome" };

const taxFileNumberBlock = (ruleId: string, minutes: number): GuardEvent => ({
  eventId: eventId(),
  occurredAt: minutesAgo(minutes),
  kind: "content",
  action: "blocked",
  serviceId: "openai-chatgpt",
  host: "chatgpt.com",
  port: 443,
  method: "POST",
  pathHint: "/backend-api",
  app: chrome,
  ruleId,
  ruleKind: "content",
  matchType: "au-tfn",
  matchCount: 1,
  snippet: "123***782",
  bytes: 2048,
});

const observedFlow = (service: { serviceId: string; host: string }, app: GuardEvent["app"], minutes: number): GuardEvent => ({
  eventId: eventId(),
  occurredAt: minutesAgo(minutes),
  kind: "flow",
  action: "observed",
  serviceId: service.serviceId,
  host: service.host,
  port: 443,
  method: "POST",
  app,
  bytes: 4096,
});

const storageState = (account: Account) => ({
  cookies: [
    {
      name: SESSION_COOKIE,
      value: account.sessionToken,
      domain: new URL(REGISTRY_URL).hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [],
});

const seedDevice = (agent: AgentClient, personEmail: string): SeedDevice => ({
  hostname: agent.facts.hostname,
  deviceId: agent.deviceId,
  deviceToken: agent.deviceToken,
  personEmail,
  serialNumber: agent.facts.serialNumber ?? "",
});

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the seed could not find ${what}`);
  return value;
};

export default async function globalSetup(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true });

  const adaAccount = await signUp(PEOPLE.ada);
  const graceAccount = await signUp(PEOPLE.grace);
  const boAccount = await signUp(PEOPLE.bo);
  const deeAccount = await signUp(PEOPLE.dee);
  const ada = await ConsoleClient.open(adaAccount);
  if (ada.session.role !== "admin") throw new Error(`the first sign-up should own ${ORG_DOMAIN}, got role ${ada.session.role}`);
  const directory = await ada.read(ConsolePeoplePage, "/people");

  const person = (who: { name: string; email: string }) => ({
    ...who,
    userId: required(directory.rows.find((row) => row.email === who.email)?.subject, `${who.email} in the directory`),
  });
  const people = { ada: person(PEOPLE.ada), grace: person(PEOPLE.grace), bo: person(PEOPLE.bo), dee: person(PEOPLE.dee) };
  await ada.write(ConsolePeoplePage, "POST", `/people/${encodeURIComponent(people.bo.userId)}/role`, { role: "admin" });
  const bo = await ConsoleClient.open(boAccount);
  const grace = await ConsoleClient.open(graceAccount);
  if (grace.session.handle !== ada.session.handle) throw new Error("Grace did not join Ada's organisation");

  const engineering = await ada.write(ConsoleGroupDetail, "POST", "/groups", { name: "Engineering" });
  await ada.write(ConsoleGroupDetail, "POST", `/groups/${encodeURIComponent(engineering.row.id)}/members`, { email: PEOPLE.bo.email });
  const finance = await ada.write(ConsoleGroupDetail, "POST", "/groups", { name: "Finance" });
  await ada.write(ConsoleGroupDetail, "POST", `/groups/${encodeURIComponent(finance.row.id)}/members`, { email: PEOPLE.grace.email });

  const loaded = await ada.read(GuardRulesPage, "/guard/rules");
  const rules = await ada.write(GuardRulesPage, "PUT", "/guard/rules", { baseVersion: loaded.document.version, document: RULES } satisfies GuardRulesUpdate);
  const deepseekBlock = required(rules.document.serviceRules.find((rule) => rule.serviceId === "deepseek")?.ruleId, "the DeepSeek service rule");
  const taxFileNumbers = required(rules.document.contentRules.find((rule) => rule.name === "Tax file numbers")?.ruleId, "the tax file number rule");

  const acme = await ada.write(GuardServiceRow, "POST", "/guard/services", {
    slug: "acme-ai",
    name: "Acme AI",
    vendor: "Acme",
    category: "chat",
    domains: ["ai.acme.example"],
    bundleIds: [],
    cliNames: ["acme"],
    defaultAction: "block",
  });

  const adasMbp = await enrolDevice(ada, PEOPLE.ada, "adas-mbp");
  await adasMbp.checkIn({ caTrusted: true, proxyListening: true });
  const gracesAir = await enrolDevice(ada, PEOPLE.grace, "graces-air");
  await gracesAir.checkIn({ caTrusted: false, proxyListening: true });

  const adaEvents = [taxFileNumberBlock(taxFileNumbers, 50), observedFlow({ serviceId: "openai-chatgpt", host: "chatgpt.com" }, chrome, 40)];
  const graceEvents = [
    taxFileNumberBlock(taxFileNumbers, 30),
    observedFlow({ serviceId: "anthropic-claude", host: "claude.ai" }, { bundleId: "com.anthropic.claudefordesktop", name: "Claude" }, 20),
  ];
  for (const [agent, events] of [[adasMbp, adaEvents], [gracesAir, graceEvents]] as const) {
    const uploaded = await agent.upload(events);
    if (uploaded.accepted !== events.length) throw new Error(`${agent.facts.hostname}: ${JSON.stringify(uploaded.rejected)}`);
  }
  const [adaBlocked, adaObserved] = adaEvents;
  const [graceBlocked, graceObserved] = graceEvents;

  const pending = await gracesAir.ask({ serviceId: "openai-chatgpt", ruleId: taxFileNumbers, matchType: "au-tfn", eventId: required(graceBlocked, "Grace's block").eventId, app: "Google Chrome" });
  const claudeAsk = await adasMbp.ask({ serviceId: "anthropic-claude", app: "Claude" });
  const deepseekAsk = await adasMbp.ask({ serviceId: "deepseek", app: "Google Chrome" });
  await bo.write(ConsolePolicyDecided, "POST", `/policy-requests/${encodeURIComponent(claudeAsk.request.requestId)}/approve`, { grant: { days: 7 } });
  await bo.write(ConsolePolicyDecided, "POST", `/policy-requests/${encodeURIComponent(deepseekAsk.request.requestId)}/decline`, { note: "Use the workspace" });
  const grants = await ada.read(ConsolePolicyGrantsPage, "/policy-grants");
  const approvedGrant = required(grants.grants.find((grant) => grant.requestId === claudeAsk.request.requestId)?.id, "the Claude grant");

  await ada.write(GuardEnrolLink, "POST", "/guard/devices/enrol-links", { personEmail: PEOPLE.dee.email, note: "Dee's laptop" });

  const seed: Seed = {
    handle: ada.session.handle,
    orgId: ada.session.orgId,
    orgName: ada.session.orgName,
    people,
    accounts: { ada: adaAccount, grace: graceAccount, bo: boAccount, dee: deeAccount },
    groups: { engineering: engineering.row.id, finance: finance.row.id },
    rules: { version: rules.document.version, deepseekBlock, taxFileNumbers },
    customServiceId: acme.serviceId,
    devices: { adasMbp: seedDevice(adasMbp, PEOPLE.ada.email), gracesAir: seedDevice(gracesAir, PEOPLE.grace.email) },
    events: {
      adaBlocked: required(adaBlocked, "Ada's block").eventId,
      adaObserved: required(adaObserved, "Ada's flow").eventId,
      graceBlocked: required(graceBlocked, "Grace's block").eventId,
      graceObserved: required(graceObserved, "Grace's flow").eventId,
    },
    requests: { pending: pending.request.requestId, approved: claudeAsk.request.requestId, declined: deepseekAsk.request.requestId },
    grants: { approved: approvedGrant },
  };
  writeFileSync(SEED_FILE, `${JSON.stringify(seed, null, 2)}\n`);
  writeFileSync(ADMIN_STATE, `${JSON.stringify(storageState(adaAccount), null, 2)}\n`);
  writeFileSync(MEMBER_STATE, `${JSON.stringify(storageState(graceAccount), null, 2)}\n`);
}
