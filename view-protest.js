// Protests and thrown-out questions on the screens (v2 5.1, 5.2). Three things live here, so that view-score.js stays
// under 1,000 lines:
//  - the words: a protest's line, a thrown-out question's line and the bonus bounds line. They are pure functions of the
//    record and derive(), and files.js uses them for the scoresheet, its file and the CSV, so they also run under Node;
//  - the two dialogs the menu and the cycle editor both start, protestFlow and throwOutFlow. Each is built with api.ask like
//    the swap flow, asks, sends one action and shows the engine's refusal; Cancel and the back button end it with nothing
//    recorded. The engine alone decides what is allowed (protests.js);
//  - a protest's controls, a status select and Copy for Discord, which the cycle editor and the scoresheet both put under a
//    protest, and the editor's two cards (editorCards).
// A protest never changes a score (v2 1.4): an Upheld one only says to fix the question with Edit.

import { derive } from './engine.js';
import { h } from './dom.js';
import { lineupAt, lineupsOf, playersOf, playerName } from './lineup.js';
import { PROTEST_STATUSES, STATUS_WORDS, protestText } from './protests.js';
import { copyText, ensureStyles, field, leftRight, refusalText, teamName } from './view-common.js';

// ---- Words ------------------------------------------------------------------------------------

const RESULT_WORDS = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };
const isCorrect = buzz => buzz.result === 'power' || buzz.result === 'ten';
// A line as pieces: ['name', text] for a name or the typed words (the files isolate and escape those) and ['text', text]
// for the rest, so the plain line is the pieces joined.
const plain = pieces => pieces.map(([, text]) => text).join('');
const joined = (segments, between) => segments.flatMap((segment, i) => (i === 0 ? segment : [['text', between], ...segment]));

// "Q14 tossup" or "Q14 bonus 12, part 2" (no number when the cycle has none): the question words of protestText's third line.
export const questionWords = (dc, part) => (part === 'tossup'
  ? `Q${dc.number} tossup`
  : `Q${dc.number} bonus${dc.bonusNumber === null ? '' : ` ${dc.bonusNumber}`}, part ${part}`);

// "Replacement bonus: floor 10, ceiling 20" from a cycle's replacementBounds, or '' when it has none.
export const boundsWords = bounds => (bounds ? `Replacement bonus: floor ${bounds.floor}, ceiling ${bounds.ceiling}` : '');

// Every protest in the record, in question order: { cycleId, index, protest }.
export const allProtests = match => match.cycles.flatMap(cycle => (cycle.protests ?? []).map((protest, index) => ({ cycleId: cycle.id, index, protest })));

// A protest's line (Task 7 ruling 5): "Q14 tossup: Team A (Smith), 10 points at stake. Open. The reason", with " (Smith)" left out
// when no player is named and the reason when there is none. [] when the cycle or the protest is not there.
export function protestPieces(match, d, cycleId, index) {
  const dc = d.cycles.find(c => c.id === cycleId);
  const given = match.cycles.find(c => c.id === cycleId)?.protests?.[index];
  if (!dc || !given) return [];
  const who = playerName(match, given.team, given.player);
  const reason = typeof given.text === 'string' ? given.text.trim() : '';
  return [
    ['text', `${questionWords(dc, given.part)}: `], ['name', teamName(match, given.team)],
    ...(who === '' ? [] : [['text', ' ('], ['name', who], ['text', ')']]),
    ['text', `, ${given.points} ${given.points === 1 ? 'point' : 'points'} at stake. ${STATUS_WORDS[given.status] ?? given.status}.`],
    ...(reason === '' ? [] : [['text', ' '], ['name', reason]]),
  ];
}
export const protestLine = (match, d, cycleId, index) => plain(protestPieces(match, d, cycleId, index));

// What a thrown-out bonus set scored: the controlling team's own parts (or its typed total), the other team's bounce-backs and the
// sweep reward, worked out by the engine. A set is a fact from the moment it was thrown out, so it is scored on its own, on a copy of
// the match holding one blank question that a made-up correct buzz has answered and that carries this set; nothing on the cycle as it
// is now (a tossup thrown out since, an edit that took the correct buzz away) can change the figure. The made-up buzz is team 0's,
// which is the same as the real team's: the figure adds both teams' parts, so it does not depend on who controlled the set.
// 0 for a set that is not there.
function setWorth(match, set) {
  if (!set) return 0;
  const cycle = {
    id: 'c1', type: 'normal', format: 'normal', clue: 0, streak: [], eligible: null, buzzes: [{ team: 0, seat: 0, result: 'ten' }],
    lostTurn: [], dead: false, noBonus: false, bonus: set, bonusNumberOverride: null, allowAfterTime: null, note: '', protests: [], thrownOut: [],
  };
  const scored = derive({ ...match, markers: [], clock: [], cycles: [cycle] }).cycles[0];
  return [0, 1].reduce((sum, team) => sum + scored.ownBonus[team] + scored.bounce[team] + scored.reward[team], 0);
}

function buzzWords(rules, buzz, format) {
  const word = RESULT_WORDS[buzz.result] ?? buzz.result;
  if (format !== 'jackpot') return word;
  const clue = buzz.clue ?? 0;
  return isCorrect(buzz) ? `jackpot clue ${clue + 1} (${rules.trivia?.jackpot?.[clue] ?? word})` : `jackpot clue ${clue + 1}, ${word}`;
}

// The words after "Thrown out: " for one entry of a cycle's `thrownOut`, as pieces. A bonus throw-out: "bonus 20", then ", part 2
// went wrong" when a part was named. A tossup throw-out: the original's entries that were not kept, worded as the sheet words
// them (the player who sat in the seat that question and the result, "<team> lost its turn", "dead"), then "bonus 30" when its
// bonus was played. A kept team's buzz and lost turn show only on the live line; with nothing else entered the words are "the tossup".
function thrownOutWords(match, entry, lineup) {
  const { original, keepTeam = null, badPart = null } = entry;
  if (entry.part === 'bonus') return [['text', `bonus ${setWorth(match, original?.bonus)}${badPart === null ? '' : `, part ${badPart} went wrong`}`]];
  const buzzes = original?.buzzes ?? [];
  const sitter = (team, seat) => playerName(match, team, lineup[team][seat]) || `seat ${seat + 1}`;
  const streakValue = match.rules.trivia?.streak ?? 0;
  const segments = [
    ...buzzes.filter(b => b.team !== keepTeam).map(b => [['name', sitter(b.team, b.seat)], ['text', ` ${buzzWords(match.rules, b, original.format)}`]]),
    ...(original?.streak ?? []).map(s => [['name', sitter(s.team, s.seat)], ['text', ` streak ${s.answers}${s.wrong ? ', wrong' : ` (${s.answers * streakValue})`}`]]),
    ...(original?.lostTurn ?? []).filter(team => team !== keepTeam).map(team => [['name', teamName(match, team)], ['text', ' lost its turn']]),
    ...(original?.dead ? [[['text', 'dead']]] : []),
  ];
  if (original?.bonus && !original.noBonus && buzzes.some(isCorrect)) segments.push([['text', `bonus ${setWorth(match, original.bonus)}`]]);
  return segments.length === 0 ? [['text', 'the tossup']] : joined(segments, ', ');
}

// One line a thrown-out entry, in question order: { cycleId, number, entryIndex, pieces, text }, `text` being "Thrown out: ...".
export function thrownOutLines(match, d) {
  const lineups = lineupsOf(match);
  return match.cycles.flatMap((cycle, at) => (cycle.thrownOut ?? []).map((entry, entryIndex) => {
    const pieces = [['text', 'Thrown out: '], ...thrownOutWords(match, entry, lineups[at])];
    return { cycleId: cycle.id, number: d.cycles[at].number, entryIndex, pieces, text: plain(pieces) };
  }));
}

// ---- Style ------------------------------------------------------------------------------------

const CSS = `
.protestform { display: grid; gap: 8px; min-width: 0; }
.protestform select { min-height: 48px; }
.protestform textarea { min-height: 72px; resize: vertical; }
.protestlist { display: grid; gap: 10px; }
.protest { overflow-wrap: anywhere; }
.pctl { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
.pctl select { flex: 1 1 140px; width: auto; min-height: 48px; }
.pctl .btn { flex: none; }
.pctl .pcopybox { flex: 1 1 100%; min-height: 96px; }
.thrownlist { display: grid; gap: 4px; }
#ed-throw-hint { min-height: 20px; }
`;

// ---- The dialogs ------------------------------------------------------------------------------

const CANCEL = { label: 'Cancel', value: 'cancel' };
const parts = count => Array.from({ length: count }, (_, i) => i + 1);

// How many bonus parts a protest can name on this cycle: the rules' parts when it has a bonus, or had one thrown out (with the
// bonus, or with its tossup); none otherwise, and then only the tossup can be protested.
const bonusPartsOf = (match, cycle) => (cycle.bonus || (cycle.thrownOut ?? []).some(entry => entry.part === 'bonus' || entry.original?.bonus) ? match.rules.bonus.parts : 0);

// The players a team's protest can name, in the order the form lists them: those who sat in this question (by seat), then the rest.
function whoCanProtest(match, index, team) {
  const all = playersOf(match, team);
  const sat = lineupAt(match, index)[team].flatMap(id => all.filter(player => player.id === id));
  const label = player => (all.filter(other => other.name === player.name).length > 1
    ? `${player.name} (${player.seat === null ? 'bench' : `started in seat ${player.seat + 1}`})` : player.name);
  return [...sat, ...all.filter(player => !sat.includes(player))].map(player => [player.id, label(player)]);
}

// Protest: the team, the part, then one form. Resolves whether a protest was recorded. The form asks again, with the reason,
// until it is recorded or cancelled; the choices, the fields and the dialog all end with nothing recorded on Cancel or Back.
export async function protestFlow({ api, match, cycleId }) {
  ensureStyles('protest-style', CSS);
  const index = match.cycles.findIndex(c => c.id === cycleId);
  if (index < 0) return false;
  const cycle = match.cycles[index];
  const dc = derive(match).cycles[index];

  const teamChoice = await api.ask({
    title: `Protest on Q${dc.number}: which team?`,
    buttons: [...leftRight(match).map(t => ({ label: teamName(match, t), value: `team${t}` })), CANCEL],
  });
  if (teamChoice !== 'team0' && teamChoice !== 'team1') return false;
  const team = Number(teamChoice.slice(4));

  let part = 'tossup';
  const bonusParts = bonusPartsOf(match, cycle);
  if (bonusParts > 0) {
    const partChoice = await api.ask({
      title: `Protest on Q${dc.number}: which part?`,
      buttons: [{ label: 'Tossup', value: 'tossup' }, ...parts(bonusParts).map(n => ({ label: `Bonus part ${n}`, value: `part${n}` })), CANCEL],
    });
    if (/^part[1-9]$/.test(partChoice ?? '')) part = Number(partChoice.slice(4));
    else if (partChoice !== 'tossup') return false;
  }

  const who = h('select', { 'aria-label': 'Who protested' }, h('option', { value: '' }, 'No player named'),
    whoCanProtest(match, index, team).map(([id, name]) => h('option', { value: id }, name)));
  const points = h('input', { type: 'number', inputmode: 'numeric', step: '1', min: '0', autocomplete: 'off', 'aria-label': 'Points at stake' });
  const says = h('textarea', { rows: 3, maxlength: 500, 'aria-label': 'What the protest says' });
  const note = h('p', { class: 'msg' });
  const body = h('div', { class: 'protestform' }, field('Who protested', who), field('Points at stake', points), field('What the protest says', says), note);
  for (;;) {
    const choice = await api.ask({
      title: `Protest on ${questionWords(dc, part)}: ${teamName(match, team)}`, body,
      buttons: [{ label: 'Record protest', value: 'ok', primary: true }, CANCEL],
    });
    if (choice !== 'ok') return false;
    const raw = points.value.trim();
    const number = Number(raw);
    if (raw === '' || !Number.isInteger(number)) { note.textContent = 'Type a whole number.'; continue; }
    if (number < 0) { note.textContent = 'Type a whole number from 0 up.'; continue; }
    const result = api.dispatch({ type: 'protest', cycleId, protest: { team, player: who.value === '' ? null : who.value, part, points: number, text: says.value.trim() } }, {});
    if (result.ok) return true;
    note.textContent = refusalText(result.error);
  }
}

// What stands on a tossup if it were thrown out for one team only: for each team with a wrong buzz (neg or wrong answer) or a lost
// turn on it and no correct buzz, the words for what it did, left team first. A question read after the gong has none: a kept buzz
// there was the one buzz allowed, so the replacement could not be buzzed.
function standing(match, cycle) {
  if (cycle.allowAfterTime === true) return [];
  return leftRight(match).flatMap(team => {
    const mine = cycle.buzzes.filter(b => b.team === team);
    const words = [mine.some(b => b.result === 'neg') ? 'neg' : null, mine.some(b => b.result === 'wrong') ? 'wrong answer' : null, cycle.lostTurn.includes(team) ? 'lost turn' : null].filter(Boolean);
    return words.length === 0 || mine.some(isCorrect) ? [] : [{ team, words }];
  });
}

// Throw out: the tossup or the bonus (asked unless `part` is given: the editor's two buttons name it), then for a tossup whether the
// replacement is for both teams or one, for a bonus which part went wrong; one throwOut action, one version, so Undo brings the original
// back. `patch` goes to the screen with the action, and `say` is told a refusal's reason. Resolves whether it was thrown out.
export async function throwOutFlow({ api, match, cycleId, part = null, patch = {}, say = () => {} }) {
  const index = match.cycles.findIndex(c => c.id === cycleId);
  if (index < 0) return false;
  const cycle = match.cycles[index];
  const q = `Q${derive(match).cycles[index].number}`;

  if (part === null) {
    part = await api.ask({
      title: `Throw out on ${q}: the tossup or the bonus?`,
      buttons: [{ label: 'The tossup', value: 'tossup' }, ...(cycle.bonus ? [{ label: 'The bonus', value: 'bonus' }] : []), CANCEL],
    });
  }
  let action;
  if (part === 'tossup') {
    let keepTeam = null;
    const teams = standing(match, cycle);
    if (teams.length > 0) {
      const choice = await api.ask({
        title: 'Replacement for both teams, or for one team only?',
        buttons: [{ label: 'Both teams', value: 'both' },
          ...teams.map(({ team, words }) => ({
            label: `${teamName(match, 1 - team)} only (${teamName(match, team)}'s ${words.join(' and ')} ${words.length > 1 ? 'stand' : 'stands'})`, value: `keep${team}`,
          })), CANCEL],
      });
      if (choice !== 'both' && !teams.some(({ team }) => choice === `keep${team}`)) return false;
      if (choice !== 'both') keepTeam = Number(choice.slice(4));
    }
    action = { type: 'throwOut', cycleId, part: 'tossup', keepTeam, note: '' };
  } else if (part === 'bonus') {
    let badPart = null;
    const count = cycle.bonus?.parts.length ?? 0;
    if (count > 0) {
      const choice = await api.ask({
        title: 'Which part went wrong?',
        buttons: [...parts(count).map(n => ({ label: `Part ${n}`, value: `part${n}` })), { label: 'The whole bonus', value: 'whole' }, CANCEL],
      });
      if (choice !== 'whole' && !/^part[1-9]$/.test(choice ?? '')) return false;
      if (choice !== 'whole') badPart = Number(choice.slice(4));
    }
    action = { type: 'throwOut', cycleId, part: 'bonus', badPart, note: '' };
  } else return false;

  const result = api.dispatch(action, patch);
  if (!result.ok) say(refusalText(result.error));
  return result.ok;
}

// ---- A protest's controls ---------------------------------------------------------------------

// Under a protest, on the cycle editor and the scoresheet: a status select (Open, Upheld, Denied, Withdrawn), which sends
// protestStatus at once, and Copy for Discord. Upheld then says "A protest never changes the score. Fix the question with Edit."
// (the scorer never works out whether a protest matters, v2 5.1). `getMatch` is read when a control is used, so the block copied is
// never older than the screen. `patch` goes to the screen with the status, and `onRefused` is told a refusal's reason.
export function protestControls({ api, getMatch, d, cycleId, index, patch = {}, onRefused = () => {} }) {
  ensureStyles('protest-style', CSS);
  const match = getMatch();
  const given = match.cycles.find(c => c.id === cycleId)?.protests?.[index];
  const dc = d.cycles.find(c => c.id === cycleId);

  const status = h('select', { class: 'pstatus', 'aria-label': `Status of the protest on ${dc && given ? questionWords(dc, given.part) : 'this question'}` },
    PROTEST_STATUSES.map(value => h('option', { value }, STATUS_WORDS[value])));
  status.value = given?.status ?? 'open';
  status.addEventListener('change', async () => {
    const next = status.value;
    const result = api.dispatch({ type: 'protestStatus', cycleId, index, status: next }, patch);
    if (!result.ok) {
      status.value = given?.status ?? 'open';
      onRefused(refusalText(result.error));
      return;
    }
    if (next === 'upheld') {
      await api.ask({ title: 'Protest upheld', body: 'A protest never changes the score. Fix the question with Edit.', buttons: [{ label: 'OK', value: 'ok', primary: true }] });
    }
  });

  const box = h('textarea', { readonly: true, rows: 6, hidden: true, class: 'pcopybox', 'aria-label': 'Protest text to copy' });
  const copy = h('button', { type: 'button', class: 'btn pcopy' }, 'Copy for Discord');
  copy.addEventListener('click', async () => {
    const now = getMatch();
    const block = protestText(now, derive(now), cycleId, index);
    box.value = block;
    copy.textContent = await copyText(block, box) ? 'Copied' : 'Select the text and copy it';
  });
  return h('div', { class: 'pctl noprint' }, status, copy, box);
}

// ---- The cycle editor's cards -----------------------------------------------------------------

// Two cards for the cycle editor: the cycle's protests (each with its controls) and Add a protest, then its thrown-out questions
// and the Throw out buttons. The protest controls act at once and never touch the editor's draft. The throw-out buttons are greyed
// with a hint while the draft differs from the saved cycle (`isDirty`, which `sync` reads again), and after a throw-out the editor
// is opened afresh on the saved cycle, so its draft is read again. Returns { nodes, sync }.
export function editorCards({ api, state, cycleId, sub, isDirty }) {
  ensureStyles('protest-style', CSS);
  const match = state.match;
  const d = derive(match);
  const cycle = match.cycles.find(c => c.id === cycleId);
  const onRefused = msg => api.setUi({ msg });
  const rows = (cycle.protests ?? []).map((_, index) => h('div', { class: 'protest', 'data-cycle': cycleId, 'data-index': index },
    h('span', { class: 'ptext' }, protestLine(match, d, cycleId, index)),
    protestControls({ api, getMatch: () => state.match, d, cycleId, index, onRefused })));
  const protestsCard = h('div', { class: 'card', id: 'ed-protests' }, h('h2', {}, 'Protests'),
    rows.length > 0 ? h('div', { class: 'protestlist' }, rows) : h('p', { class: 'hint' }, 'No protests on this question.'),
    h('button', { type: 'button', class: 'btn', id: 'ed-add-protest', onclick: () => { protestFlow({ api, match: state.match, cycleId }); } }, 'Add a protest'));

  const throwOut = part => { throwOutFlow({ api, match: state.match, cycleId, part, patch: { sub: { kind: 'cycle', cycleId, returnTo: sub.returnTo } }, say: onRefused }); };
  const tossup = h('button', { type: 'button', class: 'btn', id: 'ed-throw-tossup', onclick: () => throwOut('tossup') }, 'Throw out the tossup');
  const bonus = cycle.bonus ? h('button', { type: 'button', class: 'btn', id: 'ed-throw-bonus', onclick: () => throwOut('bonus') }, 'Throw out the bonus') : null;
  const hint = h('p', { class: 'hint', id: 'ed-throw-hint' });
  const lines = thrownOutLines(match, d).filter(line => line.cycleId === cycleId);
  const thrownCard = h('div', { class: 'card', id: 'ed-thrown' }, h('h2', {}, 'Thrown out'),
    lines.length > 0 ? h('div', { class: 'thrownlist' }, lines.map(line => h('p', { class: 'hint' }, line.text))) : null,
    tossup, bonus, hint);
  const sync = () => {
    const dirty = isDirty();
    tossup.disabled = dirty;
    if (bonus) bonus.disabled = dirty;
    hint.textContent = dirty ? 'Save or cancel your changes first' : '';
  };
  sync();
  return { nodes: [protestsCard, thrownCard], sync };
}
