import { tokens } from "@vibtra/ui";

const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

export const escapeHtml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const baseCss = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    background: ${tokens.page};
    color: ${tokens.body};
    font-family: ${tokens.font.body};
    line-height: 1.5;
    min-height: 100vh;
  }
  .wrap { max-width: 780px; margin: 0 auto; padding: 48px 20px 64px; }
  .masthead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 28px; }
  .wordmark {
    font-family: ${tokens.font.brand};
    font-weight: 900;
    font-size: 28px;
    letter-spacing: -0.02em;
    color: ${tokens.ink};
  }
  .doclabel {
    background: ${tokens.pill};
    color: ${tokens.ink};
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .mono { font-family: ${MONO}; }
`;

export const pageShell = (title: string, css: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🧾</text></svg>">
<style>${baseCss}${css}</style>
</head>
<body>
${body}
</body>
</html>
`;
