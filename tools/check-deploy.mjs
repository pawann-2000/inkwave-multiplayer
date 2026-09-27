// Check a hosted INKWAVE (after `npm run deploy`, or against `npx wrangler dev`): security headers on the real
// responses, module MIME types, host-only files not served, the game boots and plays with no CSP violation, an injected
// inline event handler is blocked, and invite links carry the room code only in the fragment.
// usage: CHROME_PATH=/path/to/chrome node tools/check-deploy.mjs <url> [--play 8]
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const base = (args[0] || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(base)) { console.error('usage: node tools/check-deploy.mjs <url> [--play seconds]'); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const playSecs = +opt('play', 8);
const results = [];
const check = (name, ok, info = '') => { results.push([ok, name, info]); };

// ---- headers (straight from the host, no browser)
const res = await fetch(base + '/', { redirect: 'manual' });
const hd = (k) => res.headers.get(k) || '';
const csp = hd('content-security-policy');
check('index served (200, text/html)', res.status === 200 && hd('content-type').startsWith('text/html'), `${res.status} ${hd('content-type')}`);
check('CSP pins scripts: self + sha256 hashes, no unsafe-inline / unsafe-eval in script-src',
  /script-src 'self'( 'sha256-[A-Za-z0-9+/=]+')+;/.test(csp) && !/script-src[^;]*unsafe/.test(csp), csp.slice(0, 140) + '…');
for (const d of ["object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'", "connect-src 'self' wss:", "worker-src 'self' blob:"]) check(`CSP ${d}`, csp.includes(d));
check('X-Content-Type-Options: nosniff', hd('x-content-type-options') === 'nosniff');
check('Referrer-Policy: no-referrer', hd('referrer-policy') === 'no-referrer');
check('Cross-Origin-Opener-Policy: same-origin', hd('cross-origin-opener-policy') === 'same-origin');
check('Permissions-Policy denies camera / microphone / geolocation', /camera=\(\)/.test(hd('permissions-policy')) && /microphone=\(\)/.test(hd('permissions-policy')) && /geolocation=\(\)/.test(hd('permissions-policy')));
check('HTTPS (secure context: online play needs it)', base.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)/.test(base), base);
for (const [p, re] of [['/src/main.js', /javascript/], ['/vendor/trystero/core/index.mjs', /javascript/], ['/assets/fonts/Rubik-latin.woff2', /font\/woff2/]]) {
  const r = await fetch(base + p);
  check(`${p} served as ${re.source}`, r.ok && re.test(r.headers.get('content-type') || ''), `${r.status} ${r.headers.get('content-type')}`);
}
for (const p of ['/_headers', '/.assetsignore', '/wrangler.jsonc', '/.env', '/tools/deploy.sh']) {
  const r = await fetch(base + p);
  check(`${p} not served`, r.status === 404, String(r.status));
}

// ---- in a browser
const MAC = process.platform === 'darwin';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: 'new', protocolTimeout: 600000,
  args: [...(MAC ? ['--use-angle=metal'] : ['--use-gl=angle', '--use-angle=gl-egl']), '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const watch = async (page) => {
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  await page.evaluateOnNewDocument(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.effectiveDirective} ${e.blockedURI || ''}`.trim()));
    localStorage.setItem('inkwave.settings', JSON.stringify({ master: 0, quality: 'low', gfxV: 2 }));
  });
  return errs;
};
const page = await browser.newPage();
const errs = await watch(page);
await page.goto(`${base}/?autostart=60&autopilot`);
try {
  await page.waitForFunction(() => window.__inkwave && __inkwave.match && __inkwave.match.state === 'playing', { timeout: 240000, polling: 250 });
  await new Promise((r) => setTimeout(r, playSecs * 1000));
  const st = await page.evaluate(() => ({ state: __inkwave.match.state, csp: window.__csp.slice(), lost: __inkwave.R.renderer.getContext().isContextLost() }));
  check('the game boots and plays a match', st.state === 'playing' && !st.lost, st.state);
  check('no CSP violations while booting and playing', st.csp.length === 0, st.csp.slice(0, 4).join(' | '));
  check('no console errors in the match', errs.length === 0, errs.slice(0, 3).join(' | '));   // before the injection below
  // negative: markup injected into the page cannot run code (inline handler + inline script both refused)
  const neg = await page.evaluate(async () => {
    const before = window.__csp.length;
    document.body.insertAdjacentHTML('beforeend', '<img src="data:," onerror="window.__pwned = 1"><img src="data:x," onerror="window.__pwned = 1">');
    const s = document.createElement('script'); s.textContent = 'window.__pwned = 2'; document.body.appendChild(s);
    await new Promise((r) => setTimeout(r, 400));
    return { pwned: window.__pwned, refused: window.__csp.slice(before) };
  });
  check('injected inline handler / script are blocked by the CSP', neg.pwned === undefined && neg.refused.length > 0, JSON.stringify(neg));
} catch (e) { check('the game boots and plays a match', false, e.message); }

// ---- online: hosting a room reaches the Nostr relays (wss: allowed) and the invite carries the code in the fragment
const host = await browser.newPage();
const hostErrs = await watch(host);
await host.goto(`${base}/?skipTitle`);
try {
  await host.waitForFunction(() => window.__inkwave && __inkwave.bootMs && __inkwave.menus && __inkwave.menus.current === 'main', { timeout: 240000, polling: 250 });
  await host.evaluate(() => __inkwave.api.online.host());
  await host.waitForFunction(() => __inkwave.session.view().status === 'lobby', { timeout: 60000, polling: 250 });
  await new Promise((r) => setTimeout(r, 3000));
  const v = await host.evaluate(() => { const s = __inkwave.session.view(); return { link: s.link, code: s.codeText, csp: window.__csp.slice() }; });
  const u = new URL(v.link);
  check('invite link: code only in the fragment (#join=)', u.hash === '#join=' + v.code && !u.search.includes(v.code), v.link.replace(v.code, 'CODE'));
  check('hosting a room: no CSP violations (relay websockets allowed)', v.csp.length === 0, v.csp.slice(0, 4).join(' | '));
  await host.evaluate(() => __inkwave.session.leave());
} catch (e) { check('hosting a room', false, e.message); }
const hostReal = hostErrs.filter((m) => !/WebSocket connection to 'wss:/.test(m));   // public relays that are down: external noise
check('no console errors while hosting (down relays aside)', hostReal.length === 0, hostReal.slice(0, 3).join(' | '));
await browser.close();

let fail = 0;
for (const [ok, name, info] of results) { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info && !ok ? '  — ' + info : ''}`); }
console.log(`\n${results.length - fail}/${results.length} checks passed · ${base}`);
process.exitCode = fail ? 1 : 0;
