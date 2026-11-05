// What the scoring screen shows over its page or below its buttons: the clock's slot in the top bar, the fixed layer at the
// bottom of the screen (the banner at 0:00, the timeout box and the halftime box), the phase banners, and the score line to
// read out. Moved out of view-score.js for version 1.6.0 (review 19/10/2026, changes 14, 15 and 22), which changed all three.
// The clock's figures are what clock.js works out from the record at api.now(), and the one 1 s ticker only repaints their
// text; it never redraws the screen.

import { derive } from './engine.js';
import { resultLine } from './files.js';
import { clockRunning, played, countdownState, defaultClockRules, timeSummary, formatLength } from './clock.js';
import { gong, beep } from './sound.js';
import { h } from './dom.js';
import { fmt, teamName, leftRight, copyText } from './view-common.js';

// ---- The score line --------------------------------------------------------------------------

// A line to read out or paste (review change 15): the whole line as wrapped text, 20 px bold in a 1 px box, which one tap
// selects, then Copy as a full-width button of its own. Returns the two, for a dialog or a box to place. Copy takes the
// line as it shows at the tap.
export function copyLine(text) {
  const line = h('div', { class: 'scoreline', tabindex: '0' }, text);
  const button = h('button', { type: 'button', class: 'btn copybtn' }, 'Copy');
  button.addEventListener('click', async () => {
    button.textContent = await copyText(line.textContent, line) ? 'Copied' : 'Select the line and copy it';
  });
  return [line, button];
}

export const backupButton = (api, id = 'backup-now') => h('button', { type: 'button', class: 'btn', id, onclick: () => api.offerBackup() }, 'Save a backup file');

// "Edinburgh A 140, Glasgow 95 after 10": the scores after a cycle, the left team first like the files.
export function checkLine(match, d, cycleId = null) {
  const done = cycleId ? d.cycles.find(x => x.id === cycleId) : d.cycles.filter(x => x.closed).at(-1);
  const running = done ? done.running : [0, 0];
  const [left, right] = leftRight(match);
  return `${teamName(match, left)} ${fmt(running[left])}, ${teamName(match, right)} ${fmt(running[right])} after ${done ? done.number : 0}`;
}

// ---- The clock (v2 3.3) ----------------------------------------------------------------------
// The top bar has a fixed slot for the clock, so no button moves whatever it says. Without a countdown it shows
// the time since the clock first started ("12:34", "0:00" before). With one it is a button: "Start clock" before
// the first start, then the time left ("3:21 left"), "Paused" while stopped and "+0:12" once over; a tap starts
// or pauses the clock. When the match has ended it shows the game's length and stops. Every figure is worked out
// from the record at api.now() (v2 1.3, 1.8), never by counting ticks, so a locked phone or a reload still
// reads right. The one 1 s ticker repaints the slot's text and the overlays; it never redraws the screen.

export const clockRulesOf = match => ({ ...defaultClockRules(), ...match.rules.clock });

// The time left, counted down to 0:00 (so the last second reads 0:01), and counting on as "+0:12" once over.
function leftText(leftMs) {
  if (leftMs > 0) return `${formatLength(Math.ceil(leftMs / 1000) * 1000)} left`;
  if (leftMs === 0) return '0:00 left';
  return `+${formatLength(Math.floor(-leftMs / 1000) * 1000)}`;
}

// With no countdown it is the time played, which stands still while the clock is paused (Tom, 19/10/2026), up to the
// last question closed once the match is over.
function slotText(match, d, now) {
  const count = countdownState(match, now);
  if (d.phase.ended) return formatLength((count === null ? timeSummary(match, d).played : null) ?? timeSummary(match, d).game);
  if (count === null) return formatLength(Math.max(0, played(match, now) ?? 0));
  if (!(match.clock ?? []).some(event => event.type === 'start')) return 'Start clock';
  return count.running ? leftText(count.left) : 'Paused';
}

export function clockSlot(c) {
  const { match, d, api } = c;
  const now = api.now();
  const text = slotText(match, d, now);
  if (countdownState(match, now) === null || d.phase.ended) return h('div', { class: 'clockslot', id: 'clock-slot', role: 'timer' }, text);
  return h('button', {
    type: 'button', class: 'btn clockslot', id: 'clock-slot', title: 'Tap to start or pause the clock',
    onclick: () => c.act({ type: 'clock', run: !clockRunning(c.state.match) }, {}),
  }, text);
}

// What the person has closed or the sound has already marked, for this page load only. A banner is keyed by its
// match and period, a timeout box by its marker and the marker's time, so each comes back for the next one.
const timeUi = { closed: new Set(), seen: new Set(), rung: new Set(), gong: new Map() };

// The gong plays once per period, when the time left first reaches 0: a period that is already over when the page
// first looks at it (a reload) makes no sound, and an undo that puts time back does not make it ring twice.
function watchGong(match, count) {
  if (count === null) return;
  const key = `${match.id}|${count.period}`;
  const seen = timeUi.gong.get(key);
  if (count.left > 0) {
    if (seen === undefined) timeUi.gong.set(key, 'before');
  } else if (seen !== 'done') {
    timeUi.gong.set(key, 'done');
    if (seen === 'before') gong();
  }
}

const bannerWords = (match, count) => {
  if (count.perHalf && count.period === 1) return 'End of the first half: press Halftime';
  return match.rules.atTime === 'stopNow' ? 'Gong: press Time called' : 'Time: finish the question, then press Time called';
};

// The banner at 0:00, or null: nothing ends by itself, so it stays until it is closed, or Halftime (the next
// period begins) or Time called is pressed, and does not come back for that period.
function bannerBox(match, d, now) {
  const count = countdownState(match, now);
  if (count === null || count.left > 0 || d.phase.ended || match.markers.some(m => m.type === 'timeCalled')) return null;
  const key = `${match.id}|${count.period}`;
  return timeUi.closed.has(key) ? null : { id: 'time-banner', closeId: 'time-banner-close', key, text: bannerWords(match, count) };
}

// The halftime box (review change 22, Tom's decision 11), or null: over the page in this layer rather than in it, so nothing
// moves when halftime comes and the score line is never below the window. It shows from the moment halftime is reached until
// it is closed or the next question is scored. The menu's Halftime shows the same score check in its dialog, so it closes
// this one (closeHalftimeBox) rather than show it twice.
const halftimeKey = (matchId, cycleId) => `${matchId}|halftime|${cycleId}`;
function halftimeBox(match, d) {
  const last = d.cycles.at(-1);
  if (!last || d.phase.ended || d.phase.halftimeAfterCycleId !== last.id) return null;
  const key = halftimeKey(match.id, last.id);
  return timeUi.closed.has(key) ? null : { id: 'halftime-box', closeId: 'halftime-close', key, line: checkLine(match, d, last.id) };
}
export function closeHalftimeBox(matchId, cycleId) {
  if (cycleId) timeUi.closed.add(halftimeKey(matchId, cycleId));
}

// The latest timeout's box, or null: its time left comes from the marker's own time. It stays at 0:00 until
// closed if it was seen counting; one that ended before the page looked (a reload) is not brought back.
function timeoutBox(match, now) {
  const marker = match.markers.filter(m => m.type === 'timeout' && Number.isFinite(m.at)).sort((a, b) => a.at - b.at).at(-1);
  if (!marker) return null;
  const key = `${match.id}|${match.markers.indexOf(marker)}|${marker.at}|${marker.team}`;
  if (timeUi.closed.has(key)) return null;
  const length = clockRulesOf(match).timeoutSeconds * 1000;
  const remaining = Math.min(length, marker.at + length - now);
  if (remaining > 0) timeUi.seen.add(key);
  else if (!timeUi.seen.has(key)) return null;
  else if (!timeUi.rung.has(key)) {
    timeUi.rung.add(key);
    beep();
  }
  return { id: 'timeout-box', closeId: 'timeout-close', key, name: `Timeout: ${teamName(match, marker.team)}`, left: formatLength(Math.max(0, Math.ceil(remaining / 1000) * 1000)) };
}

// The boxes sit in one fixed layer at the bottom of the screen, outside the page that is redrawn, so a box is
// only ever added, repainted or removed: no button moves, and a tap on Close is never lost to a redraw. From 640 px the
// layer keeps to the team block's column, so a box never covers the buttons (review change 14, Tom's decision 9, option A).
// The timeout box's button only hides it, so it says Hide.
function buildBox(box, state, api) {
  const el = makeBox(box, state, api);
  // A tap in the first 350 ms is ignored, as in a dialog: the second tap of a quick double tap on Done, which can bring the
  // halftime box up under the finger, must not land on its Copy or Save a backup file.
  const builtAt = performance.now();
  el.addEventListener('click', event => {
    if (event.detail > 0 && performance.now() - builtAt < 350) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  return el;
}

function makeBox(box, state, api) {
  const close = h('button', {
    type: 'button', class: 'btn', id: box.closeId,
    onclick: () => { timeUi.closed.add(box.key); refreshClock(state, api); },
  }, box.id === 'timeout-box' ? 'Hide' : 'Close');
  if (box.id === 'time-banner') {
    return h('div', { class: 'timebox', id: box.id, 'data-key': box.key, role: 'status' }, h('span', { class: 'timetext' }, box.text), close);
  }
  if (box.id === 'halftime-box') {
    return h('div', { class: 'timebox halfbox', id: box.id, 'data-key': box.key, role: 'group', 'aria-label': 'Halftime' },
      h('div', { class: 'halfhead' }, h('b', {}, 'Halftime'), close),
      h('p', {}, 'Score check, to read out or copy:'), ...copyLine(box.line), backupButton(api, 'halftime-backup'));
  }
  return h('div', { class: 'timebox', id: box.id, 'data-key': box.key, role: 'group', 'aria-label': box.name },
    h('span', { class: 'timetext' }, box.name), h('span', { class: 'timeleft', id: 'timeout-left', role: 'timer' }, box.left), close);
}

function syncTimeLayer(state, api, wanted) {
  let layer = document.getElementById('timelayer');
  if (wanted.length === 0) {
    layer?.remove();
    return;
  }
  if (!layer) {
    layer = h('div', { class: 'timelayer', id: 'timelayer' });
    document.body.append(layer);
  }
  for (const el of [...layer.children]) {
    if (!wanted.some(box => box.id === el.id && box.key === el.dataset.key)) el.remove();
  }
  for (const box of wanted) {
    const el = document.getElementById(box.id);
    if (!el) layer.append(buildBox(box, state, api));
    else if (box.left !== undefined) {
      const left = el.querySelector('.timeleft');
      if (left.textContent !== box.left) left.textContent = box.left;
    } else if (box.line !== undefined) {
      const line = el.querySelector('.scoreline');
      if (line.textContent !== box.line) line.textContent = box.line;   // Swap sides, say: the left team is named first
    }
  }
  const order = wanted.map(box => box.id);
  if ([...layer.children].map(el => el.id).join() !== order.join()) for (const id of order) layer.append(document.getElementById(id));
}

// Reads the clock once: repaints the slot's text, rings the gong if its time has come, and shows or removes the
// banner, the timeout box and the halftime box (not above the cycle or rules editor, which the boxes would sit over).
export function refreshClock(state, api) {
  const { match } = state;
  if (!match || state.screen !== 'score') return;
  const now = api.now();
  const d = derive(match);
  const slot = document.getElementById('clock-slot');
  if (slot) {
    const text = slotText(match, d, now);
    if (slot.textContent !== text) slot.textContent = text;
  }
  watchGong(match, countdownState(match, now));
  syncTimeLayer(state, api, state.ui.sub ? [] : [timeoutBox(match, now), bannerBox(match, d, now), halftimeBox(match, d)].filter(Boolean));
}

const ticker = { timer: null, live: null };

function tickClock() {
  const live = ticker.live;
  if (!live) return;
  if (live.state.screen !== 'score' || !live.state.match) stopClockTicker();
  else refreshClock(live.state, live.api);
}

export function startClockTicker(state, api) {
  ticker.live = { state, api };
  if (ticker.timer === null) ticker.timer = setInterval(tickClock, 1000);
}

// Called by the page when the scoring screen is left: the timer goes, and so do the boxes over the screen.
export function stopClockTicker() {
  if (ticker.timer !== null) clearInterval(ticker.timer);
  ticker.timer = null;
  ticker.live = null;
  document.getElementById('timelayer')?.remove();
}

// ---- Banners (phase announcements), below the action bar so nothing above them moves; halftime's is in the layer above ----

function banner(title, lines, ...extras) {
  return h('div', { class: 'banner' }, h('b', {}, title), [lines].flat().map(text => h('p', {}, text)), ...extras);
}

// `endMatch` is the scoring screen's End match flow, for the Regulation is over banner.
export function banners(c, endMatch) {
  const { match, d, api } = c;
  const { phase, open } = d;
  const { rules } = match;
  const last = d.cycles.at(-1);
  const out = [];
  const markerHere = type => match.markers.some(m => m.type === type && last && m.afterCycleId === last.id);

  if (phase.ended) {
    out.push(banner('Match ended', resultLine(match, d), backupButton(api),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onclick: () => api.go('sheet') }, 'Scoresheet and stats'),
        h('button', { type: 'button', class: 'btn', onclick: () => api.go('home') }, 'Home'))));
  } else {
    if (open.stage === 'awaitingEnd') {
      const tie = d.scores[0] === d.scores[1];
      out.push(banner('Regulation is over', tie ? 'The scores are level and these rules have no overtime, so the match ends as a tie.' : 'The scores are not level, so the match can only be ended.',
        h('button', { type: 'button', class: 'btn primary', id: 'banner-end', onclick: () => endMatch(c) }, 'End match')));
    } else if (phase.overtime) {
      const text = phase.overtime.mode === 'threeStarters'
        ? `Overtime: the scores are level. Three starters with no bonuses, then sudden death. This is starter ${phase.overtime.index} of 3.`
        : 'Overtime: the scores are level. Sudden death, with no bonuses: the first score that breaks the tie ends the match.';
      out.push(banner('Overtime', text));
    } else if (match.markers.some(m => m.type === 'timeCalled')) {
      out.push(banner('Time called', open.afterTimeBuzz ? 'One buzz already in may still be answered. Score it, or mark the question dead.' : 'Finish the question that is open. No new question follows unless the scores are level.'));
    }
    if (phase.lightning && !phase.regulationOver) out.push(banner('Lightning section', 'Bonus rounds are over. Score as normal until time is called (these rules are unverified).'));
    if (rules.trivia && markerHere('quarter')) {
      const quarters = match.markers.filter(m => m.type === 'quarter').length;
      out.push(banner(`Quarter ${quarters} ended`, 'Score check, to read out or copy:', ...copyLine(checkLine(match, d, last.id)), backupButton(api)));
    }
  }

  const awake = api.wakeStatus();
  if (awake === 'lost') {
    out.push(h('div', { class: 'banner' }, h('button', { type: 'button', class: 'btn', id: 'wake-ask', onclick: () => api.keepAwake() }, 'Tap to keep screen awake')));
  } else if (awake === 'hint') {
    out.push(banner('The screen may switch itself off', 'Set Auto-Lock to Never (iPhone: Settings, then Display & Brightness, then Auto-Lock) while you are scoring.'));
  }
  return h('div', { class: 'banners', id: 'banners' }, out);
}
