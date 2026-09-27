# Contributing to INKWAVE

Thanks for your interest! INKWAVE is a plain ES-module three.js project with no build step for development (only the release build bundles it), so getting started takes a minute.

## Running locally

```bash
git clone https://github.com/jaydendavisnc/inkwave.git
cd inkwave
npm install          # only needed for the headless tools (puppeteer-core)
npm start            # serves http://localhost:8490 (and your LAN address)
```

Open the URL in Chrome, Edge or Firefox. Everything reloads on refresh; there is no bundler in development. `npm run build` makes the release bundle in `dist/` (esbuild, pinned and run through npx, so it is not a project dependency).

## Before opening a pull request

```bash
npm run check        # node --check on every module
npm run smoke        # boots the game headlessly and plays 8 s on autopilot (needs Google Chrome installed)
npm test             # online-play protocol tests + graphics profiles / Auto governor
npm run mptest       # if you touched src/net, actor.js, weapons.js, paint.js or match.js: 3 tabs play online
npm run touchtest    # if you touched input, player.js, the HUD, menus or src/ui/touch.js: a phone plays via touch
```

Keep pull requests focused. If you change gameplay tuning, say what you measured and how (see `tools/measure-handling.mjs` and `tools/film.py` for the deterministic capture helpers). For rendering changes, measure GPU time with `tools/gfx-bench.mjs` (see docs/GRAPHICS.md). Check menu and HUD changes on a landscape phone viewport too (844×390); the menus are laid out for 16:9 and scroll their densest columns on short screens.

## Project map

| Path | What lives there |
|---|---|
| `src/core` | renderer + post chain, input, event bus |
| `src/game` | actors, weapons, bots, camera rig, character rig + animation, match flow |
| `src/world` | stage layouts, level geometry, ink painting, textures, environment, props |
| `src/fx` | particles, screen effects, event → effect wiring |
| `src/ui` | menus, HUD, map diorama, icons |
| `src/audio` | procedural sound effects and music |
| `src/net` | online play: wire protocol + validation, transports, lobby session, in-match sync (docs/NETWORK.md) |
| `docs` | event contract, module contracts, character rig reference, graphics settings + performance |
| `tools` | dev server, labs, headless capture and measurement scripts, release |

## Code style

Match the surrounding code: 2-space indent, single quotes, no semicolon-free style, comments that explain *why*. No per-frame allocations in hot paths, and no layout reads in per-frame code: read the viewport size from `view` (`src/core/ctx.js`), not `window.innerWidth` / `clientWidth`, which force a style + layout pass whenever the HUD changed the DOM. New stages must keep both halves identical (the layout is mirrored by a 180° rotation).

## Reporting bugs

Open an issue with your browser + GPU, the stage, and steps to reproduce. A screenshot or short clip helps a lot.
