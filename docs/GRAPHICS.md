# Graphics settings and performance

INKWAVE starts on **Auto graphics**. It picks a starting level from the GPU and adjusts during matches until the game
holds 60 fps. Players can also choose a fixed preset (Low / Medium / High / Ultra) or tune every option themselves
(Custom). Code: [`src/core/gfx.js`](../src/core/gfx.js) (presets, Auto, migration), `Renderer.setProfile`
([`src/core/renderer.js`](../src/core/renderer.js)) and `Game._applyGfx` ([`src/main.js`](../src/main.js)).

## Settings

**Video** tab: the preset, plus display preferences that apply under every preset.

| Setting | Values | Notes |
|---|---|---|
| Graphics preset | Auto · Low · Med · High · Ultra · Custom | Changing any Graphics option switches to Custom, starting from the current values |
| Render resolution | 50–100 % | Share of full resolution the 3D scene draws at; the menus and HUD stay sharp |
| HiDPI sharpness | 1× · 1.5× · 2× | Device pixels per CSS pixel on Retina / 4K-laptop screens; no effect on standard screens |
| Dynamic resolution | on / off | Fixed presets only: drops the resolution a notch while a match runs under ~40 fps |
| Frame rate limit | 30 · 60 · 120 · Off | Off follows the display. 30 or 60 keeps laptops cooler |

**Graphics** tab: the options each preset sets.

| Option | Values | What it costs |
|---|---|---|
| Shadows | Off · Low · Med · High | Sun shadow map 1K / 2K / 4K. Low redraws it every other frame and uses one filtered tap instead of nine |
| Anti-aliasing | Off · FXAA · 2× · 4× | MSAA multiplies the HDR target's memory traffic. FXAA is one cheap pass |
| Ambient occlusion | on / off | GTAO: renders the scene's normals a second time, then a 12-sample AO and a 16-sample denoise pass. The most expensive effect |
| Bloom glow | on / off | Mip-chain blur of the bright parts |
| Water reflections | Off · Low · Med · High | Planar reflection on Halyard at 28 / 40 / 50 % size. High also reflects squid kids and effects |
| Effects | Low · Med · High | Particle counts (40 / 70 / 100 %), screen-effect blur taps, and how far away ink splats animate (18 / 28 / 40 m) |
| World detail | Low · Med · High | Ink atlas 2K/2K/4K, surface textures 256/256/512 px, prop geometry 60/80/100 %, cloud bake 1024/1536/2048 px wide, minimap 3.5/5/7 px per metre, and at Low a lighter surface shader. **Applies from the next match** |

| Preset | Res | HiDPI | Shadows | AA | AO | Bloom | Reflections | Effects | Detail |
|---|---|---|---|---|---|---|---|---|---|
| Low | 75 % | 1× | Low | Off | – | – | Off | Low | Low |
| Medium | 100 % | 1× | Med | 2× | – | ✓ | Low | Med | Med |
| High | 100 % | 1.5× | High | 4× | ✓ | ✓ | Med | High | High |
| Ultra | 100 % | 2× | High | 4× | ✓ | ✓ | High | High | High |

## Auto

1. **First guess.** WebGL reports the GPU's name. A software renderer starts at the bottom of the ladder, most Intel HD/UHD
   graphics start at Low, and Iris/Xe, integrated Radeon, Apple silicon and low-end GeForce start at Medium. Desktop-class
   GeForce/Radeon/Arc start at High. Mobile GPUs (Mali, Adreno, PowerVR) start at Low, unknown GPUs at Medium. Devices reporting ≤ 4 GB RAM (`navigator.deviceMemory`),
   ≤ 2 CPU cores, or a touch-only screen are capped lower.
2. **The ladder**, heaviest first: High → High without AO → Medium → Medium lean (no MSAA, low shadows, no reflections) →
   Low → Low at 60 % resolution → Lowest (50 %). Each step removes the next-largest measured cost. Auto never picks Ultra.
3. **The governor** runs only during live match play (not in menus, the intro or hidden tabs), in 2.5 s windows:
   - It steps down after one window under 60 % of the target, or two in a row under 90 %.
   - After 20 s of windows at target it probes one step up. If the probe misses the target within two windows, it steps
     back and doubles the wait (up to 10 min).
   - The target is min(60 fps, the frame-rate limit, the display's refresh). The refresh is measured at boot, so a
     50 Hz screen is not read as a slow GPU. A GPU that steadily needs two vsyncs per frame is still read as slow.
   - Frames over 0.25 s and the first second after any change are ignored.
4. **Memory.** The level is saved per GPU name in `localStorage['inkwave.gfxAuto']`, so it is learned once. A different
   GPU (a laptop switching to its discrete card, a driver update that renames it) starts from a fresh guess.

The settings screen shows Auto's current level and the GPU it detected (e.g. `AUTO · LOW`).

## What made the game slow

Measured on an Intel UHD Graphics 630 laptop (i5-9300H), headless Chrome 151 via ANGLE/OpenGL, 1600×900 at 1×, Tidewater,
an autopilot 4 v 4 match. The CPU package ran at 85–98 °C throughout, so absolute numbers are pessimistic. Every
comparison below alternated old and new builds, or interleaved A and B frame by frame. GPU times come from
`EXT_disjoint_timer_query_webgl2`. Wall-clock timing with `gl.finish()` is misleading in Chrome: it returned after ~5 ms
while the GPU needed ~67 ms.

**The old default was High:** ~13 fps in a match on this GPU. Its GPU cost per frame (1400×787, paired A/B, ± standard error):

| Effect at High | GPU ms / frame |
|---|---|
| Whole frame | ~67 (~85 at 1600×900) |
| Ambient occlusion (GTAO) | 23.1 ± 0.2 |
| MSAA 4× | 15.2 ± 0.6 |
| Screen effects pass (when active) | 3.5 ± 0.3 |
| Bloom | 3.0 ± 0.3 |
| Grade pass | 2.6 ± 0.5 |
| Shadow map redraw (4K) | 2.1 ± 0.4 |

**The ink atlas.** It cost 16.3 ms per flush at 4K and 6.8 ms at 2K:

- Every splat still spreading or dripping was redrawn every frame with the full splat shader, over its whole footprint.
  That was 130–180 splats in flight at once, including those far away or off screen.
- Drying swept the whole atlas 20 times a second.
- The atlas's full mip chain was rebuilt after every draw.

**The surface shader** of the arena (texture library with anti-tiling, cubic ink reconstruction, ink ripples) was the
single most expensive object on screen at Low. Its cost depends heavily on how much floor the camera sees.

## What changed

| Change | Effect (same machine) |
|---|---|
| Auto is the default | Starts this GPU at Low and settles at Low 60 % or Lowest: **~50 fps** average in a match (30 s run: 33–41 fps at Low, 47–54 at 60 %, then mostly 60 at Lowest), against **~13 fps** on the old default |
| Ink: only splats near the camera and on screen animate their spread; the rest land in their final shape in one draw. Drying runs 5 times a second in bigger steps; mips rebuild at most every other frame | Ink GPU time per frame at High **10.5–10.8 → 4.6–5.3 ms**; at Low **2.4–2.7 → 0.85–0.94 ms**. Splats in flight 95–180 → 20–55 |
| Low world detail: lighter surface shader (no close-up cubic ink, no ripples, one texture tap). Low shadows: one filtered tap | Rest of the frame at Low (1200×675) **27.4–29.6 → 23.2–25.1 ms** |
| Low preset overall (same resolution) | GPU **~30–32 → ~24–26 ms** per frame; in-match **25–30 → 30–36 fps** |
| New Lowest level (800×450) | GPU 12.1 ms per frame, CPU 7.5 ms: 60 fps most of the time on this machine |
| Renderer: old post passes are disposed on every rebuild (they leaked); the AO buffer keeps its full size after a window resize (it dropped to CSS-pixel size) | After 12 settings switches, live GPU textures went **50 → 202** before, **50 → 50** now |

## Boot, download and phones

Same laptop and method as above. "4× CPU" is Chrome's CPU throttling in a landscape-phone emulation (844×390, DPR 3,
touch): roughly a mid-range phone's JavaScript speed. The GPU stays the UHD 630's, so phone GPU cost is not emulated.
Before/after rows come from runs alternated with the committed baseline, three rounds each.

**Boot** (first visit, empty shader cache, Auto → Low): **17.5 → 9.3 s**. With a warm cache it is 4.2–4.5 s. At 4× CPU
the baseline booted in 25.2–25.8 s and the current code in 16.6–17.1 s.

- three.js keys a shader program on the render target it draws into (tone mapping and output colour space differ between
  the canvas and an offscreen target). The boot pre-compile ran against the canvas, but every scene draw goes into the
  composer's HDR target, so about 50 of 128 programs were built twice. It now compiles against that target, hidden pools
  and props included: **81 programs**.
- The volumetric cloud bake took 1.64 s of GPU at 2048×640. It is now sized by world detail: 1024×320 at Low.
- The menu showcase's warm-up waits until after boot, and a timing-only GPU readback in the texture bake is gone.
- Benchmark trap: Chrome writes its shader cache to disk asynchronously. A browser closed seconds after boot loses it,
  and the next "warm" boot is really cold.

**Download.** The release build bundles, minifies and code-splits the game with esbuild. Online play and other lazy
parts are separate chunks. Every chunk has a content-hashed name and is cached as immutable, and the entry's imports are
preloaded. Development still runs the sources as they are.

- 73 JS files and 1.25 MB gzip (the old `dist/`) → **27 files and 0.79 MB gzip**.
- The main menu loads the stage thumbnails only; the full stage art loads on the stage screen.

**Frame time on a phone-class CPU** (4× CPU, Auto, sound on, a 4 v 4 autopilot match on Tidewater):

| | Before | After |
|---|---|---|
| Frame rate (median of 3) | 17.3 fps | 19.8 fps |
| Render submit per frame | ~16.9 ms | ~12.3 ms |
| Draw calls per frame | ~149 | ~99 |

What the profiles and traces found, and what changed:

- **Forced layouts.** Per-frame reads of `window.innerWidth` / `innerHeight` (renderer resize check, HUD, map pins) and
  of the ink tank canvas's `clientWidth` made the browser recompute style and layout mid-frame, after the HUD had
  already changed the DOM. In a 4 s trace, 270 of 345 ms of style and layout work was forced this way. Per-frame code
  now reads a viewport size kept by one `resize` listener (`view` in `src/core/ctx.js`).
- **Audio node churn.** Every sound effect built its own synth graph when played, about 18 Web Audio nodes. A match
  plays about 40 sounds a second, so that was about 900 node creations a second. Now each one-shot's first play is
  synthesized live while it renders offline into three takes; later plays replay a take through one buffer source.
  Result: 4.9 nodes per sound and 438 node creations a second (the rest is the music sequencer and loops). Offline
  takes match live renders in length (to −60 dB) and peak. Muted sound effects build nothing.
- **Minimap.** Its ink field was recomputed per pixel at 7 px/m, the density of the old full-screen TAB map. It now
  follows world detail (7 / 5 / 3.5 px/m), recomposes only when something on it changed, and is skipped while hidden.
  Its share of CPU samples fell from 6.9 % to 2.2 %.
- **Draw calls.** The 8 squidkids were about 94 of 155 draw calls per frame at Low. With Low shadows only their bodies
  cast shadows: squidkid shadow-pass draws went from about 21 to about 8 per frame. The hair, weapon and bomb shadows
  were smaller than a texel of that map anyway. Distant squidkids skip the tank's glass shell.

Measured and left alone:

- **Squidkid mesh detail.** The squidkids are about half the frame's triangles at Low (645k with them, 331k hidden,
  shadows included). Hiding them changed GPU time by 0.04 ms per frame (8.39 vs 8.35 ms, interleaved), so LOD meshes
  would not pay. On this class of hardware the limit is CPU work per draw call, not vertices.

Still on the table at 4× CPU:

- about 17 ms of simulation and 12 ms of render submit per frame, then about 4 ms of HUD and menu updates;
- the browser's own style and paint, about 8 ms;
- the music sequencer, about 2 ms: it still synthesizes every note live.

## Driver resets

Weak or overloaded GPUs get reset by their driver (Windows TDR, Linux i915 hang checks), and WebGL reports the context
as lost. The game keeps simulating (online play stays in sync) and pauses rendering. When the browser restores the
context it redraws everything that lived only in GPU memory:

- the surface texture library;
- the sky, light probe and far-reflection bakes;
- the ink atlas, rebuilt from the gameplay turf grid. Turf is exact; splat outlines become 25 cm squares.

It then recompiles shaders in the background and resumes. A second reset under Auto drops two levels.

Boot-time bakes (the texture library layers, cloud strips, sky probe, far reflections) are submitted as separate short
GPU batches. As one long batch they exceeded the Intel driver's ~640 ms preemption timeout and reset the GPU at boot.

## Settings migration

Saves from before this system had `quality` (low / medium / high / ultra) plus `shadows` and `bloom` switches. On first
boot:

- The old default `high` becomes **Auto**. It was saved for everyone who ever changed any setting, so it can't be told
  apart from a deliberate choice.
- Low, Medium and Ultra are kept.
- A tier with shadows or bloom switched off becomes Custom with those options.

## Measuring

```bash
npm start                                    # dev server
node tools/gfx-bench.mjs low                 # fps + GPU ms/frame (scene / ink) at a preset
node tools/gfx-bench.mjs '{"quality":"custom","gfxAO":false}' --map halyard --secs 20
```

`CHROME_PATH` selects the browser, as for the other tools. Compare builds or settings with alternating runs. A hot laptop
drifts by tens of percent over a few minutes.
