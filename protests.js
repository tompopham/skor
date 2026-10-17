// Protests and thrown-out questions (v2 5.1, 5.2). The record holds only facts: on each cycle,
// `protests` ({ team, player, part, points, status, text, at }) and `thrownOut` ({ part, at, note, keepTeam,
// badPart, original }). A protest never changes a score (v2 1.4): the scorer fixes the question with Edit, and
// nothing here works out whether a protest matters. A throw-out moves what was entered into `original` and
// blanks the cycle for the replacement, which is scored on the same line.
//
// The three handlers are applyAction's; engine.js tables them (its PROTEST_ACTIONS), and calls the helpers
// below from derive() for the bounds, the flag and the bonus numbers. engine.js imports this file and this file
// imports engine.js for RefusedError, bareSet and cycleIndex, used only inside functions, so the two importing
// each other is safe in either order (as with lineup.js). The handlers are function declarations, which an
// importing module can use before this file has run.

import { RefusedError, bareSet, cycleIndex } from './engine.js';
import { playersOf, playerName } from './lineup.js';
import { fmt, leftRight, teamName } from './view-common.js';

export const PROTEST_STATUSES = ['open', 'upheld', 'denied', 'withdrawn'];
export const STATUS_WORDS = { open: 'Open', upheld: 'Upheld', denied: 'Denied', withdrawn: 'Withdrawn' };

const CORRECT = ['power', 'ten'];
// What a tossup throw-out moves into `original`: the cycle's entries.
const MOVED = ['type', 'format', 'clue', 'streak', 'eligible', 'buzzes', 'lostTurn', 'dead', 'noBonus', 'bonus', 'bonusNumberOverride', 'allowAfterTime'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTeam = team => team === 0 || team === 1;

// ---- Protests -------------------------------------------------------------------------------

// A protest as the record keeps it, without its time. The team is 0 or 1, the player null or a line-up id of one of
// that team's named players, the part 'tossup' or a bonus part number the rules' sets have, the points a whole
// number from 0 up. A missing status reads 'open', a missing text '' and a missing player null.
function checkedProtest(match, given) {
  const bad = detail => new RefusedError('bad-protest', detail);
  if (!isObject(given)) throw bad('a protest needs a team, a part and the points at stake');
  const { team, player = null, part, points, status = 'open', text = '' } = given;
  if (!isTeam(team)) throw bad('a protest is made by team 0 or 1');
  if (player !== null && !playersOf(match, team).some(p => p.id === player)) throw bad(`${match.teams[team].name} has no player ${String(player)}`);
  const parts = match.rules.bonus.parts;
  if (part !== 'tossup' && !(Number.isInteger(part) && part >= 1 && part <= parts)) throw bad(`a protest is on the tossup or on a bonus part from 1 to ${parts}`);
  if (!Number.isInteger(points) || points < 0) throw bad('the points at stake must be a whole number, 0 or more');
  if (!PROTEST_STATUSES.includes(status)) throw bad(`a protest is ${PROTEST_STATUSES.join(', ')}`);
  if (typeof text !== 'string') throw bad('the text of a protest must be text');
  return { team, player, part, points, status, text };
}

// Adds a protest to any cycle, stamped with the time of the entry.
export function addProtest(match, { cycleId, protest }, _open, _entry, _phase, now) {
  const cycle = match.cycles[cycleIndex(match, cycleId)];
  (cycle.protests ??= []).push({ ...checkedProtest(match, protest), at: now });
}

// Changes one protest's status; nothing else about it, and no score.
export function setProtestStatus(match, { cycleId, index, status }) {
  const cycle = match.cycles[cycleIndex(match, cycleId)];
  if (!Number.isInteger(index) || index < 0 || index >= (cycle.protests?.length ?? 0)) throw new RefusedError('bad-protest', `cycle ${cycleId} has no protest ${String(index)}`);
  if (!PROTEST_STATUSES.includes(status)) throw new RefusedError('bad-protest', `a protest is ${PROTEST_STATUSES.join(', ')}`);
  cycle.protests[index].status = status;
}

// ---- Throw-outs -----------------------------------------------------------------------------

// A bonus throw-out: the set moves into `original` and a bare one of the same size takes its place, for the same
// team and with the same number (the tossup and the number override are not touched).
function throwOutBonus(cycle, { badPart, note }, now) {
  const set = cycle.bonus;
  if (!set) throw new RefusedError('no-bonus', 'this question has no bonus to throw out');
  if (badPart !== null && !(Number.isInteger(badPart) && badPart >= 1 && badPart <= set.parts.length)) {
    throw new RefusedError('bad-action', `the part that went wrong runs from 1 to ${set.parts.length}`);
  }
  cycle.thrownOut.push({ part: 'bonus', at: now, note, keepTeam: null, badPart, original: { bonus: structuredClone(set) } });
  cycle.bonus = bareSet(set.parts.length);
}

// A tossup throw-out: everything entered on the original (MOVED) moves into `original`, and the cycle is blank for
// the replacement. `keepTeam` keeps that team's buzzes and lost turn, so it has had its turn on the replacement
// (a neg stays a neg). The format, the Split seats and the starter type stay as they were: a Jailbreak or a Split
// carries on from the cycle before, and a kept buzz is fined exactly as before (a music neg is 0). The typed bonus
// number goes into `original` with the rest and is cleared: that set's number is used up by derive() (readBonuses),
// so an answered replacement takes the lowest unused number and never warns about its own question. `noBonus` and
// `allowAfterTime` stay exactly as they were, so a question read in overtime or after the gong (whether or not a buzz
// was in when time was called) carries no bonus on its replacement, and a question that carried one still does.
function throwOutTossup(cycle, { keepTeam, note }, now) {
  const entered = cycle.buzzes.length > 0 || cycle.lostTurn.length > 0 || (cycle.streak?.length ?? 0) > 0 || cycle.dead;
  if (!entered) throw new RefusedError('nothing-to-throw-out', 'nothing has been entered on this question');
  if (keepTeam !== null && cycle.buzzes.some(b => b.team === keepTeam && CORRECT.includes(b.result))) {
    throw new RefusedError('kept-buzz-correct', 'a correct answer cannot be kept: it is the question that went wrong');
  }
  const keptBuzzes = cycle.buzzes.filter(b => b.team === keepTeam);
  const keptLost = cycle.lostTurn.filter(team => team === keepTeam);
  if (keepTeam !== null && keptBuzzes.length === 0 && keptLost.length === 0) {
    throw new RefusedError('bad-action', `team ${keepTeam} has nothing on this question to keep`);
  }
  const original = Object.fromEntries(MOVED.map(key => [key, structuredClone(cycle[key])]));
  cycle.thrownOut.push({ part: 'tossup', at: now, note, keepTeam, badPart: null, original });
  Object.assign(cycle, { clue: 0, streak: [], buzzes: keptBuzzes, lostTurn: keptLost, dead: false, bonus: null, bonusNumberOverride: null });
}

// Throw out: `part` is 'tossup' or 'bonus' of any cycle. Arguments first ('bad-action'), then what there is to
// throw out.
export function throwOut(match, { cycleId, part, keepTeam = null, badPart = null, note = '' }, _open, _entry, _phase, now) {
  const cycle = match.cycles[cycleIndex(match, cycleId)];
  const bad = detail => new RefusedError('bad-action', detail);
  if (part !== 'tossup' && part !== 'bonus') throw bad("a throw-out is of the 'tossup' or the 'bonus'");
  if (typeof note !== 'string') throw bad('a note must be text');
  if (part === 'tossup' && badPart !== null) throw bad('the part that went wrong is for a bonus throw-out only');
  if (part === 'bonus' && keepTeam !== null) throw bad("a team's buzz is kept on a tossup throw-out only");
  if (keepTeam !== null && !isTeam(keepTeam)) throw bad('the team to keep is 0, 1 or none');
  cycle.thrownOut ??= [];
  if (part === 'bonus') throwOutBonus(cycle, { badPart, note }, now);
  else throwOutTossup(cycle, { keepTeam, note }, now);
}

// ---- Worked out from the record (derive()'s) ------------------------------------------------

// The floor and ceiling a replacement bonus shows (ACF E.10, NAQT H.8), from the cycle's last throw-out: when that
// was a bonus with the part that went wrong named, the floor is the points the controlling team's own parts
// before that part earned and the ceiling the floor plus that part and every later one. Bounce-backs and the
// sweep reward are left out, and a set with a typed total has no known parts, so it has no bounds. Shown only:
// it never limits or changes a point (v2 1.4).
export function replacementBounds(cycle, rules) {
  const last = cycle.thrownOut?.at(-1);
  const set = last?.part === 'bonus' ? last.original?.bonus : null;
  if (!set || !Number.isInteger(last.badPart) || set.total != null) return null;
  const { partValue } = rules.bonus;
  const floor = partValue * set.parts.slice(0, last.badPart - 1).filter(p => p.ctrl === 'got').length;
  return { floor, ceiling: floor + partValue * (set.parts.length - last.badPart + 1) };
}

// Whether a cycle is flagged 'replacement-missing': a question thrown out whose replacement is not entered, which
// is a cycle that is neither closed nor the one open now.
export const replacementMissing = (cycle, closed, isOpen) => (cycle.thrownOut?.length ?? 0) > 0 && !closed && !isOpen;

// Whether a cycle has a protest or a thrown-out record, which End match, Time called and End quarter never drop.
export const keepsRecord = cycle => (cycle.protests?.length ?? 0) > 0 || (cycle.thrownOut?.length ?? 0) > 0;

// The sets a cycle's thrown-out tossups had read (each original answered with a bonus), for the numbering: a set that
// was read stays used (v2 5.2). Each is the original, with its typed number (`bonusNumberOverride`) if it had one.
export const readBonuses = cycle => (cycle.thrownOut ?? []).flatMap(({ part, original }) => (
  part === 'tossup' && original.bonus && !original.noBonus && original.buzzes.some(b => CORRECT.includes(b.result)) ? [original] : []));

// ---- Copy for Discord -----------------------------------------------------------------------

// The block one protest puts on the clipboard (v2 5.1): the competition and round, the teams (the left team
// first), the question, who protested and why, the points at stake, the status and the score after that question.
// Names go in as typed (a blank team name reads "Team A" or "Team B", as everywhere on the page). '' when the
// cycle or the protest is not there.
export function protestText(match, derived, cycleId, index) {
  const cycle = derived.cycles.find(c => c.id === cycleId);
  const given = match.cycles.find(c => c.id === cycleId)?.protests?.[index];
  if (!cycle || !given) return '';
  const [left, right] = leftRight(match);
  const name = team => teamName(match, team);
  const heading = [match.details?.competition, match.details?.round].map(value => String(value ?? '').trim()).filter(Boolean).join(', ');
  const question = given.part === 'tossup'
    ? `Q${cycle.number} tossup`
    : `Q${cycle.number} bonus${cycle.bonusNumber === null ? '' : ` ${cycle.bonusNumber}`}, part ${given.part}`;
  const who = playerName(match, given.team, given.player);
  const reason = typeof given.text === 'string' ? given.text.trim() : '';
  return [
    heading,
    `${name(left)} v ${name(right)}`,
    question,
    `Protest by ${name(given.team)}${who === '' ? '' : ` (${who})`}`,
    reason === '' ? '' : `Reason: ${reason}`,
    `Points at stake: ${given.points}`,
    `Status: ${STATUS_WORDS[given.status] ?? given.status}`,
    `Score after Q${cycle.number}: ${name(left)} ${fmt(cycle.running[left])}, ${name(right)} ${fmt(cycle.running[right])}`,
  ].filter(line => line !== '').join('\n');
}
