// Scripted play-through for audits.
// usage: node tools/play.mjs <url> <script.json|inline-json> [--w 1600 --h 900]
// script: [{"wait":ms},{"down":"KeyW"},{"up":"KeyW"},{"press":"Space"},{"mouse":"down"|"up"},{"move":[dx,dy]},
//          {"shot":"/path.png"},{"eval":"js"},{"log":"label"}]
import puppeteer from 'puppeteer-core';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const raw = args[1];
const steps = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const W = +opt('w', 1600), H = +opt('h', 900);

// CHROME_PATH overrides the browser (e.g. a Chrome for Testing build on Linux)
const MAC = process.platform === 'darwin';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: 'new',
  args: [...(MAC ? ['--use-angle=metal'] : ['--use-gl=angle', '--use-angle=gl-egl']), '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning' || process.env.ALLLOGS) logs.push(`[${t}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}`));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
for (const s of steps) {
  if (s.until) { try { await page.waitForFunction(s.until, { timeout: 180000, polling: 150 }); } catch { console.log('until timeout', s.until); } }
  if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
  if (s.down) await page.keyboard.down(s.down);
  if (s.up) await page.keyboard.up(s.up);
  if (s.press) await page.keyboard.press(s.press);
  if (s.mouse === 'down') await page.mouse.down();
  if (s.mouse === 'up') await page.mouse.up();
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.eval) { try { const r = await page.evaluate(s.eval); if (r !== undefined) console.log((s.log || 'eval') + ' ->', typeof r === 'string' ? r : JSON.stringify(r)); } catch (e) { console.log('eval error', e.message); } }
  if (s.shot) { mkdirSync(dirname(s.shot), { recursive: true }); await page.screenshot({ path: s.shot }); console.log('shot', s.shot); }
}
if (logs.length) console.log(logs.filter((l) => !/404|preload/.test(l)).slice(0, 40).join('\n'));
await browser.close();
