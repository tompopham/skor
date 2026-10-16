// The room board (spec 6.5): both teams and scores in very large type, the question number, halftime or
// overtime (the quarter under trivia rules) and the last event, for a projector or a second screen. It is a
// screen of this same page: a second tab or window opened at #board, or the Room board button on Home.
//
// It only listens. Asking and answering go over a BroadcastChannel named 'skor': the board says
// { kind: 'hello' } when it opens, and the scorer answers, and then says it again after every change, with
// { kind: 'state', match } (app.js). If no answer comes within 2 s the board says "Waiting for the scorer".
// The board never saves or changes anything; the one thing it reads from the device is the "hide player
// names" setting, which the scorer's menu sets.

import { derive } from './engine.js';
import { loadSettings, KEYS } from './storage.js';
import { h } from './dom.js';
import { lineupAt, playerName } from './lineup.js';
import { fmt, teamName, leftRight } from './view-common.js';

export const CHANNEL_NAME = 'skor';
const WAIT_MS = 2000;

// ---- What the board says ---------------------------------------------------------------------

// A message from another tab is only trusted as far as the board needs: two teams and a list of cycles.
export const looksLikeMatch = match => match !== null && typeof match === 'object'
  && Array.isArray(match.teams) && match.teams.length === 2 && Array.isArray(match.cycles)
  && match.rules !== null && typeof match.rules === 'object' && Array.isArray(match.markers);

// The player the last event names, found the way derive() finds its last event: the newest cycle with a
// buzz or a Streak turn. A dead starter or a lost turn names no player. `index` is the cycle's place, whose
// line-up says who sat in the seat then.
function lastActor(match, d) {
  for (let i = match.cycles.length - 1; i >= 0; i -= 1) {
    const cycle = match.cycles[i];
    const derived = d.cycles[i];
    if (cycle.dead) return null;
    const buzz = cycle.buzzes.at(-1);
    if (buzz) return { index: i, number: derived.number, team: buzz.team, seat: buzz.seat };
    const turn = derived.streak.at(-1);
    if (turn) return { index: i, number: derived.number, team: turn.team, seat: turn.seat };
    if (cycle.lostTurn.length > 0) return null;
  }
  return null;
}

// derive()'s "Q12: Smith, power", naming whoever sat in the seat in that question (v2 4.4). With names hidden the
// player becomes their team: "Q12: Edinburgh A, power". If the line is not in the shape this expects, only the
// question number is shown, so a name never leaks.
function lastEventText(match, d, hideNames) {
  const text = d.lastEvent;
  const actor = hideNames ? lastActor(match, d) : null;
  if (!actor) return text;
  const sitter = playerName(match, actor.team, lineupAt(match, actor.index)[actor.team][actor.seat]);
  const named = `Q${actor.number}: ${sitter || `${match.teams[actor.team].name} seat ${actor.seat + 1}`}, `;
  if (!text.startsWith(named)) return `Q${actor.number}`;
  return `Q${actor.number}: ${teamName(match, actor.team)}, ${text.slice(named.length)}`;
}

// Everything the board shows, as text, from a match record. `teams` is in display order (left, then right).
export function boardModel(match, hideNames = false) {
  const d = derive(match);
  const { open, phase } = d;
  const last = match.cycles.at(-1) ?? null;
  const has = type => last !== null && match.markers.some(marker => marker.type === type && marker.afterCycleId === last.id);

  let question;
  if (phase.ended) question = phase.et ? 'Final (ET)' : 'Final';
  else if (open.stage === 'awaitingEnd') question = 'Regulation over';
  else question = `Question ${open.cycleId ? d.cycles.find(cycle => cycle.id === open.cycleId).number : d.cycles.length + 1}`;

  const bits = [];
  if (!phase.ended && open.stage !== 'awaitingEnd') {
    if (phase.overtime) bits.push(phase.overtime.mode === 'threeStarters' ? `Overtime, starter ${phase.overtime.index} of 3` : 'Overtime, sudden death');
    else if (last !== null && phase.halftimeAfterCycleId === last.id) bits.push('Halftime');
    if (match.rules.trivia && !phase.overtime) {
      bits.push(has('quarter') ? `End of quarter ${match.markers.filter(marker => marker.type === 'quarter').length}` : `Quarter ${phase.quarter}`);
    }
    if (match.markers.some(marker => marker.type === 'timeCalled')) bits.push('Time called');
    if (phase.lightning && !phase.regulationOver) bits.push('Lightning round');
  }

  return {
    question,
    phase: bits.join(' · '),
    teams: leftRight(match).map(team => ({ team, name: teamName(match, team), score: fmt(d.scores[team]) })),
    last: lastEventText(match, d, hideNames),
  };
}

// ---- The screen ------------------------------------------------------------------------------

// What the board holds between redraws. `match` is the last state heard (null until the first) and `model` what
// was last made of it (the last good one: a record this page cannot read leaves the board as it was), `waiting`
// turns true when 2 s pass with nothing heard, `view` is the page's current elements.
const board = { channel: null, match: null, model: null, waiting: false, timer: null, view: null, onStorage: null, onFullscreen: null };

const hideNamesNow = () => loadSettings().hideNames === true;

function paint() {
  const { view } = board;
  if (!view) return;
  if (board.match) {
    try {
      board.model = boardModel(board.match, hideNamesNow());
    } catch {
      // A record this page cannot read: keep the last good model, so the board shows what it showed.
    }
  }
  const { model } = board;
  if (model) {
    view.question.textContent = model.question;
    view.phase.textContent = model.phase;
    model.teams.forEach((team, side) => {
      view.names[side].textContent = team.name;
      view.names[side].title = team.name;
      view.scores[side].textContent = team.score;
    });
    view.last.textContent = model.last;
  }
  view.main.hidden = !model;
  view.wait.hidden = model !== null || !board.waiting;
}

function onMessage(event) {
  const message = event.data;
  if (message?.kind !== 'state' || !looksLikeMatch(message.match)) return;
  board.match = message.match;
  board.waiting = false;
  clearTimeout(board.timer);
  paint();
}

function start() {
  board.match = null;
  board.model = null;
  board.waiting = false;
  try {
    board.channel = new BroadcastChannel(CHANNEL_NAME);
    board.channel.onmessage = onMessage;
    board.channel.postMessage({ kind: 'hello' });
  } catch {
    board.channel = null;   // no BroadcastChannel here: the board can only say it is waiting
  }
  board.timer = setTimeout(() => {
    board.waiting = true;
    paint();
  }, WAIT_MS);
  // The scorer's menu changes "hide player names" in another tab; the board follows without a reload.
  board.onStorage = event => { if (event.key === KEYS.settings || event.key === null) paint(); };
  window.addEventListener('storage', board.onStorage);
}

// Called by the router when the board is left, so nothing is left listening.
export function stopBoard() {
  clearTimeout(board.timer);
  board.timer = null;
  try { board.channel?.close(); } catch { /* already closed */ }
  board.channel = null;
  if (board.onStorage) window.removeEventListener('storage', board.onStorage);
  if (board.onFullscreen) document.removeEventListener('fullscreenchange', board.onFullscreen);
  board.onStorage = null;
  board.onFullscreen = null;
  board.view = null;
}

export function renderBoard(root, state, api) {
  const running = board.channel !== null || board.timer !== null;
  const side = index => h('div', { class: 'board-team', 'data-side': index },
    h('div', { class: 'board-name' }),
    h('div', { class: 'board-score', 'aria-live': 'polite' }));
  const question = h('div', { class: 'board-q', id: 'board-question', 'aria-live': 'polite' });
  const phase = h('div', { class: 'board-phase', id: 'board-phase', 'aria-live': 'polite' });
  const last = h('div', { class: 'board-last', id: 'board-last', 'aria-live': 'polite' });
  const teams = h('div', { class: 'board-teams' }, side(0), side(1));
  const main = h('div', { class: 'board-main', id: 'board-main', hidden: true }, phase, teams, last);
  const wait = h('div', { class: 'board-wait', id: 'board-wait', hidden: true },
    h('p', { class: 'board-waiting' }, 'Waiting for the scorer'),
    h('p', { class: 'hint' }, 'Start or resume a match in the scorer, in another tab or window of this browser. The board follows it.'));

  const fullscreen = h('button', { type: 'button', class: 'btn', id: 'board-fullscreen', onclick: toggleFullscreen }, 'Fullscreen');
  const syncFullscreen = () => { fullscreen.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; };
  const acts = h('div', { class: 'board-acts' },
    document.fullscreenEnabled ? fullscreen : null,
    h('button', { type: 'button', class: 'btn', id: 'board-back', onclick: () => api.back() }, 'Back'));

  root.append(h('div', { class: 'board', id: 'board' },
    h('h1', { class: 'sr', tabindex: '-1' }, 'Room board'),
    h('div', { class: 'board-top' }, h('span', { class: 'unofficial', id: 'board-unofficial' }, 'Unofficial'), question),
    main, wait, acts));

  board.view = { question, phase, last, main, wait, names: [...teams.querySelectorAll('.board-name')], scores: [...teams.querySelectorAll('.board-score')] };
  if (board.onFullscreen) document.removeEventListener('fullscreenchange', board.onFullscreen);
  board.onFullscreen = syncFullscreen;
  document.addEventListener('fullscreenchange', syncFullscreen);
  syncFullscreen();
  api.keepAwake();   // a projector board should not go dark
  if (!running) start();
  paint();
}

function toggleFullscreen() {
  try {
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    Promise.resolve(request).catch(() => {});
  } catch {
    // The browser refused fullscreen; the board still works in the window.
  }
}
