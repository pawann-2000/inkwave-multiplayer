// INKWAVE — online screens, installed onto Menus (menus.js) so they share its building blocks, focus navigation and
// transitions:
//   'online'  host a room, or join one with a code / invite link
//   'lobby'   the room: invite code + link, the two team sheets, stage + match options (host), START
// The engine side is api.online (main.js → src/net/session.js). Everything peers send (names) reaches the DOM only
// as text nodes — h() children — never as markup.
import { h, splatSVG, restartAnim, safeCall, colorVars } from './ui-util.js';
import { GLYPHS, weaponIcon } from './ui-icons.js';
import { MAPS, WEAPONS, DIFFICULTY, MATCH, TEAM_NAMES, TEAM_PALETTES, COLORBLIND_PALETTE } from '../config.js';

const durLabel = (s) => (s < 120 ? `${s} SEC` : `${Math.round(s / 60)} MIN`);
const STAGE_DIR = new URL('../../assets/stages/', import.meta.url).href;
const stageArt = (id, time) => `${STAGE_DIR}${id}-${time === 'dusk' ? 'dusk' : 'day'}-sm.webp`;
const mapName = (id) => (MAPS.find((m) => m.id === id) || MAPS[0]).name;
// readable text on a team-ink chip (dark ink on light colours, white on dark)
const inkOn = (hex) => {
  const n = parseInt(String(hex).replace('#', ''), 16) || 0;
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.3 ? '#15121c' : '#ffffff';
};

export function installOnlineScreens(Menus) {
  const P = Menus.prototype;

  P._online = function () { return this.api.online || null; };

  /** Leave via Back / Esc: pop to the previous screen (or the main menu when opened directly). */
  P._popOr = function (fallback) {
    this._sfx('ui_back');
    if (this._stack.length > 1) this.show(this._stack[this._stack.length - 2], { pop: true, back: true });
    else this.show(fallback, { back: true });
  };

  // ================================================================ SCREEN: online (host / join)
  P._scr_online = function (opts = {}) {
    const on = this._online();
    const status = h('div', { class: 'iw-on__status', role: 'status', 'aria-live': 'polite' });
    const setStatus = (text, kind = '') => {
      if (status.textContent === (text || '') && status.dataset.kind === kind) return;
      status.textContent = text || ''; status.dataset.kind = kind;
      if (text) restartAnim(status, 'is-in');
    };

    const hostBtn = this._btn({ id: 'host', label: 'HOST A ROOM', sub: 'Get a code · invite up to 7 friends', icon: GLYPHS.flag, cls: 'iw-btn--menu iw-btn--xl iw-btn--primary', sound: 'ui_confirm', accept: () => doHost() });
    const input = h('input', { class: 'iw-on__code', type: 'text', maxlength: '16', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', placeholder: 'ABCDE-12345', 'aria-label': 'Room code' });
    const codeRow = h('div', { class: 'iw-on__coderow' }, h('span', { class: 'iw-on__codelbl' }, 'CODE'), input);
    this._bind(codeRow, { id: 'code', accept: () => { this._sfx('ui_click'); input.focus(); } });
    input.addEventListener('pointerdown', () => this._setFocus(codeRow));
    input.addEventListener('input', () => { const v = input.value.toUpperCase().replace(/[^0-9A-Z-]/g, ''); if (v !== input.value) input.value = v; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'NumpadEnter') { e.preventDefault(); e.stopPropagation(); input.blur(); doJoin(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); input.blur(); }
    });
    const joinBtn = this._btn({ id: 'join', label: 'JOIN ROOM', icon: GLYPHS.next, cls: 'iw-btn--wide iw-on__joinbtn', sound: 'ui_confirm', accept: () => doJoin() });

    const nameRow = this._nameRow();
    const lo = this._loadout();
    const W = this._weapons()[lo.weapon];
    const weaponChip = h('button', { class: 'iw-wchip iw-on__wchip' },
      h('span', { class: 'iw-wchip__icon', html: weaponIcon(W.kind || lo.weapon) }),
      h('span', { class: 'iw-wchip__text' }, h('small', null, 'WEAPON'), h('b', null, W.name)),
      h('span', { class: 'iw-wchip__edit' }, h('i', { html: GLYPHS.pencil })));
    this._fx(weaponChip);
    this._bind(weaponChip, { id: 'weapon', accept: () => { this._sfx('ui_click'); this._go('loadout'); } });

    const hostPanel = this._panel('iw-on__panel iw-in iw-in--left',
      h('div', { class: 'iw-seclabel' }, h('i', { html: GLYPHS.flag }), 'HOST'),
      h('p', { class: 'iw-on__text' }, 'Open a room, then share its code or invite link. You pick the stage; empty slots fill with bots.'),
      hostBtn);
    const joinPanel = this._panel('iw-on__panel iw-in iw-in--right',
      h('div', { class: 'iw-seclabel' }, h('i', { html: GLYPHS.users }), 'JOIN'),
      h('p', { class: 'iw-on__text' }, 'Got a code from a friend? Type it here, or just open their invite link.'),
      codeRow, joinBtn);
    const note = h('p', { class: 'iw-on__note iw-in iw-in--up' },
      h('i', { html: GLYPHS.eye }),
      'Online play is peer-to-peer: everyone in a room can see each other’s IP address. Share codes only with people you trust.');

    const el = h('div', { class: 'iw-screen iw-online' },
      h('div', { class: 'iw-on__scrim' }),
      this._header('PLAY ONLINE', { sub: 'Turf War with friends · up to 4 v 4 · no account needed' }),
      h('div', { class: 'iw-on__body' },
        h('div', { class: 'iw-on__cols' }, hostPanel, joinPanel),
        h('div', { class: 'iw-on__you iw-in iw-in--up' }, nameRow, weaponChip),
        status, note),
      this._prompts([['Enter', 'A', 'Select'], ['Esc', 'B', 'Back']]));

    let busy = false;
    const render = () => {
      if (!on) { setStatus('Online play is not available here.', 'error'); return; }
      const v = on.view();
      if (v.status === 'connecting') setStatus(v.role === 'host' ? 'Opening a room…' : 'Looking for the room… (this can take a few seconds)', 'busy');
      else if (v.status === 'error') setStatus(v.error || 'Something went wrong.', 'error');
      else if (v.status === 'lobby') {
        if (this.current === 'online' && v.me) this._go('lobby');   // admitted: into the room
        else setStatus('Joining…', 'busy');
      } else setStatus('');
      el.classList.toggle('is-busy', v.status === 'connecting');
    };
    const doHost = async () => {
      if (!on || busy) return;
      busy = true; setStatus('Opening a room…', 'busy');
      try { await on.host(); } finally { busy = false; }
      render();
    };
    const doJoin = async () => {
      if (!on || busy) return;
      const code = input.value.trim();
      if (!code) { this._sfx('ui_error'); restartAnim(codeRow, 'is-shake'); input.focus(); return; }
      busy = true; setStatus('Looking for the room…', 'busy');
      try { await on.join(code); } finally { busy = false; }
      render();
    };
    const unsub = on ? on.subscribe(() => render()) : null;
    return {
      el, initial: opts.join ? joinBtn : hostBtn,
      afterMount: () => {
        if (opts.join && on) { input.value = String(opts.join).slice(0, 16).toUpperCase(); doJoin(); }
        else render();
      },
      onBack: () => {
        const v = on && on.view();
        if (v && (v.status === 'connecting' || v.status === 'error')) on.leave();
        this._popOr('main');
      },
      destroy: () => { unsub && unsub(); },
    };
  };

  // ================================================================ SCREEN: lobby (the room)
  P._scr_lobby = function () {
    const on = this._online();
    if (!on) return this._scr_online();
    const v0 = on.view();
    const isHost = !!v0.isHost;

    // ---- room code + invite link
    const codeEl = h('div', { class: 'iw-lb__code iw-display' }, v0.codeText || '');
    const linkInput = h('input', { class: 'iw-lb__link', type: 'text', readonly: 'readonly', value: v0.link || '', 'aria-label': 'Invite link', spellcheck: 'false' });
    linkInput.addEventListener('focus', () => linkInput.select());
    const flashEl = h('div', { class: 'iw-lb__flash', role: 'status' });
    const flash = (t) => { flashEl.textContent = t; restartAnim(flashEl, 'is-on'); };
    const copy = async (text, what) => {
      try { await navigator.clipboard.writeText(text); flash(`${what} copied — send it to your friends!`); this._sfx('ui_confirm'); }
      catch { linkInput.focus(); linkInput.select(); flash('Copy blocked by the browser: press Ctrl+C / ⌘C to copy the selected link.'); }
    };
    const copyLink = this._btn({ id: 'copylink', label: 'COPY INVITE LINK', icon: GLYPHS.users, cls: 'iw-btn--wide iw-btn--primary iw-lb__copy', sound: null, accept: () => copy(on.view().link, 'Invite link') });
    const copyCode = this._btn({ id: 'copycode', label: 'COPY CODE', cls: 'iw-btn--wide iw-lb__copy', sound: null, accept: () => copy(on.view().codeText, 'Room code') });
    const noticeEl = h('div', { class: 'iw-lb__notice', role: 'status' });
    const roomPanel = this._panel('iw-lb__room iw-in iw-in--left',
      h('div', { class: 'iw-lb__roomhead' }, h('div', { class: 'iw-seclabel' }, h('i', { html: GLYPHS.flag }), 'ROOM CODE'), flashEl),
      codeEl, linkInput,
      h('div', { class: 'iw-lb__copyrow' }, copyLink, copyCode),
      noticeEl);

    // ---- teams
    const teamsEl = h('div', { class: 'iw-lb__teams iw-in iw-in--up' });
    const switchBtn = this._btn({ id: 'switch', label: 'SWITCH TEAM', icon: GLYPHS.rotate, cls: 'iw-btn--wide iw-lb__switch', accept: () => {
      const v = on.view();
      if (!v.me) return;
      const other = 1 - v.me.team;
      if (v.members.filter((m) => m.team === other).length >= v.teamMax) { this._sfx('ui_error'); flash('That team is full.'); return; }
      on.setTeam(other);
    } });
    const kick = (m) => this._openModal({
      title: 'REMOVE PLAYER?', text: `${m.name} will be sent back to the menu and can't rejoin this room.`, danger: true,
      buttons: [
        { label: 'KEEP', accept: () => this._closeModal(), sound: null },
        { label: 'REMOVE', cls: 'iw-btn--danger', sound: 'ui_confirm', accept: () => { this._closeModal(true); on.kick(m.id); } },
      ],
    });
    const roomPalette = (s) => (this._settings().colorblind ? COLORBLIND_PALETTE : TEAM_PALETTES[s && s.palette] || TEAM_PALETTES[0]);
    const renderTeams = (v) => {
      const pal = roomPalette(v.settings), inks = [pal.a, pal.b], names = pal.names || TEAM_NAMES;
      colorVars(el, 'a', pal.a); colorVars(el, 'b', pal.b);
      const bots = !!(v.settings && v.settings.bots);
      teamsEl.textContent = '';
      for (let t = 0; t < 2; t++) {
        const list = v.members.filter((m) => m.team === t);
        const rows = [];
        for (let i = 0; i < v.teamMax; i++) {
          const m = list[i];
          if (m) {
            rows.push(h('div', { class: 'iw-lb__slot is-human' + (m.isSelf ? ' is-self' : '') },
              h('span', { class: 'iw-lb__w', html: weaponIcon((WEAPONS[m.weapon] || {}).kind || 'shooter') }),
              h('span', { class: 'iw-lb__nm' }, m.name),
              m.host ? h('em', { class: 'iw-lb__tag' }, 'HOST') : null,
              m.isSelf ? h('em', { class: 'iw-lb__tag is-you' }, 'YOU') : null,
              isHost && !m.isSelf ? h('button', { class: 'iw-lb__kick', type: 'button', title: `Remove ${m.name}`, 'aria-label': `Remove ${m.name}`, onclick: () => kick(m), html: GLYPHS.close }) : null));
          } else {
            rows.push(h('div', { class: 'iw-lb__slot is-empty' },
              h('span', { class: 'iw-lb__w', html: bots ? GLYPHS.bot : '' }),
              h('span', { class: 'iw-lb__nm' }, bots ? 'Bot' : 'Open slot')));
          }
        }
        teamsEl.appendChild(h('div', { class: `iw-lb__team iw-lb__team--${t ? 'b' : 'a'}` + (v.me && v.me.team === t ? ' is-mine' : ''), style: { '--tc': inks[t], '--tc-ink': inkOn(inks[t]) } },
          h('div', { class: 'iw-lb__thead' }, h('i', { class: 'iw-lb__dot' }), h('span', { class: 'iw-lb__tname' }, names[t] || TEAM_NAMES[t]),
            h('small', null, `${list.length}/${v.teamMax}`)),
          rows));
      }
    };

    // ---- stage + options: the host edits, members see a summary
    const art = h('img', { class: 'iw-lb__art', alt: '', draggable: 'false' });
    art.addEventListener('error', () => { art.style.visibility = 'hidden'; });
    const setArt = (s) => { const src = stageArt(s.mapId, s.time); if (art.dataset.src !== src) { art.dataset.src = src; art.style.visibility = ''; art.src = src; } };
    const stageName = h('b', { class: 'iw-lb__stagename' });
    const optsEl = h('div', { class: 'iw-lb__opts' });
    const refreshers = [];
    if (isHost) {
      const cycle = (d) => {
        const s = on.view().settings;
        const i = Math.max(0, MAPS.findIndex((m) => m.id === s.mapId));
        on.setSettings({ mapId: MAPS[(i + d + MAPS.length) % MAPS.length].id });
        this._sfx('ui_toggle');
      };
      const prev = h('button', { class: 'iw-lb__arrow', type: 'button', 'aria-label': 'Previous stage', html: GLYPHS.back, onclick: (e) => { e.stopPropagation(); cycle(-1); } });
      const next = h('button', { class: 'iw-lb__arrow', type: 'button', 'aria-label': 'Next stage', html: GLYPHS.next, onclick: (e) => { e.stopPropagation(); cycle(1); } });
      const stageRow = h('div', { class: 'iw-setrow iw-lb__stagerow' }, h('div', { class: 'iw-setrow__label' }, h('i', { html: GLYPHS.map }), 'STAGE'), h('span', { class: 'iw-lb__cycler' }, prev, stageName, next));
      this._bind(stageRow, { id: 'stage', type: 'row', adjust: cycle, accept: () => cycle(1) });
      const row = (id, icon, label, options, key) => {
        const seg = this._seg(options, v0.settings[key], (val) => on.setSettings({ [key]: val }));
        const r = h('div', { class: 'iw-setrow' }, h('div', { class: 'iw-setrow__label' }, h('i', { html: icon }), label), seg.el);
        this._bind(r, { id, type: 'row', adjust: seg.adjust, accept: seg.cycle });
        refreshers.push((s) => seg.refresh(s[key]));
        return r;
      };
      optsEl.append(stageRow,
        row('time', GLYPHS.sun, 'TIME', [['day', 'DAY'], ['dusk', 'DUSK']], 'time'),
        row('length', GLYPHS.clock, 'LENGTH', (MATCH.durations || [90, 180]).map((d) => [d, durLabel(d)]), 'duration'),
        row('bots', GLYPHS.bot, 'BOTS', [[true, 'FILL SLOTS'], [false, 'OFF']], 'bots'),
        row('skill', GLYPHS.bolt, 'SKILL', Object.values(DIFFICULTY).map((d) => [d.id, d.name]), 'difficulty'));
    } else {
      const sum = h('div', { class: 'iw-lb__sum' });
      refreshers.push((s) => {
        sum.textContent = '';
        sum.append(
          h('div', null, h('i', { html: GLYPHS.map }), h('span', null, stageName.textContent)),
          h('div', null, h('i', { html: s.time === 'dusk' ? GLYPHS.moon : GLYPHS.sun }), h('span', null, s.time === 'dusk' ? 'Dusk' : 'Day')),
          h('div', null, h('i', { html: GLYPHS.clock }), h('span', null, durLabel(s.duration))),
          h('div', null, h('i', { html: GLYPHS.bot }), h('span', null, s.bots ? `Bots fill empty slots · ${(DIFFICULTY[s.difficulty] || DIFFICULTY.normal).name}` : 'No bots')));
      });
      optsEl.append(h('div', { class: 'iw-lb__hostnote' }, 'The host picks the stage and options'), sum);
    }
    const artTag = h('span', { class: 'iw-lb__arttag' });
    const stagePanel = this._panel('iw-lb__stage iw-in iw-in--right', h('div', { class: 'iw-lb__artwrap' }, art, artTag), optsEl);

    // ---- start (host) / waiting (members)
    const startSub = h('span');
    const start = isHost ? this._btn({ id: 'start', label: 'START!', icon: GLYPHS.play, cls: 'iw-btn--start iw-lb__start', sound: 'ui_confirm', accept: () => {
      if (!on.start()) { this._sfx('ui_error'); restartAnim(start, 'is-shake'); flash(on.view().startBlock || 'Not ready yet.'); }
    } }) : null;
    if (start) start.querySelector('.iw-btn__text').appendChild(h('span', { class: 'iw-btn__sub' }, startSub));
    const waitEl = isHost ? null : h('div', { class: 'iw-lb__wait iw-in iw-in--up' }, h('span', { class: 'iw-lb__spin', html: splatSVG({ seed: 9, cls: 'iw-fa', r: 60, arms: 8, drops: 3 }) }), h('b', null, 'Waiting for the host to start…'));

    const lo = this._loadout();
    const W = this._weapons()[lo.weapon];
    const weaponChip = h('button', { class: 'iw-wchip iw-lb__wchip' },
      h('span', { class: 'iw-wchip__icon', html: weaponIcon(W.kind || lo.weapon) }),
      h('span', { class: 'iw-wchip__text' }, h('small', null, 'YOUR WEAPON'), h('b', null, W.name)),
      h('span', { class: 'iw-wchip__edit' }, h('i', { html: GLYPHS.pencil })));
    this._fx(weaponChip);
    this._bind(weaponChip, { id: 'weapon', accept: () => { this._sfx('ui_click'); this._go('loadout'); } });

    const el = h('div', { class: 'iw-screen iw-lobby' + (isHost ? ' is-host' : '') },
      h('div', { class: 'iw-on__scrim' }),
      this._header('LOBBY', { sub: isHost ? 'Share the code — start when your squad is in' : 'You’re in! Pick your team and weapon' }),
      h('div', { class: 'iw-lb__body' },
        h('div', { class: 'iw-lb__left' }, roomPanel, teamsEl),
        stagePanel),
      h('div', { class: 'iw-lb__foot' }, weaponChip, switchBtn, start || waitEl),
      this._prompts([['Enter', 'A', 'Select'], [['←', '→'], null, 'Change'], ['Esc', 'B', 'Leave room']]));

    const render = () => {
      const v = on.view();
      if (v.status !== 'lobby') {
        // the room is gone (host left / kicked / error): the online screen explains why
        if (this.current === 'lobby') { this._sfx('ui_error'); this.show('online', { back: true }); }
        return;
      }
      const s = v.settings;
      if (s) {
        stageName.textContent = mapName(s.mapId);
        artTag.textContent = `${mapName(s.mapId)} · ${s.time === 'dusk' ? 'DUSK' : 'DAY'}`;
        setArt(s);
        for (const fn of refreshers) safeCall(fn, s);
      }
      if (codeEl.textContent !== v.codeText) codeEl.textContent = v.codeText;
      if (linkInput.value !== v.link) linkInput.value = v.link;
      renderTeams(v);
      noticeEl.textContent = v.notice || '';
      noticeEl.classList.toggle('is-on', !!v.notice);
      if (start) {
        const block = v.startBlock;
        start.classList.toggle('is-blocked', !!block);
        const humans = v.members.length;
        startSub.textContent = block || `${humans} squidkid${humans === 1 ? '' : 's'}${s && s.bots ? ' + bots' : ''} · ${s ? mapName(s.mapId) : ''}`;
      }
      // (on this screen during phase 'match' we're not in the live match: back early from the results, or a late joiner)
      if (waitEl) waitEl.querySelector('b').textContent = v.phase === 'match' ? (v.notice || 'The others are finishing the match…') : 'Waiting for the host to start…';
    };
    const unsub = on.subscribe(() => render());
    render();
    return {
      el, initial: isHost ? copyLink : switchBtn,
      onBack: () => this._openModal({
        title: 'LEAVE ROOM?', text: isHost ? 'The room closes for everyone.' : 'You can rejoin with the code while the room is open.', danger: true,
        buttons: [
          { label: 'STAY', accept: () => this._closeModal(), sound: null },
          { label: 'LEAVE', cls: 'iw-btn--danger', sound: 'ui_confirm', accept: () => { this._closeModal(true); on.leave(); this.show('online', { back: true }); } },
        ],
      }),
      destroy: () => unsub(),
    };
  };
}
