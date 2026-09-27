// Online end-to-end test: a host and two guests (three tabs of one headless Chrome) meet in a room, play a short
// match and must agree on what happened. It asserts cross-browser facts, not just "no errors":
//   1. the guests join by invite link, everyone lands in the lobby, the host starts, all reach 'playing'
//   2. a guest's squidkid moves on the host's screen (and a host bot moves on the guest's)
//   3. remote ink arrives: host and guest turf grids agree
//   4. a splat decided on the host lands on the guest's squidkid and is reported back to the host
//   4b. a hostile guest forges messages through its real transport: host-only commands aimed at the other guest,
//       rows for squidkids it doesn't own, oversized splats, an event flood, a markup name — all ignored/sanitized
//   5. everyone shows the same final result (the host's)
// Needs the dev server (npm start) and a Chrome: CHROME_PATH=/path/to/chrome node tools/mp-test.mjs [--net trystero]
//   --net local     (default) BroadcastChannel between the tabs — deterministic, no network
//   --net trystero  the production path: signaling over public Nostr relays + WebRTC (needs internet)
//   --lag ms        simulated one-way latency for --net local (default 60, jitter 25)
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const NET = opt('net', 'local');
const LAG = +opt('lag', 60);
const BASE = opt('base', 'http://localhost:8490');
const MAC = process.platform === 'darwin';
const Q = NET === 'local' ? `net=local&lag=${LAG}&jitter=${Math.round(LAG * 0.4)}` : '';
// errors this headless GL stack prints on pristine main too (PMREM / sky shader validation, menu portrait readback),
// and (trystero) browser noise from public Nostr relays in Trystero's default list that are down — external infra
const ENV_NOISE = /VALIDATE_STATUS false|program not valid|does not belong to this context|Material Name|Material Type|Program Info Log|^\s*$|404|preload|relay failure|Failed to load resource|\[showcase\] portrait read|WebSocket connection to 'wss:\/\//;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || (MAC ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome'),
  headless: 'new',
  args: [...(MAC ? ['--use-angle=metal'] : ['--use-gl=angle', '--use-angle=gl-egl']), '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // two WebGL-heavy tabs in one headless browser: don't let one GPU hiccup block WebGL for the whole origin
    '--disable-domain-blocking-for-3d-apis', '--disable-gpu-process-crash-limit'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const errors = { host: [], guest: [], third: [] };
async function openPage(role, name, weapon, url) {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !ENV_NOISE.test(m.text())) errors[role].push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors[role].push('pageerror: ' + e.message));
  await page.evaluateOnNewDocument((n, w) => {
    localStorage.setItem('inkwave.settings', JSON.stringify({ quality: 'low', shadows: false, bloom: false, master: 0, fovMode: 'h', fov: 82 }));
    localStorage.setItem('inkwave.profile', JSON.stringify({ name: n, level: 1, xp: 0, wins: 0, matches: 0, totalTurf: 0, weapon: w }));
  }, name, weapon);
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  return page;
}
const until = (page, fn, timeout = 90000, arg) => page.waitForFunction(fn, { timeout, polling: 200 }, arg);
const ev = (page, fn, arg) => page.evaluate(fn, arg);

try {
  // ---------------------------------------------------------------- 1. room + lobby + start
  const host = await openPage('host', 'HostKid', 'shooter', `${BASE}/?skipTitle&${Q}`);
  await until(host, () => window.__inkwave && __inkwave.menus && __inkwave.menus.current === 'main');
  await ev(host, () => { __inkwave.menus.show('online', { push: true }); return __inkwave.api.online.host(); });   // as the HOST button does
  await until(host, () => __inkwave.session.status === 'lobby' && __inkwave.menus.current === 'lobby', 60000);
  const code = await ev(host, () => __inkwave.session.view().codeText);
  check('host opened a room', /^[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(code), code);

  const guest = await openPage('guest', 'GuestKid', 'roller', `${BASE}/?join=${code}&${Q}`);
  await until(guest, () => window.__inkwave && __inkwave.session && __inkwave.session.status === 'lobby' && __inkwave.session.view().me && __inkwave.menus.current === 'lobby', NET === 'local' ? 60000 : 120000);
  await until(host, () => __inkwave.session.members.size === 2);
  const third = await openPage('third', 'ThirdKid', 'charger', `${BASE}/?join=${code}&${Q}`);
  await until(third, () => window.__inkwave && __inkwave.session && __inkwave.session.status === 'lobby' && __inkwave.session.view().me, NET === 'local' ? 60000 : 120000);
  await until(host, () => __inkwave.session.members.size === 3);
  const lobby = await ev(host, () => __inkwave.session.view().members.map((m) => ({ name: m.name, team: m.team, weapon: m.weapon, host: m.host })));
  const t0 = lobby.filter((m) => m.team === 0).length;
  check('guests joined by invite link; the host sees all three, teams balanced', lobby.length === 3 && (t0 === 1 || t0 === 2) && lobby.some((m) => m.name === 'GuestKid' && m.weapon === 'roller'), lobby);
  const guestSeesHost = await ev(guest, () => __inkwave.session.view().members.some((m) => m.name === 'HostKid' && m.host));
  check('guest sees the host in its lobby', guestSeesHost);

  await ev(host, () => __inkwave.api.online.setSettings({ mapId: 'tidewater', time: 'day', duration: 90, bots: true, difficulty: 'easy' }));
  await sleep(400);
  const guestSettings = await ev(guest, () => __inkwave.session.view().settings);
  check('room settings reach the guest', guestSettings && guestSettings.duration === 90 && guestSettings.difficulty === 'easy', guestSettings);
  await ev(host, () => __inkwave.api.online.start());
  await Promise.all([host, guest, third].map((p) => until(p, () => __inkwave.match && __inkwave.match.online && __inkwave.match.state === 'playing', 120000)));
  const roster = async (p) => ev(p, () => __inkwave.match.actors.map((a) => `${a.nid}:${a.name}:${a.team}:${a.weaponId}`).join('|'));
  const [rh, rg, r3] = [await roster(host), await roster(guest), await roster(third)];
  check('all three browsers play the same roster (8 squidkids, bots filled)', rh === rg && rh === r3 && rh.split('|').length === 8, rh);
  const own = await ev(guest, () => ({ owned: __inkwave.match.actors.filter((a) => a.owned).map((a) => a.name), local: __inkwave.match.local && __inkwave.match.local.name, team: __inkwave.match.local && __inkwave.match.local.team }));
  check('the guest simulates only its own squidkid', own.owned.length === 1 && own.owned[0] === 'GuestKid' && own.local === 'GuestKid', own);
  const vis = [await ev(host, () => document.visibilityState), await ev(guest, () => document.visibilityState), await ev(third, () => document.visibilityState)];
  console.log('      (tab visibility host/guest/third:', vis.join('/'), ')');

  // ---------------------------------------------------------------- 2. movement crosses over
  const guestNid = await ev(guest, () => __inkwave.match.local.nid);
  const posOn = (p, nid) => ev(p, (n) => { const a = __inkwave.match.actors.find((x) => x.nid === n); return [a.pos.x, a.pos.y, a.pos.z]; }, nid);
  const g0 = await posOn(host, guestNid);
  await ev(guest, () => { __inkwave.debug.key('KeyW', true); __inkwave.debug.fire(true); });
  await sleep(3500);
  await ev(guest, () => { __inkwave.debug.key('KeyW', false); __inkwave.debug.fire(false); });
  await sleep(600);
  const gSelf = await posOn(guest, guestNid), gOnHost = await posOn(host, guestNid);
  const d = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
  check('the guest walked, and the host saw it walk', d(g0, gOnHost) > 3 && d(gSelf, gOnHost) < 1.5, { moved: +d(g0, gOnHost).toFixed(2), gapAfterSettle: +d(gSelf, gOnHost).toFixed(3) });
  const botNid = await ev(host, () => __inkwave.match.actors.find((a) => a.owned && a.isBot && a.alive).nid);
  const bHost = await posOn(host, botNid), bGuest = await posOn(guest, botNid);
  check('host bots are mirrored on the guest (within interpolation delay)', d(bHost, bGuest) < 3, { gap: +d(bHost, bGuest).toFixed(2) });

  // ---------------------------------------------------------------- 3. paint agrees
  await sleep(12000);   // bots + the guest's roller paint the stage
  const cov = async (p) => ev(p, () => __G.paint.coverage().map((x) => +(x * 100).toFixed(3)));
  await ev(host, () => { __inkwave.debug.freezeBots(); });   // stop the host's bots painting so both grids settle
  await sleep(1500);
  const [ch, cg] = [await cov(host), await cov(guest)];
  const gap = Math.max(Math.abs(ch[0] - cg[0]), Math.abs(ch[1] - cg[1]));
  check('turf grids agree across browsers (≤ 1 % of the stage)', ch[0] + ch[1] > 5 && gap <= 1, { host: ch, guest: cg, gap: +gap.toFixed(3) });

  // ---------------------------------------------------------------- 4. a splat decided on the host, applied by the guest
  const before = await ev(guest, () => __inkwave.match.local.stats.deaths);
  await ev(host, (n) => {
    const v = __inkwave.match.actors.find((a) => a.nid === n);
    const atk = __inkwave.match.actors.find((a) => a.owned && a.team !== v.team);
    v.invuln = 0;
    __G.projectiles.applyHit(atk, v, 200, 'bomb');
  }, guestNid);
  await until(guest, (b) => __inkwave.match.local.stats.deaths > b, 10000, before).catch(() => {});
  const gDead = await ev(guest, () => ({ alive: __inkwave.match.local.alive, deaths: __inkwave.match.local.stats.deaths }));
  await until(host, (n) => !__inkwave.match.actors.find((a) => a.nid === n).alive, 10000, guestNid).catch(() => {});
  const hView = await ev(host, (n) => { const a = __inkwave.match.actors.find((x) => x.nid === n); return { alive: a.alive, deaths: a.stats.deaths }; }, guestNid);
  check('host-decided hit splats the guest on the guest’s browser', gDead.deaths === before + 1, gDead);
  check('the guest’s splat is reported back to the host', hView.deaths === gDead.deaths, hView);

  // ---------------------------------------------------------------- 4b. a hostile guest (forged messages, straight
  // through its real transport): the host's session/netmatch must ignore or sanitize every one
  const hostBefore = await ev(host, () => {
    const me = __inkwave.match.local;
    return { state: __inkwave.match.state, alive: me.alive, hp: me.hp, pos: [me.pos.x, me.pos.z], cov: __G.paint.coverage(), deaths: me.stats.deaths };
  });
  const thirdNid = await ev(third, () => __inkwave.match.local.nid);
  // oracle for the paint attacks: every splat the host applies from the network in the attack window (real splats
  // are never 1.8 m or 40 m exactly: those are the forged ones)
  await ev(host, () => {
    const P = __G.paint, orig = P.splat;
    window.__spy = [];
    P.splat = function (c, r, team, o = {}) { if (o.remote) window.__spy.push(r); return orig.call(this, c, r, team, o); };
    window.__unspy = () => { P.splat = orig; };
  });
  // an enemy of the host that the guest does NOT own (a host bot on the guest's team) and the third player's squidkid
  const enemyBotNid = await ev(host, () => __inkwave.match.actors.find((a) => a.owned && a.isBot && a.team !== __inkwave.match.local.team).nid);
  await ev(guest, ({ enemyBotNid, thirdNid }) => {
    const s = __inkwave.session, t = s.t, mid = s.mid, now = performance.now();
    t.send({ k: 'res', mid, cov: [1, 0], win: 1, stats: [] });                 // host-only: the result
    t.send({ k: 'end', mid, reason: 'host' });                                  // host-only: end the match
    t.send({ k: 'own', mid, n: 0, peer: s.selfId });                            // host-only: take the host's squidkid
    for (let n = 0; n < 8; n++) t.send({ k: 'own', mid, n, peer: s.selfId });   // … and everyone else's
    t.send({ k: 'lobby', phase: 'lobby', settings: { mapId: 'kelpline', time: 'dusk', duration: 90, difficulty: 'hard', bots: false, palette: 0 }, members: [], mid: null });   // well-formed, so only the host-only rule stops it
    t.send({ k: 'kick', reason: 'kicked' });                                    // host-only: kick everyone
    t.send({ k: 'reject', reason: 'full' });
    t.send({ k: 'start', mid: 'ZZZZZZZZZZZZ', mapId: 'kelpline', time: 'day', duration: 90, difficulty: 'hard', palette: 0, roster: [{ n: 0, team: 0, slot: 0, peer: s.selfId, weapon: 'shooter', name: 'x', style: {} }] });
    t.send({ k: 'g', mid, q: 900000, t: now, s: [[0, 50, 1, 50, 0, 0, 0, 0, 0, 0, 0, 1, 0, 100, 100, 0, 0, 0, 0, 1, 0]],   // speak for the host's squidkid
      e: [['h', enemyBotNid, 0, 200, 'bomb'],                                   // a lethal hit "from" an enemy squidkid the guest doesn't own
        ['d', 0, 4, 'bomb'],                                                    // the host's squidkid "died"
        ['d', thirdNid, 4, 'bomb'],                                             // the third player's squidkid "died"
        ['sp', 0, 1, 0, 40, 1, 0.5, 3, 0, 0, 0, 0, -1],                         // a splat that would ink half the stage
        ['sp', 5000, 1, 0, 2, 1, 0.5, 3, 0, 0, 0, 0, -1],                       // a splat outside the arena
        ['tr', 0, 'dispose', 0, 0, 0], ['rs', 0], ['su', 0, 'slam']] });      // puppet the host's character
    // a flood: 600 real splats in one packet (over the per-packet cap) — accepted, they would ink ~10 % of the stage
    t.send({ k: 'g', mid, q: 900001, t: now, s: [], e: Array.from({ length: 600 }, (_, i) => ['sp', ((i * 7) % 40) - 20, 0.4, ((i * 13) % 80) - 40, 1.8, 1, (i % 97) / 97, 3, 0, 0, 0, 0, -1]) });
    t.send({ k: 'g', mid, q: 'x', t: now, s: 'nope' });                         // garbage
    t.send({ k: 'prof', name: '<img src=x onerror="window.__pwned=1">[F]' + String.fromCodePoint(0x202e) + 'evil', style: { hair: 1.5 }, weapon: 'roller' });
  }, { enemyBotNid, thirdNid });
  await sleep(1500);
  const spied = await ev(host, () => { window.__unspy(); return { forged: window.__spy.filter((r) => r === 1.8 || r === 40).length, remote: window.__spy.length }; });
  const hostAfter = await ev(host, () => {
    const me = __inkwave.match.local;
    const g = [...__inkwave.session.members.values()].find((m) => !m.host);
    const th = __inkwave.match.actors.find((a) => a.name === 'ThirdKid');
    return { state: __inkwave.match.state, alive: me.alive, hp: me.hp, pos: [me.pos.x, me.pos.z], cov: __G.paint.coverage(), deaths: me.stats.deaths, owner0: __G.net && __G.net.owner.get(0) === __inkwave.session.selfId,
      thirdAlive: th.alive, thirdDeaths: th.stats.deaths,
      guestName: g && g.name, pwned: !!window.__pwned, injected: document.querySelectorAll('img[src="x"]').length, phase: __inkwave.session.phase };
  });
  check('forged host-only messages from a member change nothing', hostAfter.state === hostBefore.state && hostAfter.phase === 'match' && hostAfter.owner0, { state: hostAfter.state, phase: hostAfter.phase, stillOwnsSquidkid: hostAfter.owner0 });
  check('a member can’t move, hurt, kill or puppet the host’s squidkid', hostAfter.alive && hostAfter.hp === hostBefore.hp && hostAfter.deaths === hostBefore.deaths && Math.hypot(hostAfter.pos[0] - hostBefore.pos[0], hostAfter.pos[1] - hostBefore.pos[1]) < 0.5,
    { hp: [hostBefore.hp, hostAfter.hp], pos: [hostBefore.pos.map((x) => +x.toFixed(2)), hostAfter.pos.map((x) => +x.toFixed(2))] });
  check('a member can’t splat a third player’s squidkid (only its owner reports that)', hostAfter.thirdAlive && hostAfter.thirdDeaths === 0, { alive: hostAfter.thirdAlive, deaths: hostAfter.thirdDeaths });
  check('oversized splats and over-cap event floods are refused', spied.forged === 0, { forgedSplatsApplied: spied.forged, remoteSplatsInWindow: spied.remote });
  check('a hostile name is sanitized and never becomes markup', hostAfter.guestName && !/[<>[\]]/.test(hostAfter.guestName) && !hostAfter.pwned && hostAfter.injected === 0, hostAfter.guestName);
  const thirdAfter = await ev(third, (n) => ({
    state: __inkwave.match.state, status: __inkwave.session.status, phase: __inkwave.session.phase, result: !!__inkwave.match.result,
    ownsSelf: __inkwave.match.local.owned && __G.net && __G.net.owner.get(n) === __inkwave.session.selfId,
    hostStillOwns0: __G.net && __G.net.owner.get(0) === __inkwave.session.hostId, screen: __inkwave.menus.current,
  }), thirdNid);
  check('a member can’t end, judge, kick or take over another member’s match (host-only messages)',
    thirdAfter.state === 'playing' && thirdAfter.status === 'lobby' && thirdAfter.phase === 'match' && !thirdAfter.result && thirdAfter.ownsSelf && thirdAfter.hostStillOwns0, thirdAfter);

  // ---------------------------------------------------------------- 5. same result everywhere
  await ev(host, () => __inkwave.debug.endMatch(0.2));
  // the host's result reaches every member even with tabs in the background (network + sim run there) ...
  const judged = () => !!__inkwave.match.result && (__inkwave.match.state === 'judge' || __inkwave.match.state === 'results');
  await Promise.all([guest, third].map((p) => until(p, judged, 60000)));
  check('the host\u2019s result reaches every member (tabs hidden)', true);
  // ... the judge animation itself is frame-driven UI: each tab finishes it once it's in front
  for (const p of [third, guest, host]) { await p.bringToFront(); await until(p, () => __inkwave.match.state === 'results' && __inkwave.menus.current === 'results', 60000); }
  const res = async (p) => ev(p, () => ({ cov: __inkwave.match.result.coverage.map((x) => +x.toFixed(4)), win: __inkwave.match.result.winner, local: __inkwave.match.local.team }));
  const [resH, resG, res3] = [await res(host), await res(guest), await res(third)];
  check('everyone shows the same final score', JSON.stringify(resH.cov) === JSON.stringify(resG.cov) && JSON.stringify(resH.cov) === JSON.stringify(res3.cov) && resH.win === resG.win && resH.win === res3.win, { host: resH, guest: resG, third: res3 });
  // the results tables (the data behind them) come from the host: identical per-player turf / splats everywhere
  const table = (p) => ev(p, () => __inkwave.menus._results.players.map((x) => `${x.name}:${x.turf}:${x.splats}:${x.deaths}`).sort().join('|'));
  const [tH, tG, t3] = [await table(host), await table(guest), await table(third)];
  const guestTurf = await ev(guest, () => __inkwave.menus._results.players.find((x) => x.isSelf).turf);
  check('every results table lists the same per-player turf, splats and deaths', tH === tG && tH === t3, tH);
  check('the guest\u2019s own inking is credited in the results', guestTurf > 0, guestTurf);
  const labels = await ev(guest, () => [...document.querySelectorAll('.iw-results .iw-btn__label')].map((e) => e.textContent));
  check('online results offer BACK TO LOBBY / LEAVE ROOM', labels.includes('BACK TO LOBBY') && labels.includes('LEAVE ROOM'), labels);

  // ---------------------------------------------------------------- back to the lobby, then the host leaves
  await ev(host, () => __inkwave.api.rematch());
  await until(host, () => __inkwave.menus.current === 'lobby' && __inkwave.session.phase === 'lobby', 20000);
  await ev(guest, () => __inkwave.api.rematch());
  await until(guest, () => __inkwave.menus.current === 'lobby', 20000);
  check('both return to the same lobby', true);
  await ev(host, () => __inkwave.api.online.leave());
  await until(guest, () => __inkwave.session.status === 'error' && __inkwave.menus.current === 'online', 20000).catch(() => {});
  const gEnd = await ev(guest, () => ({ status: __inkwave.session.status, error: __inkwave.session.error, screen: __inkwave.menus.current }));
  check('when the host leaves, the guest is told and lands on the online screen', gEnd.status === 'error' && gEnd.screen === 'online', gEnd);
} catch (e) {
  check('test ran to completion', false, e.message);
} finally {
  for (const r of ['host', 'guest', 'third']) check(`no console errors on the ${r}`, errors[r].length === 0, errors[r].slice(0, 5));
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${NET}${NET === 'local' ? `, ${LAG} ms simulated latency` : ''})`);
process.exit(failed.length ? 1 : 0);
