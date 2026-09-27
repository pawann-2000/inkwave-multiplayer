// Online play — the wire protocol and its trust boundary (docs/NETWORK.md).
//
// Everything a peer sends is untrusted. Inbound messages pass through the readers below before anything else touches
// them: a reader builds a fresh plain object field by field (peer objects are never merged into game state, so key
// tricks like "__proto__" go nowhere), numbers must be finite and are clamped, strings are sanitized, enums are
// allowlisted and arrays are length-capped. A reader returns null for anything malformed; callers drop it.
// Authorization — who may send what — is the callers' job: session.js (host-only control messages) and netmatch.js
// (only an actor's owner may speak for that actor).
//
// No three.js / DOM imports: this module runs under node for tools/tests/net-protocol.test.mjs.
import { NET, WEAPONS, WEAPON_ORDER, MAPS, DIFFICULTY, MATCH, TEAM_PALETTES } from '../config.js';
import { HAIR_STYLES, SKIN_TONES, OUTFITS, IRIS, HATS, BROWS } from '../game/character-style.js';

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// finite number clamped into [lo, hi], else NaN (caller rejects)
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? (v < lo ? lo : v > hi ? hi : v) : NaN);
// integer inside [lo, hi], else NaN
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : NaN);
const bad = (x) => x !== x;   // NaN check that also covers the int/num sentinels

// ------------------------------------------------------------------------------------------------ room codes
// Crockford base32: no I, L, O, U, so a code survives being read aloud or typed from a screenshot.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh room code from the CSPRNG (5 bits per symbol; 256 % 32 = 0 so every symbol is equally likely). */
export function newRoomCode(len = NET.codeLength) {
  const b = new Uint8Array(len);
  globalThis.crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] & 31];
  return s;
}
/** User input → canonical code (uppercase, separators dropped, look-alikes folded: O→0, I/L→1) or null. */
export function normalizeCode(input, len = NET.codeLength) {
  if (typeof input !== 'string' || input.length > 64) return null;
  const s = input.toUpperCase().replace(/[\s\-_.]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== len) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}
/** 'ABCDE12345' → 'ABCDE-12345' (display only). */
export const formatCode = (c) => (typeof c === 'string' && c.length > 5 ? `${c.slice(0, 5)}-${c.slice(5)}` : c || '');
/** Match ids only keep packets of an old match out of a new one (not a secret). */
export const newMatchId = () => newRoomCode(12);

// ------------------------------------------------------------------------------------------------ sanitizers
const NAME_MAX = 16;
// control, format (bidi overrides / isolates, zero-width), private-use, unassigned, line/paragraph separators, and
// the characters richText() / markup would give meaning to
const NAME_STRIP = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}[\]{}<>`]/gu;
/** A display name a peer sent → a short, printable, markup-free string (never empty). */
export function cleanName(v, fallback = 'Squidkid') {
  if (typeof v !== 'string') return fallback;
  let s = v.slice(0, 96).normalize('NFKC').replace(NAME_STRIP, '');
  s = s.replace(/(\p{M}{2})\p{M}+/gu, '$1');          // no "zalgo" stacks of combining marks
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, NAME_MAX).join('').trim();
  return s || fallback;
}

const STYLE_N = { hair: HAIR_STYLES, skin: SKIN_TONES.length, outfit: OUTFITS.length, eyes: IRIS.length, hat: HATS.length, brows: BROWS.length };
/** A locker look a peer sent → only the known fields, each an in-range integer (missing fields derive from the name). */
export function cleanStyle(v) {
  const o = {};
  if (!isObj(v)) return o;
  for (const k of Object.keys(STYLE_N)) {
    if (!own(v, k)) continue;
    const x = v[k];
    if (Number.isInteger(x) && x >= 0 && x < STYLE_N[k]) o[k] = x;
  }
  return o;
}
export const cleanWeapon = (v) => (typeof v === 'string' && own(WEAPONS, v) ? v : null);
const cleanMap = (v) => (typeof v === 'string' && MAPS.some((m) => m.id === v) ? v : null);
const cleanDiff = (v) => (typeof v === 'string' && own(DIFFICULTY, v) ? v : null);
const cleanTime = (v) => (v === 'day' || v === 'dusk' ? v : null);
const cleanDuration = (v) => ((MATCH.durations || [90, 180]).includes(v) ? v : null);
// peer ids: Trystero's are 20 base62 chars; the local test transport uses the same shape
export const cleanPeerId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(v) ? v : null);
const cleanMid = (v) => (typeof v === 'string' && /^[0-9A-Z]{12}$/.test(v) ? v : null);

// ------------------------------------------------------------------------------------------------ enums
export const MATCH_STATES = ['wait', 'intro', 'playing', 'finish', 'judge', 'results'];
export const FORMS = ['kid', 'squid', 'swim', 'climb'];                       // state field `form`
export const PROJ_KINDS = ['shot', 'round', 'blast', 'drop', 'slosh'];         // 'f' event projectile kinds
export const SPLAT_KINDS = ['shot', 'line', 'blast', 'bomb', 'trail', 'drop', 'roll', 'speck'];   // paint.js K order
export const TRIGGERS = ['shoot', 'flick', 'throw', 'land', 'jump', 'hit', 'special_leap', 'special_slam', 'spawn', 'charge_release', 'dodge', 'slosh'];
export const CAUSES = [...WEAPON_ORDER, 'shot', 'round', 'blast', 'drop', 'slosh', 'slosher', 'roller', 'charger', 'blaster', 'bomb', 'slam', 'storm', 'water', 'ink', 'weapon'];
export const SPECIAL_IDS = ['slam', 'storm'];
const LOBBY_PHASES = ['lobby', 'match'];
const REASONS = ['full', 'version', 'busy', 'kicked', 'host', 'ended', 'left'];

// ------------------------------------------------------------------------------------------------ state snapshots
// One owned actor, 21 numbers: [nid, x, y, z, vx, vy, vz, yaw, aimYaw, aimPitch, form, flags, charge, ink, hp,
//                               special, turf, surface, wallNx, wallNy, wallNz]
export const ST = { nid: 0, x: 1, y: 2, z: 3, vx: 4, vy: 5, vz: 6, yaw: 7, aimYaw: 8, aimPitch: 9, form: 10, flags: 11, charge: 12, ink: 13, hp: 14, special: 15, turf: 16, surface: 17, wx: 18, wy: 19, wz: 20, LEN: 21 };
// state flag bits
export const SF = { alive: 1, grounded: 2, firing: 4, rolling: 8, charging: 16, streaming: 32, subAim: 64, invuln: 128, onEnemy: 256, superJump: 512, special: 1024, dodge: 2048, lock: 4096 };
const P = 400, V = 90;   // world extent (m) / speed (m/s) far beyond any stage, so clamping never bites real play
const ST_SPEC = [['i', 0, 7], ['n', -P, P], ['n', -60, 160], ['n', -P, P], ['n', -V, V], ['n', -V, V], ['n', -V, V],
  ['n', -20, 20], ['n', -20, 20], ['n', -1.7, 1.7], ['i', 0, 3], ['i', 0, 65535], ['n', 0, 1], ['n', 0, 100], ['n', 0, 100],
  ['n', 0, 1000], ['n', 0, 1e6], ['i', 0, 2], ['n', -1, 1], ['n', -1, 1], ['n', -1, 1]];

/** One snapshot row → a validated array (floats clamped) or null. */
export function readState(row) {
  if (!Array.isArray(row) || row.length !== ST.LEN) return null;
  const out = new Array(ST.LEN);
  for (let i = 0; i < ST.LEN; i++) {
    const [t, lo, hi] = ST_SPEC[i];
    const v = t === 'i' ? int(row[i], lo, hi) : num(row[i], lo, hi);
    if (bad(v)) return null;
    out[i] = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ events
// Positional arrays: [type, ...args]. Arg specs: nid = actor slot 0..7 · x/z world · y height · v velocity ·
// d unit-vector component · u 0..1 · r splat radius · dmg one hit · i:lo:hi integer · n:lo:hi number ·
// cause / trig / special = allowlisted strings.
const EVENTS = {
  f: ['nid', 'i:0:4', 'x', 'y', 'z', 'v', 'v', 'v', 'u', 'i:0:15'],              // projectile spawn (kind, pos, vel, seed, index)
  cb: ['nid', 'x', 'y', 'z', 'd', 'd', 'd', 'n:0:60', 'u', 'i:0:1', 'd', 'd', 'd'],  // charger beam (muzzle, dir, len, charge, hit wall, normal)
  b: ['nid', 'i:0:1', 'x', 'y', 'z', 'v', 'v', 'v'],                             // bomb / storm throw (storm?, pos, vel)
  tr: ['nid', 'trig', 'n:-100:100', 'n:-100:100', 'n:-100:100'],                 // character one-shot animation
  sp: ['x', 'y', 'z', 'r', 'i:0:1', 'u', 'i:0:7', 'd', 'd', 'd', 'n:0:4', 'i:-1:7'],   // splat (pos, radius, team, seed, kind, stretch, amount, credit)
  h: ['nid', 'nid', 'dmg', 'cause'],                                             // hit: attacker → victim
  d: ['nid', 'i:-1:7', 'cause'],                                                 // death: victim, attacker|-1
  rs: ['nid'],                                                                   // respawn
  su: ['nid', 'special'],                                                        // special used
  sl: ['nid', 'x', 'y', 'z'],                                                    // tidal slam impact
  sj: ['nid', 'i:0:2', 'x', 'y', 'z'],                                           // super jump phase (charge / flight / land), target
  dg: ['nid', 'd', 'd'],                                                         // dualies dodge roll direction
};
const argSpec = (s) => {
  if (s === 'nid') return (v) => int(v, 0, 7);
  if (s === 'x') return (v) => num(v, -P, P);
  if (s === 'y') return (v) => num(v, -60, 160);
  if (s === 'v') return (v) => num(v, -V, V);
  if (s === 'd') return (v) => num(v, -1, 1);
  if (s === 'u') return (v) => num(v, 0, 1);
  if (s === 'r') return (v) => (typeof v === 'number' && v >= 0.02 && v <= NET.maxSplatRadius ? v : NaN);   // oversized splats are refused, not clamped
  if (s === 'dmg') return (v) => num(v, 0, NET.maxDamage);
  if (s === 'cause') return (v) => (CAUSES.includes(v) ? v : NaN);
  if (s === 'trig') return (v) => (TRIGGERS.includes(v) ? v : NaN);
  if (s === 'special') return (v) => (SPECIAL_IDS.includes(v) ? v : NaN);
  const [k, lo, hi] = s.split(':');
  return k === 'i' ? (v) => int(v, +lo, +hi) : (v) => num(v, +lo, +hi);
};
const EVENT_READERS = Object.fromEntries(Object.entries(EVENTS).map(([t, specs]) => [t, specs.map(argSpec)]));

/** One event row → a validated [type, ...args] array or null. */
export function readEvent(row) {
  if (!Array.isArray(row) || typeof row[0] !== 'string' || !own(EVENT_READERS, row[0])) return null;
  const rd = EVENT_READERS[row[0]];
  if (row.length !== rd.length + 1) return null;
  const out = new Array(row.length);
  out[0] = row[0];
  for (let i = 0; i < rd.length; i++) {
    const v = rd[i](row[i + 1]);
    if (bad(v)) return null;
    out[i + 1] = v;
  }
  return out;
}

export const MAX_EVENTS = 512;   // per packet (a host with 7 bots at 30 Hz sends ~20)

/** A game packet { k:'g', mid, q, t, s:[states], e:[events], m?:[state, time] } → validated copy or null.
 *  Rows that fail validation are dropped individually (one bad row doesn't cost the whole snapshot). */
export function readGame(m) {
  if (!isObj(m) || m.k !== 'g') return null;
  const mid = cleanMid(m.mid), q = int(m.q, 0, 2 ** 31), t = num(m.t, 0, 1e13);
  if (!mid || bad(q) || bad(t)) return null;
  const s = m.s === undefined ? [] : m.s, e = m.e === undefined ? [] : m.e;
  if (!Array.isArray(s) || s.length > 8 || !Array.isArray(e) || e.length > MAX_EVENTS) return null;
  const out = { k: 'g', mid, q, t, s: [], e: [], m: null, dropped: 0 };
  for (const row of s) { const r = readState(row); if (r) out.s.push(r); else out.dropped++; }
  for (const row of e) { const r = readEvent(row); if (r) out.e.push(r); else out.dropped++; }
  if (m.m !== undefined) {
    if (!Array.isArray(m.m) || m.m.length !== 2) return null;
    const st = int(m.m[0], 0, MATCH_STATES.length - 1), time = num(m.m[1], 0, 3600);
    if (bad(st) || bad(time)) return null;
    out.m = [st, time];
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ control messages
const readSettings = (v) => {
  if (!isObj(v)) return null;
  const mapId = cleanMap(v.mapId), time = cleanTime(v.time), duration = cleanDuration(v.duration), difficulty = cleanDiff(v.difficulty);
  const palette = int(v.palette, 0, TEAM_PALETTES.length - 1);
  if (!mapId || !time || !duration || !difficulty || typeof v.bots !== 'boolean' || bad(palette)) return null;
  return { mapId, time, duration, difficulty, bots: v.bots, palette };
};
const readMember = (v) => {
  if (!isObj(v)) return null;
  const id = cleanPeerId(v.id), team = int(v.team, 0, 1), weapon = cleanWeapon(v.weapon);
  if (!id || bad(team) || !weapon) return null;
  return { id, team, weapon, name: cleanName(v.name), style: cleanStyle(v.style), host: v.host === true };
};
const readRosterRow = (v) => {
  if (!isObj(v)) return null;
  const n = int(v.n, 0, 7), team = int(v.team, 0, 1), slot = int(v.slot, 0, 3), weapon = cleanWeapon(v.weapon);
  const peer = v.peer === null ? null : cleanPeerId(v.peer);   // null = a bot (simulated by the host)
  if (bad(n) || bad(team) || bad(slot) || n !== team * 4 + slot || !weapon) return null;
  if (v.peer !== null && !peer) return null;
  return { n, team, slot, peer, weapon, name: cleanName(v.name), style: cleanStyle(v.style) };
};

/** A control message { k, ... } → validated copy or null. Game packets ('g') go through readGame. */
export function readControl(m) {
  if (!isObj(m) || typeof m.k !== 'string') return null;
  switch (m.k) {
    case 'hello': {   // joiner → host: who I am
      const v = int(m.v, 0, 1e6), weapon = cleanWeapon(m.weapon);
      if (bad(v) || !weapon) return null;
      return { k: 'hello', v, weapon, name: cleanName(m.name), style: cleanStyle(m.style) };
    }
    case 'prof': {    // member → host: my name / look / weapon changed
      const weapon = cleanWeapon(m.weapon);
      if (!weapon) return null;
      return { k: 'prof', weapon, name: cleanName(m.name), style: cleanStyle(m.style) };
    }
    case 'team': { const team = int(m.team, 0, 1); return bad(team) ? null : { k: 'team', team }; }
    case 'lobby': {   // host → all: the room
      const settings = readSettings(m.settings), phase = LOBBY_PHASES.includes(m.phase) ? m.phase : null;
      if (!settings || !phase || !Array.isArray(m.members) || m.members.length > NET.maxHumans) return null;
      const members = [];
      for (const r of m.members) { const x = readMember(r); if (!x || members.some((o) => o.id === x.id)) return null; members.push(x); }
      const mid = m.mid == null ? null : cleanMid(m.mid);
      return { k: 'lobby', phase, settings, members, mid };
    }
    case 'start': {   // host → all: a match begins
      const mid = cleanMid(m.mid), mapId = cleanMap(m.mapId), time = cleanTime(m.time), duration = cleanDuration(m.duration), difficulty = cleanDiff(m.difficulty);
      const palette = int(m.palette, 0, TEAM_PALETTES.length - 1);
      if (!mid || !mapId || !time || !duration || !difficulty || bad(palette) || !Array.isArray(m.roster) || !m.roster.length || m.roster.length > 8) return null;
      const roster = [];
      for (const r of m.roster) { const x = readRosterRow(r); if (!x || roster.some((o) => o.n === x.n || (x.peer && o.peer === x.peer))) return null; roster.push(x); }
      return { k: 'start', mid, mapId, time, duration, difficulty, palette, roster };
    }
    case 'loaded': { const mid = cleanMid(m.mid); return mid ? { k: 'loaded', mid } : null; }
    case 'res': {     // host → all: the final score
      const mid = cleanMid(m.mid), win = int(m.win, 0, 1);
      if (!mid || bad(win) || !Array.isArray(m.cov) || m.cov.length !== 2 || !Array.isArray(m.stats) || m.stats.length > 8) return null;
      const cov = [num(m.cov[0], 0, 1), num(m.cov[1], 0, 1)];
      if (bad(cov[0]) || bad(cov[1])) return null;
      const stats = [];
      for (const r of m.stats) {
        if (!Array.isArray(r) || r.length !== 4) return null;
        const row = [int(r[0], 0, 7), num(r[1], 0, 1e6), int(r[2], 0, 9999), int(r[3], 0, 9999)];
        if (row.some(bad)) return null;
        stats.push(row);
      }
      return { k: 'res', mid, cov, win, stats };
    }
    case 'own': {     // host → all: actor n is now simulated by `peer` (a leaver's squidkid handed to a bot)
      const mid = cleanMid(m.mid), n = int(m.n, 0, 7), peer = cleanPeerId(m.peer);
      return mid && !bad(n) && peer ? { k: 'own', mid, n, peer } : null;
    }
    case 'end': { const mid = cleanMid(m.mid); return mid && REASONS.includes(m.reason) ? { k: 'end', mid, reason: m.reason } : null; }
    case 'reject': case 'kick': return REASONS.includes(m.reason) ? { k: m.k, reason: m.reason } : null;
    case 'links': {   // member → host: peers I have a direct connection to (the host relays the rest)
      if (!Array.isArray(m.ids) || m.ids.length > 16) return null;
      const ids = [];
      for (const x of m.ids) { const id = cleanPeerId(x); if (!id) return null; if (!ids.includes(id)) ids.push(id); }
      return { k: 'links', ids };
    }
    case 'rl': {      // host → member: a game packet relayed from `o`
      const o = cleanPeerId(m.o), p = readGame(m.p);
      return o && p ? { k: 'rl', o, p } : null;
    }
    case 'bye': return { k: 'bye' };
    default: return null;
  }
}

/** Messages only the (pinned) host may send; session.js drops them from anyone else. */
export const HOST_ONLY = new Set(['lobby', 'start', 'res', 'own', 'end', 'reject', 'kick', 'rl']);

// ------------------------------------------------------------------------------------------------ outbound helpers
// Round for the wire (JSON numbers): 1 mm positions, ~0.06° angles. Keeps packets small and cheap to parse.
export const r3 = (v) => Math.round(v * 1000) / 1000;
export const r2 = (v) => Math.round(v * 100) / 100;
