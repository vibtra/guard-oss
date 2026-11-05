// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GUARD_SERVICE_ID } from "./ids.js";

export const GUARD_SERVICE_CATEGORIES = [
  "chat",
  "api",
  "coding",
  "search",
  "writing",
  "image",
  "audio",
  "meeting",
  "agent",
  "cloud",
  "notebook",
] as const;
export const GuardServiceCategory = z.enum(GUARD_SERVICE_CATEGORIES);
export type GuardServiceCategory = z.infer<typeof GuardServiceCategory>;

export const GUARD_FLOW_ACTIONS = ["allow", "block", "ask"] as const;
export const GuardFlowAction = z.enum(GUARD_FLOW_ACTIONS);
export type GuardFlowAction = z.infer<typeof GuardFlowAction>;

export const GuardHostPattern = z
  .string()
  .min(3)
  .max(253)
  .regex(/^(?:[a-z0-9*](?:[a-z0-9*-]{0,61}[a-z0-9*])?\.)+[a-z]{2,63}$/, "a lower-case host pattern (optional `*` labels)");

export const GuardService = z
  .object({
    serviceId: GUARD_SERVICE_ID,
    name: z.string().min(1).max(80),
    vendor: z.string().min(1).max(80),
    category: GuardServiceCategory,
    domains: z.array(GuardHostPattern).min(1).max(40),
    bundleIds: z.array(z.string().min(1).max(200)).max(10).default([]),
    cliNames: z.array(z.string().min(1).max(60)).max(10).default([]),
    defaultAction: GuardFlowAction.optional(),
    docsUrl: z.string().url().optional(),
    note: z.string().max(400).optional(),
    markId: z.string().regex(/^[a-z0-9-]{1,60}$/).optional(),
    custom: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .strict();
export type GuardService = z.infer<typeof GuardService>;
export type GuardServiceInput = z.input<typeof GuardService>;

export const GuardCatalogue = z
  .object({
    version: z.string().min(1).max(80),
    generatedAt: z.string().min(10).max(40),
    services: z.array(GuardService).max(500),
  })
  .strict();
export type GuardCatalogue = z.infer<typeof GuardCatalogue>;

export const GUARD_CATALOGUE_SEED_VERSION = "2026-10-17";

const VERIFIED_MAC = "bundleIds verified on a Mac, 16 Oct 2026 (Info.plist)";
const UNVERIFIED = "bundleIds from public app metadata, unverified";

export const GUARD_CATALOGUE_SEED: readonly GuardServiceInput[] = [
  {
    serviceId: "openai-chatgpt",
    markId: "openai",
    name: "ChatGPT",
    vendor: "OpenAI",
    category: "chat",
    domains: ["chatgpt.com", "chat.openai.com", "sora.chatgpt.com"],
    bundleIds: ["com.openai.chat"],
    cliNames: [],
    docsUrl: "https://chatgpt.com",
    note: UNVERIFIED,
  },
  {
    serviceId: "openai-api",
    markId: "openai",
    name: "OpenAI API",
    vendor: "OpenAI",
    category: "api",
    domains: ["api.openai.com", "platform.openai.com"],
    bundleIds: [],
    cliNames: ["openai"],
    docsUrl: "https://platform.openai.com/docs",
  },
  {
    serviceId: "openai-codex",
    markId: "codex",
    name: "Codex",
    vendor: "OpenAI",
    category: "coding",
    domains: ["chatgpt.com", "api.openai.com"],
    bundleIds: ["com.openai.codex"],
    cliNames: ["codex"],
    docsUrl: "https://developers.openai.com/codex",
    note: `${UNVERIFIED}; shares ChatGPT's and the API's hosts, so a flow rule on this row is matched by app, not host`,
  },
  {
    serviceId: "anthropic-claude",
    markId: "claude",
    name: "Claude",
    vendor: "Anthropic",
    category: "chat",
    domains: ["claude.ai"],
    bundleIds: ["com.anthropic.claudefordesktop"],
    cliNames: ["claude"],
    docsUrl: "https://claude.ai",
    note: `${VERIFIED_MAC}; the \`claude\` CLI is Claude Code — its model traffic (api.anthropic.com) is the Anthropic API row`,
  },
  {
    serviceId: "anthropic-api",
    markId: "anthropic",
    name: "Anthropic API",
    vendor: "Anthropic",
    category: "api",
    domains: ["api.anthropic.com", "console.anthropic.com", "statsig.anthropic.com"],
    bundleIds: [],
    cliNames: [],
    docsUrl: "https://docs.anthropic.com",
  },
  {
    serviceId: "google-gemini",
    markId: "google-gemini",
    name: "Gemini",
    vendor: "Google",
    category: "chat",
    domains: ["gemini.google.com", "generativelanguage.googleapis.com", "aistudio.google.com"],
    bundleIds: [],
    cliNames: ["gemini"],
    docsUrl: "https://ai.google.dev",
    note: "the `gemini` CLI is Google's Gemini CLI (generativelanguage.googleapis.com, or a Vertex endpoint)",
  },
  {
    serviceId: "google-notebooklm",
    markId: "notebooklm",
    name: "NotebookLM",
    vendor: "Google",
    category: "notebook",
    domains: ["notebooklm.google.com"],
    docsUrl: "https://notebooklm.google.com",
  },
  {
    serviceId: "google-vertex-ai",
    markId: "vertex-ai",
    name: "Vertex AI",
    vendor: "Google Cloud",
    category: "cloud",
    domains: ["aiplatform.googleapis.com", "*-aiplatform.googleapis.com"],
    docsUrl: "https://cloud.google.com/vertex-ai/docs",
  },
  {
    serviceId: "microsoft-copilot",
    markId: "microsoft-copilot",
    name: "Microsoft Copilot",
    vendor: "Microsoft",
    category: "chat",
    domains: ["copilot.microsoft.com", "copilot.cloud.microsoft", "m365.cloud.microsoft", "sydney.bing.com"],
    bundleIds: ["com.microsoft.copilot"],
    docsUrl: "https://copilot.microsoft.com",
    note: `${UNVERIFIED}; Copilot inside Office apps rides the Microsoft 365 hosts and is not separable by host`,
  },
  {
    serviceId: "azure-openai",
    markId: "azure-ai",
    name: "Azure OpenAI",
    vendor: "Microsoft",
    category: "cloud",
    domains: ["*.openai.azure.com"],
    docsUrl: "https://learn.microsoft.com/azure/ai-services/openai/",
  },
  {
    serviceId: "github-copilot",
    markId: "github-copilot",
    name: "GitHub Copilot",
    vendor: "GitHub",
    category: "coding",
    domains: ["api.githubcopilot.com", "copilot-proxy.githubusercontent.com", "copilot-telemetry.githubusercontent.com", "api.individual.githubcopilot.com", "api.business.githubcopilot.com"],
    bundleIds: [],
    cliNames: ["copilot"],
    docsUrl: "https://docs.github.com/copilot",
    note: "an editor extension (no app of its own); `copilot` is the GitHub Copilot CLI",
  },
  {
    serviceId: "cursor",
    markId: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    category: "coding",
    domains: ["cursor.com", "cursor.sh", "api2.cursor.sh", "api3.cursor.sh", "repo42.cursor.sh"],
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
    cliNames: ["cursor-agent"],
    docsUrl: "https://docs.cursor.com",
    note: `${VERIFIED_MAC}; the bundle id is ToDesktop's, which is how Cursor ships`,
  },
  {
    serviceId: "windsurf",
    markId: "windsurf",
    name: "Windsurf",
    vendor: "Codeium",
    category: "coding",
    domains: ["windsurf.com", "codeium.com", "server.codeium.com", "inference.codeium.com"],
    bundleIds: ["com.exafunction.windsurf"],
    docsUrl: "https://docs.windsurf.com",
    note: UNVERIFIED,
  },
  {
    serviceId: "amazon-q",
    markId: "amazon-q",
    name: "Amazon Q Developer",
    vendor: "Amazon Web Services",
    category: "coding",
    domains: ["q.*.amazonaws.com", "codewhisperer.*.amazonaws.com"],
    bundleIds: ["com.amazon.codewhisperer"],
    cliNames: ["q", "kiro-cli"],
    docsUrl: "https://docs.aws.amazon.com/amazonq/",
    note: UNVERIFIED,
  },
  {
    serviceId: "amazon-bedrock",
    markId: "amazon-bedrock",
    name: "Amazon Bedrock",
    vendor: "Amazon Web Services",
    category: "cloud",
    domains: ["bedrock-runtime.*.amazonaws.com", "bedrock.*.amazonaws.com", "bedrock-agent-runtime.*.amazonaws.com"],
    docsUrl: "https://docs.aws.amazon.com/bedrock/",
  },
  {
    serviceId: "perplexity",
    markId: "perplexity",
    name: "Perplexity",
    vendor: "Perplexity AI",
    category: "search",
    domains: ["perplexity.ai", "api.perplexity.ai", "pplx.ai"],
    bundleIds: ["ai.perplexity.mac", "ai.perplexity.comet"],
    docsUrl: "https://www.perplexity.ai",
    note: `${UNVERIFIED}; the second id is the Comet browser`,
  },
  {
    serviceId: "mistral",
    markId: "mistral",
    name: "Mistral Le Chat",
    vendor: "Mistral AI",
    category: "chat",
    domains: ["chat.mistral.ai", "api.mistral.ai", "console.mistral.ai"],
    docsUrl: "https://docs.mistral.ai",
  },
  {
    serviceId: "deepseek",
    markId: "deepseek",
    name: "DeepSeek",
    vendor: "DeepSeek",
    category: "chat",
    domains: ["chat.deepseek.com", "api.deepseek.com", "platform.deepseek.com"],
    docsUrl: "https://api-docs.deepseek.com",
    note: "data is processed in the PRC under the vendor's terms; many organisations block this row by default",
  },
  {
    serviceId: "xai-grok",
    markId: "grok",
    name: "Grok",
    vendor: "xAI",
    category: "chat",
    domains: ["grok.com", "api.x.ai", "console.x.ai"],
    bundleIds: ["ai.x.grok"],
    docsUrl: "https://docs.x.ai",
    note: `${UNVERIFIED}; Grok inside X rides x.com and is not separable by host`,
  },
  {
    serviceId: "meta-ai",
    markId: "meta-ai",
    name: "Meta AI",
    vendor: "Meta",
    category: "chat",
    domains: ["meta.ai"],
    docsUrl: "https://www.meta.ai",
  },
  {
    serviceId: "cohere",
    markId: "cohere",
    name: "Cohere",
    vendor: "Cohere",
    category: "api",
    domains: ["api.cohere.com", "api.cohere.ai", "dashboard.cohere.com", "coral.cohere.com"],
    docsUrl: "https://docs.cohere.com",
  },
  {
    serviceId: "huggingface",
    markId: "hugging-face",
    name: "Hugging Face",
    vendor: "Hugging Face",
    category: "api",
    domains: ["huggingface.co", "api-inference.huggingface.co", "router.huggingface.co", "hf.co"],
    docsUrl: "https://huggingface.co/docs",
    note: "the Hub (model downloads) and the inference API share these hosts",
  },
  {
    serviceId: "groq",
    markId: "groq",
    name: "Groq",
    vendor: "Groq",
    category: "api",
    domains: ["api.groq.com", "console.groq.com", "groq.com"],
    docsUrl: "https://console.groq.com/docs",
  },
  {
    serviceId: "together-ai",
    markId: "together-ai",
    name: "Together AI",
    vendor: "Together AI",
    category: "api",
    domains: ["api.together.xyz", "api.together.ai", "together.ai"],
    docsUrl: "https://docs.together.ai",
  },
  {
    serviceId: "openrouter",
    markId: "openrouter",
    name: "OpenRouter",
    vendor: "OpenRouter",
    category: "api",
    domains: ["openrouter.ai"],
    docsUrl: "https://openrouter.ai/docs",
  },
  {
    serviceId: "poe",
    markId: "poe",
    name: "Poe",
    vendor: "Quora",
    category: "chat",
    domains: ["poe.com"],
    bundleIds: ["com.quora.app.Poe"],
    docsUrl: "https://poe.com",
    note: UNVERIFIED,
  },
  {
    serviceId: "character-ai",
    markId: "character-ai",
    name: "Character.AI",
    vendor: "Character Technologies",
    category: "chat",
    domains: ["character.ai", "beta.character.ai"],
    docsUrl: "https://character.ai",
  },
  {
    serviceId: "you-com",
    markId: "you-com",
    name: "You.com",
    vendor: "You.com",
    category: "search",
    domains: ["you.com", "api.you.com"],
    docsUrl: "https://you.com",
  },
  {
    serviceId: "jasper",
    markId: "jasper",
    name: "Jasper",
    vendor: "Jasper AI",
    category: "writing",
    domains: ["app.jasper.ai", "jasper.ai"],
    docsUrl: "https://www.jasper.ai",
  },
  {
    serviceId: "grammarly",
    markId: "grammarly",
    name: "Grammarly",
    vendor: "Grammarly",
    category: "writing",
    domains: ["grammarly.com", "app.grammarly.com", "api.grammarly.com"],
    bundleIds: ["com.grammarly.ProjectLlama"],
    docsUrl: "https://www.grammarly.com",
    note: `${UNVERIFIED}; the desktop app sends every field it is typing in`,
  },
  {
    serviceId: "quillbot",
    name: "QuillBot",
    vendor: "Learneo",
    category: "writing",
    domains: ["quillbot.com"],
    docsUrl: "https://quillbot.com",
  },
  {
    serviceId: "midjourney",
    markId: "midjourney",
    name: "Midjourney",
    vendor: "Midjourney",
    category: "image",
    domains: ["midjourney.com"],
    docsUrl: "https://docs.midjourney.com",
    note: "the Discord path is not catalogued (discord.com is not an AI host)",
  },
  {
    serviceId: "stability-ai",
    markId: "stability-ai",
    name: "Stability AI",
    vendor: "Stability AI",
    category: "image",
    domains: ["api.stability.ai", "platform.stability.ai", "dreamstudio.ai", "stability.ai"],
    docsUrl: "https://platform.stability.ai/docs",
  },
  {
    serviceId: "elevenlabs",
    markId: "elevenlabs",
    name: "ElevenLabs",
    vendor: "ElevenLabs",
    category: "audio",
    domains: ["elevenlabs.io", "api.elevenlabs.io"],
    docsUrl: "https://elevenlabs.io/docs",
  },
  {
    serviceId: "otter-ai",
    markId: "otter-ai",
    name: "Otter.ai",
    vendor: "Otter.ai",
    category: "meeting",
    domains: ["otter.ai"],
    bundleIds: ["com.aisense.otter"],
    docsUrl: "https://otter.ai",
    note: UNVERIFIED,
  },
  {
    serviceId: "fireflies",
    markId: "fireflies",
    name: "Fireflies.ai",
    vendor: "Fireflies.ai",
    category: "meeting",
    domains: ["fireflies.ai", "app.fireflies.ai", "api.fireflies.ai"],
    docsUrl: "https://fireflies.ai",
  },
  {
    serviceId: "replit",
    markId: "replit",
    name: "Replit Agent",
    vendor: "Replit",
    category: "agent",
    domains: ["replit.com"],
    docsUrl: "https://docs.replit.com",
    note: "the whole Replit product, not the agent alone: a block here blocks Replit",
  },
  {
    serviceId: "lovable",
    markId: "lovable",
    name: "Lovable",
    vendor: "Lovable",
    category: "agent",
    domains: ["lovable.dev"],
    docsUrl: "https://docs.lovable.dev",
  },
  {
    serviceId: "bolt-new",
    markId: "bolt",
    name: "Bolt",
    vendor: "StackBlitz",
    category: "agent",
    domains: ["bolt.new"],
    docsUrl: "https://bolt.new",
  },
  {
    serviceId: "vercel-v0",
    markId: "v0",
    name: "v0",
    vendor: "Vercel",
    category: "agent",
    domains: ["v0.dev", "v0.app"],
    docsUrl: "https://v0.app/docs",
  },
  {
    serviceId: "devin",
    markId: "devin",
    name: "Devin",
    vendor: "Cognition",
    category: "agent",
    domains: ["devin.ai", "app.devin.ai"],
    docsUrl: "https://docs.devin.ai",
  },
  {
    serviceId: "manus",
    markId: "manus",
    name: "Manus",
    vendor: "Butterfly Effect",
    category: "agent",
    domains: ["manus.im"],
    docsUrl: "https://manus.im",
  },
  {
    serviceId: "moonshot-kimi",
    markId: "kimi",
    name: "Kimi",
    vendor: "Moonshot AI",
    category: "chat",
    domains: ["kimi.com", "kimi.moonshot.cn", "api.moonshot.cn", "api.moonshot.ai"],
    docsUrl: "https://platform.moonshot.ai",
    note: "data is processed in the PRC under the vendor's terms",
  },
  {
    serviceId: "alibaba-qwen",
    markId: "qwen",
    name: "Qwen",
    vendor: "Alibaba Cloud",
    category: "chat",
    domains: ["chat.qwen.ai", "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
    docsUrl: "https://www.alibabacloud.com/help/model-studio",
  },
  {
    serviceId: "jetbrains-ai",
    markId: "jetbrains",
    name: "JetBrains AI Assistant",
    vendor: "JetBrains",
    category: "coding",
    domains: ["api.jetbrains.ai"],
    docsUrl: "https://www.jetbrains.com/ai/",
    note: "an IDE feature; the IDEs' own bundle ids are not listed because the IDE is not the AI service",
  },
  {
    serviceId: "zed-ai",
    markId: "zed",
    name: "Zed AI",
    vendor: "Zed Industries",
    category: "coding",
    domains: ["cloud.zed.dev", "collab.zed.dev", "llm.zed.dev"],
    bundleIds: ["dev.zed.Zed"],
    docsUrl: "https://zed.dev/docs/ai/overview",
    note: UNVERIFIED,
  },
  {
    serviceId: "warp-ai",
    markId: "warp",
    name: "Warp AI",
    vendor: "Warp",
    category: "coding",
    domains: ["app.warp.dev"],
    bundleIds: ["dev.warp.Warp-Stable"],
    docsUrl: "https://docs.warp.dev/agents",
    note: `${UNVERIFIED}; Warp's sync and telemetry share this host, so a block here degrades the terminal`,
  },
  {
    serviceId: "raycast-ai",
    markId: "raycast",
    name: "Raycast AI",
    vendor: "Raycast",
    category: "chat",
    domains: ["backend.raycast.com"],
    bundleIds: ["com.raycast.macos"],
    docsUrl: "https://manual.raycast.com/ai",
    note: `${UNVERIFIED}; Raycast's whole backend, not AI alone`,
  },
];

export const normaliseHost = (host: string): string => {
  const noPort = host.includes(":") && !host.startsWith("[") ? host.slice(0, host.indexOf(":")) : host;
  return noPort.toLowerCase().replace(/\.$/, "");
};

const patternRegexes = new Map<string, RegExp>();
const regexFor = (pattern: string): RegExp => {
  let re = patternRegexes.get(pattern);
  if (re === undefined) {
    const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[a-z0-9-]+");
    re = new RegExp(`^${escaped}$`);
    patternRegexes.set(pattern, re);
  }
  return re;
};

export const hostMatchesPattern = (host: string, pattern: string): boolean => {
  const h = normaliseHost(host);
  if (h === "") return false;
  if (!pattern.includes("*")) return h === pattern || h.endsWith(`.${pattern}`);
  return regexFor(pattern).test(h);
};

export const serviceForHost = (catalogue: Pick<GuardCatalogue, "services">, host: string): GuardService | undefined => {
  let best: { service: GuardService; length: number } | undefined;
  for (const service of catalogue.services) {
    if (!service.enabled) continue;
    for (const pattern of service.domains) {
      if (hostMatchesPattern(host, pattern) && (best === undefined || pattern.length > best.length)) best = { service, length: pattern.length };
    }
  }
  return best?.service;
};

export const serviceForFlow = (
  catalogue: Pick<GuardCatalogue, "services">,
  flow: { host: string; bundleId?: string | undefined; cliName?: string | undefined },
): GuardService | undefined => {
  const byHost = serviceForHost(catalogue, flow.host);
  if (byHost === undefined) return undefined;
  for (const service of catalogue.services) {
    const owns = (flow.bundleId !== undefined && service.bundleIds.includes(flow.bundleId)) || (flow.cliName !== undefined && service.cliNames.includes(flow.cliName));
    if (owns && service.domains.some((p) => hostMatchesPattern(flow.host, p))) return service.enabled ? service : undefined;
  }
  return byHost;
};

export const isInterceptedHost = (catalogue: Pick<GuardCatalogue, "services">, host: string): boolean => serviceForHost(catalogue, host) !== undefined;

export const seedCatalogue = (generatedAt = `${GUARD_CATALOGUE_SEED_VERSION}T00:00:00.000Z`): GuardCatalogue =>
  GuardCatalogue.parse({ version: GUARD_CATALOGUE_SEED_VERSION, generatedAt, services: GUARD_CATALOGUE_SEED });

export const GuardServiceOverride = z
  .object({
    serviceId: GUARD_SERVICE_ID,
    enabled: z.boolean().optional(),
    defaultAction: GuardFlowAction.optional(),
    custom: GuardService.omit({ custom: true }).optional(),
  })
  .strict();
export type GuardServiceOverride = z.infer<typeof GuardServiceOverride>;

export const applyCatalogueOverrides = (
  seed: GuardCatalogue,
  overrides: readonly GuardServiceOverride[],
  overridesVersion: number,
  generatedAt: string,
): GuardCatalogue => {
  const byId = new Map(overrides.map((o) => [o.serviceId, o] as const));
  const services: GuardService[] = seed.services.map((s) => {
    const o = byId.get(s.serviceId);
    if (o === undefined) return s;
    return { ...s, ...(o.enabled === undefined ? {} : { enabled: o.enabled }), ...(o.defaultAction === undefined ? {} : { defaultAction: o.defaultAction }) };
  });
  for (const o of overrides) {
    if (o.custom !== undefined && !seed.services.some((s) => s.serviceId === o.serviceId)) {
      services.push(GuardService.parse({ ...o.custom, serviceId: o.serviceId, custom: true, ...(o.enabled === undefined ? {} : { enabled: o.enabled }), ...(o.defaultAction === undefined ? {} : { defaultAction: o.defaultAction }) }));
    }
  }
  return { version: overridesVersion === 0 ? seed.version : `${seed.version}+org.${overridesVersion}`, generatedAt, services };
};
