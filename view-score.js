// The scoring screen (spec 6.3): the top bar, two team columns with their seats, the action bar and
// the bonus panel, the trivia controls (spec 5.1), the menu, the phase banners and the laptop keys.
// It hands the screen to view-editor.js for the cycle editor and Edit rules (state.ui.sub). Everything
// is drawn from derive() of the match; every change goes through api.dispatch, so the engine alone
// decides what is allowed and this file only shows the refusal. The clock's slot in the top bar, the
// banner at 0:00 and the timeout box (v2 3.3) are here too: they show what clock.js works out from the
// record at api.now(), and the one 1 s ticker only repaints their text. Who sits in a seat is the line-up's
// (v2 4.4; lineup.js): the seat buttons show the player sitting now, the recent list the player who sat in
// each question, and the menu's Swap players starts the two cards in view-swap.js. The menu's Protest and Throw
// out (v2 5) start the dialogs in view-protest.js, which also words the bonus panel's floor and ceiling after a bonus throw-out.

import { derive, applyAction, FORMATS } from './engine.js';
import { keyToCommand, tapGuard, sittingNow } from './keys.js';
import { playerName } from './lineup.js';
import { loadSettings, saveSettings } from './storage.js';
import { clockRunning, timeoutsUsed } from './clock.js';
import { unlockSound } from './sound.js';
import { h } from './dom.js';
import {
  fmt, MINUS, teamName, leftRight, repeatText, refusalText, STREAK_MAX, formatOptions, select, check,
} from './view-common.js';
import { renderCycleEditor } from './view-editor.js';
import { renderRulesScreen } from './view-rules.js';
import { protestFlow, throwOutFlow, boundsWords } from './view-protest.js';
import { swapFlow } from './view-swap.js';
import { scoreHead, winMenuLine } from './view-win.js';
import { menuModel, showMenu } from './view-menu.js';
import { legend, recentList } from './view-side.js';
import {
  copyLine, backupButton, checkLine, clockSlot, clockRulesOf, refreshClock, startClockTicker, closeHalftimeBox, banners,
} from './view-banners.js';

// ---- The tap guard and the keys --------------------------------------------------------------
// One clock for both: performance.now(). A tap is ignored for 350 ms after the screen changes stage
// (a new question, the bonus opening, the next Jackpot clue, the match ending) and after the screen
// is first shown. Choosing a format or a starter type only sets up the question, so it is quiet:
// it moves the key without starting the 350 ms, and the seat tapped next is taken.

const stage = { key: '', at: -Infinity, quiet: false };
const SETUP_ACTIONS = ['starterType', 'format'];
function trackStage(match, d) {
  const { open, phase } = d;
  const key = [match.id, d.cycles.length, d.cycles.at(-1)?.id, open.cycleId, open.stage, open.clue, phase.ended].join('|');
  if (key !== stage.key) {
    stage.key = key;
    if (!stage.quiet) stage.at = performance.now();
  }
}
const tapBlocked = state => tapGuard(performance.now(), Math.max(stage.at, state.enteredAt ?? -Infinity));
// A pointer tap on Undo or Redo within 350 ms of the editor closing is the second tap of a double tap on its Cancel or Save,
// which sit where Undo, Redo and Menu are. A key press, or a click made by the page, is never held back.
const justLeftEditor = (state, event) => event.detail > 0 && tapGuard(performance.now(), state.subClosedAt);

let live = null;
let listening = false;
function listen(state, api) {
  live = { state, api };
  if (listening) return;
  listening = true;
  document.addEventListener('keydown', onKey);
  // Sound needs a tap before the browser lets a page make any (an iPhone most of all): the first touch, click
  // or key on the scoring screen unlocks it. Capturing, so that a tap which starts the match (on Setup) is not one.
  for (const type of ['pointerup', 'click', 'keydown']) document.addEventListener(type, unlockOnScoring, true);
  // A phone that was locked wakes with its timer asleep: read the clock again at once.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && live) refreshClock(live.state, live.api); });
}

function unlockOnScoring() {
  if (live?.state.screen === 'score') unlockSound();
}

const keysAreOn = () => loadSettings().singleKeys !== false;

function onKey(event) {
  const { state, api } = live;
  if (state.screen !== 'score' || state.ui.sub || state.foreign || !state.match || document.querySelector('.dialog')) return;
  const target = event.target;
  const inTextField = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const c = makeContext(state, api);
  const command = keyToCommand(
    { key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, repeat: event.repeat, inTextField },
    { selected: state.ui.selected ?? null, keysOn: keysAreOn() }, c.d, c.match);
  if (!command) return;
  event.preventDefault();
  if (command.hint) api.setUi({ hint: command.hint });
  else if (command.select) api.setUi({ selected: command.select, msg: '', streakN: 0, hint: null });
  else if (command.ui === 'undo') api.undo();
  else if (command.ui === 'redo') api.redo();
  else if (command.ui === 'cancel') api.setUi({ selected: null, msg: '', streakN: 0, hint: null });
  else if (command.action.type === 'timeCalled') callTime(c);
  else c.act(command.action);
}

// What every builder below needs: the match and its derive(), and the three ways to act on it.
function makeContext(state, api) {
  const match = state.match;
  const c = { state, api, match, d: derive(match), ui: state.ui };
  c.seats = sittingNow(match, c.d);                                  // who sits where now: [team A's four seats, team B's], ids or null
  c.who = (team, seat) => playerName(match, team, c.seats[team][seat]);   // the name of who sits there now, or '' when nobody does
  c.say = text => api.setUi({ msg: text });
  // Applies one action or a list; on success the half-entered state (chosen seat, Streak count) goes.
  c.act = (actions, patch = { selected: null, streakN: 0 }) => {
    const list = [actions].flat();
    stage.quiet = list.every(action => SETUP_ACTIONS.includes(action.type));
    let result;
    try {
      result = api.dispatchAll(list, patch);
    } finally {
      stage.quiet = false;
    }
    if (!result.ok) c.say(refusalText(result.error));
    return result.ok;
  };
  // A scoring tap: ignored just after a stage change; otherwise it asks for the wake lock again.
  c.tap = fn => event => {
    if (tapBlocked(state)) return;
    api.keepAwake();
    fn(event);
  };
  return c;
}

// ---- The screen ------------------------------------------------------------------------------

export function renderScore(root, state, api) {
  listen(state, api);
  const sub = state.ui.sub;
  if (sub?.kind === 'cycle' && state.match.cycles.some(cycle => cycle.id === sub.cycleId)) renderCycleEditor(root, state, api);
  else if (sub?.kind === 'rules') renderRulesScreen(root, state, api);
  else {
    state.ui.sub = null;
    renderMain(root, state, api);
  }
  startClockTicker(state, api);
  refreshClock(state, api);
}

function renderMain(root, state, api) {
  const c = makeContext(state, api);
  trackStage(c.match, c.d);
  const { ui, d } = c;
  // A chosen seat that can no longer answer (its team was wrong, the stage moved on) is dropped.
  if (ui.selected && !seatInfo(c, ui.selected.team, ui.selected.seat).on) ui.selected = null;

  root.append(
    topBar(c),
    h('div', { class: keysAreOn() ? 'score-layout' : 'score-layout keysoff' },
      h('div', { class: 'main', 'data-stage': d.open.stage },
        h('p', { class: ui.msg ? 'statusline err' : 'statusline', id: 'statusline', role: 'status' }, ui.msg || d.lastEvent),
        picker(c),
        teamsView(c),
        h('div', { class: 'bar', id: 'bar' }, d.open.stage === 'bonus' ? bonusPanel(c) : starterBar(c)),
        banners(c, endMatchFlow)),
      h('aside', { class: 'side' }, legend(c, keysAreOn()), recentList(c))));
}

// ---- Top bar ---------------------------------------------------------------------------------

function questionLabel({ match, d }) {
  const { open, phase } = d;
  if (open.stage === 'ended') return 'Match ended';
  if (open.stage === 'awaitingEnd') return 'Regulation over';
  const number = open.cycleId ? d.cycles.find(x => x.id === open.cycleId).number : d.cycles.length + 1;
  const bits = [`Q${number}`];
  if (open.stage === 'bonus') bits.push(`Bonus ${open.bonus.number}`);
  if (match.rules.trivia && phase.quarter) bits.push(`Quarter ${phase.quarter}`);
  return bits.join(' · ');
}

function phaseTag({ match, d }) {
  const { phase, open } = d;
  if (phase.ended) return phase.et ? 'Final (ET)' : 'Final';
  if (open.stage === 'awaitingEnd') return 'Regulation over';
  if (phase.overtime) return phase.overtime.mode === 'threeStarters' ? `Overtime ${phase.overtime.index} of 3` : 'Sudden death';
  if (match.markers.some(m => m.type === 'timeCalled')) return 'Time called';
  if (phase.lightning) return 'Lightning';
  return '';
}

function topBar(c) {
  const { state, api, match } = c;
  const small = (id, text, onclick, disabled = false) => h('button', { type: 'button', class: 'btn small', id, disabled, onclick }, text);
  return h('div', { class: 'top scoretop' },
    h('div', { class: 'toptitle' }, h('h1', { tabindex: '-1' }, questionLabel(c)),
      h('div', { class: 'info' }, [match.rules.name, phaseTag(c)].filter(Boolean).join(' · '))),
    clockSlot(c),
    h('div', { class: 'acts' },
      small('undo', 'Undo', event => { if (!justLeftEditor(state, event)) api.undo(); }, !state.history.canUndo()),
      small('redo', 'Redo', event => { if (!justLeftEditor(state, event)) api.redo(); }, !state.history.canRedo()),
      small('menu', 'Menu', () => openMenu(c))));
}

// ---- Format picker and starter types ---------------------------------------------------------

const hasEntry = cycle => cycle !== null && cycle !== undefined && (cycle.buzzes.length > 0 || cycle.lostTurn.length > 0 || cycle.streak.length > 0);

// Under trivia rules the Format box, Next clue and End quarter are one row at the top on a phone, and head the right column
// on a wider window (review 19/10/2026, change 11): the Format box's closed text names it ("Format: Normal").
function picker(c) {
  const { match, d, api, state } = c;
  const { open, phase } = d;
  const { rules } = match;
  const cycle = match.cycles.find(x => x.id === open.cycleId) ?? null;
  const editable = open.stage === 'starter';
  if (rules.trivia) {
    const box = select(formatOptions(rules), open.format, async value => {
      if (tapBlocked(state)) { box.value = open.format; return; }
      api.keepAwake();
      if (value !== 'split') { c.act({ type: 'format', format: value }, {}); return; }
      const eligible = await askSplit(c);
      if (eligible) c.act({ type: 'format', format: 'split', eligible }, {});
      else api.setUi({});
    }, { id: 'format', 'aria-label': 'Question format', disabled: !editable || hasEntry(cycle) });
    return h('div', { class: 'picker trivia', id: 'trivia-top' }, box,
      h('button', {
        type: 'button', class: 'btn', id: 'next-clue', disabled: !(editable && open.format === 'jackpot' && open.cycleId),
        onclick: c.tap(() => c.act({ type: 'nextClue' }, {})),
      }, 'Next clue'),
      h('button', {
        type: 'button', class: 'btn', id: 'end-quarter', disabled: !editable || phase.regulationOver,
        onclick: c.tap(() => endQuarterFlow(c)),
      }, 'End quarter'));
  }
  if (rules.starterTypes.on) {
    const current = cycle?.type ?? 'normal';
    return h('div', { class: 'picker' }, h('div', { class: 'chips', role: 'group', 'aria-label': 'Starter type' },
      ['normal', 'picture', 'music'].map(kind => h('button', {
        type: 'button', class: current === kind ? 'chip on' : 'chip', 'data-kind': kind, 'aria-pressed': String(current === kind), disabled: !editable,
        onclick: c.tap(() => { if (current !== kind) c.act({ type: 'starterType', kind }, {}); }),
      }, kind.charAt(0).toUpperCase() + kind.slice(1)))));
  }
  return null;
}

// A Split: tick one or two seats from each team, then OK. Asks again until the choice fits.
async function askSplit(c) {
  const { match, api } = c;
  const boxes = [0, 1].map(team => [0, 1, 2, 3].map(seat => {
    const named = c.who(team, seat) !== '';
    return check(named ? c.who(team, seat) : `Seat ${seat + 1} (empty)`, false, () => {}, { disabled: !named, 'data-team': team, 'data-seat': seat });
  }));
  const body = [h('p', { class: 'dtext' }, 'Tick one or two players from each team for this set. Only they may buzz.'),
    ...[0, 1].map(team => h('fieldset', { class: 'splitset' }, h('legend', {}, teamName(match, team)), boxes[team]))];
  const note = h('p', { class: 'msg' });
  body.push(note);
  for (;;) {
    const choice = await api.ask({ title: 'Split: who is on this set?', body, buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }] });
    if (choice !== 'ok') return null;
    const eligible = boxes.map(team => team.flatMap((label, seat) => (label.querySelector('input').checked ? [seat] : [])));
    if (eligible.every(seats => seats.length >= 1 && seats.length <= 2)) return eligible;
    note.textContent = 'Tick one or two players from each team.';
  }
}

// ---- Team columns ----------------------------------------------------------------------------

// Whether a seat can answer now: someone is in it, its team has a turn, it is not in jail, and a
// Split names it. The same test keys.js makes for the number keys, so a grey seat has a dead key.
function seatInfo(c, team, seat) {
  const { open } = c.d;
  const name = c.who(team, seat);
  const jailed = open.jailed?.[team]?.[seat] === true;
  let on = open.stage === 'starter' && open.liveTeams[team] && name !== '' && !jailed;
  if (on && open.format === 'split') on = open.eligible?.[team]?.includes(seat) === true;
  return { name, jailed, on };
}

function teamsView(c) {
  const { match, d, ui, api } = c;
  const seats = match.display?.seatOrder === 'desc' ? [3, 2, 1, 0] : [0, 1, 2, 3];
  return h('div', { class: 'teams' }, leftRight(match).map((team, column) => h('div', { class: 'team', 'data-team': team },
    h('div', { class: 'tname', title: teamName(match, team) }, h('span', { class: 'tn' }, teamName(match, team))),
    scoreHead(c, team),
    seats.map((seat, row) => {
      const info = seatInfo(c, team, seat);
      const on = ui.selected?.team === team && ui.selected?.seat === seat;
      // The points are the player's own, whoever sat in the seat before.
      const points = d.stats.players[team].find(player => player.id === c.seats[team][seat])?.tossupPoints ?? 0;
      return h('button', {
        type: 'button', class: on ? 'seat on' : 'seat', disabled: !info.on, 'aria-pressed': String(on), 'data-team': team, 'data-seat': seat,
        'aria-label': info.name ? `${teamName(match, team)}, seat ${seat + 1}, ${info.name}${info.jailed ? ', out' : ''}, ${points} points` : `${teamName(match, team)}, seat ${seat + 1}, empty`,
        onclick: c.tap(() => api.setUi({ selected: on ? null : { team, seat }, msg: '', streakN: 0, hint: null })),
      },
      h('span', { class: 'nm' }, h('span', { class: 'key' }, String(column * 4 + row + 1)), info.name ? `${info.name}${info.jailed ? ' (out)' : ''}` : 'Empty'),
      h('span', { class: 'pt' }, info.name ? fmt(points) : ''));
    }))));
}

// ---- Action bar (a starter) -----------------------------------------------------------------

const FORMAT_LINE = {
  doubleJump1: 'Double Jump 1st: either team may answer',
  doubleJump2: 'Double Jump 2nd: only the team that got the 1st, if one did',
  jailbreak: 'Jailbreak: a correct answer puts that player in jail',
  split: 'Split: only the seats that are on this set may buzz',
};

function formatLine({ match, d }) {
  const { open } = d;
  if (open.format === 'jackpot') return `Jackpot: clue ${open.clue + 1} of ${match.rules.trivia.jackpot.length}, worth ${open.clueValue}`;
  if (open.format === 'streak') return `Streak: ${match.rules.trivia.streak} points an answer; a wrong or repeated answer scores 0`;
  return FORMAT_LINE[open.format] ?? `${FORMATS[open.format] ?? open.format}: ${match.rules.tossup.ten} points`;
}

const promptLine = text => h('p', { class: 'hint', id: 'prompt' }, text || ' ');
// A key printed on its button in small grey text (review change 9), shown only with a mouse and the keys on.
const kk = key => h('span', { class: 'kk', 'aria-hidden': 'true' }, key);
const RESULT_KEYS = { power: 'P', ten: 'C', neg: 'N', wrong: 'W' };

function lostTurnButton(c, team, side) {
  const { match, d } = c;
  return h('button', {
    type: 'button', class: 'btn two', id: `lose-${side}`, 'data-team': team, disabled: !(d.open.stage === 'starter' && d.open.liveTeams[team]),
    'aria-label': `${teamName(match, team)} loses its turn`, onclick: c.tap(() => c.act({ type: 'lostTurn', team }, {})),
  }, h('span', {}, 'Lose turn', kk(side === 'left' ? '[' : ']')), h('span', { class: 'sub' }, teamName(match, team)));
}

function starterBar(c) {
  const { match, d, ui } = c;
  const { open } = d;
  const { rules } = match;
  const starter = open.stage === 'starter';
  const streak = open.format === 'streak';
  const sel = ui.selected ?? null;
  const who = sel ? c.who(sel.team, sel.seat) : '';
  // Two short teams in jail can leave nobody live: Dead stays on, so the scorer is never stuck.
  const stuck = starter && !open.liveTeams[0] && !open.liveTeams[1];
  const [leftTeam, rightTeam] = leftRight(match);
  const rows = [];

  if (streak) {
    const n = ui.streakN ?? 0;
    const value = rules.trivia.streak ?? 0;
    const turn = wrong => c.tap(() => c.act({ type: 'streak', team: sel.team, seat: sel.seat, answers: n, wrong }));
    const setN = next => c.tap(() => c.ui.streakN !== next && c.api.setUi({ streakN: next }));
    rows.push(
      // The prompt carries the format's line (no line of its own, so the Streak screen fits one window: review change 1).
      promptLine(starter ? (sel ? `${who}: how many answers, and how did the turn end?` : stuck ? 'Nobody can answer this one: tap Streak over' : `Streak, ${value} an answer: tap the seat that is naming answers`) : ''),
      h('div', { class: 'row', id: 'streak-count' },
        h('button', { type: 'button', class: 'btn', id: 'streak-minus', 'aria-label': 'One fewer answer', disabled: !sel || n <= 0, onclick: setN(Math.max(0, n - 1)) }, MINUS),
        h('button', { type: 'button', class: 'btn', id: 'streak-n', disabled: true }, `${n} ${n === 1 ? 'answer' : 'answers'}`),
        h('button', { type: 'button', class: 'btn', id: 'streak-plus', 'aria-label': 'One more answer', disabled: !sel || n >= STREAK_MAX, onclick: setN(Math.min(STREAK_MAX, n + 1)) }, '+')),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', id: 'streak-done', disabled: !sel || !starter, onclick: turn(false) }, `Done: ${n} x ${value}`),
        h('button', { type: 'button', class: 'btn', id: 'streak-wrong', disabled: !sel || !starter, onclick: turn(true) }, 'Wrong or repeat: 0')));
  } else {
    const ready = starter && sel !== null;
    const result = (kind, label, allowed = true) => h('button', {
      type: 'button', class: 'btn', 'data-result': kind, disabled: !(ready && allowed),
      onclick: c.tap(() => c.act({ type: 'buzz', team: sel.team, seat: sel.seat, result: kind })),
    }, label, kk(RESULT_KEYS[kind]));
    const tenLabel = String(open.clueValue ?? rules.tossup.ten);
    rows.push(
      promptLine(starter ? (sel ? `${who}: tap the result` : ui.hint ?? (stuck ? 'Nobody can answer this one: tap Dead' : 'Tap the seat that buzzed, then the result')) : ''),
      h('div', { class: 'row', id: 'results' },
        rules.tossup.power != null ? result('power', `Power ${rules.tossup.power}`, open.canPower) : null,
        result('ten', tenLabel),
        rules.trivia ? null : result('neg', `Neg ${fmt(rules.tossup.neg)}`),
        result('wrong', 'Wrong 0')));
  }
  rows.push(h('div', { class: 'row', id: 'others' },
    lostTurnButton(c, leftTeam, 'left'),
    h('button', { type: 'button', class: 'btn', id: 'dead', disabled: !starter, onclick: c.tap(() => c.act({ type: 'dead' })) }, streak ? 'Streak over' : 'Dead', kk('Space')),
    lostTurnButton(c, rightTeam, 'right')));

  if (rules.trivia && !streak) rows.push(h('p', { class: 'hint', id: 'formatline' }, formatLine(c)));
  return rows;
}

// ---- Bonus panel -----------------------------------------------------------------------------

function bonusPanel(c) {
  const { match, d } = c;
  const bonus = d.open.bonus;
  const { rules } = match;
  const bounce = rules.bonus.bounce != null;
  const ctrl = teamName(match, bonus.team);
  const other = teamName(match, 1 - bonus.team);
  const held = bonus.heldKind ? `Held ${bonus.heldKind} bonus. ` : '';
  const mark = (index, side, result, on) => c.tap(() => c.act({ type: 'part', index, side, result: on ? null : result }, {}));
  const button = (index, side, result, on, label, text, disabled = false) => h('button', {
    type: 'button', class: `btn ${result === 'got' ? 'got' : 'miss'}${on ? ' on' : ''}`, 'data-part': index, 'data-side': side, 'data-mark': result,
    'aria-pressed': String(on), 'aria-label': label, disabled, onclick: mark(index, side, result, on),
  }, text);
  const keyHints = ['J', 'K', 'L'];

  // A replacement bonus shows its floor and ceiling (v2 5.2) without a line of its own where there is no room for one: under
  // next unused in the repeat warning's fixed line, under paired numbering at the front of the head line.
  const bounds = boundsWords(d.cycles.find(x => x.id === d.open.cycleId)?.replacementBounds);
  const nextUnused = rules.bonus.numbering === 'nextUnused';
  const rows = [h('p', { class: 'bonushead', id: 'bonushead' }, nextUnused || !bounds ? '' : `${bounds}. `,
    `${held}Bonus ${bonus.number} for `, h('b', {}, ctrl), bounce ? `. A missed part goes to ${other}.` : '.')];
  // Under next unused a typed number can be one that was already played (v2 2.1): its warning has a
  // line of its own that is always there, empty or not, so no button moves when it appears.
  if (nextUnused) {
    rows.push(h('p', { class: 'hint', id: 'bonus-repeat', style: bonus.repeatOf === null ? null : 'color: var(--bad)' },
      [bonus.repeatOf === null ? '' : repeatText(bonus.number, bonus.repeatOf), bounds].filter(Boolean).join('. ')));
  }
  if (bounce) {
    rows.push(h('div', { class: 'part head bounce' }, h('span', {}), h('span', { style: 'grid-column: 2 / 4' }, ctrl), h('span', { style: 'grid-column: 4 / 6' }, `→ ${other}`)));
  }
  bonus.parts.forEach((part, index) => {
    const status = part.ctrl === 'passed' ? 'passed' : part.ctrl === 'unheard' ? 'cut off' : '';
    rows.push(h('div', { class: bounce ? 'part bounce' : 'part', 'data-row': index },
      h('span', { class: 'lab' }, `Part ${index + 1}`, keyHints[index] ? h('span', { class: 'kh' }, keyHints[index]) : null, status ? h('small', {}, status) : null),
      button(index, 'ctrl', 'got', part.ctrl === 'got', `Part ${index + 1}: ${ctrl} got it`, bounce ? '✓' : '✓ Got'),
      button(index, 'ctrl', 'missed', part.ctrl === 'missed', `Part ${index + 1}: ${ctrl} missed it`, bounce ? '✗' : '✗ Missed'),
      bounce ? button(index, 'other', 'got', part.other === 'got', `Part ${index + 1}: ${other} got it`, '✓', !part.offered) : null,
      bounce ? button(index, 'other', 'missed', part.other === 'missed', `Part ${index + 1}: ${other} missed it`, '✗', !part.offered) : null));
  });

  rows.push(h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn', id: 'all-got', onclick: c.tap(() => c.act({ type: 'allGot' }, {})) }, 'All got', kk('A')),
    h('button', { type: 'button', class: 'btn', id: 'none-got', onclick: c.tap(() => c.act({ type: 'noneGot' }, {})) }, 'None got'),
    h('button', { type: 'button', class: 'btn primary', id: 'bonus-done', onclick: c.tap(() => c.act({ type: 'closeBonus' }, {})) }, 'Done', kk('Enter'))));
  rows.push(h('div', { class: 'row' },
    h('button', { type: 'button', class: 'btn', id: 'bonus-number', onclick: c.tap(() => setBonusNumber(c)) }, 'Set number'),
    rules.bonus.passRest ? h('button', { type: 'button', class: 'btn', id: 'pass-rest', disabled: !bonus.canPassRest, onclick: c.tap(() => c.act({ type: 'passRest' }, {})) }, 'Pass rest') : null,
    !bounce ? h('button', { type: 'button', class: 'btn', id: 'enter-total', disabled: !bonus.canTotal, onclick: c.tap(() => enterBonusTotal(c)) }, 'Enter total') : null));
  return rows;
}

// A whole number typed in a dialog; asks again, with the reason, until it fits or is cancelled.
// Resolves the number, null for an empty box (when `empty` allows it), or undefined if cancelled.
async function askNumber(api, { title, text, initial, min, max, empty = false }) {
  const input = h('input', { type: 'number', inputmode: 'numeric', step: '1', min, max, 'aria-label': title });
  input.value = initial ?? '';
  const note = h('p', { class: 'msg' });
  for (;;) {
    const choice = await api.ask({ title, body: [text, input, note], buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: 'cancel' }] });
    if (choice !== 'ok') return undefined;
    const raw = input.value.trim();
    const number = Number(raw);
    if (raw === '' && empty) return null;
    if (raw === '' || !Number.isInteger(number)) note.textContent = 'Type a whole number.';
    else if (number < min || (max !== undefined && number > max)) note.textContent = max === undefined ? `Type a whole number from ${min} up.` : `Type a whole number from ${min} to ${max}.`;
    else return number;
  }
}

async function setBonusNumber(c) {
  const number = await askNumber(c.api, {
    title: 'Set bonus number', text: `The number shown for this bonus. Leave the box empty to go back to ${c.d.open.bonus.number}.`,
    initial: c.d.cycles.find(x => x.id === c.d.open.cycleId)?.bonusNumber, min: 1, empty: true,
  });
  if (number !== undefined) c.act({ type: 'bonusNumber', number }, {});
}

async function enterBonusTotal(c) {
  const max = c.d.open.bonus.parts.length * c.match.rules.bonus.partValue;
  const points = await askNumber(c.api, { title: 'Enter total', text: `Points the team scored on this bonus, from 0 to ${max}. The part marks are cleared.`, min: 0, max });
  if (points !== undefined) c.act({ type: 'bonusTotal', points }, {});
}

// ---- Flows from the action bar and menu ------------------------------------------------------

async function endQuarterFlow(c) {
  const choice = await c.api.ask({
    title: `End quarter ${c.d.phase.quarter}?`,
    body: ['Score check, to read out or copy:', ...copyLine(checkLine(c.match, c.d))],
    buttons: [{ label: 'End quarter', value: 'end', primary: true }, { label: 'Cancel', value: 'cancel' }],
  });
  if (choice === 'end') c.act({ type: 'endQuarter' });
}

// Halftime from the menu: asks first (Tom's decision 2), records it, then shows the score check. Once recorded, the menu
// item only shows the score check again.
async function halftimeFlow(c) {
  if (c.d.phase.halftimeAfterCycleId === null) {
    const last = c.d.cycles.at(-1);
    const choice = await c.api.ask({
      title: 'Halftime now?', body: `Halftime goes after Q${last?.number ?? 0}, and the score check follows. Undo takes it back.`,
      buttons: [{ label: 'Halftime', value: 'halftime', primary: true }, CANCEL],
    });
    if (choice !== 'halftime' || !c.act({ type: 'halftime' }, {})) return;
  }
  const match = c.state.match;
  const d = derive(match);
  closeHalftimeBox(match.id, d.phase.halftimeAfterCycleId);   // this dialog is the score check, so the box over the page does not follow it
  refreshClock(c.state, c.api);
  await c.api.ask({
    title: 'Halftime',
    body: ['Score check, to read out or copy:', ...copyLine(checkLine(match, d, d.phase.halftimeAfterCycleId)), backupButton(c.api)],
    buttons: [{ label: 'Close', value: 'cancel' }],
  });
}

// Time called (the G key and the menu). It always asks first (Tom's decision 2): with a seat chosen under rules where a
// buzz already in may answer, the question is whether the answer counts (spec 6.3); otherwise just whether to call time.
async function callTime(c) {
  const { match, d, ui, api } = c;
  const sel = ui.selected;
  let allowBuzz = false;
  if (sel && match.rules.atTime !== 'finishCycle' && d.open.stage === 'starter') {
    const choice = await api.ask({
      title: 'Time called with a buzz in',
      body: `${c.who(sel.team, sel.seat)} has buzzed in. Does the answer count?`,
      buttons: [{ label: 'Yes, the answer counts', value: 'allow', primary: true }, { label: 'No, it does not count', value: 'no' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'allow' && choice !== 'no') return;
    allowBuzz = choice === 'allow';
  } else {
    const choice = await api.ask({
      title: 'Call time?', body: 'This records that time has been called (the gong). Undo takes it back.',
      buttons: [{ label: 'Time called', value: 'time', primary: true }, CANCEL],
    });
    if (choice !== 'time') return;
  }
  c.act({ type: 'timeCalled', allowBuzz }, allowBuzz || match.rules.atTime === 'finishCycle' ? {} : { selected: null, streakN: 0 });
}

// End match. An open question with something entered cannot stay open (the engine refuses End match
// then), so it is closed in the same step: a starter is marked dead, a bonus is finished with its
// unmarked parts missed. One undo takes the whole step back.
async function endMatchFlow(c) {
  const { match, d, api } = c;
  const cycle = match.cycles.find(x => x.id === d.open.cycleId) ?? null;
  const actions = [];
  let simulated = match;
  const add = action => {
    simulated = applyAction(simulated, action, api.now());
    actions.push(action);
  };
  const body = [`Scores now: ${teamName(match, 0)} ${fmt(d.scores[0])}, ${teamName(match, 1)} ${fmt(d.scores[1])}.`];
  try {
    if (hasEntry(cycle)) {
      const number = d.cycles.find(x => x.id === cycle.id).number;
      if (d.open.stage === 'bonus') {
        add({ type: 'closeBonus' });
        if (derive(simulated).open.stage === 'bonus') add({ type: 'closeBonus' });
        body.push(`Q${number} is still on its bonus. Ending the match finishes it, with the parts not yet marked counted as missed.`);
      } else {
        add({ type: 'dead' });
        body.push(`Q${number} is still open. Ending the match marks it dead.`);
      }
    }
    add({ type: 'endMatch' });
  } catch (error) {
    c.say(refusalText(error));
    return;
  }
  body.push('You can undo this straight afterwards.');
  const choice = await api.ask({ title: 'End the match?', body, buttons: [{ label: 'End match', value: 'end', primary: true }, { label: 'Cancel', value: 'cancel' }] });
  if (choice === 'end') c.act(actions);
}

// "Timeout: <team>" from the menu. A team over the rules' limit is asked first, naming the rule (v2 3.3).
async function takeTimeout(c, team) {
  const { match } = c.state;
  const rules = clockRulesOf(match);
  if (rules.timeoutsPerTeam !== null && timeoutsUsed(match, team) >= rules.timeoutsPerTeam) {
    const n = rules.timeoutsPerTeam;
    const choice = await c.api.ask({
      title: 'Another timeout?',
      body: `${teamName(match, team)} has had its ${n} ${n === 1 ? 'timeout' : 'timeouts'}${rules.source ? ` (${rules.source})` : ''}. Record another?`,
      buttons: [{ label: 'Record', value: 'record' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'record') return;
  }
  c.act({ type: 'timeout', team }, {});
}

const CANCEL = { label: 'Cancel', value: 'cancel' };

// ---- Menu ------------------------------------------------------------------------------------

// The menu's panels are drawn by view-menu.js; this does what the chosen button says. The two settings in More are switched
// there, in place, and the screen is drawn again once the menu closes.
async function openMenu(c) {
  const { api } = c;
  const options = () => ({ keysOn: keysAreOn(), namesHidden: loadSettings().hideNames === true, updateReady: api.updateReady(), winFile: winMenuLine() });
  let toggled = false;
  const onToggle = value => {
    toggled = true;
    const settings = loadSettings();
    if (value === 'keys') saveSettings({ ...settings, singleKeys: !keysAreOn() });
    if (value === 'boardnames') saveSettings({ ...settings, hideNames: settings.hideNames !== true });
  };
  const choice = await showMenu(api, () => menuModel(c.state.match, derive(c.state.match), options()), onToggle);
  const { match } = c.state;
  const d = derive(match);
  const aim = d.open.cycleId ?? d.cycles.at(-1)?.id ?? null;   // Protest and Throw out act on the open question, else the last
  const now = makeContext(c.state, api);
  switch (choice) {
    case 'clock': return now.act({ type: 'clock', run: !clockRunning(match) }, {});
    case 'timeout0': return takeTimeout(now, 0);
    case 'timeout1': return takeTimeout(now, 1);
    case 'halftime': return halftimeFlow(now);
    case 'subs': return swapFlow(now);
    case 'protest': return protestFlow({ api, match, cycleId: aim });
    case 'throwout': return throwOutFlow({ api, match, cycleId: aim, patch: { selected: null, streakN: 0 }, say: now.say });
    case 'time': return callTime(now);
    case 'swap': return api.setDisplay({ leftTeam: 1 - leftRight(match)[0] });
    case 'reverse': return api.setDisplay({ seatOrder: match.display?.seatOrder === 'desc' ? 'asc' : 'desc' });
    case 'rules': return api.setUi({ sub: { kind: 'rules' }, selected: null });
    case 'sheet': return api.go('sheet');
    case 'print': case 'files': return api.go('sheet', { action: choice });
    case 'send': return api.sendMatch();
    case 'board': return openBoard(now);
    case 'end': return endMatchFlow(now);
    case 'home': return api.go('home');
    default: return toggled ? api.setUi({}) : undefined;
  }
}

function openBoard(c) {
  let opened = null;
  try { opened = window.open('./#board', 'scorer-board'); } catch { opened = null; }
  if (!opened) c.say('The room board could not open a window. Allow pop-ups, or open this page in a second tab and press Room board on Home.');
}
