import { reportMatches } from "./uncommented.mjs";

const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|divide|placeholder|decoration|accent|caret)-(?:white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\/\d{1,3})?\b/g;

export default {
  meta: {
    type: "problem",
    languages: ["js/js", "css/css"],
    docs: { description: "Disallow Tailwind palette colours, which ignore the theme" },
    schema: [],
    messages: { palette: "Use a theme token instead of the Tailwind palette colour '{{colour}}'." },
  },
  create(context) {
    const check = () => reportMatches(context, PALETTE, "palette");
    return { "Program:exit": check, "StyleSheet:exit": check };
  },
};
