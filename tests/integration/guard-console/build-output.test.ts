import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_ASSETS_PREFIX } from "@vibtra/guard-contract";

const consoleDir = fileURLToPath(new URL("../../../apps/guard-console/", import.meta.url));
const outDir = mkdtempSync(path.join(os.tmpdir(), "guard-console-build-"));
const ownOutDir = mkdtempSync(path.join(os.tmpdir(), "guard-console-own-"));
const OWN_CHUNK = "guard-own";
let css = "";
let js = "";
let html = "";
let ownJs = "";
const ownModules = new Set<string>();

const customProperties = (text: string): Set<string> => new Set(text.match(/--[a-zA-Z0-9-]+(?=\s*:)/g) ?? []);
const vTokens = (text: string): string[] => [...text.matchAll(/var\(\s*(--v-[a-z0-9-]+)/g)].map((match) => match[1] ?? "");

const rendersRule = (selector: string): boolean => {
  const classes = [...selector.matchAll(/\.((?:[a-zA-Z0-9_-]|\\.)+)/g)].map((match) => (match[1] ?? "").replace(/\\(.)/g, "$1"));
  return classes.length === 0 || classes.some((name) => js.includes(name));
};

const isDeclared = (declared: Set<string>, token: string): boolean => (token.endsWith("-") ? [...declared].some((name) => name.startsWith(token)) : declared.has(token));

const mediaBlocks = (text: string, query: string): string[] => {
  const blocks: string[] = [];
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + 1)) {
    const open = text.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}" && --depth === 0) {
        blocks.push(text.slice(open + 1, i));
        break;
      }
    }
  }
  return blocks;
};

const lightRootValue = (name: string): string | undefined => {
  let outside = css;
  for (const block of mediaBlocks(css, "@media")) outside = outside.replace(block, "");
  const values = [...outside.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector = ""]) => selector.split(",").map((part) => part.trim()).includes(":root"))
    .flatMap(([, , body = ""]) => [...body.matchAll(new RegExp(`(?:^|;)\\s*${name}:([^;]+)`, "g"))].map((match) => (match[1] ?? "").trim()));
  return values.at(-1);
};

const milliseconds = (value: string | undefined): number => {
  if (value === undefined) return Number.NaN;
  if (value.endsWith("ms")) return Number(value.slice(0, -2));
  if (value.endsWith("s")) return Number(value.slice(0, -1)) * 1000;
  return Number.NaN;
};

const HUES = "white|black|slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const PALETTE_UTILITY = new RegExp(`^(?:bg|text|border(?:-[trblxy])?|ring|fill|stroke|from|to|via|shadow|outline|divide|placeholder|decoration|accent|caret)-(?:${HUES})(?:-\\d{2,3})?(?:/\\d{1,3})?$`);
const PALETTE_TOKEN = new RegExp(`(?<![\\w-])${PALETTE_UTILITY.source.slice(1, -1)}(?![\\w-])`, "g");
const PALETTE_PROPERTY = new RegExp(`^--color-(?:${HUES})(?:-\\d{2,3})?$`);
const SCANNED_UI_PALETTE = { utilities: ["bg-white", "text-white"], properties: ["--color-white"] };
const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
const NAMED_COLOURS = new Set(
  "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(" "),
);
const TRANSPARENT = "#0000";

const rawColours = (value: string): string[] => [
  ...(value.match(RAW_COLOUR) ?? []).filter((hit) => hit !== TRANSPARENT),
  ...(value.replace(/url\([^)]*\)|"[^"]*"/g, " ").match(/(?<![-\w#.])[a-zA-Z]+(?![-\w(])/g) ?? []).filter((word) => NAMED_COLOURS.has(word.toLowerCase())),
];

const cssRules = (text: string): Array<{ selector: string; body: string }> =>
  [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({ selector: selector.trim(), body }));

const utilitiesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.((?:[a-zA-Z0-9_-]|\\.)+)/g)].map((match) => {
    const name = (match[1] ?? "").replace(/\\(.)/g, "$1");
    return name.replace(/\[[^\]]*\]/g, "[]").split(":").at(-1) ?? "";
  });

const declarations = (body: string): Array<{ property: string; value: string }> =>
  body
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes(":"))
    .map((part) => ({ property: part.slice(0, part.indexOf(":")).trim(), value: part.slice(part.indexOf(":") + 1).trim() }));

beforeAll(async () => {
  execFileSync("corepack", ["pnpm", "--filter", "@vibtra/guard-console", "exec", "vite", "build", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], { stdio: "pipe", env: { ...process.env, NODE_ENV: "production" } });
  const files = readdirSync(outDir);
  css = files.filter((file) => file.endsWith(".css")).map((file) => readFileSync(path.join(outDir, file), "utf8")).join("\n");
  js = files.filter((file) => file.endsWith(".js")).map((file) => readFileSync(path.join(outDir, file), "utf8")).join("\n");
  html = readFileSync(path.join(outDir, "index.html"), "utf8");
  const nodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await build({
      root: consoleDir,
      configFile: path.join(consoleDir, "vite.config.ts"),
      logLevel: "error",
      build: {
        outDir: ownOutDir,
        emptyOutDir: true,
        rollupOptions: {
          output: {
            manualChunks: (id) => {
              if (!id.startsWith(path.join(consoleDir, "src") + path.sep)) return "dependencies";
              ownModules.add(path.relative(consoleDir, id));
              return OWN_CHUNK;
            },
          },
        },
      },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }
  ownJs = readdirSync(ownOutDir)
    .filter((file) => file.startsWith(`${OWN_CHUNK}-`) && file.endsWith(".js"))
    .map((file) => readFileSync(path.join(ownOutDir, file), "utf8"))
    .join("\n");
  if (!ownModules.has(path.join("src", "main.tsx"))) throw new Error("the guard-own chunk has no src/main.tsx");
  if (![...ownModules].some((id) => id.startsWith(path.join("src", "pages") + path.sep))) throw new Error("the guard-own chunk has no page module");
  if (ownJs === "") throw new Error("the guard-own chunk is empty");
  if (ownJs.includes("jsxDEV(") || js.includes("jsxDEV(")) throw new Error("a build ran in development mode");
}, 180_000);

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
  rmSync(ownOutDir, { recursive: true, force: true });
});

describe("the built Guard console", () => {
  it("loads its script and stylesheet from the registry's Guard asset prefix", () => {
    const urls = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((match) => match[1]);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const url of urls) expect(url?.startsWith(`${GUARD_ASSETS_PREFIX}/`), url).toBe(true);
  });

  it("carries the shared @vibtra/ui theme, every --v- token it declares", () => {
    const shared = readFileSync(createRequire(import.meta.url).resolve("@vibtra/ui/theme.css"), "utf8");
    const built = customProperties(css);
    const missing = [...customProperties(shared)].filter((name) => name.startsWith("--v-") && !built.has(name));
    expect(missing).toEqual([]);
  });

  it("declares every --v- token that a rule it can render or its script reaches for", () => {
    const declared = customProperties(css);
    const fromRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selector = "", body = ""]) =>
      rendersRule(selector) ? vTokens(body).map((token) => `${token} in ${selector.trim()}`) : [],
    );
    const fromScript = vTokens(js).map((token) => `${token} in the script`);
    const used = [...fromRules, ...fromScript];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((use) => !isDeclared(declared, use.split(" ")[0] ?? ""))).toEqual([]);
  });

  it("names the properties of every transition, never all of them", () => {
    expect(css).not.toMatch(/\.transition-all\b|transition:\s*all\b|transition-property:\s*all\b/);
  });

  it("puts Guard's motion on one curve and four lengths", () => {
    expect(lightRootValue("--g-ease")?.replace(/\s+/g, "").replace(/(^|[(,])0\./g, "$1.")).toBe("cubic-bezier(.22,1,.36,1)");
    expect(Object.fromEntries(["--g-dur-fast", "--g-dur", "--g-dur-sheet", "--g-dur-exit"].map((name) => [name, milliseconds(lightRootValue(name))]))).toEqual({
      "--g-dur-fast": 100,
      "--g-dur": 150,
      "--g-dur-sheet": 260,
      "--g-dur-exit": 150,
    });
  });

  it("puts every transition utility and the shared popup motion on that curve and length", () => {
    const transitions = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector = "", body = ""]) => selector.trim().startsWith(".transition") && body.includes("transition-property"));
    expect(transitions.length).toBeGreaterThan(0);
    const offCurve = transitions
      .filter(([, , body = ""]) => !/transition-timing-function:var\(--tw-ease,var\(--g-ease\)\)/.test(body) || !/transition-duration:var\(--tw-duration,var\(--g-dur\)\)/.test(body))
      .map(([, selector = ""]) => selector.trim());
    expect(offCurve).toEqual([]);
    expect(Object.fromEntries(["--v-ease-ui", "--v-motion-ui", "--v-motion-shift", "--v-motion-scale-from"].map((name) => [name, lightRootValue(name)]))).toEqual({
      "--v-ease-ui": "var(--g-ease)",
      "--v-motion-ui": "var(--g-dur)",
      "--v-motion-shift": "4px",
      "--v-motion-scale-from": "1",
    });
  });

  it("keeps the light inks at the values that pass AA on their grounds", () => {
    expect(Object.fromEntries(["--g-muted", "--g-nav", "--g-switch-off", "--g-danger-pressed"].map((name) => [name, lightRootValue(name)?.toLowerCase()]))).toEqual({
      "--g-muted": "#6e6e6e",
      "--g-nav": "#736c67",
      "--g-switch-off": "#e5e5e5",
      "--g-danger-pressed": "#fecaca",
    });
  });

  it("cross-fades the sheets under reduced motion instead of sliding them, and ships no dead keyframe classes", () => {
    const reduced = mediaBlocks(css, "prefers-reduced-motion:reduce").join("\n");
    const rules = [...reduced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({ selectors: selector.split(",").map((part) => part.trim().replace(/"/g, "")), body }));
    const still = rules.find((rule) => rule.selectors.includes("[data-slot=detail-sheet][data-starting-style]"));
    expect(still?.body).toMatch(/translate:\s*none\s*!important/);
    const fade = rules.find((rule) => rule.selectors.includes("[data-slot=detail-sheet]") && /transition-property:\s*opacity/.test(rule.body));
    expect(fade?.body).toMatch(/transition-duration:\s*var\(--g-dur-sheet\)\s*!important/);
    expect(css).not.toMatch(/\.g-(sheet|modal|fade)-motion/);
  });

  it("ships no Tailwind palette colour in its CSS but the dead white Tailwind emits from scanning @vibtra/ui", () => {
    const utilities = new Set(cssRules(css).flatMap(({ selector }) => utilitiesOf(selector)).filter((name) => PALETTE_UTILITY.test(name)));
    const properties = new Set([...customProperties(css)].filter((name) => PALETTE_PROPERTY.test(name)));
    expect({ utilities: [...utilities].sort(), properties: [...properties].sort() }).toEqual(SCANNED_UI_PALETTE);
    expect(SCANNED_UI_PALETTE.utilities.filter((name) => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(js))).toEqual([]);
  });

  it("names no Tailwind palette class in the console's own code", () => {
    expect([...new Set(ownJs.match(PALETTE_TOKEN))]).toEqual([]);
  });

  it("names no raw or named colour in the console's own code", () => {
    const raw = ownJs.match(RAW_COLOUR) ?? [];
    const named = [...ownJs.matchAll(/(?:[\w$]+|"[\w-]+"):"([^"]*)"/g)].filter(([, value = ""]) => NAMED_COLOURS.has(value.trim().toLowerCase())).map(([pair]) => pair);
    expect([...raw, ...named]).toEqual([]);
  });

  it("writes no raw or named colour outside a custom-property declaration, but transparent and the alpha of a mask", () => {
    const raw = cssRules(css)
      .filter(({ selector }) => !selector.startsWith("@property"))
      .flatMap(({ selector, body }) =>
        declarations(body)
          .filter(({ property }) => !property.startsWith("--") && !/^(?:-webkit-)?mask-image$/.test(property))
          .flatMap(({ property, value }) => rawColours(value).map((hit) => `${selector} { ${property}: ${hit} }`)),
      );
    expect(cssRules(css).some(({ body }) => body.includes(TRANSPARENT))).toBe(true);
    expect(raw).toEqual([]);
  });
});
