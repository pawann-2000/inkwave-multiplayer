// Online play — transports: how peers in one room exchange messages. Both implementations expose the same surface:
//
//   const t = await openTransport(code, { local, lag, jitter })
//   t.selfId                          this browser's id inside the room
//   t.send(msg, target?)              JSON-able object to one peer id (or an array of ids) or, without target, everyone
//   t.onMessage = (msg, fromId) => {} t.onJoin = (id) => {}   t.onLeave = (id) => {}   t.onError = (text) => {}
//   t.peers()                         ids with an open direct connection right now
//   t.close()
//
// TrysteroTransport (production): WebRTC data channels (DTLS-encrypted, ordered + reliable), full mesh. Peers find
// each other through public Nostr relays (Trystero). The SDP offers/answers crossing the relays are AES-GCM encrypted
// with a key derived from the room code (`password`), so a relay operator sees a hashed topic and ciphertext — but
// every peer in the room learns every other peer's IP address (inherent to peer-to-peer; see docs/NETWORK.md).
//
// LocalTransport (dev + automated tests, `?net=local`): BroadcastChannel between tabs of one browser profile, JSON
// round-tripped like the real wire, optional simulated latency with ordered delivery. Same-origin only, no network.
import { NET } from '../config.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const randId = (n) => { const b = new Uint8Array(n); crypto.getRandomValues(b); let s = ''; for (const x of b) s += B62[x % 62]; return s; };

export async function openTransport(code, opts = {}) {
  if (opts.local) return new LocalTransport(code, opts);
  const t = new TrysteroTransport();
  await t.open(code);
  return t;
}

class TrysteroTransport {
  constructor() {
    this.onMessage = null; this.onJoin = null; this.onLeave = null; this.onError = null;
    this.room = null; this.selfId = null; this.closed = false;
  }

  async open(code) {
    // loaded on demand: offline players never download the signaling stack
    const T = await import('../../vendor/trystero/nostr/index.mjs');
    this.selfId = T.selfId;
    const cfg = { appId: NET.appId, password: 'inkwave:' + code };
    if (NET.turn && NET.turn.length) cfg.turnConfig = NET.turn;
    if (NET.relays && NET.relays.length) cfg.relayConfig = { urls: NET.relays };
    this.room = T.joinRoom(cfg, code, {
      // SDP exchanged but no direct route (strict NAT on both sides): the host relays game packets between members
      // it *can* reach, but a member who can't reach the host can't play — surface it
      onJoinError: (d) => { if (!this.closed) this.onError?.(d && d.error ? String(d.error).slice(0, 200) : 'connection failed'); },
    });
    this.act = this.room.makeAction('iw');
    this.act.onMessage = (data, meta) => {
      if (this.closed) return;
      const from = meta && meta.peerId;
      if (typeof from !== 'string') return;
      try { this.onMessage?.(data, from); } catch (e) { console.error('[net] message handler', e); }
    };
    this.room.onPeerJoin = (id) => { if (!this.closed) this.onJoin?.(id); };
    this.room.onPeerLeave = (id) => { if (!this.closed) this.onLeave?.(id); };
  }

  peers() { return this.room ? Object.keys(this.room.getPeers()) : []; }

  send(msg, target) {
    if (this.closed || !this.act) return;
    // only address peers that are connected (Trystero warns on unknown targets)
    let to;
    if (target != null) {
      const live = this.room.getPeers();
      to = Array.isArray(target) ? target.filter((id) => id in live) : (target in live ? target : null);
      if (!to || (Array.isArray(to) && !to.length)) return;
    }
    this.act.send(msg, to ? { target: to } : undefined).catch((e) => { if (!this.closed) console.warn('[net] send failed', e?.message || e); });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.room?.leave(); } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------------------------- local (dev/test)
class LocalTransport {
  constructor(code, { lag = 0, jitter = 0 } = {}) {
    this.onMessage = null; this.onJoin = null; this.onLeave = null; this.onError = null;
    this.selfId = 'L' + randId(11);
    this.lag = Math.max(0, +lag || 0); this.jitter = Math.max(0, +jitter || 0);
    this.seen = new Map();          // peer → last heartbeat (ms)
    this.nextAt = new Map();        // peer → earliest delivery time (keeps simulated-lag delivery ordered per sender)
    this.closed = false;
    this.ch = new BroadcastChannel('inkwave-local:' + code);
    this.ch.onmessage = (e) => this._recv(e.data);
    this._beat = setInterval(() => { this._post({ c: 'hi' }); this._reap(); }, 500);
    this._post({ c: 'hi' });
    // a closing tab says goodbye (like Trystero's unload cleanup)
    this._bye = () => this.close();
    window.addEventListener('pagehide', this._bye);
  }
  _post(o) { if (!this.closed) this.ch.postMessage({ ...o, from: this.selfId }); }
  // Like a WebRTC channel, a peer only counts as gone when it says bye (or its tab closes) or after a long silence
  // (≈ an ICE timeout): a tab busy compiling shaders for a few seconds is not a leaver.
  _reap() {
    const now = performance.now();
    for (const [id, t] of this.seen) if (now - t > 20000) { this.seen.delete(id); this.onLeave?.(id); }
  }
  _recv(d) {
    if (this.closed || !d || typeof d.from !== 'string' || d.from === this.selfId) return;
    if (d.to && d.to !== this.selfId) return;
    const from = d.from;
    if (d.c === 'hi' || d.c === 'hi-ack') {
      const known = this.seen.has(from);
      this.seen.set(from, performance.now());
      if (!known) { if (d.c === 'hi') this._post({ c: 'hi-ack', to: from }); this.onJoin?.(from); }
      return;
    }
    if (d.c === 'bye') { if (this.seen.delete(from)) this.onLeave?.(from); return; }
    if (d.c !== 'm' || !this.seen.has(from) || typeof d.json !== 'string') return;
    const deliver = () => {
      if (this.closed || !this.seen.has(from)) return;
      let msg;
      try { msg = JSON.parse(d.json); } catch { return; }
      try { this.onMessage?.(msg, from); } catch (e) { console.error('[net] message handler', e); }
    };
    if (!this.lag && !this.jitter) { deliver(); return; }
    const now = performance.now();
    const at = Math.max(this.nextAt.get(from) || 0, now + this.lag + Math.random() * this.jitter);
    this.nextAt.set(from, at);
    setTimeout(deliver, at - now);
  }
  peers() { return [...this.seen.keys()]; }
  send(msg, target) {
    if (this.closed) return;
    const json = JSON.stringify(msg);
    const ids = target == null ? [null] : Array.isArray(target) ? target : [target];
    for (const to of ids) if (to === null || this.seen.has(to)) this._post({ c: 'm', to, json });
  }
  close() {
    if (this.closed) return;
    this._post({ c: 'bye' });
    this.closed = true;
    clearInterval(this._beat);
    window.removeEventListener('pagehide', this._bye);
    this.ch.close();
  }
}
