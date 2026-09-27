// Graphics profiles (src/core/gfx.js): presets → knobs, Custom sanitising, the settings migration, the GPU guess, and
// the Auto governor's stepping, probing and back-off against synthetic frame streams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GFX_PRESETS, GFX_KEYS, AUTO_LADDER, TIER_RUNG, resolveGfx, sanitizeKnobs, migrateGfxSettings, gpuTier, gpuName,
  AutoGovernor, GOV_WINDOW,
} from '../../src/core/gfx.js';

test('presets resolve to exactly their knobs; Auto follows its ladder', () => {
  for (const [id, knobs] of Object.entries(GFX_PRESETS)) {
    const p = resolveGfx({ quality: id, gfxShadows: 'off' }, 0);   // stored knobs never leak into a preset
    assert.equal(p.preset, id);
    assert.deepEqual(p.knobs, knobs);
  }
  for (let r = 0; r < AUTO_LADDER.length; r++) {
    const p = resolveGfx({ quality: 'auto' }, r);
    assert.equal(p.rung, r);
    assert.deepEqual(p.knobs, AUTO_LADDER[r].knobs);
  }
  assert.equal(resolveGfx({ quality: 'auto' }, 99).rung, AUTO_LADDER.length - 1);
  assert.equal(resolveGfx({ quality: 'auto' }, -3).rung, 0);
  assert.equal(resolveGfx({ quality: 'auto' }, undefined).rung, TIER_RUNG.medium);
});

test('the Auto ladder gets strictly cheaper at every step (no step undoes a saving)', () => {
  const cost = (k) => {
    const p = resolveGfx({ quality: 'custom', ...k });
    return [p.res * p.density, p.msaa, p.ao ? 1 : 0, p.bloom ? 1 : 0, p.shadowSize, p.reflScale, p.particles];
  };
  for (let r = 1; r < AUTO_LADDER.length; r++) {
    const a = cost(AUTO_LADDER[r - 1].knobs), b = cost(AUTO_LADDER[r].knobs);
    assert.ok(b.every((v, i) => v <= a[i]), `rung ${r} is not lighter than rung ${r - 1}: ${a} → ${b}`);
    assert.ok(b.some((v, i) => v < a[i]), `rung ${r} saves nothing over rung ${r - 1}`);
  }
});

test('Custom takes the stored knobs, snapping / replacing anything invalid', () => {
  const p = resolveGfx({ quality: 'custom', gfxRes: 0.63, gfxDensity: 3, gfxShadows: 'huge', gfxAA: 'fxaa', gfxAO: 'yes', gfxBloom: false, gfxRefl: 'low', gfxEffects: 'medium', gfxDetail: 'low' });
  assert.equal(p.preset, 'custom');
  assert.equal(p.knobs.gfxRes, 0.65);                         // 5 % steps
  assert.equal(p.knobs.gfxDensity, GFX_PRESETS.high.gfxDensity);
  assert.equal(p.knobs.gfxShadows, GFX_PRESETS.high.gfxShadows);
  assert.equal(p.knobs.gfxAO, GFX_PRESETS.high.gfxAO);       // non-boolean → default
  assert.equal(p.fxaa, true); assert.equal(p.msaa, 0);
  assert.equal(p.bloom, false); assert.equal(p.reflScale, 0.28); assert.equal(p.particles, 0.7);
  assert.equal(p.paintAtlas, 2048); assert.equal(p.levelLite, true);
  assert.equal(sanitizeKnobs({ gfxRes: 0.2 }).gfxRes, 0.5);
  assert.equal(sanitizeKnobs({ gfxRes: 7 }).gfxRes, 1);
  assert.equal(sanitizeKnobs({ gfxRes: NaN }).gfxRes, 1);
  assert.deepEqual(Object.keys(sanitizeKnobs({})), GFX_KEYS);
  // unknown quality ids are Custom too (never a crash, never a silent preset)
  assert.equal(resolveGfx({ quality: 'potato' }).preset, 'custom');
});

test('migration: the old default High becomes Auto, other tiers stay, switched-off extras become Custom', () => {
  const run = (raw) => { const s = { quality: raw.quality ?? 'high', shadows: raw.shadows ?? true, bloom: raw.bloom ?? true, fov: 80 }; const changed = migrateGfxSettings(s, raw); return { s, changed }; };
  let r = run({});                                            // saved before any graphics change: old default
  assert.ok(r.changed); assert.equal(r.s.quality, 'auto'); assert.equal(r.s.gfxV, 2);
  assert.ok(!('shadows' in r.s) && !('bloom' in r.s)); assert.equal(r.s.fov, 80);
  assert.equal(run({ quality: 'high' }).s.quality, 'auto');
  assert.equal(run({ quality: 'ultra' }).s.quality, 'ultra');
  assert.equal(run({ quality: 'medium' }).s.quality, 'medium');
  assert.equal(run({ quality: 'low', bloom: false }).s.quality, 'low');   // Low never had bloom: still the preset
  assert.equal(run({ quality: 'nonsense' }).s.quality, 'auto');
  r = run({ quality: 'high', shadows: false });
  assert.equal(r.s.quality, 'custom');
  assert.deepEqual(resolveGfx(r.s).knobs, { ...GFX_PRESETS.high, gfxShadows: 'off' });
  r = run({ quality: 'medium', bloom: false, shadows: false });
  assert.deepEqual(resolveGfx(r.s).knobs, { ...GFX_PRESETS.medium, gfxShadows: 'off', gfxBloom: false });
  // fresh install (nothing stored) and already-migrated saves are left alone
  const fresh = { quality: 'auto', gfxV: 2 };
  assert.equal(migrateGfxSettings(fresh, null), false);
  const done = { quality: 'high', gfxV: 2 };
  assert.equal(migrateGfxSettings(done, { quality: 'high', gfxV: 2 }), false);
  assert.equal(done.quality, 'high');
});

test('GPU guess: renderer strings → starting tier, capped by weak devices', () => {
  const cases = [
    ['ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)', 'low'],
    ['ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (NVIDIA, NVIDIA GeForce MX150 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (NVIDIA, NVIDIA GeForce GT 710 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'high'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'medium'],
    ['Apple GPU', 'medium'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'min'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'min'],
    ['Mali-G78', 'low'], ['Adreno (TM) 640', 'low'],
    ['', 'medium'], ['Some Future GPU 9000', 'medium'],
  ];
  for (const [r, want] of cases) assert.equal(gpuTier(r), want, r);
  const rtx = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  assert.equal(gpuTier(rtx, { deviceMemory: 4 }), 'medium');
  assert.equal(gpuTier(rtx, { deviceMemory: 2 }), 'low');
  assert.equal(gpuTier(rtx, { cores: 2 }), 'low');
  assert.equal(gpuTier(rtx, { mobile: true }), 'low');
  assert.equal(gpuTier('llvmpipe', { deviceMemory: 16 }), 'min');   // caps only ever lower
  assert.equal(gpuName('ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)'), 'Intel UHD Graphics 630');
  assert.equal(gpuName('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)'), 'NVIDIA GeForce RTX 3060');
  assert.equal(gpuName('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), 'Apple M2');
  assert.equal(gpuName(''), 'Unknown GPU');
});

// ---- governor: feed synthetic frame times
const run = (gov, seconds, dt, active = true) => {
  const changes = [];
  for (let t = 0; t < seconds; t += dt) { const r = gov.tick(dt, active); if (r >= 0) changes.push(r); }
  return changes;
};

test('governor: a machine that cannot hold the target steps down, one rung per verdict', () => {
  const g = new AutoGovernor({ rung: 0 });
  // 25 fps is under 60 % of 60: one window per step (each change is followed by 1 s of settling)
  const ch = run(g, 3 * (1 + GOV_WINDOW) + 0.5, 1 / 25);
  assert.deepEqual(ch, [1, 2, 3]);
  // 50 fps (83 %): needs two slow windows in a row
  const g2 = new AutoGovernor({ rung: 2 });
  assert.deepEqual(run(g2, 1 + GOV_WINDOW * 1.5, 1 / 50), []);
  assert.deepEqual(run(g2, GOV_WINDOW * 1.2, 1 / 50), [3]);
  // never past the lightest rung
  const g3 = new AutoGovernor({ rung: AUTO_LADDER.length - 1 });
  assert.deepEqual(run(g3, 30, 1 / 10), []);
  assert.equal(g3.rung, AUTO_LADDER.length - 1);
});

test('governor: a steady 30 fps on a 60 Hz screen is slow, not a 30 Hz screen', () => {
  const g = new AutoGovernor({ rung: 2, refresh: 1 / 60 });
  assert.deepEqual(run(g, 1 + GOV_WINDOW * 1.1, 1 / 30), [3]);
});

test('governor: holds when the display or the fps limit is the cap', () => {
  const g50 = new AutoGovernor({ rung: 2, refresh: 1 / 50 });   // 50 Hz screen
  assert.deepEqual(run(g50, 12, 1 / 50), []);
  const lim = new AutoGovernor({ rung: 2, limit: 30 });
  assert.deepEqual(run(lim, 12, 1 / 30), []);
  const hz144 = new AutoGovernor({ rung: 3, refresh: 1 / 144 });  // fast screen: the target is still 60
  assert.deepEqual(run(hz144, 12, 1 / 58), []);
});

test('governor: probes up after sustained headroom; a failed probe steps back and doubles the wait', () => {
  const g = new AutoGovernor({ rung: 3, upAfter: 20 });
  assert.deepEqual(run(g, 1 + 20 + GOV_WINDOW * 0.5, 1 / 60), [2]);   // 20 s at target → probe up to rung 2
  assert.deepEqual(run(g, 1 + GOV_WINDOW * 1.1, 1 / 40), [3]);        // first window of the probe misses (40 fps) → back
  assert.equal(g.upAfter, 40);
  assert.deepEqual(run(g, 1 + 30, 1 / 60), []);                      // not yet: now needs 40 s
  assert.deepEqual(run(g, 12, 1 / 60), [2]);
  // this probe holds for its two confirmation windows → stays
  assert.deepEqual(run(g, 1 + GOV_WINDOW * 2.2, 1 / 60), []);
  assert.equal(g.rung, 2);
  assert.equal(g.upAfter, 40);
});

test('governor: stepDown (driver reset) drops rungs at once and delays the next probe', () => {
  const g = new AutoGovernor({ rung: 1, upAfter: 20 });
  assert.equal(g.stepDown(2), 3);
  assert.equal(g.upAfter, 40);
  assert.equal(g.stepDown(9), AUTO_LADDER.length - 1);
  assert.equal(g.stepDown(1), -1);                  // already the lightest
});

test('governor: menus / hidden tabs / stalls never count', () => {
  const g = new AutoGovernor({ rung: 1 });
  assert.deepEqual(run(g, 30, 1 / 10, false), []);   // inactive (menus, intro, hidden)
  assert.deepEqual(run(g, 3, 0.5), []);             // stalls over 0.25 s (tab switch, compile hitch)
  assert.equal(g.rung, 1);
  const g2 = new AutoGovernor({ rung: 1 });
  g2.enabled = false;
  assert.deepEqual(run(g2, 20, 1 / 10), []);
});
