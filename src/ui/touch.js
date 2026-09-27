// On-screen touch controls for phones and tablets (landscape): a floating move stick under the left thumb, drag-to-look
// anywhere on the right, and the action buttons. FIRE, SWIM, SUB and SPECIAL are held, and sliding the holding finger
// keeps aiming (the standard mobile-shooter thumb: shoot, swim or line up a bomb without letting go); JUMP is a tap;
// MAP toggles the stage map, where tapping a teammate's pin super jumps (ui/diorama.js); PAUSE opens the menu.
// Everything writes the Input's touch state (core/input.js), which the player controller reads like another device.
// Shown only in a live match while touch is the active device (a finger on the screen makes it so; a mouse or key
// hands it back).
import { G } from '../core/ctx.js';
import { h } from './ui-util.js';
import { GLYPHS, SUB_ICONS, SQUID, weaponIcon, specialIcon } from './ui-icons.js';

const DEAD = 0.14;           // stick dead zone (share of travel)
const JUMP_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 10 L54 36 L41 36 L41 54 L23 54 L23 36 L10 36 Z" fill="currentColor" stroke="#15121c" stroke-width="4" stroke-linejoin="round"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="16" y="12" width="11" height="40" rx="4" fill="currentColor"/><rect x="37" y="12" width="11" height="40" rx="4" fill="currentColor"/></svg>';

export class TouchControls {
  constructor(root, input, { onPause } = {}) {
    this.input = input;
    this.onPause = onPause;
    this.visible = false;
    this.el = h('div', { class: 'iw-touch', 'aria-hidden': 'true' });
    this.stickZone = h('div', { class: 'iw-tz iw-tz--stick' });
    this.lookZone = h('div', { class: 'iw-tz iw-tz--look' });
    this.knob = h('i', { class: 'iw-stick__knob' });
    this.stick = h('div', { class: 'iw-stick' }, this.knob);
    const btn = (id, label, icon) => h('div', { class: `iw-tb iw-tb--${id}` },
      h('span', { class: 'iw-tb__ico', html: icon }), h('b', null, label));
    this.b = {
      fire: btn('fire', 'FIRE', GLYPHS.target), swim: btn('swim', 'SWIM', SQUID), jump: btn('jump', 'JUMP', JUMP_SVG),
      sub: btn('sub', 'SUB', SUB_ICONS.bomb), special: btn('special', 'SPECIAL', GLYPHS.bolt), map: btn('map', 'MAP', GLYPHS.map),
      pause: btn('pause', 'PAUSE', PAUSE_SVG),
    };
    this.el.append(this.stickZone, this.lookZone, this.stick, ...Object.values(this.b));
    root.appendChild(this.el);
    this._stick = { id: null, ox: 0, oy: 0, r: 60 };
    this._drags = [];          // every look-drag tracker, for release()
    this._s = {};              // last applied visual state (class toggles only when something changes)
    this._bind();
  }

  // ---------------------------------------------------------------------------------------------- pointers
  _bind() {
    const t = this.input.touch;
    // one element's fingers: capture each so the moves and the lift come back here even off the element
    const own = (el, down, move, up) => {
      el.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events carry no capturable pointer */ }
        down(e);
      });
      if (move) el.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse') move(e); });
      const end = (e) => { if (e.pointerType !== 'mouse') up(e); };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    };
    // move stick: appears under the thumb; dragging past its rim drags the base along (it never "runs out")
    const S = this._stick;
    own(this.stickZone, (e) => {
      if (S.id !== null) return;
      S.id = e.pointerId; S.ox = e.clientX; S.oy = e.clientY;
      this.stick.classList.add('is-on');
      S.r = this.stick.offsetWidth * 0.5 || 60;
      this._stickMove(e.clientX, e.clientY);
    }, (e) => { if (e.pointerId === S.id) this._stickMove(e.clientX, e.clientY); }, (e) => {
      if (e.pointerId !== S.id) return;
      S.id = null; t.mx = t.my = 0;
      this.stick.classList.remove('is-on');
    });
    // look: one finger at a time per element; the frame's drag (CSS px) accumulates into the touch state
    const lookDrag = (el, key) => {
      const d = { id: null, x: 0, y: 0, el, key };
      this._drags.push(d);
      own(el, (e) => {
        if (d.id !== null) return;
        d.id = e.pointerId; d.x = e.clientX; d.y = e.clientY;
        if (key) { t[key] = true; el.classList.add('is-down'); }
      }, (e) => {
        if (e.pointerId !== d.id) return;
        t.dx += e.clientX - d.x; t.dy += e.clientY - d.y;
        d.x = e.clientX; d.y = e.clientY;
      }, (e) => {
        if (e.pointerId !== d.id) return;
        d.id = null;
        if (key) { t[key] = false; el.classList.remove('is-down'); }
      });
    };
    lookDrag(this.lookZone, null);
    lookDrag(this.b.fire, 'fire'); lookDrag(this.b.swim, 'squid'); lookDrag(this.b.sub, 'sub'); lookDrag(this.b.special, 'special');
    own(this.b.jump, () => { t.jump = true; this.b.jump.classList.add('is-down'); }, null, () => { t.jump = false; this.b.jump.classList.remove('is-down'); });
    own(this.b.map, () => { t.map = !t.map; }, null, () => {});
    own(this.b.pause, () => {}, null, (e) => { if (e.type === 'pointerup') { this.release(); this.onPause?.(); } });
  }

  _stickMove(x, y) {
    const t = this.input.touch, S = this._stick, r = S.r;
    let dx = x - S.ox, dy = y - S.oy;
    const len = Math.hypot(dx, dy);
    if (len > r) { const k = (len - r) / len; S.ox += dx * k; S.oy += dy * k; dx -= dx * k; dy -= dy * k; }
    const m = Math.min(1, Math.hypot(dx, dy) / r);
    const g = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD) / m;   // rescale past the dead zone, keep the direction
    t.mx = (dx / r) * g; t.my = (-dy / r) * g;
    this.stick.style.transform = `translate(${S.ox.toFixed(1)}px,${S.oy.toFixed(1)}px)`;
    this.knob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
  }

  release() {
    this._stick.id = null;
    for (const d of this._drags) d.id = null;
    this.input.releaseTouch();
    this.stick.classList.remove('is-on');
    for (const b of Object.values(this.b)) b.classList.remove('is-down');
  }

  _state(key, v, apply) { if (this._s[key] !== v) { this._s[key] = v; apply(v); } }

  // ---------------------------------------------------------------------------------------------- per frame
  update() {
    const m = G.match, a = m && m.local;
    const on = this.input.lastDevice === 'touch' && G.mode === 'match' && !!a && !m.attract && m.state === 'playing' && !G.menus?.current;
    if (on !== this.visible) {
      this.visible = on;
      this.el.classList.toggle('is-on', on);
      if (!on) this.release();
    }
    if (!on) return;
    const t = this.input.touch, W = a.weapon;
    if (t.map && a.superJumpState) t.map = false;           // the jump is on its way: back to the action
    this._state('team', G.teamHex[a.team], (c) => this.el.style.setProperty('--ta', c));
    this._state('weapon', W.id, () => {
      this.b.fire.firstChild.innerHTML = weaponIcon(W.kind);
      this.b.sub.firstChild.innerHTML = SUB_ICONS[W.sub] || SUB_ICONS.bomb;
      this.b.special.firstChild.innerHTML = specialIcon(W.special);
    });
    this._state('dead', !a.alive, (v) => this.el.classList.toggle('is-dead', v));
    this._state('ready', a.specialReady(), (v) => this.b.special.classList.toggle('is-ready', v));
    this._state('map', t.map, (v) => { this.el.classList.toggle('is-map', v); this.b.map.classList.toggle('is-down', v); });
  }
}
