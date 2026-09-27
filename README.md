<p align="center">
  <img src="assets/stages/halyard-day.webp" alt="Halyard Marina at golden hour" width="100%">
</p>

<h1 align="center">INKWAVE</h1>

<p align="center">
  An original Splatoon-style 4v4 turf-war shooter that runs in your browser.<br>
  Paint the ground, swim through your ink, out-turf the other team.
</p>

<p align="center">
  <a href="https://inkwave-aah.pages.dev"><b>▶ Play now</b></a> ·
  <a href="#controls">Controls</a> ·
  <a href="#online-play">Online play</a> ·
  <a href="#running-locally">Run locally</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/jaydendavisnc/inkwave/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jaydendavisnc/inkwave/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="three.js r186" src="https://img.shields.io/badge/three.js-r186-000000?logo=three.js&logoColor=white">
  <img alt="No build step" src="https://img.shields.io/badge/build-none%20needed-2ea44f">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

---

## Features

- **Turf war, 4 v 4.** Three minutes, most ground painted wins. Play against bots on three difficulty levels.
- **Online with friends.** Host a room, share a code or link, and play up to 4 v 4, peer-to-peer with no account and no game server. Bots fill the empty slots.
- **Squid form.** Hold to dive into your ink: swim fast, refill your tank, climb inked walls, dolphin-jump water gaps.
- **Seven weapons**, each with its own feel: Spritzer (shooter), Swell Roller, Glint Charger, Popper Blaster, Twinfin Dualies (dodge roll), Tidebucket Slosher and Gyre Splatling. Every kit comes with Splat Bombs and a special.
- **Three stages, day or dusk.** Tidewater Plaza, Kelpline Terminal and Halyard Marina, a working marina with a car ferry moored across the middle where the water gaps are the whole point.
- **Ink that behaves like liquid.** Splats spread and settle, fresh ink is glossy and dries, drips run down walls, and swimming leaves a wake in the surface itself.
- **A map you can actually read.** Hold <kbd>Tab</kbd> and the camera cranes up into a tilt-shift diorama of the live stage, with pins for your team and one-click Super Jumps.
- **Locker.** Choose your squidkid: tentacle style, headgear, face, outfit.
- **Everything procedural.** Characters, animation, weapons, textures, props, sound effects and music are all generated in code. There are no downloaded assets except two fonts.

<p align="center">
  <img src="assets/stages/tidewater-day.webp" width="49%" alt="Tidewater Plaza">
  <img src="assets/stages/kelpline-dusk.webp" width="49%" alt="Kelpline Terminal at dusk">
</p>

## Controls

| Action | Keyboard / mouse | Gamepad |
|---|---|---|
| Move | <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> | Left stick |
| Aim | Mouse | Right stick |
| Fire | Left click | RT |
| Squid form | <kbd>Shift</kbd> | LT |
| Jump / dodge roll | <kbd>Space</kbd> | A |
| Sub weapon (bomb) | Right click / <kbd>E</kbd> | RB |
| Special | <kbd>F</kbd> | Y |
| Map + Super Jump | Hold <kbd>Tab</kbd> or <kbd>M</kbd>, then <kbd>1</kbd>–<kbd>4</kbd> or click a pin | View |
| Pause | <kbd>Esc</kbd> | Start |

Gamepads work on the hosted (https) version. On a plain `http://` LAN address browsers block the Gamepad API.

## Online play

**PLAY ONLINE → HOST A ROOM** gives you a room code and an invite link. Friends open the link, or choose
**PLAY ONLINE → JOIN** and type the code. In the lobby everyone picks a team (up to 4 per side) and a weapon, and the
host picks the stage and presses START. Empty slots can be filled with bots.

Matches are peer-to-peer over WebRTC. Browsers find each other through public Nostr relays
([Trystero](https://github.com/dmotz/trystero)), and all game data then flows directly between players. Everyone in a
room can see the others' IP addresses, so share codes with people you trust. The authority model, wire protocol,
configuration (TURN, pinned relays) and threat model are in [docs/NETWORK.md](docs/NETWORK.md).

Online play needs a secure page: the hosted (https) version, or `http://localhost` on your own machine. Browsers
withhold the WebCrypto API that WebRTC signaling uses on plain `http://` LAN addresses. To try it on one machine, open
two tabs with `?net=local`: one hosts, the other joins with the code.

## Running locally

There is no build step. Any static file server works; the included one also serves to your LAN and sends no-cache headers so module updates are never stale.

```bash
git clone https://github.com/jaydendavisnc/inkwave.git
cd inkwave
npm start        # http://localhost:8490
```

Useful URL parameters: `?map=halyard&time=dusk` picks a stage, `&autostart=180` skips the menus into a 180 s match, `&autopilot` lets a bot drive you.

```bash
npm install      # once, for the headless tools
npm run check    # syntax-check every module
npm test         # online-play protocol tests (node)
npm run mptest   # 3 headless tabs play an online match and must agree (needs Chrome; see docs/NETWORK.md)
npm run smoke    # boot + 8 s of autopilot in headless Chrome, fails on console errors
npm run build    # assemble dist/ (game + only the three.js addons it imports)
```

## How it works

- **Ink is painted in texture space.** Every paintable face owns a region of one atlas (4K at High world detail, 2K below); splats are drawn into it on the GPU while a coarse CPU grid keeps the turf score and gameplay queries in sync. The level shader layers the ink over the surface with its own height, gloss and wetness. See [`src/world/paint.js`](src/world/paint.js) and [`src/world/inkShading.js`](src/world/inkShading.js).
- **Stages are data.** A layout is a list of boxes and ramps for one half of the arena; the other half is the 180° rotation, so both teams always get an identical field. Ambient occlusion is baked offline (`tools/bake-ao.mjs`). See [`src/world/maps.js`](src/world/maps.js).
- **Characters are fully procedural.** Geometry, materials, a 60-bone rig and every animation (locomotion, squid form, weapon poses, secondary motion) are code, driven by a spring-based pose system. See [`docs/RIG.md`](docs/RIG.md).
- **Systems talk through events.** Weapons, actors and the match emit typed events; effects, HUD and audio subscribe. The contract is documented in [`docs/EVENTS.md`](docs/EVENTS.md) and [`docs/CONTRACTS.md`](docs/CONTRACTS.md).
- **Deterministic tooling.** The game exposes a freeze/step debug interface so filmstrips, handling measurements and bot simulations are reproducible frame by frame (`tools/film.py`, `tools/measure-handling.mjs`).

Rendering is three.js r186 (vendored, plain ES modules with an import map) with GTAO, bloom and a custom grade pass. Graphics
default to **Auto**: a first guess from the GPU, then an in-match governor that settles on the level the machine holds at
60 fps. See [`docs/GRAPHICS.md`](docs/GRAPHICS.md) for the options, what each costs and how it was measured.

## Browser support

Chrome and Edge are the target; Firefox works. Safari runs but is slower. Integrated graphics run well on Auto or Low; High and
Ultra want a discrete GPU. **Settings → Video / Graphics** has the presets, a render-resolution slider, a frame-rate limit
and every effect individually (shadows, anti-aliasing, ambient occlusion, bloom, reflections, effects, world detail).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and the checks to run first.

## License

[MIT](LICENSE) © 2026 Jayden Davis. INKWAVE is an independent project and is not affiliated with Nintendo; Splatoon is a trademark of Nintendo.
