// Online play — the lobby session: one room, one host, up to 8 squidkids (4 per team) plus optional bots.
//
// Roles. The browser that creates the room is the host: it admits joiners, owns the room settings and the team
// sheet, starts matches, simulates the bots and referees the match (clock, final score). Everyone else is a member.
// There is no host migration: when the host leaves, the room closes.
//
// Trust. Anyone who knows the room code can join, so every peer is treated as untrusted input (protocol.js validates
// every message) and authority is split so a peer can only speak for itself:
//   · the host is pinned — the first peer whose valid 'lobby' reaches us — and only it may send host-only messages
//   · members may only change their own name / look / weapon / team, and only through the host
//   · per-peer token buckets bound message floods; the host can kick (and ban for this session)
// Game packets are forwarded to netmatch.js (hooks.onGame), which enforces actor ownership.
//
// Links. Trystero connects every pair of peers directly. Members report which peers they can reach each second; the
// host relays game packets across any pair without a working direct link (netmatch.js drops the duplicates).
import { NET, WEAPON_ORDER, BOT_NAMES, TEAM_PALETTES, MATCH, MAPS, DIFFICULTY } from '../config.js';
import {
  newRoomCode, normalizeCode, formatCode, newMatchId, readControl, readGame, HOST_ONLY, cleanName, cleanStyle, cleanWeapon,
} from './protocol.js';
import { openTransport } from './transport.js';
import { randomStyle } from '../game/character-style.js';

/** Token bucket: `rate` tokens/s refill up to `burst`. */
export class Bucket {
  constructor([rate, burst]) { this.rate = rate; this.burst = burst; this.tokens = burst; this.last = performance.now(); }
  take(n = 1) {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

const REJECT_TEXT = {
  full: 'That room is full (8 squidkids max).',
  version: 'That room runs a different version of INKWAVE — both of you need to refresh the page.',
  busy: 'That room is busy right now.',
  kicked: 'The host removed you from the room.',
};

export class Session {
  /** hooks: { profile() → {name, style, weapon}, defaults() → settings, onChange(), onStart(cfg), onEnd(reason),
   *           onGame(packet, originId), onControl(msg, fromId), onPeerLeft(id), onAllLoaded(mid, missingIds), local } */
  constructor(hooks) {
    this.hooks = hooks;
    this.subs = new Set();
    this._tok = 0;
    this._warned = new Map();
    this._clear();
  }

  _clear() {
    this.t = null; this.status = 'idle'; this.role = null; this.code = null; this.hostId = null; this.selfId = null;
    this.members = new Map(); this.settings = null; this.phase = 'lobby'; this.mid = null; this.roster = null; this.cfg = null;
    this.error = null; this.notice = null; this.loaded = new Set(); this.links = new Map(); this.relayTo = new Map();
    this.buckets = new Map(); this.banned = new Set(); this.connWarn = null;
    clearTimeout(this._joinTimer); clearTimeout(this._loadTimer); clearInterval(this._tickTimer);
    this._joinTimer = this._loadTimer = this._tickTimer = null;
  }

  get isHost() { return this.role === 'host'; }
  get connected() { return !!this.t && (this.status === 'lobby' || this.status === 'connecting'); }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  _changed() { for (const fn of this.subs) { try { fn(this); } catch (e) { console.error('[net] lobby listener', e); } } this.hooks.onChange?.(this); }

  // ------------------------------------------------------------------------------------------ open / close
  // WebRTC signaling encrypts with WebCrypto, which browsers only expose on https:// pages (and localhost)
  _insecure(opts) {
    if (opts.local || globalThis.isSecureContext !== false) return false;
    this.leave(true);
    this.status = 'error';
    this.error = 'Online play needs a secure page: open the game over https:// (or on this computer via http://localhost).';
    this._changed();
    return true;
  }

  async host(opts = {}) {
    if (this._insecure(opts)) return false;
    this.leave(true);
    const tok = ++this._tok;
    this.role = 'host'; this.status = 'connecting'; this.code = newRoomCode(); this.opts = opts;
    this._changed();
    const t = await this._open(tok, opts);
    if (!t) return false;
    this.selfId = this.hostId = t.selfId;
    const p = this._profile();
    this.members.set(this.selfId, { id: this.selfId, team: 0, host: true, ...p });
    this.settings = this._cleanSettings(this.hooks.defaults?.() || {});
    this.status = 'lobby';
    this._tickTimer = setInterval(() => this._tick(), 1000);
    this._changed();
    return true;
  }

  async join(input, opts = {}) {
    if (this._insecure(opts)) return false;
    const code = normalizeCode(input);
    if (!code) { this.leave(true); this.status = 'error'; this.error = "That room code doesn't look right — it's 10 letters and numbers."; this._changed(); return false; }
    this.leave(true);
    const tok = ++this._tok;
    this.role = 'client'; this.status = 'connecting'; this.code = code; this.opts = opts;
    this._changed();
    const t = await this._open(tok, opts);
    if (!t) return false;
    this.selfId = t.selfId;
    this._joinTimer = setTimeout(() => {
      if (!this.hostId) this._fail("Couldn't find that room. Check the code, or ask the host to share the link again.");
    }, NET.joinTimeout * 1000);
    for (const id of t.peers()) this._hello(id);   // whoever is already here (only the host answers)
    this._tickTimer = setInterval(() => this._tick(), 1000);
    return true;
  }

  async _open(tok, opts) {
    let t;
    try { t = await openTransport(this.code, opts); }
    catch (e) {
      console.error('[net] transport', e);
      if (tok === this._tok) this._fail("Couldn't reach the matchmaking network. Check your connection and try again.");
      return null;
    }
    if (tok !== this._tok) { t.close(); return null; }   // left (or switched rooms) while connecting
    this.t = t;
    t.onMessage = (m, from) => this._recv(m, from);
    t.onJoin = (id) => this._peerJoin(id);
    t.onLeave = (id) => this._peerLeave(id);
    t.onError = (text) => {
      console.warn('[net] connection', text);
      this.connWarn = "Couldn't open a direct connection to a player (strict network). The host will relay if it can.";
      this._changed();
    };
    return t;
  }

  /** Leave the room (tells the others). silent = don't notify listeners (used when switching rooms). */
  leave(silent = false) {
    this._tok++;
    const had = !!this.t || this.status !== 'idle';
    if (this.t) { try { this.t.send({ k: 'bye' }); } catch { /* closing anyway */ } this.t.close(); }
    this._clear();
    if (had && !silent) this._changed();
  }

  _fail(text, reason = 'left') {
    const inMatch = this.phase === 'match';
    if (this.t) this.t.close();
    this._tok++;
    const code = this.code, role = this.role;
    this._clear();
    this.status = 'error'; this.error = text; this.code = code; this.role = role;
    if (inMatch) this.hooks.onEnd?.(reason);
    this._changed();
  }

  // ------------------------------------------------------------------------------------------ peers
  _profile() {
    const p = this.hooks.profile?.() || {};
    return { name: cleanName(p.name, 'Player'), style: cleanStyle(p.style), weapon: cleanWeapon(p.weapon) || 'shooter' };
  }
  _hello(id) { const p = this._profile(); this.t?.send({ k: 'hello', v: NET.proto, ...p }, id); }

  _peerJoin(id) {
    if (this.role === 'client') { if (!this.hostId || id === this.hostId) this._hello(id); return; }
    if (this.isHost && !this.banned.has(id)) this._sendLobby(id);   // lets the joiner find (and pin) us right away
  }

  _peerLeave(id) {
    if (this.role === 'client') {
      if (id === this.hostId) this._fail('The host left the room.', 'host');
      return;
    }
    if (!this.isHost || !this.members.has(id)) return;
    const m = this.members.get(id);
    this.members.delete(id); this.links.delete(id); this.loaded.delete(id); this.buckets.delete(id);
    if (this.phase === 'match') {
      this.hooks.onPeerLeft?.(id, m);
      this._checkLoaded();
    }
    this._recomputeRelay();
    this._sendLobby();
    this._changed();
  }

  _take(from, kind) {
    let b = this.buckets.get(from);
    if (!b) this.buckets.set(from, (b = { packets: new Bucket(NET.limits.packets), control: new Bucket(NET.limits.control), relay: new Bucket(NET.limits.packets.map((x) => x * NET.maxHumans)) }));
    return b[kind].take();
  }
  _warn(from, what) {
    const t = performance.now(), last = this._warned.get(from) || 0;
    if (t - last < 3000) return;
    this._warned.set(from, t);
    console.warn(`[net] dropped ${what} from ${from.slice(0, 6)}…`);
  }

  // ------------------------------------------------------------------------------------------ inbound
  _recv(m, from) {
    if (!this.t || this.banned.has(from)) return;
    // game packets (hot path): straight to the match; the host relays them across broken links
    if (m && m.k === 'g') {
      if (!this._take(from, 'packets')) return this._warn(from, 'packets over the rate limit');
      if (this.phase !== 'match' || !this.mid) return;
      const p = readGame(m);
      if (!p) return this._warn(from, 'a malformed game packet');
      if (p.mid !== this.mid) return;
      if (this.isHost) { if (!this.members.has(from)) return; this._relay(from, p); }
      else if (!this._inRoster(from)) return;
      this.hooks.onGame?.(p, from);
      return;
    }
    if (!this._take(from, m && m.k === 'rl' ? 'relay' : 'control')) return this._warn(from, 'messages over the rate limit');
    const c = readControl(m);
    if (!c) return this._warn(from, 'a malformed message');
    if (HOST_ONLY.has(c.k) && !this._fromHost(from, c)) return this._warn(from, `a host-only '${c.k}' from a non-host`);
    if (this.isHost) this._hostRecv(c, from);
    else this._clientRecv(c, from);
  }

  _fromHost(from, c) {
    if (this.role !== 'client') return false;
    if (this.hostId) return from === this.hostId;
    // not pinned yet: the first peer to send a valid room description (or a refusal) is the host
    if (c.k === 'lobby' || c.k === 'reject') { this.hostId = from; clearTimeout(this._joinTimer); return true; }
    return false;
  }

  _inRoster(id) { return !!(this.roster && this.roster.some((r) => r.peer === id)); }

  _clientRecv(c, from) {
    switch (c.k) {
      case 'lobby': {
        this.settings = c.settings;
        this.members = new Map(c.members.map((x) => [x.id, x]));
        const admitted = this.members.has(this.selfId);
        if (this.status === 'connecting' && !admitted) this._hello(from);
        this.status = 'lobby';
        if (c.phase === 'lobby' && this.phase === 'match' && !this.cfg) this.phase = 'lobby';
        if (c.phase === 'lobby') this.notice = null;
        else if (c.phase === 'match' && admitted && !this._inRosterSelf()) this.notice = "A match is in progress — you'll join the next one.";
        this._changed();
        return;
      }
      case 'start': {
        if (!c.roster.some((r) => r.peer === this.selfId)) { this.notice = "A match started without you — you'll join the next one."; this._changed(); return; }
        if (!c.roster.some((r) => r.peer === from)) return;   // the host always plays
        this.mid = c.mid; this.roster = c.roster; this.phase = 'match'; this.notice = null;
        this.cfg = { ...c, isHost: false, selfId: this.selfId, hostId: this.hostId };
        this._changed();
        this.hooks.onStart?.(this.cfg);
        return;
      }
      case 'end':
        if (c.mid !== this.mid) return;
        this.phase = 'lobby'; this.mid = null; this.roster = null; this.cfg = null;
        this.hooks.onEnd?.(c.reason);
        this._changed();
        return;
      case 'res': case 'own':
        if (c.mid === this.mid) this.hooks.onControl?.(c, from);
        return;
      case 'rl':
        if (this.phase !== 'match' || c.p.mid !== this.mid || c.o === this.selfId || !this._inRoster(c.o)) return;
        this.hooks.onGame?.(c.p, c.o);
        return;
      case 'reject': this._fail(REJECT_TEXT[c.reason] || 'The host refused the connection.'); return;
      case 'kick': this._fail(REJECT_TEXT.kicked); return;
      default: return;   // hello / prof / team / loaded / links are host-bound
    }
  }
  _inRosterSelf() { return this._inRoster(this.selfId); }

  _hostRecv(c, from) {
    switch (c.k) {
      case 'hello': {
        if (this.members.has(from)) { this._sendLobby(from); return; }
        if (c.v !== NET.proto) { this.t.send({ k: 'reject', reason: 'version' }, from); return; }
        if (this.members.size >= NET.maxHumans) { this.t.send({ k: 'reject', reason: 'full' }, from); return; }
        const n0 = this._teamCount(0), n1 = this._teamCount(1);
        const team = n0 <= n1 ? 0 : 1;
        this.members.set(from, { id: from, team: this._teamCount(team) < NET.teamMax ? team : 1 - team, host: false, name: c.name, style: c.style, weapon: c.weapon });
        this._sendLobby();
        this._changed();
        return;
      }
      case 'prof': {
        const m = this.members.get(from);
        if (!m) return;
        Object.assign(m, { name: c.name, style: c.style, weapon: c.weapon });   // c is a validated, freshly built object
        this._sendLobby(); this._changed();
        return;
      }
      case 'team': {
        const m = this.members.get(from);
        if (!m || this.phase !== 'lobby' || m.team === c.team || this._teamCount(c.team) >= NET.teamMax) return;
        m.team = c.team;
        this._sendLobby(); this._changed();
        return;
      }
      case 'loaded':
        if (this.phase === 'match' && c.mid === this.mid && this._inRoster(from)) { this.loaded.add(from); this._checkLoaded(); this._changed(); }
        return;
      case 'links':
        if (this.members.has(from)) { this.links.set(from, new Set(c.ids)); this._recomputeRelay(); }
        return;
      case 'bye':
        this._peerLeave(from);
        return;
      default: return;
    }
  }

  _teamCount(team) { let n = 0; for (const m of this.members.values()) if (m.team === team) n++; return n; }

  // ------------------------------------------------------------------------------------------ host → room
  _sendLobby(target) {
    if (!this.isHost || !this.t) return;
    const members = [...this.members.values()].map((m) => ({ id: m.id, team: m.team, host: !!m.host, name: m.name, style: m.style, weapon: m.weapon }));
    this.t.send({ k: 'lobby', phase: this.phase, settings: this.settings, members, mid: this.phase === 'match' ? this.mid : null }, target);
  }

  _cleanSettings(s, base = {}) {
    const pick = (v, ok, d) => (ok(v) ? v : d);
    const durs = MATCH.durations || [90, 180];
    return {
      mapId: pick(s.mapId, (v) => MAPS.some((m) => m.id === v), base.mapId || MAPS[0].id),
      time: pick(s.time, (v) => v === 'day' || v === 'dusk', base.time || 'day'),
      duration: pick(s.duration, (v) => durs.includes(v), base.duration || MATCH.defaultDuration || 180),
      difficulty: pick(s.difficulty, (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(DIFFICULTY, v), base.difficulty || 'normal'),
      bots: pick(s.bots, (v) => typeof v === 'boolean', base.bots ?? true),
      // the room's two inks (lobby + every match in it), rolled once when the room opens
      palette: pick(s.palette, (v) => Number.isInteger(v) && v >= 0 && v < TEAM_PALETTES.length, base.palette ?? ((Math.random() * TEAM_PALETTES.length) | 0)),
    };
  }

  // ------------------------------------------------------------------------------------------ local actions (UI)
  setSettings(partial) {
    if (!this.isHost || this.phase !== 'lobby') return;
    this.settings = this._cleanSettings({ ...this.settings, ...partial }, this.settings);
    this._sendLobby(); this._changed();
  }

  setTeam(team) {
    if (!this.t || (team !== 0 && team !== 1) || this.phase !== 'lobby') return;
    if (this.isHost) {
      const m = this.members.get(this.selfId);
      if (!m || m.team === team || this._teamCount(team) >= NET.teamMax) return;
      m.team = team; this._sendLobby(); this._changed();
    } else this.t.send({ k: 'team', team }, this.hostId);
  }

  /** Name / look / weapon changed in the menus. */
  updateProfile() {
    if (!this.t) return;
    const p = this._profile();
    if (this.isHost) { const m = this.members.get(this.selfId); if (m) { Object.assign(m, p); this._sendLobby(); this._changed(); } }
    else if (this.hostId) this.t.send({ k: 'prof', ...p }, this.hostId);
  }

  kick(id) {
    if (!this.isHost || id === this.selfId || !this.members.has(id)) return;
    this.t.send({ k: 'kick', reason: 'kicked' }, id);
    this.banned.add(id);
    this._peerLeave(id);
  }

  /** Why the host can't start yet (null = ready). */
  startBlock() {
    if (!this.isHost) return 'Waiting for the host to start';
    if (!this.settings || this.status !== 'lobby') return 'Opening the room…';
    if (this.phase !== 'lobby') return 'A match is running';
    if (!this.settings.bots && (this._teamCount(0) === 0 || this._teamCount(1) === 0)) return 'Each team needs a squidkid (or turn bots on)';
    return null;
  }

  /** Host: lock the team sheet and start a match on every member's screen. */
  start() {
    if (this.startBlock()) return false;
    const s = this.settings;
    this.roster = this._buildRoster();
    this.mid = newMatchId();
    this.phase = 'match';
    this.loaded = new Set();
    const start = { k: 'start', mid: this.mid, mapId: s.mapId, time: s.time, duration: s.duration, difficulty: s.difficulty, palette: s.palette, roster: this.roster };
    this.t.send(start);
    this._sendLobby();
    this.cfg = { ...start, isHost: true, selfId: this.selfId, hostId: this.selfId };
    clearTimeout(this._loadTimer);
    this._loadTimer = setTimeout(() => this._loadDone(), NET.loadTimeout * 1000);
    this._changed();
    this.hooks.onStart?.(this.cfg);
    return true;
  }

  _buildRoster() {
    const roster = [];
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()));
    const names = BOT_NAMES.filter((n) => !taken.has(n.toLowerCase())).sort(() => Math.random() - 0.5);
    let ni = 0;
    for (let team = 0; team < 2; team++) {
      const humans = [...this.members.values()].filter((m) => m.team === team).sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0));
      let slot = 0;
      for (const m of humans.slice(0, NET.teamMax)) {
        roster.push({ n: team * 4 + slot, team, slot, peer: m.id, name: m.name, weapon: m.weapon, style: m.style });
        slot++;
      }
      if (!this.settings.bots) continue;
      // bots get a balanced mix of what the humans on their team didn't pick
      const pool = WEAPON_ORDER.filter((w) => !humans.some((m) => m.weapon === w));
      while (slot < 4) {
        if (!pool.length) pool.push(...WEAPON_ORDER);
        const weapon = pool.splice((Math.random() * pool.length) | 0, 1)[0];
        roster.push({ n: team * 4 + slot, team, slot, peer: null, name: names[ni++ % names.length] || 'Bot', weapon, style: randomStyle() });
        slot++;
      }
    }
    return roster;
  }

  /** This browser finished building the stage + match. */
  markLoaded() {
    if (this.phase !== 'match' || !this.mid || !this.t) return;
    if (this.isHost) { this.loaded.add(this.selfId); this._checkLoaded(); this._changed(); }
    else this.t.send({ k: 'loaded', mid: this.mid }, this.hostId);
  }
  loadProgress() {
    const humans = (this.roster || []).filter((r) => r.peer);
    return { loaded: humans.filter((r) => this.loaded.has(r.peer) || !this.members.has(r.peer)).length, total: humans.length };
  }
  _checkLoaded() {
    if (!this.isHost || this.phase !== 'match' || !this.roster || !this._loadTimer) return;
    const waiting = this.roster.filter((r) => r.peer && this.members.has(r.peer) && !this.loaded.has(r.peer));
    if (!waiting.length) this._loadDone();
  }
  _loadDone() {
    if (!this._loadTimer) return;
    clearTimeout(this._loadTimer); this._loadTimer = null;
    const missing = this.roster.filter((r) => r.peer && !this.loaded.has(r.peer)).map((r) => r.peer);
    this.hooks.onAllLoaded?.(this.mid, missing);
  }

  /** Host: the match is over (results shown) or abandoned → everyone back to the lobby. */
  endMatch(reason = 'ended') {
    if (!this.isHost || this.phase !== 'match') return;
    const mid = this.mid;
    this.phase = 'lobby'; this.mid = null; this.roster = null; this.cfg = null; this.loaded = new Set();
    clearTimeout(this._loadTimer); this._loadTimer = null;
    this.t.send({ k: 'end', mid, reason });
    this._sendLobby();
    this._changed();
  }

  /** Match-layer messages (the host's 'res' / 'own') — netmatch.js calls this. */
  sendControl(msg, target) { if (this.t) this.t.send(msg, target); }
  sendGame(packet) { if (this.t && this.phase === 'match') this.t.send(packet); }

  // ------------------------------------------------------------------------------------------ links + relay
  _tick() {
    if (!this.t) return;
    if (this.role === 'client' && this.hostId) this.t.send({ k: 'links', ids: this.t.peers() }, this.hostId);
  }

  _recomputeRelay() {
    this.relayTo.clear();
    const ids = [...this.members.keys()].filter((id) => id !== this.selfId);
    for (const a of ids) {
      const la = this.links.get(a), to = [];
      for (const b of ids) {
        if (b === a) continue;
        const lb = this.links.get(b);
        if (!(la && lb && la.has(b) && lb.has(a))) to.push(b);   // unknown counts as broken: a duplicate is cheap, a hole isn't
      }
      if (to.length) this.relayTo.set(a, to);
    }
  }

  _relay(from, p) {
    const to = this.relayTo.get(from);
    if (!to || !to.length) return;
    const packet = { k: 'g', mid: p.mid, q: p.q, t: p.t, s: p.s, e: p.e };
    if (p.m) packet.m = p.m;
    this.t.send({ k: 'rl', o: from, p: packet }, to);
  }

  // ------------------------------------------------------------------------------------------ view
  // The room code rides in the URL fragment (#join=…): browsers never send a fragment to the web server, its logs, or
  // a link-preview bot, and the code doubles as the signaling encryption password (transport.js).
  inviteLink() {
    if (!this.code) return '';
    const u = new URL(location.href);
    u.search = ''; u.hash = '';
    if (this.opts?.local) u.searchParams.set('net', 'local');
    u.hash = 'join=' + formatCode(this.code);
    return u.toString();
  }

  view() {
    const members = [...this.members.values()].map((m) => ({ ...m, isSelf: m.id === this.selfId }));
    return {
      status: this.status, role: this.role, isHost: this.isHost, code: this.code, codeText: formatCode(this.code), link: this.inviteLink(),
      selfId: this.selfId, hostId: this.hostId, phase: this.phase, settings: this.settings ? { ...this.settings } : null,
      members, me: members.find((m) => m.isSelf) || null, error: this.error, notice: this.notice || this.connWarn,
      startBlock: this.isHost ? this.startBlock() : null, inMatch: this.phase === 'match' && this._inRosterSelf(),
      teamMax: NET.teamMax, maxHumans: NET.maxHumans,
    };
  }
}
