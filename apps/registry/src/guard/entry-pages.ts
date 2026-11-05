// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

export interface GuardSignIn {
  provider: "google" | "oidc";
  label: string;
}

export const guardInvitationPath = (invitationId: string, baseUrl = ""): string =>
  `${baseUrl.replace(/\/+$/, "")}/login?invitation=${encodeURIComponent(invitationId)}`;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const VIBTRA_MARK =
  "M14.15 0.09L19.98 0.16L21.48 0.53L22.86 1.03L24.36 1.91L25.49 2.79L26.93 4.35L28.05 6.11L28.56 7.23L29.18 9.74L29.31 18.76L29.43 18.88L29.68 20.88L30.43 23.01L31.94 25.64L33.82 28.15L37.01 31.22L39.64 32.97L41.77 33.97L43.77 34.6L45.4 34.72L45.53 34.85L54.29 34.85L56.55 35.35L59.43 36.85L61.5 38.79L62.25 39.8L63.37 42.05L64 45.06L64 53.95L63.37 56.7L62.37 58.71L61.37 60.09L59.18 62.03L56.8 63.28L55.67 63.66L54.29 63.78L54.17 63.91L44.27 63.91L44.15 63.78L42.77 63.66L41.27 63.15L39.77 62.4L37.57 60.59L36.45 59.21L35.44 57.46L34.69 54.83L34.69 41.55L34.57 40.92L34.07 39.17L33.06 37.04L31.69 35.04L29.75 32.97L26.86 30.84L25.11 29.96L22.98 29.34L22.11 29.34L21.98 29.21L9.46 29.34L7.58 28.96L5.32 27.96L4.57 27.46L1.88 24.77L0.75 22.76L0.25 21.26L0.13 20.01L0 19.88L0 10.24L0.13 10.11L0.25 8.74L0.88 6.86L1.63 5.48L2.63 4.1L4.2 2.54L5.82 1.41L7.45 0.66L9.46 0.16ZM44.09 0.22L54.54 0.16L56.17 0.53L58.43 1.53L59.55 2.29L61.5 4.23L62.75 6.11L63.62 8.36L63.87 9.49L63.87 10.36L64 10.49L64 19.51L63.87 19.63L63.87 20.38L63.25 22.51L62 24.77L60.05 26.83L58.93 27.71L56.55 28.84L54.54 29.34L44.02 29.34L43.9 29.21L43.27 29.21L40.77 28.34L38.64 26.96L37.32 25.64L35.95 23.64L35.19 21.89L34.69 19.51L34.69 10.99L34.82 10.86L34.82 9.36L35.44 7.11L36.95 4.48L38.51 2.79L39.64 1.91L41.14 1.03L42.9 0.41ZM9.77 34.79L19.35 34.72L21.23 35.1L22.73 35.6L24.49 36.6L26.68 38.54L28.05 40.55L28.56 41.55L29.31 44.81L29.31 54.2L29.18 54.32L29.06 55.7L28.05 58.21L26.93 59.84L25.24 61.53L23.98 62.4L22.48 63.15L19.48 63.91L9.71 63.91L7.83 63.53L5.45 62.53L3.57 61.15L1.75 59.08L0.75 57.33L0 54.7L0 44.31L0.75 41.55L2.25 39.05L4.2 37.1L5.45 36.23L6.95 35.48L8.95 34.85Z";

const GOOGLE_G =
  '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/>' +
  '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/>' +
  '<path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/>' +
  '<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/>' +
  "</svg>";

const KEY_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/>' +
  '<circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/></svg>';

const CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>';

const CAPABILITIES = [
  "See which AI services each person and laptop uses",
  "Allow or block each service on the web, in its app and in the terminal",
  "Catch sensitive content, like tax file numbers, before it is sent",
  "Explain every block, with a way to ask for access",
  "Manage rules, laptops and requests from one dashboard",
] as const;

const STYLE = `
:root{color-scheme:light dark;--page:#f5f5f4;--surface:#fff;--line:#e5e5e5;--ink:#171717;--ink-strong:#1c1917;--muted:#6e6e6e;--lead:#44403c;--accent:#0d0d17;--focus:#171717;--btn-bg:#fff;--btn-line:#e5e5e5;--btn-ink:#171717;--btn-hover:#f5f5f5;--btn-press:#e5e5e5;--bad-bg:#fef2f2;--bad-line:#fecaca;--bad-ink:#991b1b;--note-bg:#fafaf9}
@media (prefers-color-scheme:dark){:root{--page:#121111;--surface:#1c1c1c;--line:rgba(255,255,255,.10);--ink:#fafafa;--ink-strong:#fafafa;--muted:#a3a3a3;--lead:#d4d4d4;--accent:#fafafa;--focus:#fafafa;--btn-bg:#131314;--btn-line:#8e918f;--btn-ink:#e3e3e3;--btn-hover:#1f1f20;--btn-press:#2a2a2b;--bad-bg:rgba(220,38,38,.15);--bad-line:rgba(220,38,38,.40);--bad-ink:#fca5a5;--note-bg:#222121}}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--ink);font:400 .875rem/1.43 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.frame{display:flex;min-height:100vh;min-height:100dvh;padding:8px}
.card{display:flex;flex-direction:column;flex:0 0 50%;width:50%;min-width:0;padding:40px;background:var(--surface);border:1px solid var(--line);border-radius:16px;overflow:hidden}
.lockup{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;color:var(--ink-strong);text-decoration:none;border-radius:4px}
.lockup svg{width:18px;height:18px;flex:none}
.lockup .name{font-size:1rem;line-height:1.375;font-weight:600;letter-spacing:-.01em}
.lockup .by{font-size:.75rem;line-height:1.5;font-weight:500;color:var(--muted)}
.middle{display:flex;flex:1;flex-direction:column;align-items:center;justify-content:center;padding:32px 0}
.block{width:100%;max-width:400px;padding-bottom:64px}
h1{margin:0;text-align:center;font-size:2.5rem;line-height:1.25;font-weight:500;letter-spacing:-.02em;color:var(--ink);text-wrap:balance}
.sub{margin:8px 0 0;text-align:center;color:var(--muted);text-wrap:pretty}
.invited{margin:16px 0 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--note-bg);color:var(--ink);font-size:.8125rem;line-height:1.46;text-align:center}
.providers{display:flex;flex-direction:column;gap:8px;margin-top:32px}
.provider{position:relative;display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;padding:0 48px;border:1px solid var(--btn-line);border-radius:8px;background:var(--btn-bg);color:var(--btn-ink);font:inherit;font-size:.875rem;line-height:1.43;font-weight:500;text-decoration:none;cursor:pointer;transition:background-color 150ms cubic-bezier(.22,1,.36,1)}
@media (hover:hover){.provider:hover{background:var(--btn-hover)}}
.provider:active{background:var(--btn-press)}
.provider[aria-busy=true]{cursor:progress}
.provider .mark{position:absolute;left:24px;top:50%;display:grid;place-items:center;width:18px;height:18px;margin-top:-9px}
.provider .label{text-align:center}
.status{margin:16px 0 0;font-size:.8125rem;line-height:1.46;color:var(--muted);text-align:center;text-wrap:pretty}
.status:empty{display:none}
.status[data-tone=error]{padding:10px 12px;border:1px solid var(--bad-line);border-radius:8px;background:var(--bad-bg);color:var(--bad-ink);text-align:left}
.actions{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.legal{margin:0 auto;max-width:400px;text-align:center;font-size:.75rem;line-height:1.5;color:var(--muted);text-wrap:pretty}
.legal a{color:var(--ink);text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:from-font;border-radius:2px}
.panel{display:flex;flex:1;flex-direction:column;min-width:0;padding:48px 40px}
.panel-inner{display:flex;flex:1;align-items:center;justify-content:center}
.value{width:100%;max-width:512px}
.value h2{margin:0;font-size:1.5rem;line-height:1.33;font-weight:500;letter-spacing:-.01em;color:var(--ink)}
.value p{margin:12px 0 0;color:var(--muted)}
.value ul{display:flex;flex-direction:column;gap:12px;margin:32px 0 0;padding:0;list-style:none}
.value li{display:flex;align-items:flex-start;gap:12px}
.value li svg{flex:none;margin-top:2px;color:var(--accent)}
.value li span{font-size:.8125rem;line-height:1.46;color:var(--lead)}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:1023.98px){.card{flex:1 1 auto;width:100%}.panel{display:none}}
@media (max-width:479.98px){.card{padding:24px}h1{font-size:2rem;line-height:1.25}.provider{padding:0 44px}.provider .mark{left:16px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
@media (forced-colors:active){.provider,.card,.status[data-tone=error]{border-color:CanvasText}}
`;

const SCRIPT = `
(function(){
var body=document.body,page=body.getAttribute('data-page');
var q=new URLSearchParams(location.search);
var inv=q.get('invitation');
if(inv!==null&&!/^[A-Za-z0-9_-]{1,128}$/.test(inv))inv=null;
var status=document.getElementById('status');
function say(text,tone){status.textContent=text||'';if(tone)status.setAttribute('data-tone',tone);else status.removeAttribute('data-tone');}
function withInvite(path){return inv===null?path:path+'?invitation='+encodeURIComponent(inv);}
var NETWORK='Could not reach Guard. Check your connection and try again.';
if(page==='login'){
  var note=document.getElementById('invited');if(inv!==null&&note)note.hidden=false;
  var CODES={access_denied:'Sign-in was cancelled. Try again when you are ready.',state_not_found:'Sign-in took too long, or started in another tab. Try again.',state_mismatch:'Sign-in took too long, or started in another tab. Try again.',email_not_found:'Your account did not share an email address, so Guard cannot tell who you are. Try another account.',unable_to_get_user_info:'Your identity provider did not say who you are. Try again.'};
  var err=q.get('error');
  if(err!==null){
    var said=q.get('error_description');
    var ours=(err==='VALIDATION'||err==='REGISTRY_LIMIT_EXCEEDED')&&said!==null&&said.trim()!=='';
    say(ours?said.trim().slice(0,600):(CODES[err]||'Sign-in did not finish. Try again.'),'error');
  }
  var btn=document.getElementById('signin'),busy=false;
  var provider=btn.getAttribute('data-provider'),label=btn.getAttribute('data-label');
  function reset(){busy=false;btn.removeAttribute('aria-busy');}
  window.addEventListener('pageshow',function(e){if(e.persisted){reset();if(status.getAttribute('data-tone')!=='error')say('');}});
  btn.addEventListener('click',function(){
    if(busy)return;busy=true;btn.setAttribute('aria-busy','true');say('Opening '+label+'\\u2026');
    fetch('/api/auth/sign-in/social',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:provider,callbackURL:location.origin+withInvite('/start'),errorCallbackURL:location.origin+withInvite('/login')})})
      .then(function(r){return r.json().catch(function(){return {};}).then(function(d){if(!r.ok||typeof d.url!=='string'||!/^https:\\/\\/|^http:\\/\\/(127\\.0\\.0\\.1|localhost)[:/]/.test(d.url))throw new Error('Sign-in is not available right now. Try again in a minute, or ask your administrator.');location.assign(d.url);});},function(){throw new Error(NETWORK);})
      .catch(function(e){reset();say(e.message,'error');});
  });
}
if(page==='start'){
  var actions=document.getElementById('actions'),out=document.getElementById('signout'),back=document.getElementById('back');
  back.setAttribute('href',withInvite('/login'));document.getElementById('retry').setAttribute('href',withInvite('/start'));
  function stop(title,text,show){document.getElementById('title').textContent=title;document.getElementById('sub').textContent='';say(text,'error');for(var i=0;i<show.length;i++)document.getElementById(show[i]).hidden=false;actions.hidden=false;}
  out.addEventListener('click',function(){
    out.setAttribute('aria-busy','true');
    fetch('/api/auth/sign-out',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'}).catch(function(){}).then(function(){location.replace(withInvite('/login'));});
  });
  function json(r){return r.json().catch(function(){return {};});}
  function open(){
    return fetch('/api/console/session',{credentials:'same-origin',headers:{accept:'application/json'}}).then(function(r){
      if(r.status===401){
        return fetch('/api/auth/get-session',{credentials:'same-origin'}).then(json).then(function(s){
          var who=s&&s.user&&typeof s.user.email==='string'?s.user.email:null;
          if(who===null){location.replace(withInvite('/login'));return;}
          stop('No organisation yet',who+' is signed in, but is not in an organisation on Guard. Ask an admin of your organisation to invite you, then open the link they send.',['signout']);
        });
      }
      return json(r).then(function(s){
        var h=s&&s.handle;
        if(!r.ok||typeof h!=='string'||!/^[a-z0-9][a-z0-9-]*$/.test(h)){stop('Not available','Your organisation is not available right now. Try again, or ask your administrator.',['retry','back']);return;}
        location.replace('/'+encodeURIComponent(h)+'/guard');
      });
    },function(){stop('Not available',NETWORK,['retry','back']);});
  }
  if(inv===null){open();return;}
  document.getElementById('sub').textContent='Accepting your invitation.';
  fetch('/api/auth/organization/accept-invitation',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({invitationId:inv})})
    .then(function(r){
      if(r.status===401){location.replace(withInvite('/login'));return;}
      if(r.ok){inv=null;return open();}
      return json(r).then(function(b){
        var why=b&&typeof b.message==='string'&&b.message.trim()!==''?b.message.trim().replace(/\\.?$/,'. '):'';
        inv=null;
        stop('Invitation not accepted',why+'Ask whoever invited you to send a new one, or open your dashboard if you are already a member.',['dashboard','signout']);
      });
    },function(){stop('Not available',NETWORK,['retry','back']);});
}
})();
`;

const sha256 = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

export const guardEntryPageCsp = (): string =>
  [
    "default-src 'none'",
    `script-src ${sha256(SCRIPT)}`,
    `style-src ${sha256(STYLE)}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const lockup = (): string =>
  `<a class="lockup" href="/" aria-label="Guard by Vibtra, home"><svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><path fill="currentColor" d="${VIBTRA_MARK}"/></svg><span class="name">Guard</span><span class="by">by Vibtra</span></a>`;

const panel = (): string =>
  `<section class="panel" aria-labelledby="panel-title"><div class="panel-inner"><div class="value">` +
  `<h2 id="panel-title">Govern how your team uses AI</h2>` +
  `<p>Guard runs on each Mac and applies your organisation’s rules to AI apps, websites and tools.</p>` +
  `<ul>${CAPABILITIES.map((c) => `<li>${CHECK}<span>${c}</span></li>`).join("")}</ul>` +
  `</div></div></section>`;

const legal = (): string =>
  `<p class="legal">By signing in, you agree to the <a href="/terms">Terms of service</a> and the <a href="/privacy">Privacy policy</a>.</p>`;

const documentOf = (page: "login" | "start", title: string, main: string): string =>
  `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="robots" content="noindex"><link rel="icon" href="data:,"><title>${title}</title><style>${STYLE}</style></head>
<body data-page="${page}"><div class="frame">${main}${panel()}</div><script>${SCRIPT}</script></body></html>`;

export const guardLoginPage = (signIn: GuardSignIn): string => {
  const provider = signIn.provider === "oidc" ? "oidc" : "google";
  const label = provider === "google" ? "Google" : signIn.label.trim() === "" ? "your identity provider" : signIn.label.trim();
  const words = `Continue with ${label}`;
  return documentOf(
    "login",
    "Sign in to Guard",
    `<main class="card">${lockup()}<div class="middle"><div class="block">` +
      `<h1>Sign in to Guard</h1>` +
      `<p class="sub">Use your work account to open your dashboard.</p>` +
      `<p class="invited" id="invited" hidden>You have an invitation. Sign in with the address it was sent to, and you will join that organisation.</p>` +
      `<div class="providers"><button type="button" class="provider" id="signin" data-provider="${provider}" data-label="${escapeHtml(label)}">` +
      `<span class="mark">${provider === "google" ? GOOGLE_G : KEY_ICON}</span><span class="label">${escapeHtml(words)}</span></button></div>` +
      `<p class="status" id="status" role="status" aria-live="polite"></p>` +
      `</div></div>${legal()}</main>`,
  );
};

export const guardStartPage = (): string =>
  documentOf(
    "start",
    "Signing you in to Guard",
    `<main class="card">${lockup()}<div class="middle"><div class="block">` +
      `<h1 id="title">Signing you in…</h1>` +
      `<p class="sub" id="sub">Opening your organisation’s dashboard.</p>` +
      `<p class="status" id="status" role="status" aria-live="polite"></p>` +
      `<div class="actions" id="actions" hidden>` +
      `<a class="provider" id="retry" href="/start" hidden><span class="label">Try again</span></a>` +
      `<a class="provider" id="dashboard" href="/start" hidden><span class="label">Open your dashboard</span></a>` +
      `<a class="provider" id="back" href="/login" hidden><span class="label">Back to sign in</span></a>` +
      `<button type="button" class="provider" id="signout" hidden><span class="label">Sign out</span></button>` +
      `</div></div></div>${legal()}</main>`,
  );
