# Game event bus

`import { on, emit, G } from '../core/ctx.js'` — `on(name, fn)` returns an unsubscribe function. Effects, HUD and
screen-FX modules should subscribe to these instead of editing gameplay code.

## Emitted today
| event | payload | where |
|---|---|---|
| `hit` | `{ attacker, victim, damage, killed, weaponId }` | weapons.js applyHit / storm |
| `damage` | `{ victim, attacker, amount, source }` | actor.damage |
| `splatted` | `{ victim, attacker, cause }` (cause: weapon id, 'water', …) | actor.splat |
| `respawn` | `{ actor }` | actor.respawn |
| `special:ready` | `{ actor }` | actor.addTurf |
| `special:use` | `{ actor, id }` ('slam' / 'storm') | actor._startSpecial |
| `superjump` | `{ actor, phase: 'charge' \| 'flight', to? }` | actor.superJump |
| `shake` | `{ amount, pos? }` | camera trauma requests |
| `recoil` | `{ amount }` | local-player visual recoil |
| `lowink` | `{ actor, need? }` | weapons |
| `match:state` | `{ state, match }` ('intro','playing','finish','judge','results') | match.js |
| `match:oneminute` / `match:count` | `{}` / `{ n }` | match.js |
| `actor:<name>` | `{ actor, surface, ...data }` — re-emitted from `character.onEvent(name, data)`; surface 0 dry · 1 own ink · 2 enemy ink | actor.js wiring |

## To add
| event | payload |
|---|---|
| `actor:jump` | `{ actor, surface, swim }` |
| `actor:land` | `{ actor, speed, surface, pos }` |
| `actor:form` | `{ actor, form: 'kid' \| 'squid', surface }` |
| `actor:dive` / `actor:emerge` | `{ actor, pos, speed }` (squid enters / leaves own ink) |
| `actor:climb` | `{ actor, on }` |
| `actor:enemyInk` | `{ actor, on }` |
| `weapon:fire` | `{ actor, weapon, muzzle, dir, charge? }` |
| `weapon:impact` | `{ pos, normal, team, kind, radius }` (kind: 'shot','blast','drop','charger','roll') |
| `bomb:throw` / `bomb:arm` / `bomb:explode` | `{ actor?, pos, team, radius? }` |
| `special:slam` | `{ actor, pos, radius }` |
| `storm:start` / `storm:end` | `{ pos, team }` |
| `superjump:land` | `{ actor, pos }` |
| `turf` | `{ actor, area }` (every claimed chunk; aggregate yourself) |

## Character → actor` inside character.js)
| name | data |
|---|---|
| `footstep` | `{ foot: 'L' \| 'R', pos: THREE.Vector3 (world, copy it) , speed }` at each foot plant |
| `handplant` (optional) | `{ pos }` roller/charger heavy moments |

## Audio (lead-owned, src/audio/audio.js)
- The lead plays footstep sounds on `actor:footstep` (surface-aware: `step_dry`, `step_ink`, `step_enemy`) and runs the
  harbour ambience (`harbor_ambience` loop + random `gull` cries). Don't duplicate these.
- Extra SFX names available to everyone via `G.audio.play(name, { pos, volume, pitch })`: `step_dry`, `step_ink`,
  `step_enemy`, `ink_drip`, `gull`, `harbor_ambience` (loop) — plus the full list in docs/CONTRACTS.md §2.
- Need a new sound? Add a def in src/audio/audio.js and list it in SFX_GROUPS.

## Online play (src/net/netmatch.js)
| event | payload | where |
|---|---|---|
| `net:takeover` | `{ actor }` — a player left mid-match; the host's bots play their squidkid from now on | netmatch.js |
| `net:replaced` | `{}` — *our* squidkid was handed to a bot (this browser took too long to load the stage) | netmatch.js |

Online, the events above are also emitted for remote squidkids (their owner's shots, splats, respawns, specials and
super jumps are replayed on every screen), so FX / HUD / audio subscribers keep working unchanged. Check
`actor.owned` when something must happen only on the browser that simulates that squidkid.
