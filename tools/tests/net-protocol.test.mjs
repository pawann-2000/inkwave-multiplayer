// Adversarial tests for the online-play trust boundary (src/net/protocol.js). Every inbound peer message is read
// through these functions (session.js → readControl, netmatch.js → readGame), so each test attacks an assumption a
// plausible broken reader would get wrong: coercing strings to numbers, clamping NaN, truthy prototype lookups,
// spreading peer objects, cutting names mid-surrogate, letting one peer own two squidkids.
// run: node --test tools/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newRoomCode, normalizeCode, formatCode, cleanName, cleanStyle, cleanWeapon, cleanPeerId,
  readState, readEvent, readGame, readControl, ST, HOST_ONLY, MAX_EVENTS,
} from '../../src/net/protocol.js';
import { NET, WEAPON_ORDER } from '../../src/config.js';

const MID = 'ABCDEFGHJK12';
const validState = (nid = 0) => [nid, 1.5, 0, -3, 0.5, 0, 6, 0.2, 0.1, -0.1, 0, 3, 0, 80, 100, 12, 34.5, 1, 0, 1, 0];
const allFinite = (arr) => arr.every((v) => typeof v !== 'number' || Number.isFinite(v));

// ------------------------------------------------------------------------------------------------ room codes
test('room codes: CSPRNG alphabet only, fixed length, every symbol reachable', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const c = newRoomCode();
    assert.equal(c.length, NET.codeLength);
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]+$/);          // no I L O U
    for (const ch of c) seen.add(ch);
  }
  assert.equal(seen.size, 32, 'a biased generator (e.g. % 36 or Math.random()*30) would miss symbols');
});

test('room codes: typed input is folded, garbage is refused', () => {
  const c = newRoomCode();
  assert.equal(normalizeCode(formatCode(c).toLowerCase()), c);
  assert.equal(normalizeCode(' abcde-fghjk '), 'ABCDEFGHJK');
  assert.equal(normalizeCode('OOOOO-IIIII'), '0000011111', 'look-alikes fold to digits');
  assert.equal(normalizeCode('LLLLL-LLLLL'), '1111111111');
  for (const badInput of ['', 'ABCDEFGHJ', 'ABCDEFGHJKM', 'ABCDE-FGHJU', 'ABCDE<FGHJ', '🦑🦑🦑🦑🦑🦑🦑🦑🦑🦑', 'A'.repeat(65), null, 42, { length: 10 }]) {
    assert.equal(normalizeCode(badInput), null, `accepted ${String(badInput)}`);
  }
});

// ------------------------------------------------------------------------------------------------ sanitizers
test('names: markup, control, bidi and invisible characters never survive', () => {
  const U = (...cps) => String.fromCodePoint(...cps);
  const nasty = [
    '<img src=x onerror=alert(1)>', '[F] press', '{A}pad', 'a' + U(0x202e) + 'evil', 'zero' + U(0x200b) + 'width',
    'nul' + U(0) + 'byte', 'tab\tnew\nline', 'iso' + U(0x2066) + 'late' + U(0x2069), 'back`tick', 'line' + U(0x2028) + 'sep',
  ];
  const forbidden = (cp) => '<>[]{}`'.includes(String.fromCodePoint(cp)) || cp < 0x20 || cp === 0x7f || cp === 0x200b ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x2028 || cp === 0x2029;
  for (const n of nasty) {
    const s = cleanName(n);
    for (const ch of s) assert.ok(!forbidden(ch.codePointAt(0)), `${JSON.stringify(n)} kept U+${ch.codePointAt(0).toString(16)}`);
    assert.ok(s.length > 0);
  }
});

test('names: capped at 16 code points without splitting surrogate pairs; never empty', () => {
  const s = cleanName('🦑'.repeat(40));
  assert.equal(Array.from(s).length, 16);
  assert.equal(s, '🦑'.repeat(16), 'a .slice(0, 16) on UTF-16 units would leave half a surrogate');
  assert.equal(cleanName('   '), 'Squidkid');
  assert.equal(cleanName(String.fromCodePoint(0x202e, 0x200b)), 'Squidkid');
  assert.equal(cleanName({ toString: () => 'Mallory' }), 'Squidkid', 'non-strings are not coerced');
  assert.equal(cleanName(['a']), 'Squidkid');
  const zalgo = cleanName('Ź̂̃̄̅̆o');
  assert.ok(Array.from(zalgo).length <= 4, 'combining-mark stacks are capped');
});

test('styles: only known fields, only in-range integers; prototype keys and extras are dropped', () => {
  const peer = JSON.parse('{"hair":1,"skin":2.5,"outfit":-1,"eyes":999,"hat":"1","brows":1,"__proto__":{"polluted":true},"constructor":{"x":1},"extra":7}');
  const s = cleanStyle(peer);
  assert.deepEqual(Object.keys(s).sort(), ['brows', 'hair']);
  assert.equal(s.hair, 1);
  assert.equal(s.brows, 1);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(s), Object.prototype);
  for (const junk of [null, 5, 'x', [1, 2], undefined]) assert.deepEqual(cleanStyle(junk), {});
});

test('weapons / peer ids: own-property allowlists, not truthy lookups', () => {
  for (const w of WEAPON_ORDER) assert.equal(cleanWeapon(w), w);
  for (const w of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'SHOOTER', '', 7, null]) assert.equal(cleanWeapon(w), null, `accepted ${String(w)}`);
  assert.equal(cleanPeerId('abcDEF123_-xyz'), 'abcDEF123_-xyz');
  for (const id of ['', 'abc', 'a b c d', '<script>', 'x'.repeat(65), 12345, null]) assert.equal(cleanPeerId(id), null);
});

// ------------------------------------------------------------------------------------------------ state rows
test('state rows: exact length, finite numbers, integer fields really integers', () => {
  assert.ok(readState(validState()));
  assert.equal(readState(validState().slice(1)), null, 'short row');
  assert.equal(readState([...validState(), 0]), null, 'long row');
  const mutate = (i, v) => { const r = validState(); r[i] = v; return readState(r); };
  for (const v of [NaN, Infinity, -Infinity, '1', '1e400', null, undefined, {}, [], true]) {
    assert.equal(mutate(ST.x, v), null, `x=${String(v)}`);
    assert.equal(mutate(ST.hp, v), null, `hp=${String(v)}`);
  }
  assert.equal(mutate(ST.nid, 8), null, 'nid out of range');
  assert.equal(mutate(ST.nid, 1.5), null, 'fractional nid');
  assert.equal(mutate(ST.form, 4), null, 'unknown form');
  assert.equal(mutate(ST.flags, -1), null);
});

test('state rows: absurd floats are clamped into the world, never passed through', () => {
  const r = validState(); r[ST.x] = 1e9; r[ST.vy] = -1e9; r[ST.hp] = 5000; r[ST.aimPitch] = 9;
  const out = readState(r);
  assert.ok(out);
  assert.ok(Math.abs(out[ST.x]) <= 400 && Math.abs(out[ST.vy]) <= 90 && out[ST.hp] <= 100 && Math.abs(out[ST.aimPitch]) <= 1.7);
});

// ------------------------------------------------------------------------------------------------ events
test('events: unknown types, wrong arity and prototype names are refused', () => {
  assert.ok(readEvent(['rs', 3]));
  for (const row of [['constructor', 1], ['__proto__'], ['toString', 1], ['rs'], ['rs', 3, 4], ['zz', 1], [], 'rs', null, [7, 1]]) {
    assert.equal(readEvent(row), null, JSON.stringify(row));
  }
});

test('events: hits are capped per hit and causes are allowlisted', () => {
  const h = readEvent(['h', 0, 5, 1e9, 'bomb']);
  assert.ok(h);
  assert.equal(h[3], NET.maxDamage, 'damage clamps to the cap');
  assert.equal(readEvent(['h', 0, 5, -Infinity, 'bomb']), null);
  assert.equal(readEvent(['h', 0, 5, 30, 'rm -rf']), null);
  assert.equal(readEvent(['h', 0, 9, 30, 'bomb']), null, 'victim slot out of range');
  assert.equal(readEvent(['d', 2, -1, 'water'])[2], -1, 'death by the sea has no attacker');
});

test('events: an oversized splat is refused outright (clamping would still let one peer flood the map)', () => {
  const sp = (r) => readEvent(['sp', 0, 1, 0, r, 1, 0.5, 0, 0, 0, 0, 0, -1]);
  assert.ok(sp(1.2));
  assert.equal(sp(NET.maxSplatRadius + 0.01), null);
  assert.equal(sp(1e6), null);
  assert.equal(sp(0), null);
  assert.equal(sp(NaN), null);
  assert.equal(readEvent(['sp', 0, 1, 0, 1, 2, 0.5, 0, 0, 0, 0, 0, -1]), null, 'team 2 does not exist');
  assert.equal(readEvent(['sp', 0, 1, 0, 1, 1, 0.5, 8, 0, 0, 0, 0, -1]), null, 'unknown splat kind');
});

test('events: trigger names and special ids are allowlisted', () => {
  assert.ok(readEvent(['tr', 1, 'shoot', 0, 0, 0]));
  assert.equal(readEvent(['tr', 1, 'dispose', 0, 0, 0]), null, 'a peer must not call arbitrary character methods');
  assert.equal(readEvent(['su', 1, 'nuke']), null);
});

// ------------------------------------------------------------------------------------------------ packets
test('game packets: bad rows are dropped individually, the rest survive', () => {
  const p = readGame({ k: 'g', mid: MID, q: 5, t: 1234.5, s: [validState(0), [1, 'x']], e: [['rs', 1], ['boom']] });
  assert.ok(p);
  assert.equal(p.s.length, 1);
  assert.equal(p.e.length, 1);
  assert.equal(p.dropped, 2);
});

test('game packets: floods and malformed envelopes are refused', () => {
  const base = { k: 'g', mid: MID, q: 1, t: 1 };
  assert.equal(readGame({ ...base, s: Array.from({ length: 9 }, () => validState()) }), null, '> 8 actors');
  assert.equal(readGame({ ...base, e: Array.from({ length: MAX_EVENTS + 1 }, () => ['rs', 0]) }), null, 'event flood');
  assert.equal(readGame({ ...base, mid: 'abc' }), null);
  assert.equal(readGame({ ...base, q: -1 }), null);
  assert.equal(readGame({ ...base, t: NaN }), null);
  assert.equal(readGame({ ...base, s: 'nope' }), null);
  assert.equal(readGame({ ...base, m: [1] }), null);
  assert.equal(readGame({ ...base, m: [9, 10] }), null, 'unknown match state');
  assert.equal(readGame([base]), null);
});

test('game packets: re-reading a reader\'s output is a fixed point (nothing shifts between hops, e.g. host relays)', () => {
  const p1 = readGame({ k: 'g', mid: MID, q: 9, t: 99, s: [validState(3)], e: [['sj', 3, 1, 1, 2, 3], ['h', 3, 5, 36, 'shooter']], m: [2, 88.5] });
  const p2 = readGame({ k: 'g', mid: p1.mid, q: p1.q, t: p1.t, s: p1.s, e: p1.e, m: p1.m });
  assert.deepEqual(p2.s, p1.s);
  assert.deepEqual(p2.e, p1.e);
  assert.deepEqual(p2.m, p1.m);
});

test('fuzz: readers never throw and never return non-finite numbers', () => {
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const pool = [0, 1, -1, 0.5, 7, 8, 1e9, -1e9, NaN, Infinity, -Infinity, '1', '', 'bomb', 'shoot', 'rs', null, undefined, true, {}, [], [1], MID];
  const any = () => pool[(rnd() * pool.length) | 0];
  for (let i = 0; i < 5000; i++) {
    const row = Array.from({ length: (rnd() * 24) | 0 }, any);
    if (rnd() < 0.5) row[0] = ['f', 'cb', 'b', 'tr', 'sp', 'h', 'd', 'rs', 'su', 'sl', 'sj', 'dg'][(rnd() * 12) | 0];
    const s = readState(row), e = readEvent(row);
    if (s) assert.ok(allFinite(s));
    if (e) assert.ok(allFinite(e));
    const g = readGame({ k: 'g', mid: any(), q: any(), t: any(), s: [row], e: [row], m: rnd() < 0.3 ? [any(), any()] : undefined });
    if (g) { g.s.forEach((r) => assert.ok(allFinite(r))); g.e.forEach((r) => assert.ok(allFinite(r))); }
    readControl({ k: ['hello', 'lobby', 'start', 'res', 'own', 'links', 'rl', 'team'][(rnd() * 8) | 0], v: any(), team: any(), members: [row], roster: [row], ids: row, p: { k: 'g' } });
  }
});

// ------------------------------------------------------------------------------------------------ control messages
const member = (id, team, extra = {}) => ({ id, team, weapon: 'shooter', name: 'P' + id, style: {}, ...extra });
const settings = { mapId: 'tidewater', time: 'day', duration: 180, difficulty: 'normal', bots: true, palette: 1 };

test('lobby: duplicate members and oversized rooms are refused', () => {
  assert.ok(readControl({ k: 'lobby', phase: 'lobby', settings, members: [member('peerAAAA', 0), member('peerBBBB', 1)] }));
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings, members: [member('peerAAAA', 0), member('peerAAAA', 1)] }), null);
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings, members: Array.from({ length: NET.maxHumans + 1 }, (_, i) => member('peer' + 'ABCDEFGHJ'[i] + 'xyz', i & 1)) }), null);
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings: { ...settings, duration: 5 }, members: [] }), null, 'match length must be a real option');
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings: { ...settings, bots: 'yes' }, members: [] }), null);
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings: { ...settings, palette: 99 }, members: [] }), null, 'palette index out of range');
  assert.equal(readControl({ k: 'lobby', phase: 'lobby', settings: { ...settings, palette: '1' }, members: [] }), null);
});

test('start roster: slot numbering is consistent and one peer can never own two squidkids', () => {
  const row = (n, peer) => ({ n, team: n >> 2, slot: n & 3, peer, weapon: 'roller', name: 'x', style: {} });
  const start = (roster) => readControl({ k: 'start', mid: MID, mapId: 'kelpline', time: 'dusk', duration: 90, difficulty: 'hard', palette: 2, roster });
  assert.ok(start([row(0, 'hostAAAA'), row(4, 'peerBBBB'), row(1, null)]));
  assert.equal(start([row(0, 'hostAAAA'), row(5, 'hostAAAA')]), null, 'same peer on two actors');
  assert.equal(start([row(0, 'hostAAAA'), row(0, 'peerBBBB')]), null, 'same slot twice');
  assert.equal(start([{ ...row(0, 'hostAAAA'), n: 5 }]), null, 'n inconsistent with team/slot');
  assert.equal(start([{ ...row(0, 'hostAAAA'), peer: '' }]), null, 'empty peer is not a bot');
  assert.equal(start([]), null);
  assert.equal(readControl({ k: 'start', mid: MID, mapId: 'kelpline', time: 'dusk', duration: 90, difficulty: 'hard', palette: 99, roster: [row(0, 'hostAAAA')] }), null, 'palette index out of range');
});

test('control: host-only kinds are declared, unknown kinds refused, relays revalidate their payload', () => {
  for (const k of ['lobby', 'start', 'res', 'own', 'end', 'reject', 'kick', 'rl']) assert.ok(HOST_ONLY.has(k), k);
  for (const k of ['hello', 'prof', 'team', 'loaded', 'links', 'bye']) assert.ok(!HOST_ONLY.has(k), k);
  assert.equal(readControl({ k: '__proto__' }), null);
  assert.equal(readControl({ k: 'eval', code: '1' }), null);
  assert.equal(readControl({ k: 'rl', o: 'peerAAAA', p: { k: 'g', mid: MID, q: 1, t: 1, s: [[1, 2]], e: [] } }).p.s.length, 0, 'relayed rows are validated like direct ones');
  assert.equal(readControl({ k: 'rl', o: '<x>', p: { k: 'g', mid: MID, q: 1, t: 1 } }), null);
  assert.equal(readControl({ k: 'res', mid: MID, win: 0, cov: [0.5, NaN], stats: [] }), null);
  assert.equal(readControl({ k: 'links', ids: ['peerAAAA', 'bad id!'] }), null);
});
