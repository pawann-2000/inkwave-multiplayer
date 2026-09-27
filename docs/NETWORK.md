# Online play (peer-to-peer)

INKWAVE's online mode lets up to 8 people (4 per team) play Turf War together, with bots filling any empty slots.
There is no game server: browsers talk to each other directly over WebRTC. The only third-party service is
**signaling**, the moment two browsers first find each other. That runs over public [Nostr](https://nostr.com) relays
through [Trystero](https://github.com/dmotz/trystero).

## Playing

1. **PLAY ONLINE → HOST A ROOM.** You get a 10-character room code (`ABCDE-12345`) and an invite link
   (`…/?join=ABCDE-12345`).
2. Friends open the link, or go to **PLAY ONLINE → JOIN** and type the code. They land in your lobby.
3. In the lobby everyone picks a team (4 max per side) and a weapon. The host picks the stage, time of day, length,
   whether bots fill empty slots, and bot skill. The room's two ink colours are fixed when it opens, so everyone sees
   the same team names and colours in the lobby and in every match (colour-blind players keep their safe pair).
4. The host presses **START!** Every browser loads the stage, and the intro begins when all have loaded (or after
   25 s; a squidkid whose browser is still loading is taken over by a bot).
5. After the results, **BACK TO LOBBY** returns to the room for another round. **LEAVE ROOM** exits.

Differences from offline play:
- The pause menu doesn't pause anything. Your squidkid just stands still while it's open.
- A player who leaves mid-match is taken over by a bot.
- If the host leaves, the room closes.

## Architecture

| Piece | File | Job |
|---|---|---|
| Wire protocol + trust boundary | `src/net/protocol.js` | Room codes; validators for every inbound message; sanitizers for names, looks, and weapons |
| Transport | `src/net/transport.js` | Trystero (Nostr signaling + WebRTC data channels); `?net=local` BroadcastChannel variant for dev/tests |
| Lobby session | `src/net/session.js` | Host/join, host pinning, admission, teams, settings, start/loaded handshake, relays, flood limits |
| In-match sync | `src/net/netmatch.js` | Snapshots, interpolation, events, hits/deaths, clock, result, bot takeovers |
| Game hooks | `actor.js`, `weapons.js`, `paint.js`, `match.js` | `owned` actors; authority gates; `onSplat`; roster setup; host-driven lifecycle |
| UI | `src/ui/menus-online.js`, `styles/lobby.css` | The PLAY ONLINE and LOBBY screens |

**Topology.** Trystero connects every pair of browsers in a room directly (a full mesh), and each browser sends its
packets to everyone. Every second, members report which peers they can actually reach. The host relays game packets
across any pair without a working link, and receivers drop the duplicate copies by packet id.

**Authority.** Each browser *owns* (simulates) its own squidkid; the host also owns the bots. Only the owner:

| Decision | Who decides |
|---|---|
| Movement, form, ink, special gauge, respawn | the owner of that squidkid |
| Paint (turf) | whoever owns the projectile's thrower. Every gameplay splat is broadcast and re-applied everywhere, so all turf grids agree |
| Whether a shot hit | the shooter's browser, against what it sees ("favor the shooter") |
| Health, splat-outs | the victim's browser applies the hit and announces the splat |
| Match clock, states, final score, bots | the host. Its turf grid is the official result |

Offline, every actor is owned, so every gate is a no-op and the single-player game runs exactly as before.

**Wire.** Each browser sends one packet per tick (30 Hz) to the room, on one ordered, reliable data channel:

```
{ k:'g', mid, q, t, s:[state rows], e:[events], m?:[state, seconds left] }
  s   one 21-number snapshot per owned squidkid (protocol.js `ST` layout)
  e   'f' projectile · 'cb' charger beam · 'b' bomb / tempest · 'tr' animation one-shot · 'sp' splat · 'h' hit ·
      'd' splatted · 'rs' respawn · 'su' special · 'sl' slam impact · 'sj' super jump · 'dg' dodge roll
  m   (host only) match state + clock
```

Control messages (`hello`, `lobby`, `team`, `prof`, `start`, `loaded`, `res`, `own`, `end`, `kick`, `reject`,
`links`, `rl`, `bye`) are listed in `protocol.js` `readControl`.

**Time.**
- Remote squidkids are drawn 100 ms in the past, interpolated between snapshots. Each sender gets its own clock
  estimate: the minimum observed one-way delay over 4 s.
- Their events play on that same delayed clock, so a body, the shot leaving its gun, and the ink it lands line up.
- Hits on your own squidkid are the exception: they apply the moment they arrive.

**Hidden tabs.** Browsers stop animation frames in background tabs, and a sleeping host would freeze the match. Online,
a small Worker's timer keeps a hidden tab simulating and sending at about 30 Hz, without rendering. Frame-driven UI,
such as the end-of-match judge animation, finishes when the tab comes back to the front.

## Configuration (`src/config.js` → `NET`)

| Key | Default | Meaning |
|---|---|---|
| `turn` | `[]` | TURN servers for players behind strict NATs (`[{ urls, username, credential }]`). Without them, a pair that can't connect directly is relayed through the host, but a player who can't reach the host can't join. |
| `relays` | `[]` | Pin your own `wss://` Nostr relays. Empty uses Trystero's public list; a few of those are usually down at any time, which only shows as console noise. |
| `tickHz`, `interpDelay`, `extrapolate` | 30, 0.1 s, 0.1 s | Snapshot rate, interpolation delay, and dead-reckoning cap. |
| `limits` | see file | Per-peer flood limits (token buckets). |
| `maxDamage`, `maxSplatRadius` | 200, 4.5 m | Caps on a single hit / splat from the network. |

## Security model

Online play is for **people you trust with the room code**. Anyone with the code can join, and in any peer-to-peer
game a modified client can cheat. It can lie about its own position or claim hits, within the caps below. The design
goal is narrower and enforced: **no peer can run code in another player's browser, crash or freeze it, speak for
someone else's squidkid, or act as the host.**

| # | Threat | Sub-component | Mitigation (where) |
|---|---|---|---|
| 1 | Script injection via names / strings shown in lobby, HUD, kill feed, results | Business logic | `cleanName` strips control, bidi, zero-width, markup, and bracket characters, NFKC-normalizes, and caps at 16 code points (`protocol.js`). UI renders names as text nodes; `richText` escapes first. Tested: `tools/tests`, E2E "hostile name". |
| 2 | Malformed / hostile values poisoning the sim (NaN, Infinity, huge numbers, strings, prototype keys) | Business logic | Every message goes through a `read*` validator before use: finite numbers clamped, exact row lengths, own-property allowlists, fresh objects built field by field (`protocol.js`). Fuzzed 5,000 rows, plus mutation-tested (`tools/tests/net-protocol.test.mjs`). |
| 3 | A member impersonating the host (ending the match, fake results, taking squidkids, kicking) | AuthZ | The host is pinned: the first peer to send a valid `lobby`. `HOST_ONLY` messages from anyone else are dropped (`session.js`). E2E "can't end, judge, kick or take over"; mutation-tested. |
| 4 | A peer speaking for a squidkid it doesn't own (moving, killing, or respawning it) | AuthZ | `netmatch.js` accepts a state row or event only from that squidkid's owner. Hits must name the sender's own squidkid as attacker, and deaths the sender's own as victim. E2E "can't move, hurt, kill or puppet"; mutation-tested. |
| 5 | Floods / map-wide paint griefing (CPU/GPU denial of service) | Business logic / Networking | ≤ 512 events and ≤ 8 states per packet; splat radius ≤ 4.5 m (refused, not clamped); position inside the arena; per-peer token buckets for packets, control messages, splats, and hits (`NET.limits`). E2E "floods refused"; mutation-tested. |
| 6 | Strangers joining a room | AuthN | 50-bit room codes from `crypto.getRandomValues`. Room cap of 8. The host can kick, which also bans for the session. |
| 7 | Signaling relays reading session data | Crypto / Privacy | Trystero encrypts SDP with AES-GCM under a key derived from the room code (`password`). Relays see a hashed topic and ciphertext. Game data flows over WebRTC (DTLS), never through relays. |
| 8 | IP address exposure | Privacy | Inherent to WebRTC: every peer in a room learns every other peer's IP. Disclosed on the PLAY ONLINE screen. Players who need to hide their IP can use a VPN or a TURN relay (`NET.turn`). |
| 9 | Supply chain (new dependencies) | Supply chain | Three packages vendored unmodified at pinned versions, with sha512 integrity recorded and verified (`vendor/trystero/README.md`). Loaded only when online is opened. No install scripts. |
| 10 | Cheating: speed hacks, fake hits up to caps, aimbots | Business logic | **Not mitigated.** There's no authoritative server in a peer-to-peer design. Mitigation is social: play with people you know. Per-hit damage caps and rate limits bound the worst case. |

Residual risks, accepted:
- A peer already in the room can race the real host to a *new* joiner and get pinned as host. They must already know
  the code, so this is within the trust model.
- Trystero's own chunk reassembly could be abused for memory pressure by a peer in the room.
- Trystero peer ids come from `Math.random()` (library code), so they're unique but not secret. Nothing relies on
  their secrecy.

## Testing

```bash
npm test                      # node: protocol trust-boundary tests (adversarial + fuzz)
npm start                     # dev server, then in another shell:
npm run mptest                # 3 headless tabs over BroadcastChannel (60 ms simulated latency)
node tools/mp-test.mjs --net trystero   # the production path: Nostr signaling + WebRTC (needs internet)
node tools/mp-test.mjs --lag 150        # a slower link
```

`CHROME_PATH=/path/to/chrome` selects the browser (the tools default to Google Chrome's standard path). The E2E test
asserts cross-browser facts:
- joining by link, and a shared roster;
- movement seen remotely;
- turf grids agreeing across browsers;
- a host-decided hit splatting a guest, and the splat reported back;
- a hostile guest's forged messages ignored;
- identical final scores;
- lobby round-trips and host-leave handling.

Verified so far in Chromium only (Chrome for Testing 151, headless): the local transport at 60 ms and 150 ms
simulated latency, and the real Trystero/Nostr + WebRTC path. Firefox and Safari are untested. The lobby has no
gamepad path to the kick button (mouse only).

For manual testing in one browser, open two tabs with `?net=local`: one hosts, the other joins with the code.

Online play (Trystero) needs a secure context, `https://` or `http://localhost`, because signaling encrypts with
WebCrypto. On a plain `http://` LAN address the PLAY ONLINE screen says so instead of trying.

## Known limitations

- **No host migration.** If the host leaves, the room closes.
- **Lobby-only joins.** A player can't join a match in progress; late joiners wait in the lobby for the next round.
- **Hit registration favors the shooter.** A victim can occasionally be hit just after reaching cover.
- **Ink borders can differ between screens.** Where both teams paint the same spot within ~0.2 s, cells can come out
  differently per browser. The host's grid decides the score, and everyone is shown the host's numbers.
- **Ink from flying droplets is decoration online.** It doesn't claim turf, because droplets land differently on
  every screen.
