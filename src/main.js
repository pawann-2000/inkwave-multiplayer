// INKWAVE — boot, main loop and game-flow orchestration (menus ⇄ attract mode ⇄ matches ⇄ results).
import * as THREE from 'three';
import { G, on, emit, clamp, damp, view } from './core/ctx.js';
import { Renderer, compileAsyncFor } from './core/renderer.js';
import { Input, primaryTouch } from './core/input.js';
import { resolveGfx, migrateGfxSettings, gpuInfo, gpuTier, TIER_RUNG, AUTO_LADDER, AutoGovernor, GFX_KEYS } from './core/gfx.js';
import { mapTheme,
  DEFAULT_SETTINGS, TEAM_PALETTES, COLORBLIND_PALETTE, TEAM_NAMES, WEAPONS, WEAPON_ORDER, SUB, SPECIALS,
  MAPS, DIFFICULTY, PLAYER, PROGRESSION, VERSION, MATCH,
} from './config.js';
import { Level } from './world/level.js';
import { MAP_LAYOUTS } from './world/maps.js';
import { PaintSystem } from './world/paint.js';
import { createLevelMaterial } from './world/levelMaterial.js';
import { SwimWake } from './fx/swimWake.js';
import { Decor } from './world/decor.js';
import { createMuralTexture } from './world/murals.js';
import { layoutThumbSVG } from './world/mapThumb.js';
import { dressingFor } from './world/dressing.js';
import { Physics, Hit } from './game/physics.js';
import { NavGraph } from './game/nav.js';
import { Projectiles } from './game/weapons.js';
import { CameraRig } from './game/cameraRig.js';
import { Match } from './game/match.js';
import { Minimap } from './game/minimap.js';
import { Showcase } from './game/showcase.js';
import { Session } from './net/session.js';
import { NetMatch } from './net/netmatch.js';
import { TouchControls } from './ui/touch.js';

const params = new URLSearchParams(location.search);
// online dev/test: ?net=local runs rooms over BroadcastChannel between tabs of this browser (no network), and
// &lag=ms&jitter=ms simulates a slow link there
const NET_OPTS = params.get('net') === 'local'
  ? { local: true, lag: Math.min(1000, +params.get('lag') || 0), jitter: Math.min(1000, +params.get('jitter') || 0) }
  : {};
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
// Invite link: …/#join=ABCDE-12345 (a fragment, so the room code never reaches a server — see session.inviteLink)
const joinCodeFromHash = () => new URLSearchParams(location.hash.slice(1)).get('join');
// The display's frame interval (s): the shortest of ~16 animation-frame gaps while little else runs. Delays only ever
// lengthen a gap, so the minimum is the vsync period. Hidden tab / no frames → 60 Hz.
function measureRefresh(n = 16) {
  return new Promise((resolve) => {
    let last = 0, k = 0, best = Infinity;
    const done = () => { clearTimeout(to); resolve(best >= 1 / 250 && best <= 1 / 24 ? best : 1 / 60); };
    const to = setTimeout(done, 1500);
    const f = (t) => { if (last) best = Math.min(best, (t - last) / 1000); last = t; if (++k <= n) requestAnimationFrame(f); else done(); };
    requestAnimationFrame(f);
  });
}

// ------------------------------------------------------------------------------------------ persistence
function loadJSON(key, def) { try { const v = JSON.parse(localStorage.getItem(key)); return v ? { ...def, ...v } : { ...def }; } catch { return { ...def }; } }
function loadRaw(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function saveJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }
const DEFAULT_PROFILE = { name: 'Player', level: 1, xp: 0, wins: 0, matches: 0, totalTurf: 0, weapon: 'shooter' };

// load(): a literal dynamic import, so the release bundler can split it into its own chunk
async function loadModule(name, load, useStubs) {
  try { return await load(); }
  catch (e) {
    console.error(`[inkwave] failed to load ${name} — using stub`, e);
    const stubs = await import('./dev/stubs.js');
    return useStubs ? stubs : {};
  }
}

// in-match tutorial prompts, worded for the device in hand ([KEY] → keycap, {Btn} → pad glyph in the HUD)
const HINT_KEYS = {
  kbm: { swim: '[SHIFT]', special: 'Press [F]' },
  pad: { swim: '{LT}', special: 'Press {Y}' },
  touch: { swim: 'SWIM', special: 'Tap SPECIAL' },
};

class Game {
  async boot() {
    const t0 = performance.now();
    const refresh = measureRefresh();   // display refresh, while the page is still quiet (Auto graphics' fps target)
    // real top-down thumbnails for the stage cards, generated from each layout's geometry
    for (const m of MAPS) { try { m.thumb = layoutThumbSVG(MAP_LAYOUTS[m.layout || m.id], m.theme); } catch (e) { console.warn('thumb', m.id, e); } }
    const rawSettings = loadRaw('inkwave.settings');
    this.settings = G.settings = loadJSON('inkwave.settings', DEFAULT_SETTINGS);
    let migrated = migrateGfxSettings(this.settings, rawSettings);   // v2 graphics: four tiers → presets + knobs + Auto
    // v1.1: fov became horizontal — migrate old vertical values once
    if (this.settings.fovMode !== 'h') { this.settings.fov = DEFAULT_SETTINGS.fov; this.settings.fovMode = 'h'; migrated = true; }
    if (migrated) saveJSON('inkwave.settings', this.settings);
    this.profile = loadJSON('inkwave.profile', DEFAULT_PROFILE);
    const app = document.getElementById('app');
    this.uiRoot = document.getElementById('ui-root');
    this.fadeEl = document.getElementById('fade');

    // online rooms (peer-to-peer; nothing connects until the player hosts or joins)
    this.session = new Session({
      profile: () => ({ name: this.profile.name, style: this.profile.style || {}, weapon: this.profile.weapon || 'shooter' }),
      defaults: () => {
        const s = this.settings, mapId = MAPS.some((m) => m.id === s.lastStage) ? s.lastStage : MAPS[0].id;
        const t = s.stageTimes && s.stageTimes[mapId];
        return { mapId, time: t === 'dusk' || t === 'day' ? t : (s.timeOfDay === 'dusk' ? 'dusk' : 'day'), duration: s.matchLength, difficulty: s.difficulty, bots: true };
      },
      onStart: (cfg) => {
        this.startOnlineMatch(cfg).catch((e) => {
          console.error('[inkwave] online start', e);
          if (this.session.isHost) this.session.endMatch('host');
          this._leaveMatchTo(this.session.status === 'lobby' ? 'lobby' : 'online');
        });
      },
      onEnd: (reason) => this._onlineEnded(reason),
      onGame: (p, origin) => this.netMatch?.receive(p, origin),
      onControl: (c) => this.netMatch?.control(c),
      onPeerLeft: (id) => this._onlinePeerLeft(id),
      onAllLoaded: (mid, missing) => this._onlineAllLoaded(mid, missing),
    });
    this.netMatch = null;

    // UI first so the loading screen shows immediately
    const [menusMod, hudMod] = await Promise.all([loadModule('ui/menus', () => import('./ui/menus.js')), loadModule('ui/hud', () => import('./ui/hud.js'))]);
    this.menus = G.menus = menusMod.Menus ? new menusMod.Menus(this.uiRoot, this._menuApi()) : null;
    this.hud = G.hud = hudMod.HUD ? new hudMod.HUD(this.uiRoot, { playSound: (n, o) => G.audio?.play(n, o) }) : null;
    // map diorama pins/finish live inside the HUD layer (under every other HUD element)
    try { const { DioramaOverlay } = await import('./ui/diorama.js'); this.diorama = new DioramaOverlay(this.hud ? this.hud.el : this.uiRoot); } catch (e) { console.error('[inkwave] diorama', e); this.diorama = null; }
    this.hud?.setVisible(false);
    this._applyDevice(primaryTouch() ? 'touch' : 'kbm');
    this.menus?.show('loading');
    this.bootMarks = [];
    const progress = async (p, label) => { this.bootMarks.push([label, Math.round(performance.now() - t0)]); this.menus?.setLoading(p, label); await nextFrame(); };
    await progress(0.05, 'Mixing ink…');

    // renderer / scene (graphics profile: Auto needs the GPU's name, so the renderer starts on a provisional one)
    this.gfx = G.gfx = resolveGfx(this.settings, TIER_RUNG.medium);
    this.R = new Renderer(app, this.gfx);
    G.renderer = this.R.renderer;
    await this._initGfx(refresh);
    this._initContextRecovery();
    const scene = (G.scene = new THREE.Scene());
    const camera = (G.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.15, 6500));
    camera.position.set(0, 40, -60);
    this.R.setScene(scene, camera);
    this.input = G.input = new Input(this.R.renderer.domElement);
    this.input.onKey = (e, repeat) => this._onKey(e, repeat);
    this.input.onUnlock = () => this._onPointerUnlock();
    this.input.onDevice = (d) => this._applyDevice(d);
    this.touch = new TouchControls(this.uiRoot, this.input, { onPause: () => this.pause() });
    // first gesture of any kind (key, click, tap) unlocks audio
    addEventListener('pointerdown', () => this._unlockAudio(), { capture: true, passive: true });
    // phones: turning to portrait covers the game (index.html #rotate, same query in styles/touch.css) — pause a live round
    matchMedia('(pointer: coarse) and (orientation: portrait) and (max-width: 760px)').addEventListener('change', (e) => { if (e.matches) this.pause(); });
    // after a focus steal while the map was held, the next click on the game takes the mouse back (no pause detour)
    this.R.renderer.domElement.addEventListener('mousedown', () => {
      if (this._relock && G.mode === 'match' && this.match && !this.match.paused && !this.menus?.current) { this._relock = false; this.input.requestLock(); }
    });

    // modules built by other authors
    const [charMod, fxMod, envMod, audioMod, musicMod] = await Promise.all([
      loadModule('game/character', () => import('./game/character.js'), true), loadModule('fx/fx', () => import('./fx/fx.js'), true),
      loadModule('world/environment', () => import('./world/environment.js'), true),
      loadModule('audio/audio', () => import('./audio/audio.js'), true), loadModule('audio/music', () => import('./audio/music.js'), true),
    ]);
    this.CharacterClass = charMod.Character;
    try { this.PropKit = (await import('./world/props.js')).PropKit; } catch (e) { console.error('[inkwave] prop kit failed to load', e); this.PropKit = null; }
    G.audio = audioMod.audio; G.music = musicMod.music;
    await progress(0.15, 'Building the plaza…');

    // world
    // (old ?map=sunset links = Tidewater at dusk)
    const pm = params.get('map') === 'sunset' ? 'tidewater' : params.get('map');
    const map = MAPS.find((m) => m.id === pm) || MAPS[0];
    this.time = params.get('time') === 'dusk' || params.get('map') === 'sunset' ? 'dusk' : (this.settings.timeOfDay === 'dusk' ? 'dusk' : 'day');
    this.theme = mapTheme(map, this.time);
    const gp = this.gfx;
    this.murals = await createMuralTexture();
    await this._buildWorld(map);
    await progress(0.4, 'Filling the harbor…');
    const B = G.level.bounds;
    G.env = new envMod.Environment(G.renderer, scene, { bounds: B, theme: this.theme, shadowSize: gp.shadowSize || 4096, shadowSoft: gp.shadowSoft, cloudSize: gp.cloudBake, footprint: this._footprint(G.level) });
    G.env.setReflections?.(gp.reflScale, gp.reflActors);
    if (G.env.envMap) scene.environment = G.env.envMap;
    // lighting balance: less omnidirectional sky flood, more directional sky/ground fill → surfaces keep their form
    scene.environmentIntensity = 0.66;
    G.renderer.toneMappingExposure = 0.94;
    if (G.env.hemi) G.env.hemi.intensity = Math.max(G.env.hemi.intensity, 0.38);
    await progress(0.55, 'Teaching squids to swim…');
    G.projectiles = new Projectiles(scene);
    G.fx = new fxMod.FX(scene, { quality: gp.particles });
    G.fx.setLighting?.(G.env.getSkyColors?.());
    this._applyNight();
    G.fx.setCollider?.((from, to) => { const h = G.physics.segment(from, to, this._fxHit || (this._fxHit = new Hit()), true); return h.hit ? { point: h.point, normal: h.normal } : null; });
    G.fx.onDropletLand = (point, normal, color, size) => {
      const team = this._teamOfColor(color);
      if (team < 0) return;
      // online, flying droplets land differently on every screen: they stay decoration there (no turf claim), so
      // every browser's turf grid keeps agreeing
      G.paint.splat(this._tmpV.copy(point).addScaledVector(normal, 0.05), clamp(size * 2.4, 0.12, 0.45), team, G.net ? { seed: Math.random(), kind: 'drop', cosmetic: true } : { seed: Math.random() });
    };
    this._tmpV = new THREE.Vector3(); this._tmpC = new THREE.Color();
    this.rig = new CameraRig(camera);
    G.post = this.R; G.game = this; G.rig = this.rig;
    // optional modules the VFX / screen-FX modules (absent = skipped)
    try { const m = await import('./fx/fxHooks.js'); this.fxHooks = m.initFxHooks?.(G) || null; } catch (e) { if (!/Failed to fetch|Cannot find module|404/i.test(String(e))) console.error('[inkwave] fxHooks', e); }
    try { const m = await import('./fx/screenfx.js'); this.screenfx = m.ScreenFX ? new m.ScreenFX(this.R, G) : null; } catch (e) { if (!/Failed to fetch|Cannot find module|404/i.test(String(e))) console.error('[inkwave] screenfx', e); }
    this.showcase = new Showcase(G.renderer, this.CharacterClass);
    await progress(0.7, 'Tuning the tentacles…');

    this._setPalette(this._pickPalette());
    this._bindEvents();
    this._startAttract();
    // warm up: compile every shader now so the first shot/splat never hitches
    await progress(0.85, 'Warming up…');
    this._warmup();
    // compile in parallel (KHR_parallel_shader_compile) so the loading screen keeps animating instead of freezing
    // against the composer's HDR target (what every scene draw renders into), hidden pools / props included
    await compileAsyncFor(G.renderer, scene, camera, this.R.composer.renderTarget1, { includeHidden: true });
    await progress(0.93, 'Warming up…');
    for (let i = 0; i < 3; i++) { this._frame(1 / 60); await nextFrame(); }
    await progress(1, 'Ready!');
    await new Promise((r) => setTimeout(r, 250));

    this.timer = new THREE.Timer(); this.timer.connect?.(document);
    this.fpsAcc = 0; this.fpsN = 0; this.fps = 60;
    G.mode = 'menu';
    const joinCode = joinCodeFromHash();
    this.menus?.show(params.has('skipTitle') || joinCode ? 'main' : 'title');
    this._applyAudioVolumes();
    requestAnimationFrame(() => this._loop());
    this._initBackgroundTick();
    if (params.has('autostart')) this.api.startMatch({ mapId: map.id, difficulty: this.settings.difficulty, duration: +params.get('autostart') || this.settings.matchLength });
    // invite link: opens the online screen and joins the room
    else if (joinCode) { this.menus?.show('online', { push: true, join: joinCode }); }
    // an invite pasted into this tab's address bar only changes the fragment (no reload): join from the menus
    window.addEventListener('hashchange', () => {
      const code = joinCodeFromHash();
      if (code && G.mode === 'menu' && this.session.status === 'idle') this.menus?.show('online', { push: true, join: code });
    });
    this.bootMs = Math.round(performance.now() - t0);
    window.__inkwave = this; // debug/audit hook
    window.__G = G;
    this.debug = {
      endMatch: (t = 0.5) => { if (this.match && !this.match.attract) this.match.time = t; },
      paintRandom: (n = 400) => { const v = new THREE.Vector3(); for (let i = 0; i < n; i++) { v.set((Math.random() - 0.5) * 48, 0.4, (Math.random() - 0.5) * 86); G.paint.splat(v, 0.8 + Math.random() * 1.4, Math.random() < 0.5 ? 0 : 1); } },
      // deterministic stepping for audits: freeze(), then step(ms) advances the sim at a fixed 60 Hz and renders once
      freeze: () => { this.frozen = true; },
      unfreeze: () => { this.frozen = false; this.timer.update(); },
      step: (ms = 16.7) => {
        const n = Math.max(1, Math.round(ms / (1000 / 60)));
        this._skipRender = true;
        for (let i = 0; i < n - 1; i++) this._frame(1 / 60);
        this._skipRender = false;
        this._frame(1 / 60);
      },
      key: (code, down) => { if (down) { this.input.keys.add(code); this.input.pressed.add(code); } else this.input.keys.delete(code); },
      fire: (on) => { this.input.mouse.left = on; },
      freezeBots: () => { for (const a of G.actors) if (a.bot && !a.isLocal) a.bot.update = () => { a.intent.move.set(0, 0, 0); a.intent.fire = false; }; },
    };
  }

  // Build (or rebuild) everything that depends on the stage layout or on the world-detail setting: level, collision,
  // paint atlas, surface material + its texture library, decor, navigation graph and minimap. Environment / FX /
  // projectiles persist across stages. force: rebuild the same layout (world detail changed).
  async _buildWorld(map, force = false) {
    const scene = G.scene;
    const layoutId = map.layout || map.id;
    if (!force && this.layoutId === layoutId) { this.mapDef = map; return; }
    if (this.levelMesh) { scene.remove(this.levelMesh, this.grateMesh); this.levelMesh.geometry.dispose(); this.grateMesh?.geometry.dispose(); this.levelMat.dispose(); this.grateMat?.dispose(); }
    if (this.decor) { scene.remove(this.decor.group); }
    if (this.props) { this.props.dispose?.(); this.props = null; }
    G.paint?.dispose();
    this.layoutId = layoutId;
    this.mapDef = map;
    const gp = this.gfx;
    this._builtDetail = gp.detail;
    // texture library for the surface material, baked at this detail's size
    if (!this.texlib || this.texlib.size !== gp.texlibSize) {
      this.texlib?.dispose();
      this.texlib = null;
      try {
        const { createTextureLibrary } = await import('./world/texlib.js');
        this.texlib = await createTextureLibrary(G.renderer, { size: gp.texlibSize });
      } catch (e) { console.error('[inkwave] texture library failed — procedural fallback', e); this.texlib = null; }
    }
    // set dressing first: solid props hand back collision boxes that become part of the level (physics, nav, paint)
    const colliders = [];
    if (this.PropKit) {
      try {
        this.props = new this.PropKit(scene, { castShadow: true, quality: gp.detail });
        for (const it of dressingFor(layoutId)) {
          const r = this.props.add(it.type, it);
          if (r && r.colliders) colliders.push(...r.colliders);
        }
        this.props.build();
      } catch (e) { console.error('[inkwave] props failed', e); this.props = null; }
    }
    const level = (G.level = new Level(MAP_LAYOUTS[layoutId], colliders));
    G.physics = new Physics(level);
    const lightmap = await this._loadLightmap(level, layoutId);
    G.paint = new PaintSystem(G.renderer, level, { atlasSize: gp.paintAtlas, maxDensity: gp.paintDensity });
    G.paint.setQuality({ animDist: gp.inkAnimDist, animHalfRate: gp.inkAnimHalfRate });
    this.levelMat = createLevelMaterial(G.paint.texture, G.paint.size, this.murals, { lightmap, texlib: this.texlib, lite: gp.levelLite });
    (this.swimWake || (this.swimWake = new SwimWake())).reset();
    this.levelMesh = new THREE.Mesh(level.buildGeometry(G.paint.size), this.levelMat);
    this.levelMesh.castShadow = true; this.levelMesh.receiveShadow = true;
    this.levelMesh.name = 'level';
    scene.add(this.levelMesh);
    // grates: same surface shader, cut-out holes, no ink (they cast no shadow; the mesh is too fine for the shadow map)
    this.grateMat = createLevelMaterial(G.paint.texture, G.paint.size, this.murals, { grate: true, lightmap, texlib: this.texlib, lite: gp.levelLite });
    const gg = level.buildGeometry(G.paint.size, (b) => b.grate);
    this.grateMesh = new THREE.Mesh(gg, this.grateMat);
    this.grateMesh.receiveShadow = true; this.grateMesh.visible = gg.index.count > 0;
    scene.add(this.grateMesh);
    this.decor = new Decor(scene, level);
    G.nav = new NavGraph(level, G.physics);
    this.minimap = new Minimap(level, G.paint, gp.minimapPx);
    G.env?.setCloudSize?.(...gp.cloudBake);
    if (G.env?.rebuildForArena) G.env.rebuildForArena(level.bounds, this._footprint(level));
    else if (G.env?.setFootprint) G.env.setFootprint(this._footprint(level));
    if (G.teamColors[0]) this._setPalette(this.palette || this._pickPalette());
  }

  // Baked AO (tools/bake-ao.mjs). Applied only when the bake matches this exact layout.
  async _loadLightmap(level, layoutId) {
    try {
      const meta = await (await fetch(`assets/lightmaps/${layoutId}.json`, { cache: 'no-cache' })).json();
      level.layoutLightmap(meta.ppm, meta.size);
      if (level.layoutHash !== meta.hash) { console.warn(`[inkwave] lightmap for ${layoutId} is stale — re-run tools/bake-ao.mjs`); level.lightSize = 0; for (const f of level.faces) f.light = null; return null; }
      const tex = await new THREE.TextureLoader().loadAsync(`assets/lightmaps/${layoutId}.png?h=${meta.hash}`);
      tex.colorSpace = THREE.NoColorSpace;
      tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
      tex.anisotropy = 4;
      return tex;
    } catch (e) {
      console.warn('[inkwave] no lightmap for', layoutId, e.message);
      for (const f of level.faces) f.light = null;
      return null;
    }
  }

  _footprint(level) {
    return level.blocks.filter((b) => b.aligned && b.aabbMax.y < 0.01 && b.aabbMax.y > -2.5 && b.aabbMin.y < -1)
      .map((b) => ({ minX: b.aabbMin.x, maxX: b.aabbMax.x, minZ: b.aabbMin.z, maxZ: b.aabbMax.z }));
  }

  _warmup() {
    // trigger one of each effect off-screen so shaders + pools exist
    const p = new THREE.Vector3(0, -30, 0), n = new THREE.Vector3(0, 1, 0);
    const c = G.teamColors[0];
    try {
      G.fx.burst(p, n, c, { count: 4 }); G.fx.ring(p, n, c, {}); G.fx.explosion(p, c, 2); G.fx.splatted(p, c);
      G.fx.wake(p, n, c, 5); G.fx.muzzle(p, n, c); G.fx.spawnFlash(p, c);
    } catch (e) { console.warn('fx warmup', e); }
  }

  // ---------------------------------------------------------------------------------------- palette
  _pickPalette() {
    if (this.settings.colorblind) return COLORBLIND_PALETTE;
    const p = TEAM_PALETTES[(Math.random() * TEAM_PALETTES.length) | 0];
    return p;
  }
  _setPalette(p) {
    this.palette = p;
    G.teamHex = [p.a, p.b];
    G.teamColors = [new THREE.Color(p.a), new THREE.Color(p.b)];
    this.levelMat.userData.uniforms.uTeamA.value.copy(G.teamColors[0]);
    this.levelMat.userData.uniforms.uTeamB.value.copy(G.teamColors[1]);
    if (this.grateMat) { this.grateMat.userData.uniforms.uTeamA.value.copy(G.teamColors[0]); this.grateMat.userData.uniforms.uTeamB.value.copy(G.teamColors[1]); }
    // warm/low light mutes saturated ink: give it more self-glow at dusk so team colours stay the loudest thing on screen
    // ink self-light: more at dusk, a touch more in golden hour's long shadows
    this.levelMat.userData.uniforms.uInkGlow.value = { sunset: 0.2, golden: 0.1 }[this.theme] ?? 0.07;
    this.decor.setTeamColors(G.teamColors);
    this.props?.setTeamColors?.(G.teamColors[0], G.teamColors[1]);
    G.projectiles.refreshColors();
    for (const a of G.actors) a.character.setColor(G.teamColors[a.team]);
    this.minimap.version = -1;
    this.menus?.setAccent?.(p.a, p.b);
  }
  _teamOfColor(color) {
    const c = color.isColor ? color : this._tmpC.set(color);
    for (let t = 0; t < 2; t++) { const k = G.teamColors[t]; if (Math.abs(k.r - c.r) + Math.abs(k.g - c.g) + Math.abs(k.b - c.b) < 0.05) return t; }
    return -1;
  }

  // ---------------------------------------------------------------------------------------- menus api
  _menuApi() {
    const self = this;
    const api = (this.api = {
      version: VERSION,
      weapons: WEAPONS, weaponOrder: WEAPON_ORDER, specials: SPECIALS, sub: SUB.bomb, maps: MAPS, difficulties: DIFFICULTY,
      getSettings: () => ({ ...self.settings, ...(self.gfx && self.gfx.knobs) }),   // knobs as in effect (preset / Auto level)
      gfxStatus: () => self.gfxStatus(),
      setSettings: (partial) => self._setSettings(partial),
      getProfile: () => {
        const p = self.profile;
        return { ...p, played: p.matches, xpToNext: PROGRESSION.xpForLevel(p.level) };
      },
      setProfileName: (n) => { self.profile.name = String(n || 'Player').slice(0, 16); saveJSON('inkwave.profile', self.profile); self.session.updateProfile(); },
      // locker look ({ hair, skin, outfit, eyes, hat, brows, … } — indices into character-style.js tables)
      setProfileStyle: (st) => { self.profile.style = { ...(st || {}) }; saveJSON('inkwave.profile', self.profile); self.session.updateProfile(); },
      getLoadout: () => ({ weapon: self.profile.weapon || 'shooter' }),
      setLoadout: ({ weapon }) => {
        if (!WEAPONS[weapon]) return;
        self.profile.weapon = weapon; saveJSON('inkwave.profile', self.profile);
        self.session.updateProfile();
        if (self.menus?.current === 'loadout') self.showcase.showLoadout(weapon, G.teamColors[0], self.profile.style);
      },
      startMatch: (o) => self.startMatch(o),
      resumeMatch: () => self.resume(),
      quitMatch: () => self.quitToMenu(),
      // online: the results screen's buttons read "back to lobby" / "leave room"
      rematch: () => (self.match?.online ? self._backToLobby() : self.startMatch(self.lastMatchOpts || {})),
      toMainMenu: () => { if (self.session.status !== 'idle') self.session.leave(); return self.quitToMenu(); },
      // online rooms (the lobby screens in menus-online.js)
      online: {
        view: () => self.session.view(),
        subscribe: (fn) => self.session.subscribe(fn),
        host: () => self.session.host(NET_OPTS),
        join: (code) => self.session.join(code, NET_OPTS),
        leave: () => self.session.leave(),
        start: () => self.session.start(),
        setTeam: (t) => self.session.setTeam(t),
        setSettings: (p) => self.session.setSettings(p),
        kick: (id) => self.session.kick(id),
      },
      onScreenChange: (s) => self._onScreen(s),
      playSound: (n) => { G.audio?.init?.(); G.audio?.play(n); },
    });
    return api;
  }

  _setSettings(partial) {
    const s = this.settings;
    const knobs = Object.keys(partial).filter((k) => GFX_KEYS.includes(k));
    // one knob of a preset (or of Auto's current level) edited: the rest keep their current values → Custom
    if (knobs.length && !('quality' in partial) && s.quality !== 'custom') { Object.assign(s, this.gfx.knobs); s.quality = 'custom'; }
    Object.assign(s, partial);
    saveJSON('inkwave.settings', s);
    if ('quality' in partial || knobs.length || 'fpsLimit' in partial || 'gfxDynRes' in partial) this._applyGfx();
    if ('master' in partial || 'music' in partial || 'sfx' in partial) this._applyAudioVolumes();
    if ('colorblind' in partial && G.mode !== 'match') this._setPalette(this._pickPalette());
  }
  _applyAudioVolumes() { G.audio?.setVolumes?.({ master: this.settings.master, music: this.settings.music, sfx: this.settings.sfx }); }

  // ---------------------------------------------------------------------------------------- graphics
  // Auto graphics: a first guess from the GPU's name (plus memory / cores), then the governor (gfx.js) settles on a
  // ladder level from real match frame rates. The level is remembered per GPU, so it is only learned once.
  async _initGfx(refresh) {
    const gl = this.R.renderer.getContext();
    this.gpu = gpuInfo(gl);
    this.gpu.tier = gpuTier(this.gpu.renderer, { deviceMemory: navigator.deviceMemory, cores: navigator.hardwareConcurrency, mobile: primaryTouch() });
    const saved = loadRaw('inkwave.gfxAuto');
    const known = saved && saved.gpu === this.gpu.renderer && Number.isInteger(saved.rung);
    this._gov = new AutoGovernor({
      rung: known ? saved.rung : TIER_RUNG[this.gpu.tier], upAfter: known ? saved.upAfter : 20,
      limit: this.settings.fpsLimit | 0, refresh: await refresh,
    });
    this._applyGfx();
  }

  // Resolve the settings (+ Auto's level) into a profile and hand it to every consumer. World detail (ink atlas,
  // surface textures, prop geometry) takes effect at the next stage load (_prepareStage compares _builtDetail).
  _applyGfx({ fromAuto = false } = {}) {
    const p = (this.gfx = G.gfx = resolveGfx(this.settings, this._gov ? this._gov.rung : TIER_RUNG.medium));
    if (!fromAuto) { this.R.dynScale = 1; this._dyn = null; }   // a settings change starts at full resolution again
    if (this.R.setProfile(p)) this._recompileLit();
    G.env?.setShadows?.(p.shadowSize, p.shadowSoft);
    G.env?.setReflections?.(p.reflScale, p.reflActors);
    G.fx?.setQuality?.(p.particles);
    G.paint?.setQuality?.({ animDist: p.inkAnimDist, animHalfRate: p.inkAnimHalfRate });
    if (this._gov) this._gov.limit = this.settings.fpsLimit | 0;
    this.menus?.refreshSettings?.();
  }

  // Shadows switched on / off: shaders that sample the shadow map must be rebuilt (three does not track the switch).
  _recompileLit() {
    const mark = (o) => { if (!o.material) return; for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true; };
    G.scene?.traverse(mark);
    this.showcase?.scene?.traverse(mark);
  }

  // Once per rendered frame: Auto's governor, or (manual presets) the dynamic-resolution nudge.
  _gfxTick(dt) {
    const m = this.match;
    const live = !!(m && !m.attract && m.state === 'playing' && !m.paused && !this.menus?.current && !document.hidden);
    if (this.settings.quality === 'auto') {
      if (this._gov.tick(dt, live) >= 0) {
        this._applyGfx({ fromAuto: true });
        saveJSON('inkwave.gfxAuto', { gpu: this.gpu.renderer, rung: this._gov.rung, upAfter: this._gov.upAfter });
      }
    } else if (this.settings.gfxDynRes !== false) this._dynRes(dt, live);
  }

  // Weak or overloaded GPUs get reset by their driver (Windows TDR, Linux i915 hang checks): WebGL loses its context.
  // three.js restores its own state; everything drawn into render targets is gone, so the texture library, the sky /
  // light-probe / far-reflection bakes and the ink atlas (from the gameplay grid) are redrawn. The sim and online sync
  // keep running; rendering waits until the shaders have recompiled in the background. A second reset under Auto
  // steps two levels lighter.
  _initContextRecovery() {
    const cv = this.R.renderer.domElement;
    cv.addEventListener('webglcontextlost', () => {
      this._gpuLost = true;
      this._gpuLosses = (this._gpuLosses || 0) + 1;
      console.warn('[inkwave] WebGL context lost (graphics driver reset) — waiting for the browser to restore it');
    });
    cv.addEventListener('webglcontextrestored', () => {
      this._restoreGpu().catch((e) => { console.error('[inkwave] graphics restore failed', e); this._gpuLost = false; });
    });
  }
  async _restoreGpu() {
    try { await this.texlib?.rebake?.(); } catch (e) { console.error('[inkwave] texture library rebake', e); }
    if (G.env?.setTheme) { G.env.setTheme(G.env.theme); if (G.env.envMap) G.scene.environment = G.env.envMap; }
    const cells = G.paint?.restore?.() ?? 0;
    try { await compileAsyncFor(G.renderer, G.scene, G.camera, this.R.composer.renderTarget1, { includeHidden: true }); } catch (e) { /* compiles on first draw instead */ }
    this._gpuLost = false;
    console.info(`[inkwave] graphics restored after a driver reset (${cells} ink cells repainted)`);
    const live = this.match && !this.match.attract;
    if (this.settings.quality === 'auto' && this._gpuLosses >= 2 && this._gov.stepDown(2) >= 0) {
      this._applyGfx({ fromAuto: true });
      saveJSON('inkwave.gfxAuto', { gpu: this.gpu.renderer, rung: this._gov.rung, upAfter: this._gov.upAfter });
      if (live) this.hud?.feed({ text: 'Graphics reset by the driver — Auto lowered the quality', kind: 'info' });
    } else if (live) this.hud?.feed({ text: this.settings.quality === 'auto' ? 'Graphics reset by the driver — recovered' : 'Graphics reset by the driver — a lower preset may help', kind: 'info' });
  }

  // Graphics status for the settings screen and debugging.
  gfxStatus() {
    const p = this.gfx, g = this._gov;
    return {
      preset: p.preset, rung: p.rung, level: p.rung >= 0 ? AUTO_LADDER[p.rung].label : null,
      base: p.rung >= 0 ? AUTO_LADDER[p.rung].id.split('-')[0].replace('lowest', 'low') : p.preset,   // nearest preset
      gpu: this.gpu ? this.gpu.name : '', tier: this.gpu ? this.gpu.tier : '', fps: this.fps,
      target: g ? Math.round(g.target()) : 60, knobs: { ...p.knobs }, pixelRatio: +this.R.pixelRatio().toFixed(3),
      detailPending: this._builtDetail !== undefined && this._builtDetail !== p.detail,
    };
  }
  gfxState() { const st = this.gfxStatus(); return `${st.preset}${st.level ? ':' + st.level : ''} pr=${st.pixelRatio}`; }

  _onScreen(s) {
    if (!this.showcase) return;
    if (s === 'loadout') this.showcase.showLoadout(this.profile.weapon || 'shooter', G.teamColors[0], this.profile.style);
    else if (s !== 'results') { if (this.showcase.mode === 'loadout') this.showcase.hide(); }
    if (G.mode === 'menu') {
      if (s === 'title' || s === 'main' || s === 'setup' || s === 'settings' || s === 'howto' || s === 'credits' || s === 'loadout' || s === 'locker') {
        if (this._musicTrack !== (s === 'title' ? 'title' : 'menu')) this._playMusic(s === 'title' ? 'title' : 'menu');
      }
    }
  }
  _playMusic(t) { this._musicTrack = t; try { G.music?.play(t, { fade: 1.2 }); } catch (e) { /* not initialised yet */ } }

  // ---------------------------------------------------------------------------------------- input routing
  // touch screens: a match goes fullscreen and locks to landscape where the browser allows it (Android; iPhone Safari has
  // no element fullscreen). Only works inside the tap that started the match (user activation); refusals are fine.
  _immersive() {
    if (this.input.lastDevice !== 'touch' || document.fullscreenElement || !document.fullscreenEnabled) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => { /* declined or unsupported: play in the page */ });
  }
  _unlockAudio() {
    if (this._audioOn) return;
    this._audioOn = true; G.audio?.init?.(); this._applyAudioVolumes(); this._playMusic(this.menus?.current === 'title' || !this.menus ? 'title' : 'menu');
  }
  // device-dependent UI: body.is-touch (touch HUD layout, no keyboard glyphs) + the menus' prompts
  _applyDevice(d) {
    document.body.classList.toggle('is-touch', d === 'touch');
    this.menus?.setInputMode(d);
  }
  _onKey(e, repeat) {
    this._unlockAudio();
    if (G.mode === 'match' && this.match && !this.match.paused && !this.menus?.current) {
      if (e.code === 'Escape' || e.code === 'KeyP') { this.pause(); return true; }
      return false;
    }
    if (this.menus && this.menus.current) return this.menus.handleKey(e) || false;
    return false;
  }
  _onPointerUnlock() {
    // only a live round pauses on focus loss; intro / time's up / judge / results release the mouse on purpose.
    // Holding the map is never a reason to pause (some browsers/embeds steal focus on TAB): relock on the next click.
    if (this.match?.controller?.mapHeld || this.rig.mapK > 0) { this._relock = true; return; }
    if (G.mode === 'match' && this.match && !this.match.paused && this.match.state === 'playing' && !this.menus?.current) this.pause();
  }

  // pull the fog back while the view is overhead (the stage is ~150 m away up there), restore it exactly after
  _dioFog() {
    const f = G.scene?.fog, k = this.rig.mapK;
    if (!f || !f.isFog) return;
    if (k > 0) {
      if (!this._fog0) this._fog0 = { near: f.near, far: f.far };
      const e = k * k * (3 - 2 * k);
      f.near = this._fog0.near + 190 * e; f.far = this._fog0.far + 600 * e;
    } else if (this._fog0) { f.near = this._fog0.near; f.far = this._fog0.far; this._fog0 = null; }
  }

  // ---------------------------------------------------------------------------------------- events → HUD/audio
  _bindEvents() {
    const self = this;
    let lastHitSnd = 0, lastHurtSnd = 0;
    on('hit', ({ attacker, victim, damage, killed }) => {
      if (!this.match || this.match.attract) return;
      if (attacker?.isLocal) {
        this.hud?.hitMarker(killed ? 'kill' : 'hit');
        if (G.time - lastHitSnd > 0.06) { lastHitSnd = G.time; G.audio?.play('hit_marker', { volume: 0.6 }); }
      }
    });
    on('damage', ({ victim, amount, attacker, source }) => {
      if (!this.match || this.match.attract || !victim.isLocal) return;
      let ang = null;
      if (attacker && attacker !== victim) {
        const v = this._dmgV || (this._dmgV = new THREE.Vector3());
        v.copy(attacker.pos); v.y += 1; v.project(G.camera);
        let dx = v.x, dy = -v.y;
        const behind = v.z > 1;
        if (behind) { dx = -dx; dy = -dy; }
        if (!behind && Math.abs(dx) < 1 && Math.abs(dy) < 1) ang = dx >= 0 ? 0 : Math.PI;   // attacker on screen: ink the nearer side edge, never over them
        else ang = Math.atan2(dy * view.h, dx * view.w);
      }
      this.hud?.damage(clamp(amount / 80, 0.15, 1), G.teamHex[victim.enemyTeam], ang);
      if (G.time - lastHurtSnd > 0.25) { lastHurtSnd = G.time; G.audio?.play('hurt', { volume: 0.7 }); }
      if (amount >= 40) this.rig.addShake(clamp((amount - 30) / 220, 0, 0.4));   // only heavy hits move the camera; chip damage reads through the HUD
    });
    // a squid dropping back into its own ink (dolphin-jump re-entry, hopping in from dry ground) gets a wet plunge;
    // transform dives already play squid_in
    const formT = new WeakMap();
    on('actor:form', ({ actor }) => formT.set(actor, G.time));
    on('actor:dive', ({ actor, speed }) => {
      if (!actor || !this.match || this.match.attract || G.time - (formT.get(actor) ?? -9) < 0.2) return;
      if (actor.isLocal || actor._nearCamera?.()) G.audio?.play('swim_splash', { pos: actor.isLocal ? undefined : actor.pos, volume: (actor.isLocal ? 0.5 : 0.32) * Math.min(1, 0.55 + (speed || 0) / 16) });
    });
    on('splatted', ({ victim, attacker, cause }) => {
      if (!this.match || this.match.attract) return;
      const local = this.match.local;
      if (attacker?.isLocal) {
        if (!victim.owned) this.hud?.hitMarker('kill');   // online: the victim's browser confirmed our splat
        G.audio?.play('splat_enemy', { volume: 0.9 });
        this.hud?.feed({ text: `You splatted ${victim.name}!`, color: G.teamHex[local.team], kind: 'kill' });
      } else if (victim.isLocal) {
        G.audio?.play('splatted_self');
        G.audio?.duck?.(0.45, 2.2);
        const by = attacker ? attacker.name : cause === 'water' ? 'the sea' : 'enemy ink';
        this.hud?.showSplatted({ by, byColor: attacker ? G.teamHex[attacker.team] : '#6fd0ff', respawn: PLAYER.respawnTime });
        this.rig.mode = 'spectate';
        this.rig.spectate = { actor: attacker && attacker.alive ? attacker : null, pos: victim.pos.clone(), from: victim.pos.clone() };
        this.rig.lookAt.copy(victim.pos);
      } else if (victim.team === local?.team) {
        G.audio?.play('ally_splatted', { volume: 0.5 });
        this.hud?.feed({ text: `${victim.name} was splatted${attacker ? ' by ' + attacker.name : ''}`, color: G.teamHex[victim.enemyTeam], kind: 'death' });
      } else if (attacker && attacker.team === local?.team) {
        this.hud?.feed({ text: `${attacker.name} splatted ${victim.name}`, color: G.teamHex[attacker.team], kind: 'ally' });
      }
    });
    on('respawn', ({ actor }) => {
      if (!this.match || this.match.attract) return;
      if (actor.isLocal) { this.hud?.hideSplatted(); this.rig.follow(actor, true); this.rig.yaw = actor.yaw; this.rig.pitch = -0.12; }
    });
    on('special:ready', ({ actor }) => {
      if (actor.isLocal && !this.match?.attract) { G.audio?.play('special_ready'); }
    });
    on('special:use', ({ actor, id }) => {
      if (actor.isLocal && !this.match?.attract) this.hud?.banner('special', SPECIALS[id].name.toUpperCase() + '!');
    });
    on('shake', ({ amount, pos }) => { if (!this.match?.attract) this.rig.addShake(amount, pos); });
    on('recoil', ({ amount }) => { if (!this.match?.attract) this.rig.recoil(amount); });
    on('lowink', ({ actor }) => { if (actor.isLocal) this._lowInkFlash = 1.2; });
    // footsteps (character animation → 'actor:footstep'): surface-aware, only for actors near the camera
    on('actor:footstep', ({ actor, surface, pos, speed }) => {
      if (!actor || !actor.alive || actor.form === 'squid') return;
      const p = pos || actor.pos;
      if (!actor.isLocal && G.camera.position.distanceToSquared(p) > 18 * 18) return;
      const name = surface === 1 ? 'step_ink' : surface === 2 ? 'step_enemy' : 'step_dry';
      const vol = (actor.isLocal ? 0.7 : 0.45) * Math.min(1, 0.45 + (speed || actor.anim.speed || 0) / 8);
      G.audio?.play(name, { pos: actor.isLocal ? undefined : p, volume: vol });
    });
    on('match:oneminute', () => { this.hud?.banner('one_minute'); G.audio?.play('one_minute'); this._playMusic('battle_final'); });
    on('match:count', ({ n }) => { this.hud?.countdown(n); G.audio?.play('final_count'); });
    // online: our squidkid was handed to a bot (we took too long to load the stage): out to the lobby
    on('net:replaced', () => {
      if (!this.match?.online) return;
      this.session.notice = 'You took too long to load, so a bot took your place. You\u2019ll join the next match.';
      this._leaveMatchTo(this.session.status === 'lobby' ? 'lobby' : 'online');
    });
    // online: a leaver's squidkid keeps playing as a bot (the host simulates it from here on)
    on('net:takeover', ({ actor }) => {
      if (!this.match || !actor) return;
      const mine = actor.team === this.match.local?.team;
      this.hud?.feed({ text: `${actor.name} left — a bot takes over`, color: G.teamHex[actor.team], kind: mine ? 'death' : 'info' });
    });
    on('match:state', ({ state, match }) => {
      if (match.attract || match !== this.match) return;
      if (state === 'intro' && match.online) this._onlineReveal();
      if (state === 'intro') this._intro();
      if (state === 'playing') {
        this.hud?.banner('go'); G.audio?.play('go_horn');
        this._playMusic('battle');
        if (this.match.local) { this.rig.follow(this.match.local, true); }
      }
      if (state === 'finish') {
        this.hud?.banner('timesup'); G.audio?.play('times_up'); G.music?.stop?.(0.4); this._musicTrack = null;
        this.input.exitLock();
      }
      if (state === 'judge') this._judge();
    });
  }

  // ---------------------------------------------------------------------------------------- attract mode
  _startAttract() {
    this._endOnline();
    if (this.match) this.match.dispose();
    G.projectiles.clear(); G.fx.clear?.(); G.paint.clear();
    const m = (this.match = G.match = new Match({ attract: true, duration: 99999, difficulty: 'normal', CharacterClass: this.CharacterClass, rig: this.rig, input: this.input }));
    m.setup(); m.start();
    for (const a of m.actors) { a.respawnTimer = 0; }
    this.attractT = 0; this.shotT = 0; this.shotIdx = 0;
    this._attractShot();
    this.hud?.setVisible(false);
  }
  _attractShot() {
    const shots = ['orbit', 'follow', 'orbit2', 'follow'];
    const s = shots[this.shotIdx++ % shots.length];
    this.shotT = s.startsWith('follow') ? 7 : 10;
    if (s === 'orbit') this.rig.orbit(new THREE.Vector3(0, 1, 0), 34, 17, 0.05, Math.random() * 6);
    else if (s === 'orbit2') this.rig.orbit(new THREE.Vector3(0, 2, -8), 18, 7, -0.07, Math.random() * 6);
    else {
      const alive = this.match.actors.filter((a) => a.alive);
      const a = alive[(Math.random() * alive.length) | 0];
      if (a) { this.rig.follow(a, true); this.rig.yaw = a.yaw; this.rig.pitch = -0.28; this._attractFollow = a; }
    }
  }
  _updateAttract(dt) {
    this.attractT += dt; this.shotT -= dt;
    if (this.menus?.current === 'title') { if (this.rig.mode !== 'orbit') this.rig.orbit(new THREE.Vector3(0, 1, 0), 34, 17, 0.05, 0); }
    else if (this.shotT <= 0) this._attractShot();
    if (this.rig.mode === 'follow' && this._attractFollow) {
      const a = this._attractFollow;
      if (!a.alive) this.shotT = Math.min(this.shotT, 0.5);
      this.rig.yaw = G.time > 0 ? this.rig.yaw + (((a.yaw - this.rig.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * (1 - Math.exp(-2 * dt)) : a.yaw;
    }
    const cov = G.paint.coverage();
    if (this.attractT > 110 || cov[0] + cov[1] > 0.72) {
      this._fade(1, 400).then(() => { this._setPalette(this._pickPalette()); this._startAttract(); this._fade(0, 600); });
      this.attractT = -999;
    }
  }

  // ---------------------------------------------------------------------------------------- match flow
  // lamps, signs, lit windows: follow the environment's night factor (0 day / golden … 1 dusk)
  _applyNight() {
    const k = G.env?.getSkyColors?.()?.night ?? 0;
    this.props?.setNight?.(k); this.decor?.setNight?.(k);
  }

  // Stage, time of day and a clean slate for a new match (offline and online starts).
  async _prepareStage(mapId, time) {
    G.music?.stop?.(0.3); this._musicTrack = null;
    this.showcase.hide();
    this._endOnline();
    if (this.match) this.match.dispose();
    G.projectiles.clear(); G.fx.clear?.(); G.paint.clear();
    const map = MAPS.find((m) => m.id === mapId) || MAPS[0];
    // a new layout, or a world-detail change since the last build (ink atlas, surface textures, prop geometry)
    if ((map.layout || map.id) !== this.layoutId || this._builtDetail !== this.gfx.detail) await this._buildWorld(map, true);
    const theme = mapTheme(map, time);
    this.time = time === 'dusk' ? 'dusk' : 'day';
    if (theme !== this.theme) {
      this.theme = theme;
      G.env.setTheme?.(theme);
      if (G.env.envMap) G.scene.environment = G.env.envMap;
      G.fx.setLighting?.(G.env.getSkyColors?.());
    }
    this._applyNight();   // after any stage rebuild too (new prop kit / decor)
    this.mapDef = map;
  }

  async startMatch(o = {}) {
    if (this.session.status !== 'idle') this.session.leave();   // an offline match never runs inside a room
    const opts = {
      mapId: o.mapId === 'sunset' ? 'tidewater' : (o.mapId || this.mapDef.id),
      time: o.mapId === 'sunset' ? 'dusk' : (o.time || this.time || 'day'),
      difficulty: o.difficulty || this.settings.difficulty,
      duration: o.duration || this.settings.matchLength || MATCH.defaultDuration,
    };
    this.lastMatchOpts = opts;
    G.audio?.init?.();
    this.input.requestLock();
    this._immersive();
    this.menus?.show(null);
    await this._fade(1, 350);
    await this._prepareStage(opts.mapId, opts.time);
    this._setPalette(this._pickPalette());
    const m = (this.match = G.match = new Match({
      attract: false, duration: opts.duration, difficulty: opts.difficulty, weapon: this.profile.weapon || 'shooter',
      playerName: this.profile.name || 'Player', CharacterClass: this.CharacterClass, rig: this.rig, input: this.input,
      autopilot: params.has('autopilot'), style: this.profile.style || null,
    }));
    m.setup();
    this.minimap.setViewerTeam(0);
    G.mode = 'match';
    this.hud?.setVisible(false);
    this.hudPrompt = null; this._hintT = 0; this._hints = {};
    m.start();
    this._fade(0, 500);
  }

  // ---------------------------------------------------------------------------------------- online match flow
  // The host started a match (session 'start', or our own START on the host). Build the stage behind the loading
  // screen, then sit in 'wait' until the host has heard from every browser and starts the intro for everyone.
  async startOnlineMatch(cfg) {
    const mid = cfg.mid;
    const stale = () => this.session.mid !== mid || this.session.phase !== 'match';
    this._onlineLoading = true; this._pendingEnd = null;
    try {
      G.audio?.init?.();
      this.input.exitLock();
      this.menus?.show(null);
      await this._fade(1, 300);
      this.menus?.show('loading');
      this.menus?.setLoading(0.3, 'Joining the turf war…');
      this._fade(0, 200);
      // (a macrotask, not a frame: a hidden tab gets no animation frames but must still load — see _bgFrame)
      await new Promise((r) => setTimeout(r, 30));
      if (stale()) return;
      await this._prepareStage(cfg.mapId, cfg.time);
      if (stale()) return;
      // same palette as the room (colours are per screen: the colour-blind setting still wins locally)
      this._setPalette(this.settings.colorblind ? COLORBLIND_PALETTE : (TEAM_PALETTES[cfg.palette] || this._pickPalette()));
      const m = (this.match = G.match = new Match({
        attract: false, duration: cfg.duration, difficulty: cfg.difficulty, weapon: this.profile.weapon || 'shooter',
        playerName: this.profile.name || 'Player', CharacterClass: this.CharacterClass, rig: this.rig, input: this.input,
        autopilot: params.has('autopilot'), style: this.profile.style || null,
        online: { roster: cfg.roster, isHost: cfg.isHost, selfId: cfg.selfId },
      }));
      m.setup();
      this.netMatch = new NetMatch(this.session, m, cfg);
      this._bgSync?.();   // (already hidden? keep ticking)
      this.lastMatchOpts = { mapId: cfg.mapId, time: cfg.time, difficulty: cfg.difficulty, duration: cfg.duration };
      this.minimap.setViewerTeam(m.local ? m.local.team : 0);
      G.mode = 'match';
      this.hud?.setVisible(false);
      this.hudPrompt = null; this._hintT = 0; this._hints = {};
      m.start();   // 'wait'
      this.rig.overview();
      this.menus?.setLoading(0.92, 'Waiting for squidkids…');
      this.session.markLoaded();
    } finally {
      this._onlineLoading = false;
    }
    const pendingEnd = this._pendingEnd;
    this._pendingEnd = null;
    // the room moved on while the stage loaded (match ended, host gone): back to the lobby / online screen
    if (stale() || !this.netMatch || this.netMatch.mid !== mid) return this._leaveMatchTo(this.session.status === 'lobby' ? 'lobby' : 'online');
    if (pendingEnd) { this._onlineEnded(pendingEnd); return; }
    if (this._pendingGo && this._pendingGo.mid === mid) { const g = this._pendingGo; this._pendingGo = null; this._onlineAllLoaded(g.mid, g.missing); }
  }

  // host: every browser has the stage (or timed out → its squidkid goes to a bot) — start the intro for the room
  _onlineAllLoaded(mid, missing) {
    const nm = this.netMatch, m = this.match;
    if (!nm || nm.mid !== mid || !m) { this._pendingGo = { mid, missing }; return; }
    if (m.state !== 'wait') return;
    for (const id of missing) nm.takeOver(id);
    m.setState('intro');
  }

  // host: a member left mid-match — the bots take their squidkid over
  _onlinePeerLeft(id) { this.netMatch?.takeOver(id); }

  // the intro is starting on every screen: drop the loading screen
  _onlineReveal() {
    this.menus?.show(null);
    // the match started from a network message, not a click: the next click on the game takes the mouse
    this._relock = true;
    this.input.requestLock();
  }

  // The match ended under us (session.onEnd): the host quit the match, the host / room is gone, or we failed.
  _onlineEnded(reason) {
    if (this._onlineLoading) { this._pendingEnd = reason; return; }
    const m = this.match;
    if (!m || !m.online) return;   // not in a match: the lobby / online screens follow the session themselves
    const roomAlive = this.session.status === 'lobby';
    // results on screen and the room still there: everyone heads back to the lobby at their own pace
    if (roomAlive && (m.state === 'judge' || m.state === 'results')) return;
    if (roomAlive) this.session.notice = reason === 'host' ? 'The host ended the match.' : null;
    this._leaveMatchTo(roomAlive ? 'lobby' : 'online');
  }

  // results → lobby (host: this also ends the match for anyone still on their results screen)
  _backToLobby() {
    if (this.session.isHost && this.session.phase === 'match') this.session.endMatch('ended');
    return this._leaveMatchTo(this.session.status === 'lobby' ? 'lobby' : 'online');
  }

  _endOnline() {
    if (this.netMatch) { this.netMatch.dispose(); this.netMatch = null; }
    this._pendingGo = null;
    this._bgSync?.();
  }

  _intro() {
    const L = G.level;
    const local = this.match.local;
    // sweep from high over the enemy base down behind the player (a stage can open on its own hero shot instead).
    // Written for team 0; the other base is the 180° rotation of the stage, so team 1 gets the same shot mirrored.
    const T = local ? local.team : 0, pad = L.spawnPads[0];
    const I = L.layout?.intro;
    const from = I ? new THREE.Vector3(...I.from) : new THREE.Vector3(18, 26, 30), to = new THREE.Vector3(pad.x, pad.y + 2.6, pad.z - (I?.toBack ?? 5.2));
    const lookFrom = I ? new THREE.Vector3(...I.lookFrom) : new THREE.Vector3(0, 0, 10), lookTo = new THREE.Vector3(pad.x, pad.y + 1.6, pad.z + 6);
    if (T === 1) for (const v of [from, to, lookFrom, lookTo]) { v.x = -v.x; v.z = -v.z; }
    this.rig.cinematic(from, to, lookFrom, lookTo, 3.6, () => {});
    this.rig.yaw = T === 1 ? Math.PI : 0; this.rig.pitch = -0.12;
    G.audio?.play('ready');
    setTimeout(() => { if (this.match?.state === 'intro') this.hud?.banner('ready'); }, 1700);
    setTimeout(() => { if (this.match?.state === 'intro') this.hud?.setVisible(true); }, 3000);
    this._playMusic(null);
  }

  pause() {
    if (!this.match || this.match.attract || this.match.paused) return;
    // only a live round (or its intro) can pause — never on top of time's up / judge / results
    if (this.match.state !== 'playing' && this.match.state !== 'intro') return;
    // online the room plays on: the menu opens over the live match (your squidkid stands still meanwhile)
    if (this.match.online) { this.input.exitLock(); this.menus?.show('pause'); return; }
    this.match.paused = true;
    this.input.exitLock();
    this.menus?.show('pause');
    G.audio?.duck?.(0.5, 99);
  }
  resume() {
    if (!this.match) return;
    this.menus?.show(null);
    this.match.paused = false;
    this.input.requestLock();
    G.audio?.duck?.(1, 0.01);
  }
  quitToMenu() {
    if (this.match?.online) {
      // host: the match ends for the whole room (everyone back to the lobby) · member: leave the room
      if (this.session.isHost && this.session.status === 'lobby') { this.session.endMatch('host'); return this._leaveMatchTo('lobby'); }
      this.session.leave();
    }
    return this._leaveMatchTo('main');
  }
  async _leaveMatchTo(screen) {
    this.input.exitLock();
    this.menus?.show(null);
    await this._fade(1, 350);
    this._endOnline();
    this.hud?.setVisible(false);
    this.hud?.hideSplatted?.();
    this.showcase.hide();
    G.mode = 'menu';
    this._setPalette(this._pickPalette());
    this._startAttract();
    this.menus?.show(screen);
    this._playMusic('menu');
    G.audio?.duck?.(1, 0.01);
    this._fade(0, 500);
  }

  async _judge() {
    const m = this.match;
    this.hud?.hideSplatted?.();
    this.rig.overview();
    this.hud?.setVisible(true);
    // everything below is from the local player's side: your team first (online you may be team 1)
    const local = m.local, T = local ? local.team : 0, E = 1 - T;
    const cov = m.result.coverage, names = this.palette.names || TEAM_NAMES;
    // the table is frozen as judging starts (online: the same instant the host sends its numbers), so a storm cloud
    // still raining during the reveal can't make one screen's table differ from another's
    const final = new Map(m.actors.map((a) => [a, { turf: Math.round(a.stats.turf), splats: a.stats.splats, deaths: a.stats.deaths }]));
    const judgeP = this.hud?.judge({ colors: [G.teamHex[T], G.teamHex[E]], percents: [cov[T] * 100, cov[E] * 100], names: [names[T], names[E]] });
    await (judgeP || new Promise((r) => setTimeout(r, 4000)));
    if (m !== this.match) return;   // (online: we left while the judge animation ran)
    const won = m.result.winner === T;
    m.setState('results');
    this.hud?.setVisible(false);
    // profile / XP
    const p = this.profile;
    const mine = final.get(local), turf = mine.turf;
    const gained = Math.round((won ? PROGRESSION.xpWin : PROGRESSION.xpLose) + turf * PROGRESSION.xpPerTurfPoint + mine.splats * PROGRESSION.xpPerSplat);
    const before = { level: p.level, xp: p.xp, toNext: PROGRESSION.xpForLevel(p.level) };
    p.xp += gained; p.matches++; if (won) p.wins++; p.totalTurf += turf;
    while (p.xp >= PROGRESSION.xpForLevel(p.level)) { p.xp -= PROGRESSION.xpForLevel(p.level); p.level++; }
    saveJSON('inkwave.profile', p);
    const data = {
      win: won, percents: [cov[T] * 100, cov[E] * 100], colors: [G.teamHex[T], G.teamHex[E]], teamNames: [names[T], names[E]],
      players: m.actors.map((a) => ({ name: a.name, team: a.team === T ? 0 : 1, weapon: a.weaponId, ...final.get(a), isSelf: a.isLocal })),
      xp: { gained, levelBefore: before.level, levelAfter: p.level, xpBefore: before.xp, xpAfter: p.xp, xpToNextBefore: before.toNext, xpToNextAfter: PROGRESSION.xpForLevel(p.level) },
      mapName: this.mapDef.name,
      online: !!m.online,
    };
    // your team on the podium
    const team = m.actors.filter((a) => a.team === T);
    this.showcase.showResults(T, won, G.teamColors[T], team.map((a) => ({ weapon: a.weaponId, style: a.character.style || { hair: a.slot % 4, skin: (a.slot * 3) % 4 }, name: a.name })));
    this.menus?.showResults(data);
    this.menus?.show('results');
    G.audio?.play(won ? 'victory_fanfare' : 'defeat_jingle');
    setTimeout(() => this._playMusic(won ? 'results_win' : 'results_lose'), 2600);
  }

  _fade(to, ms) {
    return new Promise((r) => {
      const el = this.fadeEl;
      if (!el) return r();
      el.style.transition = `opacity ${ms}ms ease`;
      el.style.opacity = String(to);
      el.style.pointerEvents = to > 0.5 ? 'all' : 'none';
      setTimeout(r, ms + 20);
    });
  }

  // ---------------------------------------------------------------------------------------- loop
  _loop(now) {
    requestAnimationFrame((t) => this._loop(t));
    // frame-rate limit: skip display frames until the next slot is due (before the timer, so dt spans rendered frames)
    const lim = this.settings.fpsLimit | 0;
    if (lim > 0 && now > 0) {
      const iv = 1000 / lim, el = now - (this._limitAt || 0);
      if (el < iv - 1.5) return;   // (display frames arrive with jitter: 1.5 ms early still counts as on time)
      // advance by whole slots so an early frame never shifts the grid (else 30 fps ran at ~37)
      this._limitAt = el > iv * 3 ? now : this._limitAt + iv * Math.max(1, Math.floor((el + 1.5) / iv));
    }
    this.timer.update(); let dt = this.timer.getDelta();
    if (this.frozen || this._bgActive) return;   // (hidden tab online: the background tick drives the frames)
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }
    this._gfxTick(dt);
    dt = Math.min(dt, 1 / 24);
    this._frame(dt);
  }

  // Online, a hidden tab must keep simulating its squidkid(s) and talking to the room: requestAnimationFrame stops in
  // background tabs (a sleeping host would freeze the match for everyone) and page timers are throttled to ~1 Hz. A
  // tiny worker's timer is not, so while hidden its ticks drive sim-only frames (no rendering) until the tab is back.
  _initBackgroundTick() {
    this._bgActive = false;
    this._bgSync = () => {
      const want = document.hidden && !!this.netMatch;
      if (want === this._bgActive) return;
      if (want) {
        if (!this._bgWorker) {
          try {
            this._bgUrl = URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' }));
            this._bgWorker = new Worker(this._bgUrl);
            this._bgWorker.onmessage = () => this._bgFrame();
          } catch (e) { console.warn('[inkwave] background tick unavailable', e); return; }
        }
        this._bgActive = true;
        this._bgLast = performance.now();
      } else {
        this._bgActive = false;
        this._bgWorker?.terminate(); this._bgWorker = null;
        if (this._bgUrl) { URL.revokeObjectURL(this._bgUrl); this._bgUrl = null; }
        this.timer?.update();   // the next visible frame measures from now, not from when the tab was hidden
      }
    };
    document.addEventListener('visibilitychange', this._bgSync);
  }
  _bgFrame() {
    if (!this._bgActive) return;
    if (!this.netMatch || !document.hidden) { this._bgSync(); return; }
    const now = performance.now(), dt = Math.min(1 / 24, Math.max(0, (now - this._bgLast) / 1000));
    this._bgLast = now;
    if (dt <= 0) return;
    this._skipRender = true;
    try { this._frame(dt); } finally { this._skipRender = false; }
  }

  // Manual presets with dynamic resolution on: when a 4 s window of a live round averages under ~40 fps, drop render
  // density one notch (down to 0.75). Stepping back up needs 12 s of real headroom and happens at most twice, so the
  // image never pumps between sizes (re-sizing every couple of seconds read as flicker). Auto adapts on its own.
  _dynRes(dt, live) {
    if (dt <= 0 || dt > 0.25) return;
    const d = this._dyn || (this._dyn = { acc: 0, n: 0, t: 0, fast: 0, ups: 0 });
    d.acc += dt; d.n++; d.t += dt;
    if (d.t < 4) return;
    const avg = d.acc / d.n;
    d.acc = 0; d.n = 0; d.t = 0;
    if (!live) { d.fast = 0; return; }
    const s = this.R.dynScale || 1;
    if (avg > 1 / 40 && s > 0.76) { this.R.setDynamicScale(s - 0.125); d.fast = 0; }
    else if (avg < 1 / 75 && s < 1 && d.ups < 2) { if (++d.fast >= 3) { this.R.setDynamicScale(s + 0.125); d.fast = 0; d.ups++; } }
    else d.fast = 0;
  }

  _frame(dt) {
    const tA = performance.now();
    G.renderer.info.reset();
    G.time += dt;
    this.input.pollPad();
    this._padMenus();
    const m = this.match;
    if (m) {
      // online: remote squidkids to their (delayed) snapshots + their due events, before anything simulates
      this.netMatch?.preUpdate(dt);
      m.inputBlocked = !!this.menus?.current;   // online the menu never pauses the round; it only takes your hands off
      m.updateController(dt);
      const sub = dt > 1 / 45 ? 2 : 1; // substep physics on slow frames
      for (let i = 0; i < sub; i++) m.update(dt / sub);
      if (!m.paused) G.projectiles.update(dt);
      this.netMatch?.flush(dt);
      if (m.state === 'wait' && this.menus?.current === 'loading') this._waitLabel(dt);
      if (m.attract) this._updateAttract(dt);
      else if (m.state === 'playing' && m.local?.alive && this.rig.mode !== 'follow' && this.rig.mode !== 'path') this.rig.follow(m.local, true);
    }
    if (!m || !m.paused) G.fx.update(dt, G.camera);
    if (!m || !m.paused) this.fxHooks?.update?.(dt);
    this.screenfx?.update?.(dt, this);
    G.env.update?.(dt, G.camera);
    this.decor.update(dt);
    this.props?.update?.(dt, G.time);
    // map diorama: held map key during live play (or while waiting to respawn) swoops the view overhead
    this.rig.setMap?.(!!(m && !m.attract && !m.paused && m.state === 'playing' && m.controller?.mapHeld && !this.menus?.current));
    this.rig.update(dt);
    this._dioFog();
    this.diorama?.update(dt, this.rig.mapK);
    // local player camera-dependent aim must use this frame's camera
    if (m && m.controller && m.state === 'playing') m.controller.computeAim?.();
    // bomb arc preview
    const loc = m?.local;
    G.projectiles.updateArc(loc, !!(loc && loc.alive && loc.weaponRunner.aimingSub && m.state === 'playing' && !m.paused));
    const tB = performance.now();
    // paint → atlas, shader uniforms
    G.paint.flush(dt);
    this.levelMat.userData.uniforms.uTime.value = G.time;
    // see-through window toward the local player
    {
      const lu = this.levelMat.userData.uniforms;
      const on = !!(m && !m.attract && loc && loc.alive && this.rig.mode === 'follow' && this.rig.target === loc && this.rig.mapK < 0.3);
      lu.uSeeOn.value = damp(lu.uSeeOn.value, on ? 1 : 0, 10, dt);
      lu.uSeeA.value.copy(G.camera.position);
      if (loc) lu.uSeeB.value.set(loc.pos.x, loc.pos.y + (loc.form === 'squid' ? 0.4 : 1.0), loc.pos.z);
      if (this.grateMat) { const gu = this.grateMat.userData.uniforms; gu.uSeeOn.value = lu.uSeeOn.value; gu.uSeeA.value.copy(lu.uSeeA.value); gu.uSeeB.value.copy(lu.uSeeB.value); }
    }
    if (this.grateMat) this.grateMat.userData.uniforms.uTime.value = G.time;
    // swimmers' wakes in the ink surface
    if (this.swimWake && (!m || !m.paused)) this.swimWake.update(dt, this.levelMat.userData.uniforms, G.camera.position);
    this.showcase.update(dt);
    this._updateLocalLoops(dt);
    this._updateAmbience(dt);
    // audio listener
    if (G.audio?.setListener) {
      const cam = this.rig.gameCam || G.camera;   // the player's ears stay with the player while the map is up
      G.audio.setListener(cam.position, cam.getWorldDirection(this._lf || (this._lf = new THREE.Vector3())), cam.up);
    }
    // post uniforms (low-hp vignette)
    const g = this.R.grade.uniforms;
    const hpK = loc && m && !m.attract && loc.alive ? clamp(1 - loc.hp / 55, 0, 1) : 0;
    g.uHurt.value = damp(g.uHurt.value, hpK * 0.8, 6, dt);
    if (loc) g.uHurtColor.value.copy(G.teamColors[loc.enemyTeam]);
    // shadows: every frame (half-rate updates made moving shadows — your own, right under the crosshair — judder);
    // only the low shadow setting halves it
    const sm = G.renderer.shadowMap;
    sm.autoUpdate = false;
    this._frameN = (this._frameN || 0) + 1;
    if (!this.gfx.shadowHalfRate || (this._frameN & 1)) sm.needsUpdate = true;
    if (!this._skipRender && !this._gpuLost) {
      this.R.render();
      if (this.showcase.mode) sm.needsUpdate = true;
      this.showcase.render();
    }
    const tC = performance.now();
    const ps = this.perf || (this.perf = { sim: 0, render: 0, ui: 0, calls: 0, tris: 0 });
    ps.sim += (tB - tA - ps.sim) * 0.05; ps.render += (tC - tB - ps.render) * 0.05;
    ps.calls = G.renderer.info.render.calls; ps.tris = G.renderer.info.render.triangles;
    // HUD
    if (m && !m.attract && this.hud && (m.state === 'playing' || m.state === 'intro' || m.state === 'finish')) this._updateHud(dt);
    this.menus?.update?.(dt);
    this.touch?.update();
    this.input.endFrame();
    ps.ui += (performance.now() - tC - ps.ui) * 0.05;   // HUD + menus + touch layer (DOM work; the browser's style / paint come after)
  }

  // continuous sounds tied to the local player's state (swim gurgle, wall climb, enemy-ink sizzle)
  // harbour soundscape: continuous sea wash + occasional gull cries out over the water
  _updateAmbience(dt) {
    if (!this._audioOn || !G.audio?.loop) return;
    if (!this._amb) this._amb = G.audio.loop('harbor_ambience', { volume: 0.55 });
    this._gullT = (this._gullT ?? 4) - dt;
    if (this._gullT <= 0) {
      this._gullT = 7 + Math.random() * 12;
      const B = G.level.bounds, a = Math.random() * Math.PI * 2;
      const p = this._gullP || (this._gullP = new THREE.Vector3());
      p.set(Math.cos(a) * (B.maxX + 25), 12 + Math.random() * 8, Math.sin(a) * (B.maxZ + 20));
      G.audio.play('gull', { pos: p, volume: 0.6 + Math.random() * 0.4, pitch: 0.9 + Math.random() * 0.25 });
    }
    // marina: rigging ringing against the masts in the gusts, and now and then a ship's horn out in the channel
    if (G.level?.layout?.id === 'halyard') {
      const p = this._ambP || (this._ambP = new THREE.Vector3());
      this._gustT = (this._gustT ?? 2) - dt;
      if (this._gustT <= 0) { this._gustT = 2.5 + Math.random() * 4; this._clinks = 2 + ((Math.random() * 4) | 0); this._clinkT = 0; }
      if (this._clinks > 0 && (this._clinkT -= dt) <= 0) {
        this._clinks--; this._clinkT = 0.12 + Math.random() * 0.45;
        const s = Math.random() < 0.5 ? -1 : 1;
        p.set(s * (27 + Math.random() * 14), 8 + Math.random() * 4, (Math.random() * 2 - 1) * 40);
        G.audio.play('halyard_clink', { pos: p, volume: 0.5 + Math.random() * 0.5, pitch: 0.85 + Math.random() * 0.35 });
      }
      this._hornT = (this._hornT ?? 28 + Math.random() * 10) - dt;
      if (this._hornT <= 0) {
        this._hornT = 55 + Math.random() * 30;
        p.set((Math.random() < 0.5 ? -1 : 1) * 95, 8, (Math.random() * 2 - 1) * 70);
        G.audio.play('ferry_horn', { pos: p, volume: 0.8 });
      }
    }
  }

  _updateLocalLoops(dt) {
    const m = this.match, a = m && !m.attract && !m.paused ? m.local : null;
    const L = this._loops || (this._loops = {});
    const want = (name, on, vol, pitch = 1) => {
      if (on && !L[name]) L[name] = G.audio?.loop?.(name, { volume: 0 });
      const h = L[name];
      if (!h) return;
      h._v = damp(h._v || 0, on ? vol : 0, on ? 10 : 7, dt);
      h.set({ volume: h._v, pitch });
      if (!on && h._v < 0.01) { h.stop(0.05); L[name] = null; }
    };
    const alive = !!(a && a.alive);
    const hs = alive ? Math.hypot(a.vel.x, a.vel.z) : 0;
    want('swim', alive && a.anim.form === 'swim' && hs > 0.5, Math.min(0.6, hs / 11.8 * 0.6 + 0.08), 0.6 + Math.min(1, hs / 11.8));
    want('climb', alive && a.anim.form === 'climb', 0.5, alive ? 0.6 + Math.min(1, Math.abs(a.vel.y) / 7.5) : 1);
    want('enemy_ink_sizzle', alive && a.grounded && a.groundTeam === 2, 0.45, 1.0);
  }

  _padMenus() {
    const inp = this.input;
    if (!inp.pad) return;
    const pp = inp.padPressed;
    if (this.menus?.current) {
      const nav = (d) => this.menus.nav?.(d);
      if (pp.has(12)) nav('up'); if (pp.has(13)) nav('down'); if (pp.has(14)) nav('left'); if (pp.has(15)) nav('right');
      if (pp.has(0)) nav('accept'); if (pp.has(1)) nav('back'); if (pp.has(2)) nav('alt');   // X: locker shuffle etc.
      if (pp.has(4)) nav('tab_prev'); if (pp.has(5)) nav('tab_next');
      // left stick as d-pad with repeat
      const ly = inp.padAxis(1), lx = inp.padAxis(0);
      this._stickT = (this._stickT || 0) - 1 / 60;
      if (this._stickT <= 0) {
        if (ly < -0.6) { nav('up'); this._stickT = 0.22; } else if (ly > 0.6) { nav('down'); this._stickT = 0.22; }
        else if (lx < -0.6) { nav('left'); this._stickT = 0.22; } else if (lx > 0.6) { nav('right'); this._stickT = 0.22; }
      }
      if (pp.has(9) && this.menus.current === 'pause') this.resume();
    } else if (G.mode === 'match' && pp.has(9)) this.pause();
  }

  // online, while every browser loads the stage: who we're waiting for
  _waitLabel(dt) {
    this._waitT = (this._waitT || 0) - dt;
    if (this._waitT > 0) return;
    this._waitT = 0.4;
    const { loaded, total } = this.session.loadProgress();
    this.menus?.setLoading(0.92, this.session.isHost ? `Waiting for squidkids… ${loaded}/${total}` : 'Waiting for the host…');
  }

  // Online you may be on team 1: the HUD always gets your team first / 'enemy' = the other one (it was written for
  // team 0 = you).
  _updateHud(dt) {
    const m = this.match, a = m.local, cam = G.camera;
    const showMap = this.settings.minimap !== false;
    if (showMap) this.minimap.update(dt);
    const w = a.weapon;
    // crosshair spread = the weapon's live cone (first-shot accurate, blooms with sustained fire / in the air)
    const vHalf = (G.camera.fov * Math.PI) / 360;
    const coneDeg = a.weaponRunner.spread ?? (w.kind === 'shooter' ? 5.5 : w.kind === 'blaster' ? 1.2 : 0);
    const spread = w.kind === 'roller' ? 28 : Math.min(90, (Math.tan((coneDeg * Math.PI) / 180) / Math.tan(vHalf)) * (view.h / 2));
    const players = [];
    const t = { x: 0, y: 0 };
    if (showMap) for (const o of m.actors) {
      if (!o.alive) continue;
      if (o.team !== a.team && !o.isLocal) {
        // enemies only show on the map when visible to your team (not submerged far away)
        if (o.anim.form === 'swim') continue;
      }
      this.minimap.toCanvas(o.pos.x, o.pos.z, t);
      players.push({ x: t.x / this.minimap.w, y: t.y / this.minimap.h, team: o.team === a.team ? 0 : 1, isSelf: o.isLocal, yaw: -o.yaw + (this.minimap.flip ? Math.PI : 0), alive: o.alive, color: G.teamHex[o.team] });
    }
    // ally markers
    const markers = [];
    const v = this._mv || (this._mv = new THREE.Vector3());
    const W = view.w, H = view.h;
    for (const o of m.actors) {
      if (o.isLocal || o.team !== a.team || !o.alive) continue;
      if (o.character.getHeadPosition && o.form !== 'squid') { o.character.getHeadPosition(v); v.y += 0.45; }
      else { if (o.visualPos) o.visualPos(v); else v.copy(o.pos); v.y += o.form === 'squid' ? 1.0 : 1.9; }
      v.project(cam);
      const behind = v.z > 1;
      let x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
      const onScreen = !behind && x > 20 && x < W - 20 && y > 20 && y < H - 20;
      let angle = 0;
      if (!onScreen) {
        let dx = x - W / 2, dy = y - H / 2;
        if (behind) { dx = -dx; dy = -dy; }
        angle = Math.atan2(dy, dx);
        const k = Math.min((W / 2 - 40) / Math.max(1e-3, Math.abs(Math.cos(angle))), (H / 2 - 40) / Math.max(1e-3, Math.abs(Math.sin(angle))));
        x = W / 2 + Math.cos(angle) * k; y = H / 2 + Math.sin(angle) * k;
      }
      markers.push({ x, y, name: o.name, color: G.teamHex[o.team], onScreen, angle, dist: o.pos.distanceTo(a.pos) });
    }
    // contextual prompts (light tutorial)
    this._hintT += dt;
    let prompt = null;
    const inkF = a.ink / PLAYER.inkMax;
    if (m.state === 'playing' && a.alive) {
      const k = HINT_KEYS[this.input.lastDevice] || HINT_KEYS.kbm;
      if (m.controller?.mapHeld) prompt = null;   // the map diorama carries its own super-jump hints
      else if (a.superJumpState) prompt = null;
      else if (this._lowInkFlash > 0) { this._lowInkFlash -= dt; prompt = `Low ink! Hold ${k.swim} in your ink to refill`; }
      else if (a.specialReady() && (this._hints.specialT = (this._hints.specialT || 0) + dt) > 2) prompt = `Special ready! ${k.special}`;
      else if (inkF < 0.25 && a.form !== 'squid') prompt = `Hold ${k.swim} to swim in your ink and refill`;
      else if (m.duration - m.time < 8 && !this._hints.shot) prompt = 'Paint the ground — most turf wins!';
      else if (m.online && !this.input.locked && this.input.lastDevice === 'kbm') prompt = 'Click to aim with the mouse';
      if (!a.specialReady()) this._hints.specialT = 0;
      if (a.intent.fire) this._hints.shot = true;
    }
    const teams = m.teamSummary();
    if (a.team === 1) teams.reverse();
    const frame = {
      time: m.time,
      teams,
      ink: a.ink / PLAYER.inkMax, inkLow: a.ink < 18 || (this._lowInkFlash > 0), subCost: SUB.bomb.inkCost / PLAYER.inkMax,
      special: a.specialFrac(), specialReady: a.specialReady(), specialActive: !!a.specialActive,
      hp: a.hp / PLAYER.hp,
      weapon: a.weaponId, charge: a.weaponRunner.charge,
      crosshair: { spread, onTarget: m.controller?.onTarget ? 'enemy' : null, inRange: m.controller ? m.controller.inRange !== false : true },
      // corner minimap follows the setting; the TAB map (needed for super jumps) is always available
      map: showMap ? { canvas: this.minimap.canvas, expanded: false, players } : null,
      markers,
      prompt,
      fps: this.settings.showFps ? this.fps : undefined,
    };
    this.hud.update(dt, frame);
  }
}

const game = new Game();
game.boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('boot-error');
  if (el) { el.textContent = 'Something went wrong while loading: ' + e.message; el.style.display = 'block'; }
});
