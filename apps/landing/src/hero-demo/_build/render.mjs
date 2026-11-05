import { createRequire } from "node:module";
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "media");
const PORT = process.env.PORT || "3491";
const FPS = Number(process.env.FPS || 24);
const MOBILE = process.env.MOBILE === "1";
const WIDE = process.env.WIDE === "1";
const SUF = MOBILE ? "-m" : WIDE ? "-w" : "";
const FF = "/opt/homebrew/bin/ffmpeg";
const require = createRequire(join(HERE, "..", "..", "..", "..", "console", "package.json"));
const pw = require("playwright");

const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["claude-web", "chatgpt-web", "claude-mac", "chatgpt-mac"];
const browser = await pw.chromium.launch({ channel: "chrome" });
const meta = {};

for (const id of ids) {
  const ctx = await browser.newContext({ viewport: MOBILE ? { width: 720, height: 720 } : WIDE ? { width: 1140, height: 493 } : { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error(id, m.text()); });
  page.on("pageerror", (e) => console.error(id, e.message));
  await page.route("**/@vite/client", (r) => r.fulfill({ contentType: "text/javascript", body: "export const createHotContext=()=>({accept(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){},data:{}});export const updateStyle=()=>{};export const removeStyle=()=>{};export const injectQuery=(u)=>u;export class ErrorOverlay{}" }));
  await page.goto(`http://localhost:${PORT}/landing/src/hero-demo/_build/compose.html`);
  await page.waitForFunction(() => window.__compose);
  await page.evaluate(() => document.fonts.ready);
  const info = await page.evaluate((a) => window.__compose.setup(a.id, { mobile: a.m, wide: a.w }), { id, m: MOBILE, w: WIDE });
  const tmp = join(process.env.FRAMES || join(tmpdir(), "hero-lab-a-frames"), id + SUF);
  rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  const n = Math.round(info.dur * FPS);
  const stage = page.locator("#stage");
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.__compose.renderAt(t), i / FPS);
    await stage.screenshot({ path: join(tmp, `f${String(i).padStart(4, "0")}.png`) });
  }
  await ctx.close();
  const inp = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(tmp, "f%04d.png")];
  execFileSync(FF, [...inp, "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, `${id}${SUF}.mp4`)]);
  execFileSync(FF, [...inp, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "25", "-row-mt", "1", "-tile-columns", "2", "-deadline", "good", "-cpu-used", "2", "-pix_fmt", "yuv420p", join(OUT, `${id}${SUF}.webm`)]);
  const posterAt = Math.min(n - 1, Math.round(info.posterT * FPS));
  execFileSync("python3", ["-c", "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2],'WEBP',quality=86,method=6)", join(tmp, `f${String(posterAt).padStart(4, "0")}.png`), join(OUT, `${id}${SUF}-poster.webp`)]);
  if (MOBILE) meta[id] = { mobileFrames: n, mobilePosterT: info.posterT };
  else if (WIDE) meta[id] = { wideFrames: n, widePosterT: info.posterT };
  else meta[id] = { ...info, frames: n, fps: FPS };
  const kb = (f) => Math.round(statSync(join(OUT, f)).size / 1024);
  console.log(id + SUF, `${info.dur.toFixed(2)}s`, `${n} frames`, `mp4 ${kb(id + SUF + ".mp4")}KB`, `webm ${kb(id + SUF + ".webm")}KB`, `poster ${kb(id + SUF + "-poster.webp")}KB`);
}
const now = existsSync(join(OUT, "clips.json")) ? JSON.parse(readFileSync(join(OUT, "clips.json"), "utf8")) : {};
for (const id of ids) now[id] = { ...now[id], ...meta[id] };
writeFileSync(join(OUT, "clips.json"), JSON.stringify(now, null, 1));
await browser.close();
