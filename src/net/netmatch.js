// Online play — in-match replication (docs/NETWORK.md).
//
// Authority. Every browser simulates the squidkids it owns — its player; the host also the bots — and only it paints
// turf and deals damage with them (actor.js / weapons.js check `owned`). Hits are decided by the shooter's browser and
// applied by the victim's (the victim owns its health); a splat-out is announced by the victim's browser. The host
// also runs the clock and judges: its turf grid is the official score.
//
// Wire. NET.tickHz times a second each browser sends the room one packet (protocol.js readGame):
//   s  a snapshot of each squidkid it owns       e  everything they did since the last packet
//   m  (host only) match state + seconds left
// Events: 'f' projectile · 'cb' charger beam · 'b' bomb / tempest · 'tr' animation one-shot · 'sp' splat ·
//         'h' hit · 'd' splatted · 'rs' respawn · 'su' special · 'sl' slam impact · 'sj' super jump · 'dg' dodge roll
//
// Time. Remote squidkids are drawn NET.interpDelay in the past, interpolated between snapshots on a clock estimated
// per sender (the minimum one-way delay seen over a few seconds), and their events play on the same delayed clock,
// so a body, the shot leaving its gun and the ink it lands all line up. Hits on our own squidkids are the exception:
// they apply the moment they arrive.
import * as THREE from 'three';
import { G, on, emit, clamp, angleDiff } from '../core/ctx.js';
import { NET } from '../config.js';
import { ST, SF, FORMS, PROJ_KINDS, SPLAT_KINDS, MATCH_STATES, TRIGGERS, CAUSES, r2, r3 } from './protocol.js';
import { Bucket } from './session.js';
import { BotBrain } from '../game/bots.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DELAY_MS = NET.interpDelay * 1000;
const BUF_MAX = 32;                      // snapshots kept per remote squidkid (~1 s at 30 Hz)
const SEEN_MAX = 256;                    // packet ids remembered per sender (direct + relayed copies are deduped)
const MAX_OUT = 480;                     // events per packet (protocol MAX_EVENTS = 512)
const r4 = (v) => Math.round(v * 10000) / 10000;
// dualies trigger arg: which hand fired (0 = none / 1 = right / 2 = left); frozen like weapons.js' HAND_R / HAND_L
const HANDS = [undefined, Object.freeze({ hand: 0, valueOf() { return 1; } }), Object.freeze({ hand: 1, valueOf() { return 1; } })];
const wrapPi = (a) => { a %= Math.PI * 2; return a > Math.PI ? a - Math.PI * 2 : a < -Math.PI ? a + Math.PI * 2 : a; };

export class NetMatch {
  /** cfg: the session's start config { mid, roster, isHost, selfId, hostId, difficulty } */
  constructor(session, match, cfg) {
    this.session = session; this.match = match; this.cfg = cfg;
    this.isHost = !!cfg.isHost; this.selfId = cfg.selfId; this.hostId = cfg.hostId; this.mid = cfg.mid;
    this.byNid = new Map();
    this.owner = new Map();               // nid → peer id that simulates it (bots → the host)
    for (const a of match.actors) { this.byNid.set(a.nid, a); this.owner.set(a.nid, a.peer || this.hostId); }
    this.origins = new Map();             // peer id → { off, samples, seen, queue, splats, hits }
    this.buf = new Map();                 // nid → snapshot objects, oldest first
    this.out = [];                        // outbound events for the next packet
    this.stormRows = new Map();           // storm damage merged per packet (it ticks every frame)
    this.seq = 0; this.tAcc = 0;
    this.stats = { sent: 0, recv: 0, dropped: 0, bytesOut: 0 };
    // replicate the one-shot animations of the squidkids we own (checked per call: ownership can move to us)
    this._trig = [];
    for (const a of match.actors) {
      const ch = a.character, orig = ch.trigger;
      ch.trigger = (name, arg) => { orig.call(ch, name, arg); if (a.owned) this._outTrig(a, name, arg); };
      this._trig.push([ch, orig]);
    }
    G.paint.onSplat = (c, r, team, seed, kind, st, amt, credit) => this._outSplat(c, r, team, seed, kind, st, amt, credit);
    const mine = (a) => a && a.owned && this.byNid.get(a.nid) === a;
    this.unsubs = [
      on('splatted', ({ victim, attacker, cause }) => { if (mine(victim)) this._ev(['d', victim.nid, attacker && this.byNid.get(attacker.nid) === attacker ? attacker.nid : -1, CAUSES.includes(cause) ? cause : 'weapon']); }),
      on('respawn', ({ actor }) => { if (mine(actor)) this._ev(['rs', actor.nid]); }),
      on('special:use', ({ actor, id }) => { if (mine(actor)) this._ev(['su', actor.nid, id]); }),
      on('special:slam', ({ actor, pos }) => { if (mine(actor)) this._ev(['sl', actor.nid, r3(pos.x), r3(pos.y), r3(pos.z)]); }),
      on('superjump', ({ actor, phase, to }) => {
        if (!mine(actor)) return;
        const p = phase === 'flight' && to ? to : actor.pos;
        this._ev(['sj', actor.nid, phase === 'flight' ? 1 : 0, r3(p.x), r3(p.y), r3(p.z)]);
      }),
      on('superjump:land', ({ actor, pos }) => { if (mine(actor)) this._ev(['sj', actor.nid, 2, r3(pos.x), r3(pos.y), r3(pos.z)]); }),
      on('weapon:dodge', ({ actor, dir }) => { if (mine(actor)) this._ev(['dg', actor.nid, r3(dir.x), r3(dir.z)]); }),
      on('match:state', ({ state, match: m }) => { if (m === this.match && this.isHost && state === 'judge') this._sendResult(); }),
    ];
    G.net = this;
  }

  dispose() {
    if (G.net === this) G.net = null;
    if (G.paint && G.paint.onSplat) G.paint.onSplat = null;
    for (const [ch, orig] of this._trig) ch.trigger = orig;
    this._trig.length = 0;
    this.unsubs.forEach((u) => u());
    this.origins.clear(); this.buf.clear(); this.out.length = 0;
  }

  // ------------------------------------------------------------------------------------------ outbound (G.net.*)
  _ev(row) { this.out.push(row); }

  fire(a, kind, p, x) {
    this._ev(['f', a.nid, PROJ_KINDS.indexOf(kind), r3(p.pos.x), r3(p.pos.y), r3(p.pos.z), r3(p.vel.x), r3(p.vel.y), r3(p.vel.z), r4(p.seed), x | 0]);
  }
  beam(a, m, dir, len, charge, n) {
    this._ev(['cb', a.nid, r3(m.x), r3(m.y), r3(m.z), r4(dir.x), r4(dir.y), r4(dir.z), r2(clamp(len, 0, 60)), r2(charge), n ? 1 : 0, n ? r3(n.x) : 0, n ? r3(n.y) : 0, n ? r3(n.z) : 0]);
  }
  bomb(a, storm, pos, vel) {
    this._ev(['b', a.nid, storm ? 1 : 0, r3(pos.x), r3(pos.y), r3(pos.z), r3(vel.x), r3(vel.y), r3(vel.z)]);
  }
  hit(attacker, victim, dmg, cause) {
    const c = CAUSES.includes(cause) ? cause : 'weapon';
    if (c === 'storm') {   // rain ticks every frame: one merged hit per victim per packet
      const k = attacker.nid * 8 + victim.nid, row = this.stormRows.get(k);
      if (row) { row[3] = Math.min(NET.maxDamage, row[3] + dmg); return; }
      const r = ['h', attacker.nid, victim.nid, Math.min(NET.maxDamage, dmg), c];
      this.stormRows.set(k, r); this._ev(r);
      return;
    }
    this._ev(['h', attacker.nid, victim.nid, r2(Math.min(NET.maxDamage, dmg)), c]);
  }
  _outSplat(c, r, team, seed, kind, st, amt, credit) {
    if (r < 0.02 || r > NET.maxSplatRadius) return;   // (never happens in play; the receivers would refuse it anyway)
    this._ev(['sp', r3(c.x), r3(c.y), r3(c.z), r4(r), team, r4(seed), kind, st ? r4(st.x) : 0, st ? r4(st.y) : 0, st ? r4(st.z) : 0, r2(amt), credit && this.byNid.get(credit.nid) === credit ? credit.nid : -1]);
  }
  _outTrig(a, name, arg) {
    if (!TRIGGERS.includes(name)) return;
    let a1 = 0, a2 = 0, a3 = 0;
    if (name === 'shoot') a1 = arg && typeof arg === 'object' ? (arg.hand | 0) + 1 : 0;
    else if (name === 'hit' || name === 'dodge') {
      if (arg && typeof arg === 'object') { a1 = +arg.x || 0; a2 = +arg.z || 0; a3 = name === 'hit' ? +arg.amp || 1 : +arg.t || 0.3; }
    } else if (typeof arg === 'number' && Number.isFinite(arg)) a1 = arg;
    this._ev(['tr', a.nid, name, r3(clamp(a1, -100, 100)), r3(clamp(a2, -100, 100)), r3(clamp(a3, -100, 100))]);
  }

  _snap(a) {
    const wr = a.weaponRunner;
    let f = 0;
    if (a.alive) f |= SF.alive;
    if (a.grounded) f |= SF.grounded;
    if (wr.firingPose()) f |= SF.firing;
    if (wr.rolling) f |= SF.rolling;
    if (wr.charging) f |= SF.charging;
    if (wr.streaming) f |= SF.streaming;
    if (wr.aimingSub) f |= SF.subAim;
    if (a.invuln > 0) f |= SF.invuln;
    if (a.onEnemy) f |= SF.onEnemy;
    if (a.superJumpState) f |= SF.superJump;
    if (a.specialActive) f |= SF.special;
    if (wr.dodge) f |= SF.dodge;
    if (wr.lockT > 0) f |= SF.lock;
    const form = a.form !== 'squid' ? 0 : a.climbing ? 3 : a.submerged ? 2 : 1;
    // the visual (step-smoothed) height: what the owner sees is what everyone else draws and aims at
    return [a.nid, r3(a.pos.x), r3(a.pos.y + (a.smoothY || 0)), r3(a.pos.z), r2(a.vel.x), r2(a.vel.y), r2(a.vel.z),
      r3(a.yaw), r3(a.aimYaw), r3(clamp(a.aimPitch, -1.7, 1.7)), form, f, r2(wr.charge || 0), r2(clamp(a.ink, 0, 100)), r2(clamp(a.hp, 0, 100)),
      r2(clamp(a.special, 0, 1000)), r2(a.stats.turf), a.grounded ? a.groundTeam : 0, r2(a.wallN.x), r2(a.wallN.y), r2(a.wallN.z)];
  }

  /** End of frame: one packet per tick (the host adds the match clock). */
  flush(dt) {
    this.tAcc += dt;
    const step = 1 / NET.tickHz;
    if (this.tAcc < step) return;
    this.tAcc = Math.min(this.tAcc - step, step);
    const s = [];
    for (const a of this.match.actors) if (a.owned) s.push(this._snap(a));
    const m = this.match;
    const mm = this.isHost ? [Math.max(0, MATCH_STATES.indexOf(m.state)), r2(Math.max(0, m.time))] : undefined;
    let events = this.out;
    this.out = [];
    this.stormRows.clear();
    do {
      const e = events.length > MAX_OUT ? events.slice(0, MAX_OUT) : events;
      events = events.length > MAX_OUT ? events.slice(MAX_OUT) : [];
      const packet = { k: 'g', mid: this.mid, q: this.seq++, t: Math.round(performance.now() * 10) / 10, s, e };
      if (mm) packet.m = mm;
      this.session.sendGame(packet);
      this.stats.sent++;
    } while (events.length);
  }

  _sendResult() {
    const m = this.match, r = m.result;
    if (!r) return;
    const stats = m.actors.map((a) => [a.nid, r2(a.stats.turf), a.stats.splats | 0, a.stats.deaths | 0]);
    this.session.sendControl({ k: 'res', mid: this.mid, cov: [r4(r.coverage[0]), r4(r.coverage[1])], win: r.winner, stats });
  }

  // ------------------------------------------------------------------------------------------ inbound
  _origin(id) {
    let o = this.origins.get(id);
    if (!o) this.origins.set(id, (o = { off: undefined, samples: [], seen: new Set(), seenQ: [], queue: [], splats: new Bucket(NET.limits.splats), hits: new Bucket(NET.limits.hits) }));
    return o;
  }
  _participant(id) { for (const p of this.owner.values()) if (p === id) return true; return false; }

  /** A validated game packet (session.js) from `origin` (directly, or relayed by the host). */
  receive(p, origin) {
    if (p.mid !== this.mid) return;
    const o = this._origin(origin);
    if (o.seen.has(p.q)) return;   // the direct copy and the host's relay of the same packet
    o.seen.add(p.q); o.seenQ.push(p.q);
    if (o.seenQ.length > SEEN_MAX) o.seen.delete(o.seenQ.shift());
    this.stats.recv++; this.stats.dropped += p.dropped || 0;
    const now = performance.now();
    // sender clock: minimum (arrival - send stamp) over the last 4 s ≈ offset + the fastest one-way trip
    o.samples.push(now, now - p.t);
    while (o.samples.length > 2 && now - o.samples[0] > 4000) o.samples.splice(0, 2);
    let min = Infinity;
    for (let i = 1; i < o.samples.length; i += 2) if (o.samples[i] < min) min = o.samples[i];
    o.off = min;
    for (const row of p.s) {
      const nid = row[ST.nid];
      if (this.owner.get(nid) !== origin) continue;   // only an actor's owner speaks for it
      const a = this.byNid.get(nid);
      if (a && !a.owned) this._pushState(nid, p.t, row);
    }
    for (const e of p.e) {
      if (e[0] === 'h') this._inHit(e, origin, o);    // our squidkids take hits right away
      else o.queue.push(p.t, e);
    }
    if (p.m && origin === this.hostId && !this.isHost) this._hostClock(p.m);
  }

  _pushState(nid, t, row) {
    let b = this.buf.get(nid);
    if (!b) this.buf.set(nid, (b = []));
    const last = b[b.length - 1];
    if (last && t <= last.t) {
      if (t < last.t - 1000) return;                        // a straggler from a relay path: too old to matter
      let i = b.length - 1;
      while (i >= 0 && b[i].t > t) i--;
      if (i >= 0 && b[i].t === t) return;
      b.splice(i + 1, 0, { t, s: row });
    } else b.push({ t, s: row });
    if (b.length > BUF_MAX) b.splice(0, b.length - BUF_MAX);
  }

  _inHit(e, origin, o) {
    const at = this.byNid.get(e[1]), v = this.byNid.get(e[2]);
    if (!at || !v || this.owner.get(e[1]) !== origin || !v.owned) return;   // the sender's attacker, our victim
    if (!o.hits.take()) return;
    G.projectiles.applyRemoteHit(at, v, e[3], e[4]);
  }

  // host → members: match state + clock (members never run their own lifecycle; see match.js)
  _hostClock([si, time]) {
    const m = this.match, want = MATCH_STATES[si];
    const cur = MATCH_STATES.indexOf(m.state), next = MATCH_STATES.indexOf(want);
    // forward only; 'judge' waits for the host's result message (it carries the score)
    if (next > cur && want !== 'judge' && want !== 'results') m.setState(want);
    if (m.state === 'playing' || m.state === 'intro') {
      if (Math.abs(m.time - time) > 0.3) m.time = time;
      else m.time += (time - m.time) * 0.1;
    }
  }

  /** Host-only control messages that belong to the match ('res', 'own'). */
  control(c) {
    if (c.mid !== this.mid || this.isHost) return;
    if (c.k === 'res') {
      const m = this.match;
      for (const [nid, turf, splats, deaths] of c.stats) {
        const a = this.byNid.get(nid);
        if (a) { a.stats.turf = turf; a.stats.splats = splats; a.stats.deaths = deaths; }
      }
      m.result = { coverage: c.cov, winner: c.win };
      if (m.state !== 'judge' && m.state !== 'results') { m.time = 0; m.setState('judge'); }
    } else if (c.k === 'own') {
      if (!this.byNid.has(c.n) || c.peer !== this.hostId) return;   // only ever handed to the host (a leaver → bot)
      if (this.byNid.get(c.n).owned) { emit('net:replaced', {}); return; }   // ours: we were too slow to load
      this.owner.set(c.n, c.peer);
      this.buf.delete(c.n);                                          // new sender, new clock
      emit('net:takeover', { actor: this.byNid.get(c.n) });
    }
  }

  /** Host: a member left (or never loaded) — the host's bots take their squidkids over. */
  takeOver(peerId) {
    if (!this.isHost) return [];
    const taken = [];
    for (const a of this.match.actors) {
      if (a.peer !== peerId || a.owned) continue;
      a.stopRemoteLoops();
      a.owned = true; a.peer = null; a.isBot = true;
      a.superJumpState = null; a.specialActive = null; a._rc = null;
      a.weaponRunner.reset();
      a.bot = new BotBrain(a, this.cfg.difficulty);
      a.bot.aimYaw = a.yaw;
      this.owner.set(a.nid, this.selfId);
      this.buf.delete(a.nid);
      this.session.sendControl({ k: 'own', mid: this.mid, n: a.nid, peer: this.selfId });
      emit('net:takeover', { actor: a });
      taken.push(a);
    }
    return taken;
  }

  // ------------------------------------------------------------------------------------------ per frame
  /** Before the match update: remote squidkids to their delayed snapshot, then release due events. */
  preUpdate(dt) {
    const now = performance.now();
    for (const a of this.match.actors) {
      if (a.owned) continue;
      const o = this.origins.get(this.owner.get(a.nid));
      if (o && o.off !== undefined) this._sample(a, now - o.off - DELAY_MS, dt);
    }
    for (const [id, o] of this.origins) {
      if (o.off === undefined || !o.queue.length) continue;
      const tp = now - o.off - DELAY_MS;
      // never let events pile up behind a stale clock estimate (e.g. we just woke from a hidden tab and the window
      // is full of slow samples): anything scheduled > 2 s ahead of the playhead, or a huge backlog, plays now
      const flushAll = o.queue.length > 4000 || o.queue[0] > tp + 2000;
      let i = 0;
      while (i < o.queue.length && (flushAll || o.queue[i] <= tp)) { this._applyEvent(o.queue[i + 1], id, o.queue[i]); i += 2; }
      if (i) o.queue.splice(0, i);
    }
  }

  _sample(a, tp, dt) {
    const b = this.buf.get(a.nid);
    if (!b || !b.length) return;
    let i = b.length - 1;
    while (i > 0 && b[i].t > tp) i--;
    const s0 = b[i].s, t0 = b[i].t;
    const n1 = t0 <= tp && i < b.length - 1 ? b[i + 1] : null;
    if (i > 1) b.splice(0, i - 1);                       // keep one snapshot behind the playhead
    let x = s0[ST.x], y = s0[ST.y], z = s0[ST.z], yaw = s0[ST.yaw], ay = s0[ST.aimYaw], ap = s0[ST.aimPitch], d = s0;
    if (n1) {
      const s1 = n1.s, f = clamp((tp - t0) / Math.max(1, n1.t - t0), 0, 1);
      const jump = (s1[ST.x] - x) ** 2 + (s1[ST.y] - y) ** 2 + (s1[ST.z] - z) ** 2 > 36;   // > 6 m: respawn / landing — never slide
      if (jump) { if (f >= 0.5) { x = s1[ST.x]; y = s1[ST.y]; z = s1[ST.z]; } }
      else { x += (s1[ST.x] - x) * f; y += (s1[ST.y] - y) * f; z += (s1[ST.z] - z) * f; }
      yaw += angleDiff(yaw, s1[ST.yaw]) * f; ay += angleDiff(ay, s1[ST.aimYaw]) * f; ap += (s1[ST.aimPitch] - ap) * f;
      if (f >= 0.5) d = s1;
    } else if (t0 <= tp) {
      // past the newest snapshot: dead-reckon a moment, then hold
      const ex = Math.min((tp - t0) / 1000, NET.extrapolate);
      x += s0[ST.vx] * ex; y += s0[ST.vy] * ex; z += s0[ST.vz] * ex;
    }
    a.pos.set(x, y, z);
    a.vel.set(d[ST.vx], d[ST.vy], d[ST.vz]);
    a.yaw = wrapPi(yaw); a.aimYaw = wrapPi(ay); a.aimPitch = ap;
    const form = FORMS[d[ST.form]], fl = d[ST.flags], wr = a.weaponRunner;
    a.form = form === 'kid' ? 'kid' : 'squid';
    a.submerged = form === 'swim'; a.climbing = form === 'climb';
    a.grounded = !!(fl & SF.grounded);
    wr.firingT = fl & SF.firing ? 0.2 : 0;
    wr.rolling = !!(fl & SF.rolling); wr.charging = !!(fl & SF.charging); wr.streaming = !!(fl & SF.streaming);
    wr.aimingSub = !!(fl & SF.subAim); wr.charge = d[ST.charge];
    wr.dodge = fl & SF.dodge ? wr.dodge || { t: 0, dur: 0.3 } : null;
    wr.lockT = fl & SF.lock ? 0.3 : 0;
    a.invuln = fl & SF.invuln ? Math.max(a.invuln, 0.25) : 0;
    a.onEnemy = !!(fl & SF.onEnemy);
    a.superJumpState = fl & SF.superJump ? a.superJumpState || { phase: 'flight', t: 0, remote: true } : null;
    a.specialActive = fl & SF.special ? a.specialActive || { id: a.weapon.special, t: 0, remote: true } : null;
    a.ink = d[ST.ink]; a.hp = d[ST.hp]; a.special = d[ST.special]; a.stats.turf = d[ST.turf];
    a.groundTeam = d[ST.surface];
    a.wallN.set(d[ST.wx], d[ST.wy], d[ST.wz]);
    if (a.climbing) a.anim.wallNormal.copy(a.wallN);
    // life comes from 'd' / 'rs' events; if the snapshots disagree for long (an event lost across a path switch), heal
    const alive = !!(fl & SF.alive);
    if (alive === a.alive) a._aliveOff = 0;
    else if ((a._aliveOff = (a._aliveOff || 0) + dt) > 1.5) {
      a._aliveOff = 0;
      if (alive) a.remoteRespawn();
      else { a.alive = false; a.hp = 0; a.stopRemoteLoops(); a.character.setVisible(false); }
    }
  }

  _applyEvent(e, origin, t) {
    const own = (nid) => { const a = this.byNid.get(nid); return a && !a.owned && this.owner.get(nid) === origin ? a : null; };
    switch (e[0]) {
      case 'f': { const a = own(e[1]); if (a) G.projectiles.spawnRemote(a, PROJ_KINDS[e[2]], _v.set(e[3], e[4], e[5]), _v2.set(e[6], e[7], e[8]), e[9], e[10]); return; }
      case 'cb': {
        const a = own(e[1]);
        if (!a || !(e[8] > 0)) return;
        const dir = _v2.set(e[5], e[6], e[7]);
        if (dir.lengthSq() < 0.25) return;
        dir.normalize();
        const n = e[10] && (e[11] || e[12] || e[13]) ? new THREE.Vector3(e[11], e[12], e[13]).normalize() : null;
        G.projectiles.spawnRemoteBeam(a, _v.set(e[2], e[3], e[4]), dir, e[8], e[9], n);
        return;
      }
      case 'b': { const a = own(e[1]); if (a) G.projectiles.spawnRemoteBomb(a, e[2] === 1, _v.set(e[3], e[4], e[5]), _v2.set(e[6], e[7], e[8])); return; }
      case 'tr': { const a = own(e[1]); if (a && a.alive) this._inTrig(a, e[2], e[3], e[4], e[5]); return; }
      case 'sp': {
        const o = this.origins.get(origin);
        if (!this._participant(origin) || !o.splats.take()) return;
        const B = G.level.bounds;
        if (e[1] < B.minX - 20 || e[1] > B.maxX + 20 || e[3] < B.minZ - 20 || e[3] > B.maxZ + 20) return;
        const st = e[8] || e[9] || e[10] ? _v2.set(e[8], e[9], e[10]) : undefined;
        const area = G.paint.splat(_v.set(e[1], e[2], e[3]), e[4], e[5], { seed: e[6], kind: SPLAT_KINDS[e[7]], stretch: st, stretchAmt: st ? e[11] : undefined, remote: true });
        // turf credit for a splat painted on someone else's browser (the burst when our squidkid splats theirs)
        const c = e[12] >= 0 ? this.byNid.get(e[12]) : null;
        if (c && c.owned && c.team === e[5] && area > 0) c.addTurf(area);
        return;
      }
      case 'd': {
        const v = own(e[1]);
        if (!v || !v.alive) return;
        v.splat(e[2] >= 0 ? this.byNid.get(e[2]) || null : null, e[3]);
        return;
      }
      case 'rs': {
        const a = own(e[1]);
        if (!a || a.alive) return;
        a.remoteRespawn();
        const b = this.buf.get(a.nid);   // drop the death-spot snapshots: interpolate from the drop-in on
        if (b) { const keep = b.filter((x) => x.t >= t); b.length = 0; b.push(...keep); }
        return;
      }
      case 'su': { const a = own(e[1]); if (a && a.alive && e[2] === a.weapon.special) a.remoteSpecial(e[2]); return; }
      case 'sl': { const a = own(e[1]); if (a && a.weapon.special === 'slam') a.remoteSlam(_v.set(e[2], e[3], e[4])); return; }
      case 'sj': {
        const a = own(e[1]);
        if (!a || !a.alive) return;
        const p = new THREE.Vector3(e[3], e[4], e[5]);
        if (e[2] === 0) {
          G.audio?.play('super_jump', { pos: a.pos, volume: 0.6 });
          emit('superjump', { actor: a, phase: 'charge' });
        } else if (e[2] === 1) {
          G.fx?.burst(_v.copy(a.pos), UP, a.color, { count: 16, speed: 6, size: 0.1 });
          emit('superjump', { actor: a, phase: 'flight', to: p });
        } else {
          G.fx?.burst(p, UP, a.color, { count: 14, speed: 5, size: 0.09 });
          emit('superjump:land', { actor: a, pos: p });
        }
        return;
      }
      case 'dg': {
        const a = own(e[1]);
        if (!a || !a.alive) return;
        const dir = new THREE.Vector3(e[2], 0, e[3]);
        if (dir.lengthSq() < 1e-4) return;
        dir.normalize();
        if (a._nearCamera()) G.audio?.play('dualies_roll', { pos: a.pos, volume: 0.5 });
        emit('weapon:dodge', { actor: a, pos: a.pos.clone(), dir });
        return;
      }
      default: return;
    }
  }

  _inTrig(a, name, a1, a2, a3) {
    let arg;
    if (name === 'shoot') arg = HANDS[a1 | 0];
    else if (name === 'hit') { const amp = clamp(a3, 0.3, 1.6); arg = { x: a1, z: a2, amp, valueOf() { return amp; } }; }
    else if (name === 'dodge') arg = { x: a1, z: a2, t: a3 };
    else if (name === 'land') arg = a1;
    a.character.trigger(name, arg);
    // the one-shot sounds a local WeaponRunner plays alongside these
    if (a._nearCamera()) {
      if (name === 'flick') G.audio?.play('roller_flick', { pos: a.pos, volume: 0.8 });
      else if (name === 'slosh') G.audio?.play('slosh_throw', { pos: a.pos, volume: 0.55 });
    }
  }

  /** Round-trip-free link health for the HUD / debugging. */
  debugInfo() {
    const peers = [];
    for (const [id, o] of this.origins) peers.push({ id: id.slice(0, 6), queued: o.queue.length / 2, off: Math.round(o.off ?? -1) });
    return { ...this.stats, peers, owned: this.match.actors.filter((a) => a.owned).length };
  }
}
