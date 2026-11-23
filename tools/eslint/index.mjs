import css from "@eslint/css";
import reactHooks from "eslint-plugin-react-hooks";
import xo from "./vendor/eslint-config-xo/index.js";
import noComments from "./rules/no-comments.mjs";
import noPaletteColour from "./rules/no-palette-colour.mjs";
import noRawColour from "./rules/no-raw-colour.mjs";
import disabled from "./disabled-at-import.json" with { type: "json" };
import guardrailAllowlist from "./guardrails.json" with { type: "json" };
import { noEnvelopePrefixLiteral, noKeyMaterial, noOrgLockedTxCast, noProcessEnv } from "./rules/guardrails.mjs";

const OTHER_LANGUAGES = new Set(["xo/json", "xo/json5", "xo/jsonc", "xo/package-json", "xo/html", "xo/markdown", "xo/css"]);

export const scriptFiles = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

export const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];

export const plugin = {
  meta: { name: "@vibtra/eslint-config" },
  rules: {
    "no-comments": noComments,
    "no-palette-colour": noPaletteColour,
    "no-raw-colour": noRawColour,
    "no-key-material": noKeyMaterial,
    "no-process-env": noProcessEnv,
    "no-envelope-prefix-literal": noEnvelopePrefixLiteral,
    "no-org-locked-tx-cast": noOrgLockedTxCast,
  },
};

export const vendored = xo({ space: 2 }).filter((config) => !OTHER_LANGUAGES.has(config.name));

export const browser = (files) => {
  const base = xo({ space: 2, browser: true }).find((config) => config.name === "xo/base");
  return {
    name: "vibtra/browser",
    files,
    languageOptions: { globals: base.languageOptions.globals },
    rules: {
      "no-restricted-globals": base.rules["no-restricted-globals"],
      "unicorn/no-unnecessary-global-this": base.rules["unicorn/no-unnecessary-global-this"],
    },
  };
};

export const typescript = {
  name: "vibtra/typescript-without-type-information",
  files: typescriptFiles,
  languageOptions: { parserOptions: { projectService: false } },
};

export const reactHooksFor = (files) => ({
  name: "vibtra/react-hooks",
  files,
  plugins: { "react-hooks": reactHooks },
  rules: {
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "error",
  },
});

export const colourFences = ({ scripts, styles, tokens }) => [
  {
    name: "vibtra/colour-fences",
    files: scripts,
    plugins: { vibtra: plugin },
    rules: { "vibtra/no-palette-colour": "error", "vibtra/no-raw-colour": "error" },
  },
  {
    name: "vibtra/colour-fences-css",
    files: styles,
    language: "css/css",
    plugins: { css, vibtra: plugin },
    rules: { "vibtra/no-palette-colour": "error", "vibtra/no-raw-colour": "error" },
  },
  {
    name: "vibtra/colour-tokens",
    files: tokens.files,
    rules: { "vibtra/no-raw-colour": ["error", { tokenPrefix: tokens.prefix }] },
  },
];

export const disabledRules = [
  ...Object.keys(disabled.violations),
  ...Object.keys(disabled.violationsAfterCommentRemoval),
  ...disabled.needsTypeInformation,
];

export const disabledAtImport = [
  {
    name: "vibtra/disabled-at-import",
    files: scriptFiles,
    rules: Object.fromEntries(disabledRules.map((rule) => [rule, "off"])),
  },
  ...(disabled.unusedDisableDirectives.length > 0
    ? [
        {
          name: "vibtra/disabled-at-import-directives",
          files: disabled.unusedDisableDirectives,
          linterOptions: { reportUnusedDisableDirectives: "off" },
        },
      ]
    : []),
];

export const fenceRules = [
  "vibtra/no-palette-colour",
  "vibtra/no-raw-colour",
];

export const inlineDisableGuard = {
  name: "vibtra/no-inline-disable-of-vibtra-rules",
  files: scriptFiles,
  rules: { "@eslint-community/eslint-comments/no-restricted-disable": ["error", "vibtra/*", "@eslint-community/eslint-comments/*"] },
};

export const comments = {
  name: "vibtra/no-comments",
  files: scriptFiles,
  plugins: { vibtra: plugin },
  rules: { "vibtra/no-comments": "error" },
};

export const guardrailRules = Object.keys(guardrailAllowlist).filter((rule) => rule.startsWith("vibtra/"));

export const guardrailsFrom = (allowlist) =>
  Object.entries(allowlist)
    .filter(([rule]) => rule.startsWith("vibtra/"))
    .flatMap(([rule, { scope, allow }]) => {
      for (const entry of allow) {
        if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
          throw new Error(`tools/eslint/guardrails.json: the ${rule} allow entry for ${entry.files.join(", ")} has no reason. Write why the file may break the rule.`);
        }
      }
      const name = rule.slice("vibtra/".length);
      return [
        {
          name: `vibtra/guardrail:${name}`,
          files: scope,
          ignores: allow.filter((entry) => entry.only === undefined).flatMap((entry) => entry.files),
          plugins: { vibtra: plugin },
          rules: { [rule]: "error" },
        },
        ...allow
          .filter((entry) => entry.only !== undefined)
          .map((entry) => ({
            name: `vibtra/guardrail:${name}:${entry.files.join(",")}`,
            files: entry.files,
            plugins: { vibtra: plugin },
            rules: { [rule]: ["error", { allow: entry.only }] },
          })),
      ];
    });

export const guardrails = guardrailsFrom(guardrailAllowlist);
