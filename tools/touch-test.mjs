// A phone plays INKWAVE through real touch input: a landscape phone (844×390, DPR 2, mobile + touch emulation) driven
// with CDP Input.dispatchTouchEvent, i.e. the browser's own touch + pointer events. Checks device detection, the title
// tap, touch prompts in the menus, the move stick, drag-to-look, FIRE (hold + slide to aim), SWIM, JUMP, SUB, two thumbs
// at once, the map + a Super Jump by tapping a teammate's pin, PAUSE, and the portrait "turn your phone" overlay.
// usage: node tools/touch-test.mjs [url=http://localhost:8490] [--shots dir]     (CHROME_PATH selects the browser)
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:/.test(a)) || 'http://localhost:8490';
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1] : '';
if (shots) mkdirSync(shots, { recursive: true });
const W = 844, H = 390;
const MAC = process.platform === 'darwin';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: 'new', protocolTimeout: 600000,
  args: [...(MAC ? ['--use-angle=metal'] : ['--use-gl=angle', '--use-angle=gl-egl']), '--ignore-gpu-blocklist'],
});
const p = await browser.newPage();
await p.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36');
await p.setViewport({ width: W, height: H, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
const cdp = await p.createCDPSession();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.evaluateOnNewDocument(() => localStorage.setItem('inkwave.settings', JSON.stringify({ master: 0 })));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (fn, ...a) => p.evaluate(fn, ...a);
const shot = (name) => (shots ? p.screenshot({ path: `${shots}/${name}.png` }) : null);
// touch points [[x, y, id], …]; CDP diffs each event against the previous one (press / move / release per point)
const touch = (type, pts = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
const tap = async (x, y, id) => { await touch('touchStart', [[x, y, id]]); await touch('touchEnd'); };
const center = (sel) => ev((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r && r.width ? [r.x + r.width / 2, r.y + r.height / 2] : null; }, sel);
const me = () => ev(() => { const a = __inkwave.match.local; return { x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: __inkwave.rig.yaw, form: a.form, ink: a.ink, sj: !!a.superJumpState, fire: a.intent.fire }; });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  ' + info : ''}`); };

await p.goto(base + '/');
await p.waitForFunction(() => window.__inkwave && __inkwave.bootMs && __inkwave.menus.current === 'title', { timeout: 300000, polling: 250 });
await sleep(3500);   // the title's reveal
const boot = await ev(() => ({ body: document.body.classList.contains('is-touch'), menus: document.querySelector('.iw-ui').classList.contains('is-touch'), device: __inkwave.input.lastDevice, press: document.querySelector('.iw-title__presstext')?.textContent }));
check('a phone starts in touch mode, title says TAP TO START', boot.body && boot.menus && boot.device === 'touch' && boot.press === 'TAP TO START', JSON.stringify(boot));
await shot('1-title');
await tap(W / 2, H / 2, 1);
await p.waitForFunction(() => __inkwave.menus.current === 'main', { timeout: 10000, polling: 100 }).catch(() => {});
await sleep(1200);
const mm = await ev(() => ({ cur: __inkwave.menus.current, audio: !!__inkwave._audioOn, prompts: [...document.querySelectorAll('.iw-prompts')].map((e) => getComputedStyle(e).display) }));
check('tapping the title opens the main menu and unlocks audio', mm.cur === 'main' && mm.audio, JSON.stringify(mm));
check('no keyboard / pad prompt bars in touch mode', mm.prompts.every((d) => d === 'none'), JSON.stringify(mm.prompts));
await shot('2-main');

await ev(() => __inkwave.api.startMatch({ mapId: 'tidewater', duration: 180 }));
await p.waitForFunction(() => __inkwave.match && !__inkwave.match.attract && __inkwave.match.state === 'playing', { timeout: 120000, polling: 250 });
await sleep(1500);
const vis = await ev(() => ({ on: document.querySelector('.iw-touch')?.classList.contains('is-on'), locked: __inkwave.input.locked }));
check('touch controls shown in a live match, no pointer lock', vis.on && !vis.locked, JSON.stringify(vis));
await shot('3-match');

// move stick: press lower-left, push up (forward) and hold
let a0 = await me();
await touch('touchStart', [[150, 300, 1]]);
for (let i = 1; i <= 6; i++) { await touch('touchMove', [[150, 300 - i * 10, 1]]); await sleep(16); }
await sleep(900);
let a1 = await me();
await touch('touchEnd');
const fwd = (a1.x - a0.x) * Math.sin(a0.yaw) + (a1.z - a0.z) * Math.cos(a0.yaw), dist = Math.hypot(a1.x - a0.x, a1.z - a0.z);
check('the stick moves the player forward', fwd > 2 && fwd > dist * 0.8, `${fwd.toFixed(2)} m forward of ${dist.toFixed(2)} m`);
await sleep(300);
const rel = await ev(() => ({ mx: __inkwave.input.touch.mx, my: __inkwave.input.touch.my }));
check('lifting the thumb stops the move', rel.mx === 0 && rel.my === 0, JSON.stringify(rel));

// look: drag 100 px left on the right half → yaw grows by ≈ 100 × 0.0068 rad (less under aim-assist friction)
a0 = await me();
await touch('touchStart', [[640, 120, 2]]);
for (let i = 1; i <= 10; i++) { await touch('touchMove', [[640 - i * 10, 120, 2]]); await sleep(16); }
await touch('touchEnd');
await sleep(200);
a1 = await me();
check('dragging on the right turns the camera', a1.yaw - a0.yaw > 0.35 && a1.yaw - a0.yaw < 0.8, `Δyaw ${(a1.yaw - a0.yaw).toFixed(3)} rad`);

// FIRE: hold, then slide the same finger to aim
const fireC = await center('.iw-tb--fire');
a0 = await me();
await touch('touchStart', [[fireC[0], fireC[1], 3]]);
await sleep(250);
const firing = await me();
for (let i = 1; i <= 5; i++) { await touch('touchMove', [[fireC[0] + i * 6, fireC[1], 3]]); await sleep(16); }
await sleep(600);
a1 = await me();
await touch('touchEnd');
check('FIRE: holding fires, sliding aims', firing.fire && a1.ink < a0.ink && a1.yaw < a0.yaw, `ink ${a0.ink.toFixed(0)}→${a1.ink.toFixed(0)}, Δyaw ${(a1.yaw - a0.yaw).toFixed(3)}`);
await sleep(300);

const swimC = await center('.iw-tb--swim');
await touch('touchStart', [[swimC[0], swimC[1], 4]]);
await sleep(400);
const sq = await me();
await touch('touchEnd');
await sleep(300);
check('SWIM: holding turns you into a squid', sq.form === 'squid', sq.form);

const jumpC = await center('.iw-tb--jump');
a0 = await me();
await touch('touchStart', [[jumpC[0], jumpC[1], 5]]); await sleep(120); await touch('touchEnd');
let peak = a0.y;
for (let i = 0; i < 12; i++) { await sleep(30); peak = Math.max(peak, (await me()).y); }
check('JUMP: a tap jumps', peak > a0.y + 0.4, `y ${a0.y.toFixed(2)} → ${peak.toFixed(2)}`);
await sleep(600);

const subC = await center('.iw-tb--sub');
a0 = await me();
await touch('touchStart', [[subC[0], subC[1], 6]]);
await sleep(400);
const aiming = await ev(() => __inkwave.match.local.weaponRunner.aimingSub);
await touch('touchEnd');
await sleep(300);
a1 = await me();
check('SUB: hold aims the bomb, release throws it', aiming && a1.ink < a0.ink - 10, `ink ${a0.ink.toFixed(0)}→${a1.ink.toFixed(0)}`);

// two thumbs: move and fire together
a0 = await me();
await touch('touchStart', [[150, 300, 7]]);
await touch('touchMove', [[150, 250, 7]]);
await touch('touchStart', [[150, 250, 7], [fireC[0], fireC[1], 8]]);
await sleep(700);
const both = await me();
await touch('touchEnd');
check('two thumbs: move and fire at once', both.fire && Math.hypot(both.x - a0.x, both.z - a0.z) > 1);
await sleep(500);

// MAP: the diorama opens, the fight buttons step aside, tapping a teammate's pin super jumps and closes the map
const mapC = await center('.iw-tb--map');
await tap(mapC[0], mapC[1], 9);
await p.waitForFunction(() => __inkwave.rig.mapK > 0.95, { timeout: 5000, polling: 50 }).catch(() => {});
await sleep(400);
const mp = await ev(() => ({
  k: __inkwave.rig.mapK, hidden: getComputedStyle(document.querySelector('.iw-tb--fire')).display === 'none',
  pins: [...document.querySelectorAll('.iw-pin.is-ok:not(.iw-pin--self)')].map((e) => { const b = e.querySelector('.iw-pin__badge').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; }),
}));
check('MAP opens the stage map, fight buttons step aside', mp.k > 0.9 && mp.hidden, `mapK ${mp.k.toFixed(2)}`);
await shot('4-map');
const pin = mp.pins.find(([x, y]) => x > 0 && x < W && y > 0 && y < H);
if (pin) await tap(pin[0], pin[1], 10);
await sleep(250);
const sj = await me();
const closed = await ev(() => !__inkwave.input.touch.map);
check('tapping a teammate pin super jumps and closes the map', !!pin && sj.sj && closed, pin ? '' : 'no tappable pin');
await p.waitForFunction(() => !__inkwave.match.local.superJumpState, { timeout: 15000, polling: 100 }).catch(() => {});
await sleep(800);

const pauseC = await center('.iw-tb--pause');
await tap(pauseC[0], pauseC[1], 11);
await sleep(700);
const pz = await ev(() => ({ cur: __inkwave.menus.current, paused: __inkwave.match.paused, ctl: document.querySelector('.iw-touch').classList.contains('is-on') }));
check('PAUSE opens the pause menu and hides the controls', pz.cur === 'pause' && pz.paused && !pz.ctl, JSON.stringify(pz));
await shot('5-pause');

await p.setViewport({ width: H, height: W, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false });
await sleep(800);
const rot = await ev(() => getComputedStyle(document.getElementById('rotate')).display);
check('holding the phone upright shows "turn your phone sideways"', rot !== 'none', rot);
await shot('6-portrait');
check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
