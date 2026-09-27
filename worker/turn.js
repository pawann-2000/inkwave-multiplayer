// INKWAVE's only server code. The site is static assets; this Worker runs for /api/* alone (wrangler.jsonc
// assets.run_worker_first) and serves one endpoint:
//
//   POST /api/turn  →  { iceServers: [{ urls: [...], username, credential }], ttl }
//
// Short-lived Cloudflare Realtime TURN credentials, so players whose networks block a direct WebRTC link (mobile
// carrier NAT, campus / office Wi-Fi) can still reach the room through a relay. Minting needs the TURN key's API token,
// which only this Worker holds (secrets TURN_KEY_ID, TURN_KEY_API_TOKEN; `wrangler secret put`).
//
// Threat model (docs/NETWORK.md → TURN relay): the game has no accounts, so anyone can ask for credentials. The limits
// are: same-origin POST only, a per-IP rate limit (TURN_LIMIT binding), and credentials that expire after TTL. Errors
// are generic; the token and upstream bodies never reach a client or a log.

import { TTL, cleanIceServers } from './ice.js';

const UPSTREAM = 'https://rtc.live.cloudflare.com/v1/turn/keys/';

// every response carries its own hardening (the static assets' _headers don't apply to Worker responses)
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};
const reply = (status, body, extra) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/turn') return reply(404, { error: 'not found' });
    if (request.method !== 'POST') return reply(405, { error: 'method not allowed' }, { Allow: 'POST' });
    // the game's own page only (browsers always send Origin on a POST): other sites can't spend relay bandwidth through
    // their visitors. Scripts can forge it — the rate limit and the credential TTL are the backstop.
    if (request.headers.get('Origin') !== url.origin) return reply(403, { error: 'forbidden' });
    if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return reply(503, { error: 'relay not configured' });
    if (env.TURN_LIMIT) {
      const { success } = await env.TURN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!success) return reply(429, { error: 'too many requests' }, { 'Retry-After': '60' });
    }
    let res;
    try {
      res = await fetch(UPSTREAM + encodeURIComponent(env.TURN_KEY_ID) + '/credentials/generate-ice-servers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: TTL }),
      });
    } catch {
      console.error('[turn] upstream unreachable');
      return reply(502, { error: 'relay unavailable' });
    }
    if (!res.ok) { console.error('[turn] upstream status', res.status); return reply(502, { error: 'relay unavailable' }); }
    let data;
    try { data = await res.json(); } catch { console.error('[turn] upstream sent non-JSON'); return reply(502, { error: 'relay unavailable' }); }
    const iceServers = cleanIceServers(data && data.iceServers);
    if (!iceServers.some((s) => s.username)) { console.error('[turn] upstream sent no TURN entry'); return reply(502, { error: 'relay unavailable' }); }
    return reply(200, { iceServers, ttl: TTL });
  },
};
