// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra

export type GuardMarkSource = "simple-icons" | "lobe-icons" | "vendor";

export type GuardMarkSpec = {
  id: string;
  title: string;
  source: GuardMarkSource;
  file: string;
  license: string;
  origin: string;
  holder: string;
  hex?: string;
  extract?: { paths: number[]; viewBox: string; fill: string };
  note?: string;
};

const SI = (id: string, slug: string, title: string, hex: string, note?: string): GuardMarkSpec => ({
  id,
  title,
  source: "simple-icons",
  hex,
  file: `simple-icons/${slug}.svg`,
  license: slug === "githubcopilot" ? "MIT" : "CC0-1.0",
  holder: slug === "githubcopilot" ? "GitHub, Inc." : "Simple Icons contributors",
  origin: `npm simple-icons@16.30.0 icons/${slug}.svg`,
  ...(note === undefined ? {} : { note }),
});

const LOBE = (id: string, file: string, title: string, note?: string): GuardMarkSpec => ({
  id,
  title,
  source: "lobe-icons",
  file: `lobe-icons/${file}.svg`,
  license: "MIT",
  holder: "2023 LobeHub",
  origin: `npm @lobehub/icons-static-svg@1.95.1 icons/${file}.svg`,
  ...(note === undefined ? {} : { note }),
});

const BROWSER = (id: string, title: string, pkg: string, version: string, owner: string): GuardMarkSpec => ({
  id,
  title,
  source: "vendor",
  file: `vendor/${id}.svg`,
  license: "LicenseRef-Nominative-Use",
  holder: `${owner} (the mark's owner)`,
  origin: `npm @browser-logos/${pkg}@${version} ${pkg}.svg (github.com/alrra/browser-logos src/${pkg})`,
  note: "the browser's full-colour logo; Simple Icons carries only a single-colour path",
});

const READ = "read 16 Oct 2026";

export const GUARD_MARK_SPECS: readonly GuardMarkSpec[] = [
  SI("claude", "claude", "Claude", "#D97757"),
  SI("anthropic", "anthropic", "Anthropic", "#191919"),
  SI("notebooklm", "notebooklm", "NotebookLM", "#000000"),
  SI("github-copilot", "githubcopilot", "GitHub Copilot", "#000000", "this one icon is MIT (Primer octicons), per simple-icons' own data"),
  SI("cursor", "cursor", "Cursor", "#000000"),
  SI("windsurf", "windsurf", "Windsurf", "#0B100F"),
  SI("perplexity", "perplexity", "Perplexity", "#1FB8CD"),
  SI("deepseek", "deepseek", "DeepSeek", "#5786FE"),
  SI("openrouter", "openrouter", "OpenRouter", "#94A3B8"),
  SI("grammarly", "grammarly", "Grammarly", "#027E6F"),
  SI("elevenlabs", "elevenlabs", "ElevenLabs", "#000000"),
  SI("replit", "replit", "Replit", "#F26207"),
  SI("v0", "v0", "v0", "#000000"),
  SI("kimi", "kimi", "Kimi", "#000000"),
  SI("jetbrains", "jetbrains", "JetBrains", "#000000"),
  SI("zed", "zedindustries", "Zed", "#084CCF"),
  SI("warp", "warp", "Warp", "#01A4FF"),
  SI("raycast", "raycast", "Raycast", "#FF6363"),
  SI("safari", "safari", "Safari", "#006CFF"),
  SI("arc", "arc", "Arc", "#FCBFBD"),
  SI("iterm2", "iterm2", "iTerm2", "#000000"),
  LOBE("openai", "openai", "OpenAI", "Simple Icons removed OpenAI's mark; Lobe's monochrome Blossom"),
  LOBE("codex", "codex-color", "Codex"),
  LOBE("google-gemini", "gemini-color", "Google Gemini", "Gemini's own four-colour gradient spark (Simple Icons has a single purple path)"),
  LOBE("mistral", "mistral-color", "Mistral AI", "Mistral's own five-stripe colours"),
  LOBE("meta-ai", "metaai-color", "Meta AI", "Meta AI's own gradient ring"),
  LOBE("hugging-face", "huggingface-color", "Hugging Face", "the full-colour face"),
  LOBE("poe", "poe-color", "Poe", "the gradient bubble; its outline is the vendor's currentColor ink"),
  LOBE("qwen", "qwen-color", "Qwen", "Qwen's own gradient"),
  LOBE("vertex-ai", "vertexai-color", "Vertex AI"),
  LOBE("microsoft-copilot", "copilot-color", "Microsoft Copilot"),
  LOBE("azure-ai", "azureai-color", "Azure AI"),
  LOBE("amazon-bedrock", "bedrock-color", "Amazon Bedrock"),
  LOBE("grok", "grok", "Grok"),
  LOBE("groq", "groq", "Groq"),
  LOBE("cohere", "cohere-color", "Cohere"),
  LOBE("brave", "brave-color", "Brave", "the lion in Brave's own orange gradient"),
  LOBE("together-ai", "together-color", "Together AI"),
  LOBE("midjourney", "midjourney", "Midjourney"),
  LOBE("stability-ai", "stability-color", "Stability AI"),
  LOBE("lovable", "lovable-color", "Lovable"),
  LOBE("devin", "devin-color", "Devin"),
  LOBE("manus", "manus", "Manus"),
  {
    id: "character-ai",
    title: "Character.AI",
    source: "vendor",
    file: "vendor/character-ai.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Character.AI (the mark's owner)",
    origin: `https://character.ai/icon.svg (${READ})`,
  },
  {
    id: "you-com",
    title: "You.com",
    source: "vendor",
    file: "vendor/you-com-lockup.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "You.com (the mark's owner)",
    origin: `https://you.com — the header logo (<a aria-label="You.com home">), inline SVG (${READ})`,
    extract: { paths: [0, 1], viewBox: "0 0 28 28", fill: "currentColor" },
    note: "the symbol's two paths taken unaltered from the vendor's lockup (the wordmark path left out); You.com uses this symbol alone as its favicon and app icon; the site paints it with its theme ink (class asfgmu2 → fill: var(--…)), so it is drawn in ink",
  },
  {
    id: "jasper",
    title: "Jasper",
    source: "vendor",
    file: "vendor/jasper.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Jasper (the mark's owner)",
    origin: `https://www.jasper.ai/brand → "Jasper Logo (2025).svg" (hubspotusercontent) (${READ})`,
    note: "Jasper's 2025 identity is a wordmark only (no symbol is published), so the tile shows the wordmark",
  },
  {
    id: "otter-ai",
    title: "Otter.ai",
    source: "vendor",
    file: "vendor/otter-ai.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Otter.ai (the mark's owner)",
    origin: `https://otter.ai — the header logo (.nav_logo), inline SVG (${READ})`,
  },
  {
    id: "fireflies",
    title: "Fireflies.ai",
    source: "vendor",
    file: "vendor/fireflies.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Fireflies.ai (the mark's owner)",
    origin: `https://fireflies.ai/_next/static/media/logo.4ae482a6.svg (${READ})`,
  },
  {
    id: "bolt",
    title: "Bolt",
    source: "vendor",
    file: "vendor/bolt.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Bolt (the mark's owner)",
    origin: `https://bolt.new/static/favicon.svg (${READ})`,
  },
  {
    id: "amazon-q",
    title: "Amazon Q",
    source: "vendor",
    file: "vendor/amazon-q.svg",
    license: "Apache-2.0",
    holder: "Amazon.com, Inc. or its affiliates",
    origin: "github.com/aws/aws-toolkit-vscode packages/core/resources/icons/aws/amazonq/q-gradient.svg (AWS's own repository, Apache-2.0)",
  },
  BROWSER("google-chrome", "Google Chrome", "chrome", "2.0.0", "Google LLC"),
  BROWSER("firefox", "Firefox", "firefox", "3.0.10", "Mozilla Foundation"),
  BROWSER("microsoft-edge", "Microsoft Edge", "edge", "2.0.7", "Microsoft Corporation"),
  BROWSER("opera", "Opera", "opera", "1.1.11", "Opera Norway AS"),
  {
    id: "vscode",
    title: "Visual Studio Code",
    source: "vendor",
    file: "vendor/vscode.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Microsoft Corporation (the mark's owner)",
    origin: "https://code.visualstudio.com/brand → visual-studio-code-icons.zip vscode.svg (version 2021-06-21)",
    note: "the brand page permits the icon to refer to VS Code and forbids lock-ups with another brand",
  },
  {
    id: "slack",
    title: "Slack",
    source: "vendor",
    file: "vendor/slack.svg",
    license: "LicenseRef-Nominative-Use",
    holder: "Slack Technologies, LLC (the mark's owner)",
    origin: `https://slack.com/media-kit → https://a.slack-edge.com/9cc0056/marketing/img/nav/logo.svg (${READ})`,
    note: "Slack asked Simple Icons to remove its mark; DECISIONS.md connect-24 allows a Slack mark only from Slack's own kit — this is Slack's own file, shown on an app row only",
  },
  {
    id: "chromium",
    title: "Chromium",
    source: "vendor",
    file: "vendor/chromium.svg",
    license: "BSD-3-Clause",
    holder: "The Chromium Authors",
    origin: "chromium.googlesource.com chromium/src chrome/app/theme/chromium/product_logo.svg (The Chromium Authors, BSD-3-Clause)",
  },
];

export const GUARD_SERVICES_WITHOUT_MARK: Readonly<Record<string, string>> = {
  quillbot:
    "QuillBot is in neither Simple Icons nor Lobe Icons, and quillbot.com answers every request (the page, /favicon.ico, the help centre) with a Cloudflare challenge, which we do not work around. A neutral glyph stands in until the founder supplies QuillBot's file.",
};


export type GuardAppMarkRow = { markId: string | null; bundleIds: string[]; names: string[]; reason?: string };

export const GUARD_APP_MARKS: readonly GuardAppMarkRow[] = [
  { markId: "google-chrome", bundleIds: ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary"], names: ["Google Chrome", "Chrome"] },
  { markId: "safari", bundleIds: ["com.apple.Safari", "com.apple.SafariTechnologyPreview"], names: ["Safari"] },
  { markId: "firefox", bundleIds: ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly"], names: ["Firefox", "Mozilla Firefox"] },
  { markId: "microsoft-edge", bundleIds: ["com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev"], names: ["Microsoft Edge", "Edge"] },
  { markId: "opera", bundleIds: ["com.operasoftware.Opera"], names: ["Opera"] },
  { markId: "brave", bundleIds: ["com.brave.Browser"], names: ["Brave", "Brave Browser"] },
  { markId: "arc", bundleIds: ["company.thebrowser.Browser"], names: ["Arc"] },
  { markId: "chromium", bundleIds: ["org.chromium.Chromium"], names: ["Chromium", "Chromium (headless)"] },
  { markId: "perplexity", bundleIds: [], names: ["Comet"] },
  { markId: "iterm2", bundleIds: ["com.googlecode.iterm2"], names: ["iTerm2", "iTerm"] },
  { markId: "warp", bundleIds: [], names: ["Warp"] },
  { markId: "vscode", bundleIds: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"], names: ["Visual Studio Code", "VS Code", "Code"] },
  { markId: "slack", bundleIds: ["com.tinyspeck.slackmacgap"], names: ["Slack"] },
  { markId: "openai", bundleIds: [], names: ["ChatGPT"] },
  { markId: "jetbrains", bundleIds: ["com.jetbrains.intellij", "com.jetbrains.intellij.ce", "com.jetbrains.pycharm", "com.jetbrains.WebStorm", "com.jetbrains.goland"], names: ["IntelliJ IDEA", "PyCharm", "WebStorm", "GoLand"] },
  {
    markId: null,
    bundleIds: ["com.apple.Terminal"],
    names: ["Terminal"],
    reason:
      "Apple publishes no SVG of Terminal's icon and none of the three sources carries one. The Mac app shows the real icon from the system (NSWorkspace); the console and the block page show the neutral terminal glyph.",
  },
];

export type GuardMarkHandling = "brand" | "ink" | "brand-ink" | "light-tile";

export type GuardMark = {
  id: string;
  title: string;
  source: GuardMarkSource;
  license: string;
  light: string;
  dark?: string;
  handling: { light: GuardMarkHandling; dark: GuardMarkHandling };
  wide?: true;
  contrast: { light: [number, number]; dark: [number, number] };
};

export const GUARD_MARK_ID_PREFIX = "gmid_";

export type GuardMarkIndex = {
  byBundleId: Record<string, string>;
  byName: Record<string, string>;
  byCli: Record<string, string>;
  byService: Record<string, string>;
};

