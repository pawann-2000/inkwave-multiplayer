// worker/turn.js (+ worker/ice.js) — the site's only server code (TURN relay credentials). Attacks the boundary: wrong method / path /
// origin, missing configuration, rate limiting, upstream failures (no token or upstream body may leak), path injection
// through the key id, and hostile or malformed upstream answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/turn.js';
import { cleanIceServers, TTL } from '../../worker/ice.js';

const SITE = 'https://inkwave.example';
const TOKEN = 'secret-token-do-not-leak';
const GOOD = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u1', credential: 'c1' }] };
const env = (over = {}) => ({ TURN_KEY_ID: 'key123', TURN_KEY_API_TOKEN: TOKEN, TURN_LIMIT: { limit: async () => ({ success: true }) }, ...over });
const req = (path = '/api/turn', { method = 'POST', origin = SITE } = {}) => new Request(SITE + path, { method, headers: origin ? { Origin: origin } : {} });

// swap global fetch for one call: records what the Worker sent upstream, answers with `respond`
async function withUpstream(respond, fn) {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return respond(url, init); };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}
const json = (body, status = 201) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noLeak = async (res) => { const t = await res.clone().text(); assert.ok(!t.includes(TOKEN), 'token leaked'); assert.ok(!t.includes('upstream-detail'), 'upstream body leaked'); };

test('mints credentials: bearer token upstream, ttl, clean answer, hardened no-store response', async () => {
  await withUpstream(() => json(GOOD), async (calls) => {
    const res = await worker.fetch(req(), env());
    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key123/credentials/generate-ice-servers');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: TTL });
    const body = await res.json();
    assert.equal(body.ttl, TTL);
    assert.equal(body.iceServers.length, 2);
    assert.deepEqual(body.iceServers[1], GOOD.iceServers[1]);
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.match(res.headers.get('Content-Security-Policy'), /default-src 'none'/);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null, 'must not open CORS');
  });
});

test('refuses: other paths, other methods, missing or foreign Origin — without calling upstream', async () => {
  await withUpstream(() => json(GOOD), async (calls) => {
    assert.equal((await worker.fetch(req('/api/other'), env())).status, 404);
    assert.equal((await worker.fetch(req('/api/turn/../turn2'), env())).status, 404);
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const r = await worker.fetch(req('/api/turn', { method }), env());
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get('Allow'), 'POST');
    }
    assert.equal((await worker.fetch(req('/api/turn', { origin: null }), env())).status, 403);
    for (const origin of ['https://evil.example', 'null', SITE + '.evil.example', 'http://inkwave.example']) {
      assert.equal((await worker.fetch(req('/api/turn', { origin }), env())).status, 403, origin);
    }
    assert.equal(calls.length, 0);
  });
});

test('not configured → 503, never an upstream call with an empty key', async () => {
  await withUpstream(() => json(GOOD), async (calls) => {
    assert.equal((await worker.fetch(req(), env({ TURN_KEY_ID: '' }))).status, 503);
    assert.equal((await worker.fetch(req(), env({ TURN_KEY_API_TOKEN: undefined }))).status, 503);
    assert.equal(calls.length, 0);
  });
});

test('rate limited per client IP → 429 before any upstream call', async () => {
  const keys = [];
  const limiter = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  await withUpstream(() => json(GOOD), async (calls) => {
    const r = new Request(SITE + '/api/turn', { method: 'POST', headers: { Origin: SITE, 'CF-Connecting-IP': '203.0.113.7' } });
    const res = await worker.fetch(r, env({ TURN_LIMIT: limiter }));
    assert.equal(res.status, 429);
    assert.deepEqual(keys, ['203.0.113.7']);
    assert.equal(calls.length, 0);
  });
});

test('upstream failures are generic 502s: no token, no upstream body', async () => {
  const cases = [
    () => new Response('upstream-detail: invalid token ' + TOKEN, { status: 401 }),
    () => new Response('upstream-detail', { status: 500 }),
    () => new Response('<html>upstream-detail</html>', { status: 201 }),                 // not JSON
    () => json({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }),          // no TURN entry
    () => json({ iceServers: 'upstream-detail' }),
    () => { throw new Error('upstream-detail ' + TOKEN); },                             // network error
  ];
  for (const respond of cases) {
    await withUpstream(respond, async () => {
      const res = await worker.fetch(req(), env());
      assert.equal(res.status, 502);
      await noLeak(res);
    });
  }
});

test('the key id cannot redirect the upstream call (path injection)', async () => {
  await withUpstream(() => json(GOOD), async (calls) => {
    await worker.fetch(req(), env({ TURN_KEY_ID: '../../../v1/apps/x?y=1#' }));
    const u = new URL(calls[0].url);
    assert.equal(u.origin, 'https://rtc.live.cloudflare.com');
    assert.ok(u.pathname.startsWith('/v1/turn/keys/') && u.pathname.endsWith('/credentials/generate-ice-servers'), u.pathname);
    assert.equal(u.search, '');
  });
});

test('cleanIceServers keeps only well-formed STUN / TURN entries and drops extra fields', () => {
  const out = cleanIceServers([
    { urls: 'stun:stun.cloudflare.com:3478', extra: 'x' },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'javascript:alert(1)', 'https://evil.example', 'turn:a b'], username: 'u', credential: 'c', credentialType: 'oauth' },
    { urls: ['turn:turn.cloudflare.com:3478'] },                                     // TURN without credentials
    { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'x'.repeat(600) },
    { urls: [] }, null, 'turn:x', 42,
  ]);
  assert.deepEqual(out, [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
  ]);
  assert.deepEqual(cleanIceServers(undefined), []);
  assert.equal(cleanIceServers(Array.from({ length: 50 }, () => ({ urls: 'stun:a.example' }))).length, 8);
});
