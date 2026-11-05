import config from "../../eslint.config.mjs";
import { scriptFiles } from "./index.mjs";

export default [
  ...config.map(({ rules, ...rest }) => rest),
  {
    name: "vibtra/no-comments-only",
    files: scriptFiles,
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off", reportUnusedInlineConfigs: "off" },
    rules: { "vibtra/no-comments": "error" },
  },
];
