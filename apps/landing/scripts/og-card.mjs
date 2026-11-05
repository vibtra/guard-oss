#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING = resolve(HERE, "..");
const ROOT = resolve(LANDING, "..", "..");
const req = createRequire(join(LANDING, "package.json"));
const mod = await import(pathToFileURL(req.resolve("playwright")).href);
const pw = mod.chromium ? mod : mod.default;

const lreq = createRequire(join(LANDING, "package.json"));
const font = (pkg, file) => readFileSync(join(dirname(lreq.resolve(`${pkg}/package.json`)), "files", file)).toString("base64");
const inter = font("@fontsource-variable/inter", "inter-latin-wght-normal.woff2");
const merri = font("@fontsource-variable/merriweather", "merriweather-latin-wght-normal.woff2");
const mark = readFileSync(join(LANDING, "public", "vibtra-mark-v5.png")).toString("base64");

const shot = (p) => readFileSync(p).toString("base64");
const consoleImg = shot(join(HERE, "og", "console-overview.webp"));
const guardImg = shot(join(HERE, "og", "guard-window.webp"));

const html = (H) => `<!doctype html><html><head><meta charset="utf-8">
<style>
  @font-face { font-family: "Inter Variable"; font-weight: 100 900; src: url(data:font/woff2;base64,${inter}) format("woff2"); }
  @font-face { font-family: "Merriweather Variable"; font-weight: 300 900; src: url(data:font/woff2;base64,${merri}) format("woff2"); }
  *{margin:0;box-sizing:border-box}
  html,body{width:1200px;height:${H}px;background:#ffffff;color:#0a0e19;font-family:"Inter Variable",system-ui,sans-serif}
  .card{position:absolute;inset:18px;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;align-items:center;
        background:radial-gradient(46% 64% at 0% 100%, rgba(10,14,25,.92) 0%, rgba(10,14,25,.5) 42%, rgba(10,14,25,0) 100%),
                   radial-gradient(46% 64% at 100% 100%, rgba(10,14,25,.92) 0%, rgba(10,14,25,.5) 42%, rgba(10,14,25,0) 100%),
                   radial-gradient(70% 40% at 50% 64%, rgba(10,14,25,.10) 0%, rgba(10,14,25,0) 100%), #f4f4f5}
  .lock{margin-top:${H < 630 ? 40 : 50}px;display:flex;align-items:center;gap:12px}
  .mark{width:46px;height:46px;background:#0d0d17;-webkit-mask:url(data:image/png;base64,${mark}) center/contain no-repeat;mask:url(data:image/png;base64,${mark}) center/contain no-repeat}
  .word{display:flex;flex-direction:column;align-items:flex-start;gap:3px}
  .word b{font-size:30px;line-height:1;font-weight:600;letter-spacing:-0.03em}
  .word small{font-size:15px;line-height:1;font-weight:400}
  h1{margin-top:24px;font-family:"Merriweather Variable",Georgia,serif;font-weight:300;font-size:58px;line-height:1.1;letter-spacing:-0.035em}
  .console{position:absolute;left:150px;top:${H < 630 ? 262 : 280}px;width:800px;border-radius:12px 12px 0 0;overflow:hidden;background:#fff;
           border:1px solid rgba(10,14,25,.10);box-shadow:0 18px 50px rgba(10,14,25,.12)}
  .console img{display:block;width:100%}
  .guard{position:absolute;left:800px;top:${H < 630 ? 300 : 318}px;width:290px;border-radius:12px;
         box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 22px 60px rgba(10,14,25,.28),0 6px 16px rgba(10,14,25,.12)}
  .guard img{display:block;width:100%;border-radius:12px}
</style></head><body><div class="card">
  <div class="lock"><span class="mark"></span><span class="word"><b>Guard</b><small>by Vibtra</small></span></div>
  <h1>Block out-of-policy AI use</h1>
  <div class="console"><img src="data:image/webp;base64,${consoleImg}"></div>
  <div class="guard"><img src="data:image/webp;base64,${guardImg}"></div>
</div></body></html>`;

let browser;
try { browser = await pw.chromium.launch({ channel: "chrome" }); } catch { browser = await pw.chromium.launch(); }
for (const [file, H] of [["og.png", 630], ["og-x.png", 600]]) {
	const page = await browser.newPage({ viewport: { width: 1200, height: H }, deviceScaleFactor: 2 });
	await page.setContent(html(H), { waitUntil: "load" });
	await page.evaluate(() => document.fonts.ready);
	writeFileSync(join(LANDING, "public", file), await page.screenshot({ type: "png" }));
	await page.close();
	console.log(`wrote public/${file} (2400x${H * 2})`);
}
await browser.close();
