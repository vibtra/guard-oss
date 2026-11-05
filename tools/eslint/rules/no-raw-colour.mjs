import { reportMatches } from "./uncommented.mjs";

const RAW = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g;

export default {
  meta: {
    type: "problem",
    languages: ["js/js", "css/css"],
    docs: { description: "Disallow raw hex, rgb, hsl and oklch colour values outside token declarations" },
    schema: [
      {
        type: "object",
        properties: { tokenPrefix: { type: "string", pattern: "^--" } },
        additionalProperties: false,
      },
    ],
    messages: { raw: "Use a theme token instead of the raw colour value '{{colour}}'." },
  },
  create(context) {
    const prefix = context.options[0]?.tokenPrefix;
    const tokens = [];
    const check = () => reportMatches(context, RAW, "raw", tokens);
    return {
      Declaration(node) {
        if (prefix !== undefined && node.property.startsWith(prefix)) tokens.push(context.sourceCode.getRange(node));
      },
      "Program:exit": check,
      "StyleSheet:exit": check,
    };
  },
};
