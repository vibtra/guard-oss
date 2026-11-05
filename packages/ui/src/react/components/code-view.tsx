import * as React from "react";
import { cn } from "../lib/cn";
import { HUE_COUNTER, type SeriesHue } from "../lib/hue";

type TokenKind = "ident" | "punct" | "comment" | "keyword" | "string" | "number" | "type" | "function";

const KIND_CLASS: Record<TokenKind, string> = {
  ident: "text-syntax-ident",
  punct: "text-syntax-punct",
  comment: "text-syntax-comment italic",
  keyword: "text-syntax-keyword",
  string: "text-syntax-string",
  number: "text-syntax-number",
  type: "text-syntax-type",
  function: "text-syntax-function",
};

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from",
  "async", "await", "new", "class", "extends", "try", "catch", "finally", "throw", "typeof", "in", "of",
  "true", "false", "null", "undefined", "default", "interface", "type", "def", "None", "True", "False",
]);

const RULES: ReadonlyArray<readonly [RegExp, TokenKind]> = [
  [/^(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/, "comment"],
  [/^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/, "string"],
  [/^(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/i, "number"],
  [/^([A-Za-z_$][\w$]*)(?=\s*\()/, "function"],
  [/^([A-Z][\w$]*)/, "type"],
  [/^([A-Za-z_$][\w$]*)/, "ident"],
  [/^([{}[\]().,:;=<>+\-*/!?&|%^~@])/, "punct"],
  [/^(\s+)/, "ident"],
];

export function tokenize(line: string): { text: string; kind: TokenKind }[] {
  const out: { text: string; kind: TokenKind }[] = [];
  let rest = line;
  while (rest.length > 0) {
    let matched = false;
    for (const [rule, kind] of RULES) {
      const hit = rule.exec(rest);
      if (hit === null || hit[0] === "") continue;
      const text = hit[0];
      const k = kind === "ident" && KEYWORDS.has(text) ? "keyword" : kind;
      out.push({ text, kind: k });
      rest = rest.slice(text.length);
      matched = true;
      break;
    }
    if (!matched) {
      out.push({ text: rest[0] ?? "", kind: "ident" });
      rest = rest.slice(1);
    }
  }
  return out;
}

export function CodeView({
  code,
  highlight = true,
  className,
  label,
  lineClassName,
  lineNumber,
}: {
  code: string;
  highlight?: boolean;
  className?: string;
  label?: string;
  lineClassName?: (line: string, index: number) => string | undefined;
  lineNumber?: (index: number) => React.ReactNode;
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div
      data-slot="code-view"
      role="region"
      aria-label={label ?? "Code"}
      className={cn("font-mono text-code font-book tracking-normal", className)}
    >
      <ol className="m-0 list-none p-0">
        {lines.map((line, index) => (
          <li key={index} className={cn("flex", lineClassName?.(line, index))}>
            <span
              aria-hidden
              className="w-(--v-code-gutter-w) shrink-0 pr-2 pl-1 text-right text-line-number select-none"
            >
              {lineNumber === undefined ? index + 1 : lineNumber(index)}
            </span>
            <code className="min-w-0 flex-1 pl-1.5 break-words whitespace-pre-wrap">
              {highlight
                ? tokenize(line).map((token, i) => (
                    <span key={i} className={KIND_CLASS[token.kind]}>
                      {token.text}
                    </span>
                  ))
                : line}
              {line === "" ? "\u200b" : null}
            </code>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function StatusChip({
  hue,
  className,
  ...props
}: React.ComponentProps<"span"> & { hue: SeriesHue }) {
  return (
    <span
      data-slot="status-chip"
      className={cn(
        "inline-flex h-[22px] shrink-0 items-center rounded-md px-[5px] py-px font-mono text-code font-strong",
        HUE_COUNTER[hue],
        className,
      )}
      {...props}
    />
  );
}

export function ResponseView({
  status,
  hue,
  reason,
  protocol,
  headers,
  body,
  className,
}: {
  status: string;
  hue: SeriesHue;
  reason: React.ReactNode;
  protocol?: string;
  headers: readonly { key: string; value: React.ReactNode }[];
  body?: string;
  className?: string;
}) {
  return (
    <div data-slot="response-view" className={cn("flex min-w-0 flex-col", className)}>
      <div className="flex flex-col gap-0 px-3 py-3 hairline-b">
        <div className="flex h-[22px] items-center gap-2">
          <StatusChip hue={hue}>{status}</StatusChip>
          <span className="min-w-0 truncate font-mono text-code text-foreground">{reason}</span>
          {protocol === undefined ? null : (
            <span className="ml-auto shrink-0 font-mono text-code text-muted-foreground">{protocol}</span>
          )}
        </div>
        <dl className="mt-1 flex flex-col">
          {headers.map((header) => (
            <div key={header.key} className="flex min-w-0 gap-2 font-mono text-code">
              <dt className="shrink-0 text-foreground">{header.key}:</dt>
              <dd className="min-w-0 truncate text-muted-foreground">{header.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {body === undefined ? null : <CodeView code={body} className="py-2" label="Body" />}
    </div>
  );
}

export function LogView({
  lines,
  empty = "Nothing logged",
  className,
  label = "Log",
}: {
  lines: readonly string[];
  empty?: string;
  className?: string;
  label?: string;
}) {
  return (
    <div
      data-slot="log-view"
      role="log"
      aria-label={label}
      className={cn("p-3 font-mono text-code font-book tracking-normal", className)}
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        lines.map((line, index) => (
          <p key={index} className="break-words whitespace-pre-wrap text-foreground">
            {line === "" ? "\u200b" : line}
          </p>
        ))
      )}
    </div>
  );
}
