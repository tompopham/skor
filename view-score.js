// The scoring screen (spec 6.3): the top bar, two team columns with their seats, the action bar and
// the bonus panel, the trivia controls (spec 5.1), the menu, the phase banners and the laptop keys.
// It hands the screen to view-editor.js for the cycle editor and Edit rules (state.ui.sub). Everything
// is drawn from derive() of the match; every change goes through api.dispatch, so the engine alone
// decides what is allowed and this file only shows the refusal. The clock's slot in the top bar, the
// banner at 0:00 and the timeout box (v2 3.3) are here too: they show what clock.js works out from the
// record at api.now(), and the one 1 s ticker only repaints their text. Who sits in a seat is the line-up's
// (v2 4.4; lineup.js): the seat buttons show the player sitting now, the recent list the player who sat in
// each question, and the menu's Swap players asks for the team, the seat and who comes in. The menu's Protest and Throw
// out (v2 5) start the dialogs in view-protest.js, which also words the bonus panel's floor and ceiling after a bonus throw-out.

import { derive, applyAction, FORMATS } from './engine.js';
import { keyToCommand, tapGuard, sittingNow } from './keys.js';
import { lineupsOf, playersOf, playerName } from './lineup.js';
import { loadSettings, saveSettings } from './storage.js';
import { resultLine } from './files.js';
import { clockRunning, played, countdownState, defaultClockRules, timeoutsUsed, timeSummary, formatLength } from './clock.js';
import { unlockSound, gong, beep } from './sound.js';
import { h } from './dom.js';
import {
  fmt, MINUS, teamName, leftRight, flagText, repeatText, refusalText, STREAK_MAX, triviaFormats, select, check, copyText,
} from './view-common.js';
import { renderCycleEditor, renderRulesEditor } from './view-editor.js';
import { protestFlow, throwOutFlow, boundsWords } from './view-protest.js';
import { menuModel, showMenu } from './view-menu.js';

// ---- Words and numbers -----------------------------------------------------------------------

const RESULT_WORDS = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };
const hasEntry = cycle => cycle !== null && cycle !== undefined && (cycle.buzzes.length > 0 || cycle.lostTurn.length > 0 || cycle.streak.length > 0);

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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tickClock(); });
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
  if (command.select) api.setUi({ selected: command.select, msg: '', streakN: 0 });
  else if (command.ui === 'undo') api.undo();
  else if (command.ui === 'redo') api.redo();
  else if (command.ui === 'cancel') api.setUi({ selected: null, msg: '', streakN: 0 });
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

// ---- Small builders --------------------------------------------------------------------------

// A line to read out or paste, in a box that can be selected, with a Copy button.
function copyLine(text) {
  const input = h('input', { readonly: true, 'aria-label': 'Score check line', class: 'copytext' });
  input.value = text;
  input.addEventListener('focus', () => input.select());
  const button = h('button', { type: 'button', class: 'btn' }, 'Copy');
  button.addEventListener('click', async () => {
    button.textContent = await copyText(text, input) ? 'Copied' : 'Select the line and copy it';
  });
  return h('div', { class: 'copyline' }, input, button);
}

const backupButton = api => h('button', { type: 'button', class: 'btn', id: 'backup-now', onclick: () => api.offerBackup() }, 'Save a backup file');

// "Edinburgh A 140, Glasgow 95 after 10": the scores after a cycle, the left team first like the files.
function checkLine(match, d, cycleId = null) {
  const done = cycleId ? d.cycles.find(x => x.id === cycleId) : d.cycles.filter(x => x.closed).at(-1);
  const running = done ? done.running : [0, 0];
  const [left, right] = leftRight(match);
  return `${teamName(match, left)} ${fmt(running[left])}, ${teamName(match, right)} ${fmt(running[right])} after ${done ? done.number : 0}`;
}

// A short account of a cycle for the recent list. `lineup` is the cycle's own (lineupsOf), so a buzz is named for the
// player who sat in the seat that question, whoever sits there now.
function describe(match, cycle, dc, lineup) {
  const bits = [];
  if (match.rules.trivia) bits.push(`[${FORMATS[dc.format] ?? dc.format}]`);
  else if (match.rules.starterTypes.on && cycle.type !== 'normal') bits.push(`[${cycle.type}]`);
  const name = (team, seat) => playerName(match, team, lineup[team][seat]) || `seat ${seat + 1}`;
  cycle.buzzes.forEach(b => bits.push(`${name(b.team, b.seat)} ${RESULT_WORDS[b.result]}${dc.format === 'jackpot' ? ` clue ${(b.clue ?? 0) + 1}` : ''}`));
  dc.streak.forEach(s => bits.push(`${name(s.team, s.seat)} streak ${s.answers}${s.wrong ? ' wrong' : ''}`));
  cycle.lostTurn.forEach(t => bits.push(`${teamName(match, t)} lost turn`));
  if (cycle.dead) bits.push('dead');
  else if (bits.length === 0) bits.push('open');
  if (dc.bonusNumber !== null) bits.push(`bonus ${dc.ownBonus[0] + dc.ownBonus[1] + dc.bounce[0] + dc.bounce[1]}`);
  return bits.join(', ');
}

// ---- The screen ------------------------------------------------------------------------------

export function renderScore(root, state, api) {
  listen(state, api);
  const sub = state.ui.sub;
  if (sub?.kind === 'cycle' && state.match.cycles.some(cycle => cycle.id === sub.cycleId)) renderCycleEditor(root, state, api);
  else if (sub?.kind === 'rules') renderRulesEditor(root, state, api);
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
    h('div', { class: 'score-layout' },
      h('div', { class: 'main', 'data-stage': d.open.stage },
        h('p', { class: ui.msg ? 'statusline err' : 'statusline', id: 'statusline', role: 'status' }, ui.msg || d.lastEvent),
        picker(c),
        teamsView(c),
        h('div', { class: 'bar', id: 'bar' }, d.open.stage === 'bonus' ? bonusPanel(c) : starterBar(c)),
        banners(c)),
      h('aside', { class: 'side' }, legend(c), recentList(c))));
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

function picker(c) {
  const { match, d, api, state } = c;
  const { open } = d;
  const { rules } = match;
  const cycle = match.cycles.find(x => x.id === open.cycleId) ?? null;
  const editable = open.stage === 'starter';
  if (rules.trivia) {
    const box = select(triviaFormats(rules), open.format, async value => {
      if (tapBlocked(state)) { box.value = open.format; return; }
      api.keepAwake();
      if (value !== 'split') { c.act({ type: 'format', format: value }, {}); return; }
      const eligible = await askSplit(c);
      if (eligible) c.act({ type: 'format', format: 'split', eligible }, {});
      else api.setUi({});
    }, { id: 'format', 'aria-label': 'Question format', disabled: !editable || hasEntry(cycle) });
    return h('div', { class: 'picker' }, h('label', {}, h('span', {}, 'Format'), box));
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
    h('div', { class: 'score', 'data-score': team }, fmt(d.scores[team])),
    seats.map((seat, row) => {
      const info = seatInfo(c, team, seat);
      const on = ui.selected?.team === team && ui.selected?.seat === seat;
      // The points are the player's own, whoever sat in the seat before.
      const points = d.stats.players[team].find(player => player.id === c.seats[team][seat])?.tossupPoints ?? 0;
      return h('button', {
        type: 'button', class: on ? 'seat on' : 'seat', disabled: !info.on, 'aria-pressed': String(on), 'data-team': team, 'data-seat': seat,
        'aria-label': info.name ? `${teamName(match, team)}, seat ${seat + 1}, ${info.name}${info.jailed ? ', out' : ''}, ${points} points` : `${teamName(match, team)}, seat ${seat + 1}, empty`,
        onclick: c.tap(() => api.setUi({ selected: on ? null : { team, seat }, msg: '', streakN: 0 })),
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

function lostTurnButton(c, team, side) {
  const { match, d } = c;
  return h('button', {
    type: 'button', class: 'btn two', id: `lose-${side}`, 'data-team': team, disabled: !(d.open.stage === 'starter' && d.open.liveTeams[team]),
    'aria-label': `${teamName(match, team)} loses its turn`, onclick: c.tap(() => c.act({ type: 'lostTurn', team }, {})),
  }, h('span', {}, 'Lose turn'), h('span', { class: 'sub' }, teamName(match, team)));
}

function starterBar(c) {
  const { match, d, ui } = c;
  const { open, phase } = d;
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
    }, label);
    const tenLabel = String(open.clueValue ?? rules.tossup.ten);
    rows.push(
      promptLine(starter ? (sel ? `${who}: tap the result` : stuck ? 'Nobody can answer this one: tap Dead' : 'Tap the seat that buzzed, then the result') : ''),
      h('div', { class: 'row', id: 'results' },
        rules.tossup.power != null ? result('power', `Power ${rules.tossup.power}`, open.canPower) : null,
        result('ten', tenLabel),
        rules.trivia ? null : result('neg', `Neg ${fmt(rules.tossup.neg)}`),
        result('wrong', 'Wrong 0')));
  }
  rows.push(h('div', { class: 'row', id: 'others' },
    lostTurnButton(c, leftTeam, 'left'),
    h('button', { type: 'button', class: 'btn', id: 'dead', disabled: !starter, onclick: c.tap(() => c.act({ type: 'dead' })) }, streak ? 'Streak over' : 'Dead'),
    lostTurnButton(c, rightTeam, 'right')));

  if (rules.trivia) {
    rows.push(
      streak ? null : h('p', { class: 'hint', id: 'formatline' }, formatLine(c)),
      h('div', { class: 'row', id: 'trivia-row' },
        h('button', {
          type: 'button', class: 'btn', id: 'next-clue', disabled: !(starter && open.format === 'jackpot' && open.cycleId),
          onclick: c.tap(() => c.act({ type: 'nextClue' }, {})),
        }, 'Next clue'),
        h('button', {
          type: 'button', class: 'btn', id: 'end-quarter', disabled: !starter || phase.regulationOver,
          onclick: c.tap(() => endQuarterFlow(c)),
        }, 'End quarter')));
  }
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
    h('button', { type: 'button', class: 'btn', id: 'all-got', onclick: c.tap(() => c.act({ type: 'allGot' }, {})) }, 'All got'),
    h('button', { type: 'button', class: 'btn', id: 'none-got', onclick: c.tap(() => c.act({ type: 'noneGot' }, {})) }, 'None got'),
    h('button', { type: 'button', class: 'btn primary', id: 'bonus-done', onclick: c.tap(() => c.act({ type: 'closeBonus' }, {})) }, 'Done')));
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
    body: ['Score check, to read out or copy:', copyLine(checkLine(c.match, c.d))],
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
  await c.api.ask({
    title: 'Halftime',
    body: ['Score check, to read out or copy:', copyLine(checkLine(match, d, d.phase.halftimeAfterCycleId)), backupButton(c.api)],
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

// ---- The clock (v2 3.3) ----------------------------------------------------------------------
// The top bar has a fixed slot for the clock, so no button moves whatever it says. Without a countdown it shows
// the time since the clock first started ("12:34", "0:00" before). With one it is a button: "Start clock" before
// the first start, then the time left ("3:21 left"), "Paused" while stopped and "+0:12" once over; a tap starts
// or pauses the clock. When the match has ended it shows the game's length and stops. Every figure is worked out
// from the record at api.now() (v2 1.3, 1.8), never by counting ticks, so a locked phone or a reload still
// reads right. The one 1 s ticker repaints the slot's text and the overlays; it never redraws the screen.

const clockRulesOf = match => ({ ...defaultClockRules(), ...match.rules.clock });

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

function clockSlot(c) {
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
// only ever added, repainted or removed: no button moves, and a tap on Close is never lost to a redraw.
function buildBox(box, state, api) {
  const close = h('button', {
    type: 'button', class: 'btn', id: box.closeId,
    onclick: () => { timeUi.closed.add(box.key); refreshClock(state, api); },
  }, 'Close');
  if (box.id === 'time-banner') {
    return h('div', { class: 'timebox', id: box.id, 'data-key': box.key, role: 'status' }, h('span', { class: 'timetext' }, box.text), close);
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
    }
  }
  const order = wanted.map(box => box.id);
  if ([...layer.children].map(el => el.id).join() !== order.join()) for (const id of order) layer.append(document.getElementById(id));
}

// Reads the clock once: repaints the slot's text, rings the gong if its time has come, and shows or removes the
// banner and the timeout box (not above the cycle or rules editor, which the boxes would sit over).
function refreshClock(state, api) {
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
  syncTimeLayer(state, api, state.ui.sub ? [] : [timeoutBox(match, now), bannerBox(match, d, now)].filter(Boolean));
}

const ticker = { timer: null, live: null };

function tickClock() {
  const live = ticker.live;
  if (!live) return;
  if (live.state.screen !== 'score' || !live.state.match) stopClockTicker();
  else refreshClock(live.state, live.api);
}

function startClockTicker(state, api) {
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

// ---- Swap players (v2 4.4) -------------------------------------------------------------------
// Menu, Swap players: the team, the seat, then who comes in (a bench player or a starter who is not sitting, the
// seat left empty, or a new name typed in, which joins the bench). Each step is a dialog, and Cancel or the back
// button on any of them ends it with nothing recorded. A new name is added to the bench and swapped in as one
// version, so one Undo takes both back. The engine alone decides: a swap outside the rules' windows comes back
// refused with the rules' words, the page asks, and Record sends it again as confirmed.

const WINDOW_WORDS = { halftime: 'at halftime', beforeOvertime: 'before overtime', timeout: 'after a timeout', quarter: 'between quarters' };
const CANCEL = { label: 'Cancel', value: 'cancel' };

// "UK quizbowl allows swaps only at halftime or before overtime (ACF C.12). Record it anyway?" The bracket is left
// out when the rules cite no clause, and rules with no window at all say so.
function outsideWindowText(match, { windows, source }) {
  const name = match.rules.name || 'These rules';
  const clause = source ? ` (${source})` : '';
  const words = (windows ?? []).map(kind => WINDOW_WORDS[kind] ?? kind);
  if (words.length === 0) return `${name} has no swap window${clause}. Record it anyway?`;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
  return `${name} allows swaps only ${list}${clause}. Record it anyway?`;
}

// The name of a player who is not on the bench yet, typed in a box; asks again until there is one. undefined if cancelled.
async function askNewName(api) {
  const input = h('input', {
    type: 'text', maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false', 'aria-label': "New player's name",
  });
  const note = h('p', { class: 'msg' });
  for (;;) {
    const choice = await api.ask({
      title: 'New player', body: ['The new player joins the bench and takes the seat.', input, note],
      buttons: [{ label: 'Swap in', value: 'ok', primary: true }, CANCEL],
    });
    if (choice !== 'ok') return undefined;
    const name = input.value.trim();
    if (name !== '') return name;
    note.textContent = 'Type a name.';
  }
}

async function swapFlow(c) {
  const { match, api } = c;
  const teamChoice = await api.ask({
    title: 'Swap players: which team?',
    buttons: [...leftRight(match).map(t => ({ label: teamName(match, t), value: `team${t}` })), CANCEL],
  });
  if (teamChoice !== 'team0' && teamChoice !== 'team1') return;
  const team = Number(teamChoice.slice(4));

  const seatChoice = await api.ask({
    title: `Swap players: ${teamName(match, team)}, which seat?`,
    buttons: [...[0, 1, 2, 3].map(seat => ({ label: `Seat ${seat + 1}: ${c.who(team, seat) || 'empty'}`, value: `seat${seat}` })), CANCEL],
  });
  if (!/^seat[0-3]$/.test(seatChoice ?? '')) return;
  const seat = Number(seatChoice.slice(4));

  // Everyone the team has who is not in a seat now: the bench, and starters who have gone off. A name used twice says which is which.
  const candidates = playersOf(match, team).filter(p => !c.seats[team].includes(p.id));
  const label = p => (candidates.filter(other => other.name === p.name).length > 1
    ? `${p.name} (${p.seat === null ? 'bench' : `started in seat ${p.seat + 1}`})` : p.name);
  const here = c.who(team, seat);
  const who = await api.ask({
    title: `Seat ${seat + 1}: who comes in?`,
    body: here ? `${here} is in seat ${seat + 1} now.` : `Seat ${seat + 1} is empty.`,
    buttons: [
      ...candidates.map(p => ({ label: label(p), value: `player:${p.id}` })),
      { label: 'Leave the seat empty', value: 'empty', disabled: here === '' },
      { label: 'Someone new', value: 'new' }, CANCEL,
    ],
  });
  let player = null;
  let name;
  if (who === 'new') {
    name = await askNewName(api);
    if (name === undefined) return;
    player = `b${(match.teams[team].bench ?? []).length}`;
  } else if (typeof who === 'string' && who.startsWith('player:')) player = who.slice('player:'.length);
  else if (who !== 'empty') return;

  const swap = { type: 'sub', team, seat, player };
  const actions = name === undefined ? [swap] : [{ type: 'addBench', team, name }, swap];
  const patch = { selected: null, streakN: 0 };
  let result = api.dispatchAll(actions, patch);
  if (!result.ok && result.error.code === 'outside-window') {
    const choice = await api.ask({
      title: 'Swap outside the window?', body: outsideWindowText(match, result.error),
      buttons: [{ label: 'Record', value: 'record' }, CANCEL],
    });
    if (choice !== 'record') return;
    result = api.dispatchAll(actions.map(action => (action.type === 'sub' ? { ...action, confirmed: true } : action)), patch);
  }
  if (!result.ok) c.say(refusalText(result.error));
}

// ---- Menu ------------------------------------------------------------------------------------

// The menu's panels are drawn by view-menu.js; this does what the chosen button says. The two settings in More are switched
// there, in place, and the screen is drawn again once the menu closes.
async function openMenu(c) {
  const { api } = c;
  const options = () => ({ keysOn: keysAreOn(), namesHidden: loadSettings().hideNames === true, updateReady: api.updateReady() });
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
    case 'print': return api.go('sheet', { action: 'print' });
    case 'files': return api.go('sheet', { action: 'files' });
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

// ---- Banners (phase announcements), below the action bar so nothing above them moves ---------

function banner(title, lines, ...extras) {
  return h('div', { class: 'banner' }, h('b', {}, title), [lines].flat().map(text => h('p', {}, text)), ...extras);
}

function banners(c) {
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
        h('button', { type: 'button', class: 'btn primary', id: 'banner-end', onclick: () => endMatchFlow(c) }, 'End match')));
    } else if (phase.overtime) {
      const text = phase.overtime.mode === 'threeStarters'
        ? `Overtime: the scores are level. Three starters with no bonuses, then sudden death. This is starter ${phase.overtime.index} of 3.`
        : 'Overtime: the scores are level. Sudden death, with no bonuses: the first score that breaks the tie ends the match.';
      out.push(banner('Overtime', text));
    } else if (match.markers.some(m => m.type === 'timeCalled')) {
      out.push(banner('Time called', open.afterTimeBuzz ? 'One buzz already in may still be answered. Score it, or mark the question dead.' : 'Finish the question that is open. No new question follows unless the scores are level.'));
    }
    if (phase.lightning && !phase.regulationOver) out.push(banner('Lightning section', 'Bonus rounds are over. Score as normal until time is called (these rules are unverified).'));
    if (last && phase.halftimeAfterCycleId === last.id) {
      out.push(banner('Halftime', 'Score check, to read out or copy:', copyLine(checkLine(match, d, last.id)), backupButton(api)));
    }
    if (rules.trivia && markerHere('quarter')) {
      const quarters = match.markers.filter(m => m.type === 'quarter').length;
      out.push(banner(`Quarter ${quarters} ended`, 'Score check, to read out or copy:', copyLine(checkLine(match, d, last.id)), backupButton(api)));
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

// ---- Laptop side: key legend and recent questions --------------------------------------------

function legend(c) {
  const { match } = c;
  const { rules } = match;
  const items = [['1–4, 5–8', 'Seats: left team, right team']];
  if (rules.tossup.power != null) items.push(['P', 'Power']);
  items.push(['C', 'Correct']);
  if (!rules.trivia) items.push(['N', 'Neg']);
  items.push(['W', 'Wrong'], ['Space', 'Dead question'], ['[  ]', 'Left, right team loses its turn']);
  if (!rules.trivia && rules.bonus.parts > 0) {
    items.push(['J K L', rules.bonus.bounce != null ? 'Bonus parts got (then the other team)' : 'Bonus parts got'], ['A', 'All parts got'], ['Enter', 'Close the bonus']);
  }
  if (rules.starterTypes.on) items.push(['T', 'Change the starter type']);
  items.push(['G', 'Time called'], ['Ctrl/Cmd+Z', 'Undo'], ['+ Shift', 'Redo'], ['Esc', 'Cancel']);
  return h('div', {}, h('h2', {}, 'Keys'),
    keysAreOn() ? null : h('p', { class: 'hint' }, 'Single-key shortcuts are off (Menu, then More). Undo and redo still work.'),
    h('dl', { class: 'legend', id: 'legend' }, items.flatMap(([keys, text]) => [h('dt', {}, keys), h('dd', {}, text)])));
}

function recentList(c) {
  const { match, d, api } = c;
  const [left, right] = leftRight(match);
  const lineups = lineupsOf(match);
  const rows = d.cycles.slice(-10).reverse().map(dc => h('button', {
    type: 'button', class: 'btn rc', 'data-cycle': dc.id, onclick: () => api.setUi({ sub: { kind: 'cycle', cycleId: dc.id }, selected: null }),
  },
  h('span', { class: 'what' }, `Q${dc.number} ${describe(match, match.cycles[dc.number - 1], dc, lineups[dc.number - 1])}`),
  h('span', { class: 'run' }, `${fmt(dc.running[left])}–${fmt(dc.running[right])}`),
  dc.flags.length > 0 ? h('span', { class: 'flag' }, dc.flags.map(flagText).join('; ')) : null));
  return h('div', { class: 'recent', id: 'recent' }, h('h2', {}, 'Recent questions'),
    rows.length > 0 ? rows : h('p', { class: 'hint' }, 'None yet.'));
}

