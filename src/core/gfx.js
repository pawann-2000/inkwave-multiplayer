// Graphics profiles: the presets, the knobs behind them, Auto (a hardware guess to start from + an in-match frame-rate
// governor that settles on a level per GPU), and the one-time settings migration from the old four-tier `quality`.
// Pure logic — no DOM or three.js at module scope — so node tests import it directly (tools/tests/gfx.test.mjs).
//
// Settings keys (persisted in 'inkwave.settings'):
//   quality  'auto' | 'low' | 'medium' | 'high' | 'ultra' | 'custom'
//   gfx*     the knobs; read only for 'custom' (a preset or Auto supplies them otherwise)
//   gfxDynRes, fpsLimit  display preferences that apply under every preset
// Measured costs behind the presets and the Auto ladder: docs/GRAPHICS.md.

export const GFX_KNOBS = {
  gfxRes: { min: 0.5, max: 1, step: 0.05 },          // render resolution (share of the pixel density below)
  gfxDensity: [1, 1.5, 2],                           // max device pixels per CSS pixel (HiDPI / Retina screens)
  gfxShadows: ['off', 'low', 'medium', 'high'],
  gfxAA: ['off', 'fxaa', 'msaa2', 'msaa4'],
  gfxAO: [false, true],
  gfxBloom: [false, true],
  gfxRefl: ['off', 'low', 'medium', 'high'],         // marina water reflections
  gfxEffects: ['low', 'medium', 'high'],             // particles, screen effects, ink animation
  gfxDetail: ['low', 'medium', 'high'],              // ink atlas, surface textures, prop geometry (next match)
};
export const GFX_KEYS = Object.keys(GFX_KNOBS);

export const GFX_PRESETS = {
  low:    { gfxRes: 0.75, gfxDensity: 1,   gfxShadows: 'low',    gfxAA: 'off',   gfxAO: false, gfxBloom: false, gfxRefl: 'off',    gfxEffects: 'low',    gfxDetail: 'low' },
  medium: { gfxRes: 1,    gfxDensity: 1,   gfxShadows: 'medium', gfxAA: 'msaa2', gfxAO: false, gfxBloom: true,  gfxRefl: 'low',    gfxEffects: 'medium', gfxDetail: 'medium' },
  high:   { gfxRes: 1,    gfxDensity: 1.5, gfxShadows: 'high',   gfxAA: 'msaa4', gfxAO: true,  gfxBloom: true,  gfxRefl: 'medium', gfxEffects: 'high',   gfxDetail: 'high' },
  ultra:  { gfxRes: 1,    gfxDensity: 2,   gfxShadows: 'high',   gfxAA: 'msaa4', gfxAO: true,  gfxBloom: true,  gfxRefl: 'high',   gfxEffects: 'high',   gfxDetail: 'high' },
};
export const PRESET_IDS = ['auto', 'low', 'medium', 'high', 'ultra', 'custom'];

// Auto's ladder, heaviest first. Each step down sheds the next-biggest measured GPU cost for the least visible loss:
// ambient occlusion, then pixel density + MSAA 4× → 2×, then MSAA / big shadows / reflections, then bloom + resolution,
// then resolution alone. Auto never picks Ultra (2× density is a deliberate choice).
export const AUTO_LADDER = [
  { id: 'high', label: 'High', knobs: GFX_PRESETS.high },
  { id: 'high-noao', label: 'High · no AO', knobs: { ...GFX_PRESETS.high, gfxAO: false } },
  { id: 'medium', label: 'Medium', knobs: GFX_PRESETS.medium },
  { id: 'medium-lean', label: 'Medium · lean', knobs: { ...GFX_PRESETS.medium, gfxAA: 'off', gfxShadows: 'low', gfxRefl: 'off' } },
  { id: 'low', label: 'Low', knobs: GFX_PRESETS.low },
  { id: 'low-60', label: 'Low · 60% res', knobs: { ...GFX_PRESETS.low, gfxRes: 0.6 } },
  { id: 'lowest', label: 'Lowest', knobs: { ...GFX_PRESETS.low, gfxRes: 0.5 } },
];
export const TIER_RUNG = { high: 0, medium: 2, low: 4, min: 6 };
const TIER_RANK = { min: 0, low: 1, medium: 2, high: 3 };
const TIERS = ['min', 'low', 'medium', 'high'];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const clampRung = (r) => clamp(Number.isInteger(r) ? r : TIER_RUNG.medium, 0, AUTO_LADDER.length - 1);

// A knob value from settings, or the High preset's when missing / invalid.
function knob(s, k) {
  const spec = GFX_KNOBS[k], v = s ? s[k] : undefined;
  if (Array.isArray(spec)) return spec.includes(v) ? v : GFX_PRESETS.high[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) return GFX_PRESETS.high[k];
  return +clamp(Math.round((v - spec.min) / spec.step) * spec.step + spec.min, spec.min, spec.max).toFixed(2);
}
export function sanitizeKnobs(s) {
  const out = {};
  for (const k of GFX_KEYS) out[k] = knob(s, k);
  return out;
}

// What each knob means to the engine.
export function profileFromKnobs(k) {
  return {
    res: k.gfxRes, density: k.gfxDensity,
    shadows: k.gfxShadows, shadowSize: { off: 0, low: 1024, medium: 2048, high: 4096 }[k.gfxShadows],
    shadowHalfRate: k.gfxShadows === 'low',            // sun shadow map redrawn every other frame
    shadowSoft: k.gfxShadows !== 'low',                // 9-tap soft filter; low = 1 hardware-filtered tap
    msaa: k.gfxAA === 'msaa4' ? 4 : k.gfxAA === 'msaa2' ? 2 : 0, fxaa: k.gfxAA === 'fxaa',
    ao: k.gfxAO, bloom: k.gfxBloom,
    refl: k.gfxRefl, reflScale: { off: 0, low: 0.28, medium: 0.4, high: 0.5 }[k.gfxRefl], reflActors: k.gfxRefl === 'high',
    effects: k.gfxEffects, particles: { low: 0.4, medium: 0.7, high: 1 }[k.gfxEffects],
    screenTaps: { low: 5, medium: 6, high: 8 }[k.gfxEffects], lensScale: k.gfxEffects === 'high' ? 1 / 3 : 1 / 4,
    // ink splats animate their spread only within this distance of the camera (and on screen); farther ones land final
    inkAnimDist: { low: 18, medium: 28, high: 40 }[k.gfxEffects], inkAnimHalfRate: k.gfxEffects === 'low',
    detail: k.gfxDetail, paintAtlas: k.gfxDetail === 'high' ? 4096 : 2048, paintDensity: k.gfxDetail === 'high' ? 30 : 18,
    texlibSize: k.gfxDetail === 'high' ? 512 : 256, levelLite: k.gfxDetail === 'low',
    // volumetric cloud bake (once per theme): 1.6 s of GPU time at 2048×640 on an Intel UHD 630, a quarter at 1024×320
    cloudBake: { high: [2048, 640], medium: [1536, 480], low: [1024, 320] }[k.gfxDetail],
    minimapPx: { high: 7, medium: 5, low: 3.5 }[k.gfxDetail],   // corner minimap pixels per metre (its ink is redrawn per pixel)
  };
}

// settings (+ Auto's current rung) → { preset, rung, knobs, ...engine profile }
export function resolveGfx(s, autoRung) {
  const q = s && s.quality;
  let preset, knobs, rung = -1;
  if (q === 'auto') { preset = 'auto'; rung = clampRung(autoRung); knobs = { ...AUTO_LADDER[rung].knobs }; }
  else if (GFX_PRESETS[q]) { preset = q; knobs = { ...GFX_PRESETS[q] }; }
  else { preset = 'custom'; knobs = sanitizeKnobs(s); }
  return { preset, rung, knobs, ...profileFromKnobs(knobs) };
}

export const sameKnobs = (a, b) => GFX_KEYS.every((k) => a[k] === b[k]);

// One-time migration of settings saved before graphics v2 (four tiers + separate shadows / bloom switches). `raw` is the
// object as stored (before defaults are merged in); `s` is the live settings object, updated in place. The old default
// `high` was saved for everyone once any setting changed, so it becomes Auto; any other tier is kept, and a tier with
// shadows or bloom switched off becomes Custom with those knobs. Returns true when `s` changed.
export function migrateGfxSettings(s, raw) {
  if (!raw || typeof raw !== 'object' || raw.gfxV >= 2) return false;
  const tier = GFX_PRESETS[raw.quality] ? raw.quality : 'high';
  const knobs = { ...GFX_PRESETS[tier] };
  if (raw.shadows === false) knobs.gfxShadows = 'off';
  if (raw.bloom === false) knobs.gfxBloom = false;
  if (sameKnobs(knobs, GFX_PRESETS[tier])) s.quality = tier === 'high' ? 'auto' : tier;
  else { Object.assign(s, knobs); s.quality = 'custom'; }
  delete s.shadows; delete s.bloom;
  s.gfxV = 2;
  return true;
}

// ------------------------------------------------------------------------------------------------ hardware guess
// GPU name as reported by WebGL (unmasked when the browser allows), shortened for display.
export function gpuInfo(gl) {
  let renderer = '', vendor = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    vendor = String(gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || '');
  } catch (e) { /* context lost / blocked: unknown GPU */ }
  return { renderer, vendor, name: gpuName(renderer) };
}
export function gpuName(r) {
  let s = String(r || '');
  const m = /^ANGLE \((.*)\)$/.exec(s);
  if (m) { const parts = m[1].split(', '); s = parts.length >= 2 ? parts[1] : m[1]; }
  s = s.replace(/\((R|TM|tm|r)\)/g, '').replace(/^ANGLE \w+ Renderer: /, '')
    .replace(/\bMesa\b|\bDirect3D\S*|\bvs_\S+|\bps_\S+|\bOpenGL.*$|\bD3D\S*|\(0x[0-9a-f]+\)|\([A-Z]{2,4} GT\d\)/gi, '')
    .replace(/\s+/g, ' ').trim();
  return s || 'Unknown GPU';
}

// renderer string (+ device hints) → starting tier: 'high' | 'medium' | 'low' | 'min'. Deliberately conservative:
// starting a notch low costs a little sharpness until Auto's governor climbs; starting high costs a stuttering match.
export function gpuTier(renderer, env = {}) {
  const r = String(renderer || '');
  let tier;
  if (/swiftshader|llvmpipe|softpipe|lavapipe|software|basic render/i.test(r)) tier = 'min';
  else if (/nvidia|geforce|quadro|rtx|gtx|tesla/i.test(r)) tier = /\bGT \d{3}\b|\bMX ?\d{3}\b|\bNVS\b|GeForce \d{3}M?\b|GeForce [2-9]\d{2}M/i.test(r) ? 'medium' : 'high';
  else if (/radeon|amd/i.test(r)) tier = /\bRX ?\d{3,4}|\bR9\b|\bPro W|Vega (56|64)|Radeon VII/i.test(r) ? 'high' : 'medium';
  else if (/intel/i.test(r)) tier = /\bArc\b/i.test(r) ? 'high' : /iris|\bXe\b/i.test(r) ? 'medium' : 'low';
  else if (/apple/i.test(r)) tier = 'medium';
  else if (/mali|adreno|powervr|videocore|img tec|sgx|tegra/i.test(r)) tier = 'low';
  else tier = 'medium';
  let cap = 'high';
  const lower = (t) => { if (TIER_RANK[t] < TIER_RANK[cap]) cap = t; };
  if (env.deviceMemory && env.deviceMemory <= 2) lower('low'); else if (env.deviceMemory && env.deviceMemory <= 4) lower('medium');
  if (env.cores && env.cores <= 2) lower('low');
  if (env.mobile) lower('low');
  return TIERS[Math.min(TIER_RANK[tier], TIER_RANK[cap])];
}

// ------------------------------------------------------------------------------------------------ Auto governor
// Watches live gameplay frames and moves along AUTO_LADDER. Windows of 2.5 s: one window under 60 % of the target (or
// two in a row under 90 %) steps down; after `upAfter` seconds of windows at the target it probes one step up, and a
// probe that misses the target within its first two windows steps back and doubles `upAfter` (up to 10 min), so a
// machine on the edge settles instead of pumping. The target is min(60, fps limit, display refresh). `refresh` is the
// display's frame interval measured while nothing renders (boot); a window's fastest frames can only shorten it — a
// GPU that steadily needs two vsyncs per frame must read as slow, not as a 30 Hz screen. Frames over 0.25 s (tab
// switches, loading hitches) and the first second after any change or pause are ignored.
export const GOV_WINDOW = 2.5;
export class AutoGovernor {
  constructor({ rung = TIER_RUNG.medium, upAfter = 20, limit = 0, refresh = 1 / 60 } = {}) {
    this.rung = clampRung(rung);
    this.upAfter = clamp(+upAfter || 20, 20, 600);
    this.limit = limit;
    this.enabled = true;
    this.minFrame = clamp(+refresh || 1 / 60, 1 / 250, 1 / 24);   // display refresh interval (s)
    this._dts = [];
    this._t = 0;
    this._grace = 1;
    this._good = 0;
    this._bad = 0;
    this._probe = 0;               // windows left to confirm an upward probe (0 = not probing)
    this.lastFps = 0;
  }
  target() {
    const hz = 1 / this.minFrame;
    return Math.min(60, hz, this.limit > 0 ? this.limit : Infinity);
  }
  _reset() { this._dts.length = 0; this._t = 0; }
  _set(r) {
    r = clampRung(r);
    if (r === this.rung) return -1;
    this.rung = r;
    this._grace = 1;
    this._reset();
    return r;
  }
  // Outside evidence that the GPU is overloaded (a driver reset): drop n rungs now and wait longer before probing up.
  stepDown(n = 1) {
    this._probe = 0; this._good = 0; this._bad = 0;
    this.upAfter = Math.min(this.upAfter * 2, 600);
    return this._set(this.rung + n);
  }

  // dt = seconds since the previous rendered frame; active = live gameplay on screen. Returns the new rung, or -1.
  tick(dt, active) {
    if (!this.enabled || !active || !(dt > 0)) { this._reset(); this._grace = 1; return -1; }
    if (this._grace > 0) { this._grace -= dt; return -1; }
    if (dt > 0.25) return -1;
    this._dts.push(dt); this._t += dt;
    if (this._t < GOV_WINDOW) return -1;
    const d = this._dts.slice().sort((a, b) => a - b);
    const fps = d.length / this._t;
    this.lastFps = fps;
    // a window's 10th-percentile frame (robust to a stray double-fired frame) can reveal a faster display
    const p10 = d[Math.floor(d.length * 0.1)];
    if (p10 >= 1 / 250 && p10 < this.minFrame * 0.97) this.minFrame = p10;
    this._reset();
    const ratio = fps / this.target();
    if (ratio < 0.9) {
      this._good = 0;
      if (this._probe > 0) { this._probe = 0; this._bad = 0; this.upAfter = Math.min(this.upAfter * 2, 600); return this._set(this.rung + 1); }
      if (ratio < 0.6 || ++this._bad >= 2) { this._bad = 0; return this._set(this.rung + 1); }
      return -1;
    }
    this._bad = 0;
    if (this._probe > 0) { this._probe--; return -1; }
    if (ratio >= 0.97) {
      this._good += GOV_WINDOW;
      if (this._good >= this.upAfter && this.rung > 0) { this._good = 0; this._probe = 2; return this._set(this.rung - 1); }
    } else this._good = 0;
    return -1;
  }
}
