// Helpers for worker/turn.js, kept out of the Worker's main module: the Workers runtime treats every named export of
// the main module as an entrypoint, so it may export only its handler.

export const TTL = 3 * 3600;   // s: a lobby plus several matches (TURN allocations refresh with these credentials)

// keep only well-formed TURN / STUN entries from the upstream answer (never forward anything else it might add)
const URL_RE = /^(turns?|stun):[a-z0-9.-]{1,253}(:\d{1,5})?(\?transport=(udp|tcp))?$/i;
export function cleanIceServers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list.slice(0, 8)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && URL_RE.test(u)).slice(0, 12);
    if (!urls.length) continue;
    const turn = urls.some((u) => /^turns?:/i.test(u));
    const ok = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
    if (turn && !(ok(s.username) && ok(s.credential))) continue;   // a TURN entry is useless without its credentials
    out.push(turn ? { urls, username: s.username, credential: s.credential } : { urls });
  }
  return out;
}
