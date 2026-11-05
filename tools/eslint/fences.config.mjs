import config from "../../eslint.config.mjs";
import { fenceRules } from "./index.mjs";

const fencesOf = (rules) => Object.fromEntries(Object.entries(rules).filter(([ruleId]) => fenceRules.includes(ruleId)));

export default [
  ...config.map(({ rules, ...rest }) => (rules === undefined ? rest : { ...rest, rules: fencesOf(rules) })),
  {
    name: "vibtra/fences-only",
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: "off", reportUnusedInlineConfigs: "off" },
  },
];
