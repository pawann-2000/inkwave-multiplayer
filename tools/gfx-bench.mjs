// Graphics benchmark: a live autopilot match at given graphics settings → frames per second and GPU milliseconds per
// frame (EXT_disjoint_timer_query_webgl2), split into the ink atlas (paint.flush) and everything else (renderer).
// GPU time is the honest cost: in Chrome gl.finish() returns long before the GPU is done, so wall-clock timing of a
// frame measures command submission, not rendering. Runs are only comparable on the same machine in the same thermal
// state — alternate A/B runs rather than doing all of A then all of B.
//
// usage: node tools/gfx-bench.mjs [settings-json|preset] [--map tidewater] [--secs 15] [--w 1600 --h 900 --dpr 1]
//        e.g.  node tools/gfx-bench.mjs low        node tools/gfx-bench.mjs '{"quality":"custom","gfxAO":false}'
// The dev server must be running (npm start); URL via --url (default http://localhost:8490). Dynamic resolution and
// Auto's governor are held still during the measurement so every run renders at the settings given.
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const first = args[0] && !args[0].startsWith('--') ? args[0] : 'auto';
const settings = { master: 0, gfxV: 2, ...(first.startsWith('{') ? JSON.parse(first) : { quality: first }) };
const url = opt('url', 'http://localhost:8490'), map = opt('map', 'tidewater'), secs = +opt('secs', 15);
const W = +opt('w', 1600), H = +opt('h', 900), DPR = +opt('dpr', 1);

const MAC = process.platform === 'darwin';
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: 'new', protocolTimeout: 600000,
  args: [...(MAC ? ['--use-angle=metal'] : ['--use-gl=angle', '--use-angle=gl-egl']), '--enable-gpu', '--ignore-gpu-blocklist'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: DPR },
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.evaluateOnNewDocument((s) => localStorage.setItem('inkwave.settings', JSON.stringify(s)), settings);
await page.goto(`${url}/?autostart=180&autopilot&map=${map}`);
await page.waitForFunction(() => window.__inkwave && __inkwave.match && __inkwave.match.state === 'playing' && __inkwave.match.local, { timeout: 240000, polling: 250 });
await new Promise((r) => setTimeout(r, 3000));
const out = await page.evaluate(async (secs) => {
  const I = __inkwave, G = __G, gl = I.R.renderer.getContext();
  I._gov.enabled = false; I._dyn = null; I.settings.gfxDynRes = false; I.R.setDynamicScale(1);
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const rec = { ink: [], scene: [], frame: [] }, pend = [];
  if (ext) {
    const timed = (obj, name, key) => {
      const o = obj[name];
      obj[name] = function (...a) { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); try { return o.apply(this, a); } finally { gl.endQuery(ext.TIME_ELAPSED_EXT); pend.push([key, q]); } };
    };
    timed(G.paint, 'flush', 'ink');
    timed(I.R, 'render', 'scene');
  }
  let last = performance.now();
  const t0 = last;
  await new Promise((done) => {
    const f = (now) => {
      rec.frame.push(now - last); last = now;
      for (let i = pend.length - 1; i >= 0; i--) {
        const [k, q] = pend[i];
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) rec[k].push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q); pend.splice(i, 1);
      }
      if (now - t0 < secs * 1000) requestAnimationFrame(f); else done();
    };
    requestAnimationFrame(f);
  });
  const st = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +s[s.length >> 1].toFixed(2), p90: +s[Math.floor(s.length * 0.9)].toFixed(2) }; };
  const fr = rec.frame.slice(1);
  return {
    gfx: I.gfxState(), gpu: I.gfxStatus().gpu, px: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    fps: +(fr.length / (fr.reduce((x, y) => x + y, 0) / 1000)).toFixed(1), frameMs: st(fr), ink: st(rec.ink), scene: st(rec.scene), timerQuery: !!ext,
    boot: I.bootMs,
  };
}, secs);
await browser.close();
console.log(`${out.gpu} · ${map} · ${out.gfx} · ${out.px.join('×')} px · boot ${out.boot} ms`);
console.log(`  ${out.fps} fps   frame interval ms ${JSON.stringify(out.frameMs)}`);
if (out.timerQuery) {
  console.log(`  GPU ms/frame: scene ${JSON.stringify(out.scene)}`);
  console.log(`                ink   ${JSON.stringify(out.ink)}`);
} else console.log('  (no GPU timer queries in this browser: fps only)');
if (errors.length) { console.log('  page errors:', errors.slice(0, 5).join(' | ')); process.exitCode = 1; }
