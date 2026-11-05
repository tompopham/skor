// The scoring screen's side column on a laptop (from 900 px): the Keys list and Recent questions. The Keys list greys the
// rows whose keys do nothing at this stage (review 19/10/2026, change 9), and Recent questions is a box of its own that
// scrolls inside, with two-line rows, so the page never grows mid-match and no button moves (change 12). legendRows() and
// recentRows() are pure, for the tests; legend() and recentList() draw them.

import { FORMATS } from './engine.js';
import { lineupsOf, playerName } from './lineup.js';
import { h } from './dom.js';
import { fmt, teamName, leftRight, flagText } from './view-common.js';

const RESULT_WORDS = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };

// ---- Keys --------------------------------------------------------------------------------------

// Each row of the Keys list as { keys, text, live }: `live` is false where the key does nothing at this stage, the same
// tests keys.js makes (a starter, a bonus, time not yet called). `opts`: { canUndo, canRedo, keysOn }.
export function legendRows(match, d, { canUndo, canRedo, keysOn = true }) {
  const { rules } = match;
  const { open, phase } = d;
  const starter = keysOn && open.stage === 'starter';
  const answering = starter && open.format !== 'streak';
  const bonus = keysOn && open.stage === 'bonus';
  const timeLive = keysOn && !phase.ended && !phase.regulationOver && !match.markers.some(m => m.type === 'timeCalled');
  const rows = [['1–4, 5–8', 'Seats: left team, right team', answering]];
  if (rules.tossup.power != null) rows.push(['P', 'Power', answering]);
  rows.push(['C', 'Correct', answering]);
  if (!rules.trivia) rows.push(['N', 'Neg', answering]);
  rows.push(['W', 'Wrong', answering], ['Space', 'Dead question', starter], ['[  ]', 'Left, right team loses its turn', starter]);
  if (!rules.trivia && rules.bonus.parts > 0) {
    rows.push(['J K L', rules.bonus.bounce != null ? 'Bonus parts got (then the other team)' : 'Bonus parts got', bonus], ['A', 'All parts got', bonus], ['Enter', 'Close the bonus', bonus]);
  }
  if (rules.starterTypes.on) rows.push(['T', 'Change the starter type', starter]);
  rows.push(['G', 'Time called', timeLive], ['Ctrl/Cmd+Z', 'Undo', canUndo], ['Ctrl/Cmd+Shift+Z', 'Redo', canRedo], ['Esc', 'Cancel', starter]);
  return rows.map(([keys, text, live]) => ({ keys, text, live: Boolean(live) }));
}

export function legend(c, keysOn) {
  const { match, d, state } = c;
  const rows = legendRows(match, d, { canUndo: state.history.canUndo(), canRedo: state.history.canRedo(), keysOn });
  return h('div', {}, h('h2', {}, 'Keys'),
    keysOn ? null : h('p', { class: 'hint' }, 'Single-key shortcuts are off (Menu, then More). Undo and redo still work.'),
    h('dl', { class: 'legend', id: 'legend' }, rows.flatMap(row => [
      h('dt', { class: row.live ? null : 'off' }, row.keys), h('dd', { class: row.live ? null : 'off' }, row.text)])));
}

// ---- Recent questions --------------------------------------------------------------------------

// A short account of a cycle. `lineup` is the cycle's own (lineupsOf), so a buzz is named for the player who sat in the seat
// that question, whoever sits there now.
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

// The last ten questions, newest first: { id, q: 'Q5', run: '50 : −5' (left team first, a colon so a minus sign reads
// clearly), what, flags }.
export function recentRows(match, d) {
  const [left, right] = leftRight(match);
  const lineups = lineupsOf(match);
  return d.cycles.slice(-10).reverse().map(dc => ({
    id: dc.id, q: `Q${dc.number}`, run: `${fmt(dc.running[left])} : ${fmt(dc.running[right])}`,
    what: describe(match, match.cycles[dc.number - 1], dc, lineups[dc.number - 1]), flags: dc.flags.map(flagText).join('; '),
  }));
}

export function recentList(c) {
  const { match, d, api } = c;
  const rows = recentRows(match, d).map(row => h('button', {
    type: 'button', class: 'btn rc', 'data-cycle': row.id, onclick: () => api.setUi({ sub: { kind: 'cycle', cycleId: row.id }, selected: null }),
  },
  h('span', { class: 'rcline' }, h('span', { class: 'rq' }, row.q), h('span', { class: 'run' }, row.run)),
  h('span', { class: 'what' }, row.what),
  row.flags ? h('span', { class: 'flag' }, row.flags) : null));
  return h('div', { class: 'recentbox' }, h('h2', {}, 'Recent questions'),
    h('div', { class: 'recent', id: 'recent' }, rows.length > 0 ? rows : h('p', { class: 'hint' }, 'None yet.')));
}
