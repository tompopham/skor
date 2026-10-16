// The match engine: the match record, the actions that change it, the entries it refuses, and
// derive(), which works out scores and the open state from the record alone. Nothing derived is
// ever stored (spec section 4: the record is the only truth), so editing any cycle stays safe.
// No screen code lives here, so every rule can be tested in Node.

const RESULTS = ['power', 'ten', 'neg', 'wrong'];
const CORRECT = ['power', 'ten'];
const STARTER_TYPES = ['normal', 'picture', 'music'];
const RESULT_WORDS = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };
// What a part mark may set. 'passed' comes only from Pass rest, 'unheard' only from Time called.
const PART_RESULTS = ['got', 'missed', null];
const PART_SIDES = ['ctrl', 'other'];
// A controlling result that needs nothing more from the other team.
const SETTLED = ['got', 'passed', 'unheard'];

// Trivia question formats (spec 5.1): key to the label shown on the screen and the scoresheet.
export const FORMATS = {
  normal: 'Normal', doubleJump1: 'Double Jump 1st', doubleJump2: 'Double Jump 2nd', jackpot: 'Jackpot',
  streak: 'Streak', jailbreak: 'Jailbreak', split: 'Split', blitz: 'Blitz', set: 'Set',
  unrevealedSet: 'Unrevealed Set', mystery: 'Mystery', linkedSet: 'Linked Set',
};

// A refused entry (spec 6.4). `code` is stable for code and tests; the message starts with it.
export class RefusedError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RefusedError';
    this.code = code;
  }
}

const isTeam = team => team === 0 || team === 1;
const isSeat = seat => Number.isInteger(seat) && seat >= 0 && seat < 4;
const isCorrect = buzz => CORRECT.includes(buzz.result);
const powersOn = rules => rules.tossup.power != null;
const seatName = (team, seat) => (team.seats[seat] ?? '').trim();
const answered = cycle => cycle.buzzes.some(isCorrect);
const controllingTeam = cycle => cycle.buzzes.find(isCorrect).team;
const buzzCount = (cycle, team) => cycle.buzzes.filter(b => b.team === team).length;
// Anything entered against a question: a buzz, a lost turn or a Streak turn.
const hasEntry = cycle => cycle.buzzes.length > 0 || cycle.lostTurn.length > 0 || cycle.streak.length > 0;

// The format a cycle plays as: its own under trivia rules, always 'normal' under quizbowl rules.
const formatOf = (cycle, rules) => (rules.trivia ? cycle.format : 'normal');
// The formats that carry on to the next cycle, and what they carry on as (spec 5.1).
const CARRY_ON = { doubleJump1: 'doubleJump2', jailbreak: 'jailbreak', split: 'split' };
const triedClue = (cycle, team, clue) => cycle.buzzes.some(b => b.team === team && b.clue === clue);
// Whether a team has had its turn, from the cycle's own record: it lost its turn, or answered a
// Jackpot twice, or (any other format) buzzed or took its Streak turn.
function teamOut(cycle, team, format) {
  if (cycle.lostTurn.includes(team)) return true;
  if (format === 'jackpot') return buzzCount(cycle, team) >= 2;
  return buzzCount(cycle, team) > 0 || (format === 'streak' && cycle.streak.some(s => s.team === team));
}
// Whether a team is kept out of a cycle by earlier ones: in jail, or locked out of a Double Jump.
const shutOut = (entry, team) => entry.lockedOut[team] || entry.jailedOut[team];
// A cycle plays a bonus when its starter was answered correctly and a set was opened for it.
const playsBonus = cycle => answered(cycle) && cycle.bonus !== null;
const bounceOn = rules => rules.bonus.bounce != null;
// A part goes over to the other team only when bounce-backs are on and the controlling team missed it.
const isOffered = (part, rules) => bounceOn(rules) && part.ctrl === 'missed';

function copyTeam(team = {}) {
  return {
    name: team.name ?? '',
    seats: [0, 1, 2, 3].map(seat => team.seats?.[seat] ?? ''),
    captain: team.captain ?? null,
  };
}

export function newMatch({ rules, teams, details = {}, display = {}, id, now }) {
  return {
    id, createdAt: now, changedAt: now, rev: 0, nextCycleNo: 1,
    rules: structuredClone(rules),
    details: { competition: '', venue: '', round: '', reader: '', scorer: '', ...details },
    teams: [copyTeam(teams?.[0]), copyTeam(teams?.[1])],
    display: { leftTeam: 0, seatOrder: 'asc', ...display },
    cycles: [],
    markers: [],
  };
}

// A cycle with nothing entered: every field of the Cycle shape at its default.
const blankCycle = id => ({
  id, type: 'normal',
  format: 'normal', clue: 0, streak: [], eligible: null,
  buzzes: [], lostTurn: [], dead: false, noBonus: false, bonus: null,
  bonusNumberOverride: null, allowAfterTime: null, note: '',
});

// A new cycle id: 'c1', 'c2'..., never reused, even after a delete.
function nextCycleId(match) {
  const id = 'c' + match.nextCycleNo;
  match.nextCycleNo += 1;
  return id;
}

function addCycle(match) {
  const cycle = blankCycle(nextCycleId(match));
  match.cycles.push(cycle);
  return cycle;
}

// The set a correct answer opens: one unmarked entry per part.
const bareSet = parts => ({ parts: Array.from({ length: parts }, () => ({ ctrl: null, other: null })), total: null, passedRest: false });

// ---- Actions -------------------------------------------------------------------------------
// Each handler changes its own copy of the match, or throws a RefusedError. `open` and `phase` are
// derive()'s open state and phase for the match before the action, and `entry` the open cycle's
// starting state from cycleEntries() (the next cycle's when none is open); a starter action with
// no cycle open adds one. A refusal may come after the handler has changed its copy: the copy is
// then thrown away.

const openCycleOf = (match, open) => match.cycles.find(c => c.id === open.cycleId) ?? null;

// A cycle started by a starter action, in the format carried on from the one before (spec 5.1).
// An overtime starter never carries a bonus, so it is marked noBonus as it starts (spec 4).
function startCycle(match, entry, phase) {
  const cycle = addCycle(match);
  cycle.format = entry.format;
  cycle.eligible = entry.eligible;
  if (phase.overtime) cycle.noBonus = true;
  return cycle;
}

// Removes the open cycle, which has nothing entered against it. A marker on it moves to the cycle
// before (or to before the first cycle), as markers move with their cycles (spec 4).
function dropOpenCycle(match) {
  const { id } = match.cycles.pop();
  const before = match.cycles.at(-1)?.id ?? null;
  for (const marker of match.markers) if (marker.afterCycleId === id) marker.afterCycleId = before;
}

function checkSeatNamed(match, team, seat) {
  const t = match.teams[team];
  if (!seatName(t, seat)) throw new RefusedError('empty-seat', `${t.name} has nobody in seat ${seat + 1}`);
}

// A team with no turn left on the question. Shared by buzzes, lost turns and Streak turns.
function checkTeamTurn(cycle, team, name, format) {
  if (cycle.lostTurn.includes(team)) throw new RefusedError('team-lost-turn', `${name} has lost its turn on this question`);
  if (!teamOut(cycle, team, format)) return;
  if (format === 'jackpot') throw new RefusedError('jackpot-twice', `${name} has answered this Jackpot twice`);
  throw new RefusedError('team-already-buzzed', `${name} has already had its turn on this question`);
}

// The refusals for a buzz that rest on its own cycle alone: spec 6.4's starter refusals, a buzz
// from an empty seat, and the trivia formats' own rules. `clue` is the Jackpot clue it answers.
// Jail and the Double Jump lock rest on earlier cycles: see checkCarried.
function checkBuzz(match, cycle, { team, seat, result, clue }) {
  if (!isTeam(team) || !isSeat(seat) || !RESULTS.includes(result)) {
    throw new RefusedError('bad-action', `a buzz needs team 0 or 1, seat 0 to 3 and a result of ${RESULTS.join(', ')}`);
  }
  const { name } = match.teams[team];
  checkSeatNamed(match, team, seat);
  if (result === 'power' && !powersOn(match.rules)) throw new RefusedError('powers-off', 'these rules have no powers');
  const format = formatOf(cycle, match.rules);
  if (format === 'streak') throw new RefusedError('use-streak', 'a Streak is scored by turns, not buzzes');
  if (answered(cycle)) {
    if (CORRECT.includes(result)) {
      throw new RefusedError('second-correct', 'this starter has already been answered correctly');
    }
    throw new RefusedError('buzz-after-correct', 'nobody can buzz after a correct answer');
  }
  if (format === 'split' && !(cycle.eligible?.[team] ?? []).includes(seat)) {
    throw new RefusedError('not-on-this-set', `${name} did not put seat ${seat + 1} on this set`);
  }
  checkTeamTurn(cycle, team, name, format);
  if (format === 'jackpot' && triedClue(cycle, team, clue)) {
    throw new RefusedError('clue-already-tried', `${name} has already answered on clue ${clue + 1}`);
  }
}

// The refusals that rest on earlier cycles: the Double Jump lock and Jailbreak's jail. `seat` is
// null for a lost turn, refused only when the whole team is in jail. An edited cycle meets these
// as derive()'s flags instead (spec 6.4).
function checkCarried(match, entry, team, seat) {
  const { name } = match.teams[team];
  if (entry.lockedOut[team]) throw new RefusedError('double-jump-locked', `only the team that got the first half may answer, not ${name}`);
  if (seat === null ? entry.jailedOut[team] : entry.jailed[team][seat]) {
    throw new RefusedError('jailed', seat === null ? `every player on ${name} is in jail` : `${name}'s seat ${seat + 1} is in jail`);
  }
}

// Split seats: for each team one or two of its seats, all named, so a short team can play.
// Returns them as a sorted copy.
function checkSplitSeats(match, eligible) {
  const fits = Array.isArray(eligible) && eligible.length === 2 && eligible.every((seats, team) =>
    Array.isArray(seats) && seats.length >= 1 && seats.length <= 2 && new Set(seats).size === seats.length
    && seats.every(seat => isSeat(seat) && seatName(match.teams[team], seat) !== ''));
  if (!fits) throw new RefusedError('split-seats', 'a Split needs one or two named seats from each team');
  return eligible.map(seats => [...seats].sort((a, b) => a - b));
}

// A Streak turn's refusals; `cycle` is the open cycle, or null.
function checkStreakTurn(match, cycle, { team, seat, answers, wrong }) {
  if (!cycle || formatOf(cycle, match.rules) !== 'streak') throw new RefusedError('not-a-streak', 'the open question is not a Streak');
  if (!isTeam(team) || !isSeat(seat) || !Number.isInteger(answers) || answers < 0 || typeof wrong !== 'boolean') {
    throw new RefusedError('bad-action', 'a Streak turn needs team 0 or 1, seat 0 to 3, a whole number of answers and wrong true or false');
  }
  checkSeatNamed(match, team, seat);
  checkTeamTurn(cycle, team, match.teams[team].name, 'streak');
}

function buzz(match, { team, seat, result }, open, entry, phase) {
  const cycle = openCycleOf(match, open) ?? startCycle(match, entry, phase);
  const format = formatOf(cycle, match.rules);
  const entered = { team, seat, result };
  if (format === 'jackpot') entered.clue = cycle.clue;
  checkBuzz(match, cycle, entered);
  checkCarried(match, entry, team, seat);
  cycle.buzzes.push(entered);
  // A correct answer opens a bare bonus set; marking and closing it are the bonus actions' job.
  // (A buzz allowed after time called closes its cycle with no rebound: see isClosed.)
  const { parts } = match.rules.bonus;
  if (CORRECT.includes(result) && parts > 0 && !cycle.noBonus) cycle.bonus = bareSet(parts);
}

function refuseIfAnswered(cycle) {
  if (cycle && answered(cycle)) throw new RefusedError('starter-answered', 'this starter has been answered correctly');
}

// Dead also ends a Streak ("Streak over") and a Jackpot nobody answered.
function dead(match, _action, open, entry, phase) {
  const cycle = openCycleOf(match, open);
  refuseIfAnswered(cycle);
  (cycle ?? startCycle(match, entry, phase)).dead = true;
}

function lostTurn(match, { team }, open, entry, phase) {
  if (!isTeam(team)) throw new RefusedError('bad-action', 'a lost turn needs team 0 or 1');
  const cycle = openCycleOf(match, open) ?? startCycle(match, entry, phase);
  refuseIfAnswered(cycle);
  checkTeamTurn(cycle, team, match.teams[team].name, formatOf(cycle, match.rules));
  checkCarried(match, entry, team, null);
  cycle.lostTurn.push(team);
}

// A starter type the rules allow. Shared by the starter type action and the cycle editor.
function checkStarterType(match, kind) {
  if (!match.rules.starterTypes.on) throw new RefusedError('starter-types-off', 'these rules have no picture or music starters');
  if (!STARTER_TYPES.includes(kind)) throw new RefusedError('bad-action', `no starter type called ${kind}`);
}

// Sets the open starter's type (UC picture and music). It may be changed until the cycle closes,
// since derive() reworks the fine from the record.
function starterType(match, { kind }, open, entry, phase) {
  checkStarterType(match, kind);
  (openCycleOf(match, open) ?? startCycle(match, entry, phase)).type = kind;
}

// ---- Trivia actions (spec 5.1) --------------------------------------------------------------

// A question format the rules allow. Shared by the format action and the cycle editor.
function checkFormat(match, format) {
  const { trivia } = match.rules;
  if (!trivia) throw new RefusedError('trivia-off', 'question formats are for trivia rules only');
  if (!Object.hasOwn(FORMATS, format)) throw new RefusedError('unknown-format', `there is no format called ${format}`);
  if (format === 'streak' && trivia.streak == null) throw new RefusedError('format-not-in-rules', 'these rules have no Streak');
}

// Sets the open question's format before anything is entered against it; with no cycle open it
// starts one in that format. The Jackpot clue goes back to the first; Split seats are kept only
// for a Split.
function setFormat(match, { format, eligible }, open, entry, phase) {
  checkFormat(match, format);
  const existing = openCycleOf(match, open);
  if (existing && hasEntry(existing)) {
    throw new RefusedError('question-started', 'the format cannot change once anything is entered on the question');
  }
  const seats = format === 'split' ? checkSplitSeats(match, eligible) : null;
  const cycle = existing ?? startCycle(match, entry, phase);
  cycle.format = format;
  cycle.clue = 0;
  cycle.eligible = seats;
}

// Jackpot: on to the next clue. Next clue after the last one leaves the question dead.
function nextClue(match, _action, open) {
  const cycle = openCycleOf(match, open);
  if (!cycle || formatOf(cycle, match.rules) !== 'jackpot') throw new RefusedError('not-a-jackpot', 'the open question is not a Jackpot');
  refuseIfAnswered(cycle);
  if (cycle.clue >= match.rules.trivia.jackpot.length - 1) cycle.dead = true;
  else cycle.clue += 1;
}

// A Streak turn: the answers one player named before passing or finishing, or before a wrong
// or repeated answer (`wrong`), which scores the turn 0.
function streakTurn(match, { team, seat, answers, wrong = false }, open) {
  const cycle = openCycleOf(match, open);
  checkStreakTurn(match, cycle, { team, seat, answers, wrong });
  cycle.streak.push({ team, seat, answers, wrong });
}

// End quarter: a quarter marker after the last question; the last quarter's marker ends regulation.
// An open question with nothing entered against it is removed first.
function endQuarter(match, _action, open, _entry, phase) {
  const { trivia } = match.rules;
  if (!trivia) throw new RefusedError('trivia-off', 'quarters are for trivia rules only');
  checkNotEnded(phase);
  const quarters = match.markers.filter(m => m.type === 'quarter');
  if (quarters.length >= trivia.quarters) throw new RefusedError('quarters-done', `all ${trivia.quarters} quarters have been played`);
  checkInRegulation(phase);
  const cycle = openCycleOf(match, open);
  if (cycle && hasEntry(cycle)) throw new RefusedError('question-open', 'finish the open question first');
  if (cycle) dropOpenCycle(match);
  const last = match.cycles.at(-1);
  if (!last || quarters.some(m => m.afterCycleId === last.id)) {
    throw new RefusedError('no-questions', 'no question has been played in this quarter');
  }
  match.markers.push({ type: 'quarter', afterCycleId: last.id });
}

// ---- Bonus actions (spec 6.3, "A bonus") ----------------------------------------------------

// The cycle whose set is open; every bonus action is refused when there is none.
function bonusCycle(match, open) {
  const cycle = open.stage === 'bonus' ? openCycleOf(match, open) : null;
  if (!cycle?.bonus) throw new RefusedError('no-open-bonus', 'there is no bonus open');
  return cycle;
}

// The bonus refusals (spec 6.4), shared by the bonus actions and the cycle editor.
// - A set has no more parts than `limit`: the open set's own count, or the rules' for an edited set.
function checkPartCount(count, limit) {
  if (count > limit) throw new RefusedError('too-many-parts', `a set has at most ${limit} part${limit === 1 ? '' : 's'} here`);
}
// - The other team marks only a part offered to it.
function checkOffered(part, rules, index) {
  if (!isOffered(part, rules)) throw new RefusedError('part-not-offered', `part ${index + 1} has not gone over to the other team`);
}
// - Passing the rest of a set only where the rules allow it.
function checkPassRest(match) {
  if (!match.rules.bonus.passRest) throw new RefusedError('pass-rest-off', 'these rules do not allow passing the rest of a set');
}
// - A typed total: never with bounce-backs, a whole number, from 0 to the set's full value.
function checkTotal(match, bonus, points) {
  if (bounceOn(match.rules)) throw new RefusedError('total-not-with-bounce', 'a typed total cannot be used with bounce-backs');
  if (!Number.isInteger(points)) throw new RefusedError('bad-action', 'a bonus total must be a whole number');
  const max = bonus.parts.length * match.rules.bonus.partValue;
  if (points < 0 || points > max) throw new RefusedError('total-out-of-range', `a total for this set runs from 0 to ${max}`);
}
// - A hand-corrected bonus number: a whole number from 1 up, or null for none.
function checkBonusNumber(number) {
  if (number !== null && !(Number.isInteger(number) && number >= 1)) {
    throw new RefusedError('bad-action', 'a bonus number must be a whole number from 1 up');
  }
}

// One part's mark. Side 'ctrl' is the controlling team's result; side 'other' is the other team's,
// on a part offered to it. A null result clears the mark.
function part(match, { index, side, result }, open) {
  const { bonus } = bonusCycle(match, open);
  if (!PART_SIDES.includes(side) || !PART_RESULTS.includes(result) || !Number.isInteger(index) || index < 0) {
    throw new RefusedError('bad-action', "a part mark needs a part index, a side of 'ctrl' or 'other' and a result of got, missed or null");
  }
  checkPartCount(index + 1, bonus.parts.length);
  const entry = bonus.parts[index];
  if (side === 'other') {
    checkOffered(entry, match.rules, index);
    entry.other = result;
    return;
  }
  entry.ctrl = result;
  if (!isOffered(entry, match.rules)) entry.other = null;   // the other team's mark goes with its offer
  bonus.passedRest = bonus.parts.some(p => p.ctrl === 'passed');
}

// All got and None got mark the whole set in one tap; with bounce-backs on, None got offers
// every part to the other team.
function markWholeSet(match, open, ctrl) {
  const { bonus } = bonusCycle(match, open);
  for (const p of bonus.parts) { p.ctrl = ctrl; p.other = null; }
  bonus.passedRest = false;
}
const allGot = (match, _action, open) => markWholeSet(match, open, 'got');
const noneGot = (match, _action, open) => markWholeSet(match, open, 'missed');

// Close (Enter): unmarked parts become missed, which offers them when bounce-backs are on. Once
// only the other team's marks are pending, Close marks those missed.
function closeBonus(match, _action, open) {
  const { parts } = bonusCycle(match, open).bonus;
  const unmarked = parts.filter(p => p.ctrl === null);
  if (unmarked.length > 0) {
    for (const p of unmarked) p.ctrl = 'missed';
    return;
  }
  for (const p of parts) if (isOffered(p, match.rules) && p.other === null) p.other = 'missed';
}

// NAQT: the controlling team passes the rest of the set, so every unmarked part becomes passed.
function passRest(match, _action, open) {
  const { bonus } = bonusCycle(match, open);
  checkPassRest(match);
  const unmarked = bonus.parts.filter(p => p.ctrl === null);
  if (unmarked.length === 0) throw new RefusedError('nothing-to-pass', 'every part of this set already has a result');
  for (const p of unmarked) p.ctrl = 'passed';
  bonus.passedRest = true;
}

// A typed total for a graded set. It stands instead of the part marks (spec 4), so they are
// cleared, and it never earns the sweep reward.
function bonusTotal(match, { points }, open) {
  const { bonus } = bonusCycle(match, open);
  checkTotal(match, bonus, points);
  bonus.total = points;
  for (const p of bonus.parts) { p.ctrl = null; p.other = null; }
  bonus.passedRest = false;
}

// A hand correction of the open set's number. It changes the number shown for this cycle only,
// and no score or later number; null removes it.
function bonusNumber(match, { number }, open) {
  const cycle = bonusCycle(match, open);
  checkBonusNumber(number);
  cycle.bonusNumberOverride = number;
}

// ---- Match flow actions (spec 6.3: halftime, time called, end of match) ---------------------

function checkNotEnded(phase) {
  if (phase.ended) throw new RefusedError('match-ended', 'the match has ended');
}

function checkInRegulation(phase) {
  if (phase.regulationOver) throw new RefusedError('regulation-over', 'regulation is over');
}

// Halftime by hand: a marker after the last closed cycle, where the rules give no halftime cycle
// or it has not been reached yet. Halftime happens once.
function halftime(match, _action, open, _entry, phase) {
  checkNotEnded(phase);
  checkInRegulation(phase);
  if (phase.halftimeAfterCycleId !== null) throw new RefusedError('halftime-done', 'halftime has already been reached');
  const last = (open.cycleId === null ? match.cycles : match.cycles.slice(0, -1)).at(-1);
  if (!last) throw new RefusedError('no-questions', 'no question has been played yet');
  match.markers.push({ type: 'halftime', afterCycleId: last.id });
}

// Time called (the UC gong) ends regulation once its marker's cycle closes, by the rules' atTime:
// - finishCycle: the open cycle is finished as normal, so the marker goes on it;
// - stopNow: an open set closes at once, its unmarked parts unheard (a part waiting for the other
//   team's mark is closed as missed); an open starter closes at once, or is removed if nothing
//   is entered against it;
// - buzzMayAnswer: an open set is finished as normal; an open starter closes as under stopNow.
// With allowBuzz (stopNow and buzzMayAnswer), a buzz already in at time stands: the starter being
// read stays open (one is started if none is) for that one buzz, with no rebound and no bonus.
// A starter with no buzz yet is marked allowAfterTime, so its first buzz closes it (isClosed). A
// starter that already has a buzz is not: only the other team is still in, and its buzz closes
// the starter by the ordinary rules, so marking it would close it at once.
// Under finishCycle the starter is finished anyway, so allowBuzz changes nothing.
function timeCalled(match, { allowBuzz = false }, open, entry, phase) {
  if (typeof allowBuzz !== 'boolean') throw new RefusedError('bad-action', 'allowBuzz must be true or false');
  checkNotEnded(phase);
  checkInRegulation(phase);
  if (match.markers.some(m => m.type === 'timeCalled')) {
    throw new RefusedError('time-already-called', 'time has already been called; finish the open question');
  }
  const { rules } = match;
  const allow = allowBuzz && rules.atTime !== 'finishCycle';
  if (allow && open.stage === 'bonus') throw new RefusedError('no-buzz-in', 'a bonus is being read, so there is no starter buzz to allow');
  let cycle = openCycleOf(match, open);
  if (open.stage === 'bonus' && rules.atTime === 'stopNow') {
    for (const p of cycle.bonus.parts) {
      if (p.ctrl === null) p.ctrl = 'unheard';
      else if (isOffered(p, rules) && p.other === null) p.other = 'missed';
    }
  } else if (open.stage === 'starter' && rules.atTime !== 'finishCycle') {
    if (allow) {
      cycle ??= startCycle(match, entry, phase);
      if (cycle.buzzes.length === 0) cycle.allowAfterTime = true;
      cycle.noBonus = true;
    } else if (cycle && hasEntry(cycle)) {
      cycle.dead = true;
    } else if (cycle) {
      dropOpenCycle(match);
      cycle = null;
    }
  }
  const at = cycle ?? match.cycles.at(-1);
  match.markers.push({ type: 'timeCalled', afterCycleId: at?.id ?? null });
}

// End match: an ended marker after the last question. Refused while a question is open; an open
// question with nothing entered against it is removed first.
function endMatch(match, _action, open, _entry, phase) {
  checkNotEnded(phase);
  const cycle = openCycleOf(match, open);
  if (cycle && hasEntry(cycle)) throw new RefusedError('question-open', 'finish the open question first');
  if (cycle) dropOpenCycle(match);
  match.markers.push({ type: 'ended', afterCycleId: match.cycles.at(-1)?.id ?? null });
}

// ---- Edit actions (spec 6.4: the cycle editor, and changing a rule mid-match) ---------------
// Save, Delete, Insert and a note in the cycle editor, and Edit rules. They may be used at any
// time, after the end of the match too. Later cycles are never removed: anything an edit makes
// impossible in them is flagged by derive() (cycleFlags, and 'after-end' from matchFlow).

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function cycleIndex(match, cycleId) {
  const index = match.cycles.findIndex(c => c.id === cycleId);
  if (index < 0) throw new RefusedError('no-such-cycle', `there is no cycle ${cycleId}`);
  return index;
}

// A Jackpot clue: a whole number from 0 to the last clue.
function checkClue(match, clue) {
  const last = match.rules.trivia.jackpot.length - 1;
  if (!(Number.isInteger(clue) && clue >= 0 && clue <= last)) throw new RefusedError('bad-action', `a Jackpot clue runs from 0 to ${last}`);
  return clue;
}

// A replacement cycle, checked on its own with live play's refusals and copied into the record's
// shape: a missing field takes its default, unknown fields are dropped, and the Jackpot clue and
// Split seats are kept only for their own formats, as the format action does. Its buzzes, Streak
// turns and lost turns are checked one at a time as if entered in that order, lost turns last,
// since a team may lose its turn before the other team answers. The Double Jump lock and jail
// rest on earlier cycles, so derive() flags them instead of a refusal here.
function checkedCycle(match, id, given) {
  const bad = detail => new RefusedError('bad-action', detail);
  if (!isObject(given)) throw bad('a cycle must be an object');
  if (given.id !== undefined && given.id !== id) throw bad(`cycle ${id} keeps its id`);
  const cycle = blankCycle(id);
  const value = key => given[key] ?? cycle[key];

  cycle.type = value('type');
  if (cycle.type !== 'normal') checkStarterType(match, cycle.type);
  cycle.format = value('format');
  if (cycle.format !== 'normal') checkFormat(match, cycle.format);
  const format = formatOf(cycle, match.rules);
  if (format === 'split') cycle.eligible = checkSplitSeats(match, given.eligible);
  if (format === 'jackpot') cycle.clue = checkClue(match, value('clue'));
  for (const key of ['dead', 'noBonus']) {
    if (typeof value(key) !== 'boolean') throw bad(`${key} must be true or false`);
    cycle[key] = value(key);
  }
  if (![null, true].includes(value('allowAfterTime'))) throw bad('allowAfterTime must be true or null');
  cycle.allowAfterTime = value('allowAfterTime');
  if (typeof value('note') !== 'string') throw bad('a note must be text');
  cycle.note = value('note');
  checkBonusNumber(value('bonusNumberOverride'));
  cycle.bonusNumberOverride = value('bonusNumberOverride');

  const list = (key, fits) => {
    if (!Array.isArray(value(key)) || !value(key).every(fits)) throw bad(`${key} must be a list of entries`);
    return value(key);
  };
  for (const b of list('buzzes', isObject)) {
    const entered = { team: b.team, seat: b.seat, result: b.result };
    if (format === 'jackpot') entered.clue = checkClue(match, b.clue ?? cycle.clue);   // as a live buzz takes the clue being read
    checkBuzz(match, cycle, entered);
    cycle.buzzes.push(entered);
  }
  for (const s of list('streak', isObject)) {
    const turn = { team: s.team, seat: s.seat, answers: s.answers, wrong: s.wrong ?? false };
    checkStreakTurn(match, cycle, turn);
    cycle.streak.push(turn);
  }
  for (const team of list('lostTurn', isTeam)) {
    checkTeamTurn(cycle, team, match.teams[team].name, format);
    cycle.lostTurn.push(team);
  }
  if (cycle.dead) refuseIfAnswered(cycle);
  cycle.bonus = checkedBonus(match, cycle, value('bonus'));
  return cycle;
}

// What the controlling team's mark on a stored part may be: 'passed' and 'unheard' as well.
const CTRL_MARKS = ['got', 'missed', 'passed', 'unheard', null];

// The set a replacement cycle carries. Only a correct starter that carries a bonus has one, and
// such a starter given none gets a bare set, as a correct buzz opens. The set meets the bonus
// actions' refusals under the match's rules, and passedRest is worked out from its parts.
function checkedBonus(match, cycle, given) {
  const carries = answered(cycle) && !cycle.noBonus;
  const count = match.rules.bonus.parts;
  if (given === null) return carries && count > 0 ? bareSet(count) : null;
  if (!carries) {
    throw new RefusedError('no-open-bonus', answered(cycle) ? 'this starter carries no bonus' : 'a bonus needs a correct starter');
  }
  if (!isObject(given) || !Array.isArray(given.parts) || !given.parts.every(isObject)) {
    throw new RefusedError('bad-action', 'a bonus needs a list of parts');
  }
  checkPartCount(given.parts.length, count);
  const parts = given.parts.map((p, index) => {
    const entry = { ctrl: p.ctrl ?? null, other: p.other ?? null };
    if (!CTRL_MARKS.includes(entry.ctrl) || !PART_RESULTS.includes(entry.other)) {
      throw new RefusedError('bad-action', `part ${index + 1} has a mark that is not got, missed, passed, unheard or none`);
    }
    if (entry.ctrl === 'passed') checkPassRest(match);
    if (entry.other !== null) checkOffered(entry, match.rules, index);
    return entry;
  });
  const set = { parts, total: given.total ?? null, passedRest: parts.some(p => p.ctrl === 'passed') };
  if (set.total !== null) {
    checkTotal(match, set, set.total);
    if (parts.some(p => p.ctrl !== null || p.other !== null)) {
      throw new RefusedError('bad-action', 'a typed total stands instead of the part marks, so a set has one or the other');
    }
  }
  return set;
}

// Save in the cycle editor: the cycle is replaced, keeping its id and its place.
function replaceCycle(match, { cycleId, cycle }) {
  match.cycles[cycleIndex(match, cycleId)] = checkedCycle(match, cycleId, cycle);
}

// Delete: a marker on the deleted cycle moves to the cycle before, or goes if there is none.
function deleteCycle(match, { cycleId }) {
  const index = cycleIndex(match, cycleId);
  match.cycles.splice(index, 1);
  const before = match.cycles[index - 1]?.id;
  match.markers = match.markers.flatMap(marker => {
    if (marker.afterCycleId !== cycleId) return [marker];
    return before === undefined ? [] : [{ ...marker, afterCycleId: before }];
  });
}

// Insert: a dead cycle with a new id before the one named. Markers stay after their own cycles,
// so they move with them. The screen then opens the new cycle in the editor.
function insertCycle(match, { beforeCycleId }) {
  const index = cycleIndex(match, beforeCycleId);
  const cycle = blankCycle(nextCycleId(match));
  cycle.dead = true;
  match.cycles.splice(index, 0, cycle);
}

function note(match, { cycleId, text }) {
  const cycle = match.cycles[cycleIndex(match, cycleId)];
  if (typeof text !== 'string') throw new RefusedError('bad-action', 'a note must be text');
  cycle.note = text;
}

// New rules must keep the Rules shape, so that derive() can read every group; the values
// themselves are the setup screen's to check.
const RULE_GROUPS = ['tossup', 'starterTypes', 'bonus', 'regulation'];
function checkRules(rules) {
  const fits = isObject(rules) && RULE_GROUPS.every(group => isObject(rules[group]))
    && (rules.trivia === null || (isObject(rules.trivia) && Array.isArray(rules.trivia.jackpot)));
  if (!fits) throw new RefusedError('bad-action', 'rules need tossup, starterTypes, bonus and regulation, and trivia rules or null');
}

// Edit rules: the match keeps its own full copy of the new rules, and derive() reworks every
// score from them. The screen first shows ruleChangeDiff() and asks.
function setRules(match, { rules }) {
  checkRules(rules);
  match.rules = structuredClone(rules);
}

// Starter actions are refused once the match has ended, or while it waits to be ended after
// regulation; bonus actions once it has ended. Match flow actions make their own checks, and
// edit actions are open at any time.
const STARTER_ACTIONS = { buzz, dead, lostTurn, starterType, format: setFormat, nextClue, streak: streakTurn };
const BONUS_ACTIONS = { part, allGot, noneGot, closeBonus, passRest, bonusTotal, bonusNumber };
const FLOW_ACTIONS = { halftime, timeCalled, endMatch, endQuarter };
const EDIT_ACTIONS = { replaceCycle, deleteCycle, insertCycle, note, setRules };
const ACTIONS = { ...STARTER_ACTIONS, ...BONUS_ACTIONS, ...FLOW_ACTIONS, ...EDIT_ACTIONS };

function checkInPlay(type, { open, phase }) {
  const starter = Object.hasOwn(STARTER_ACTIONS, type);
  if (starter || Object.hasOwn(BONUS_ACTIONS, type)) checkNotEnded(phase);
  if (starter && open.stage === 'awaitingEnd') {
    throw new RefusedError('regulation-over', 'regulation is over and the scores are not level, so the match can only be ended');
  }
}

// Returns a new match with the action applied, `rev` raised by 1 and `changedAt` set to `now`.
// The match passed in is never changed. Throws a RefusedError for an entry that cannot stand.
export function applyAction(match, action, now) {
  const type = action?.type;
  const handler = Object.hasOwn(ACTIONS, type) ? ACTIONS[type] : null;
  if (!handler) throw new RefusedError('unknown-action', `there is no action called ${type}`);
  const { derived, entry } = analyse(match);
  checkInPlay(type, derived);
  const next = structuredClone(match);
  handler(next, action, derived.open, entry, derived.phase);
  next.rev = match.rev + 1;
  next.changedAt = now;
  return next;
}

// ---- derive --------------------------------------------------------------------------------

// The fine for the first buzz of a cycle being a wrong interruption.
function firstNeg(cycle, rules) {
  const { tossup, starterTypes } = rules;
  if (starterTypes.on && cycle.type === 'music') return starterTypes.musicNeg;
  if (starterTypes.on && cycle.type === 'picture') return starterTypes.pictureNeg;
  return tossup.neg;
}

function buzzPoints(buzz, position, cycle, rules, format) {
  const { tossup } = rules;
  // Jackpot: a correct answer scores its clue's value; a wrong one 0 (spec 5.1).
  if (format === 'jackpot') return isCorrect(buzz) ? rules.trivia.jackpot[buzz.clue ?? 0] ?? 0 : 0;
  switch (buzz.result) {
    case 'power': return tossup.power ?? tossup.ten;   // a power kept after powers are switched off counts as 10
    case 'ten': return tossup.ten;
    // Only the first buzz of the cycle is fined; a lost turn is not a buzz (spec 5, shared rules).
    case 'neg': return position === 0 ? firstNeg(cycle, rules) : tossup.secondNeg;
    default: return 0;                                  // 'wrong': after the question ended
  }
}

// Whether a set is finished: it has a typed total, or every part is settled. A missed part is
// settled when bounce-backs are off or the other team has its mark. Part values play no part.
function bonusFinished(bonus, rules) {
  if (bonus.total !== null) return true;
  return bonus.parts.every(p => SETTLED.includes(p.ctrl) || (p.ctrl === 'missed' && (!bounceOn(rules) || p.other !== null)));
}

// A cycle closes on dead, on a correct answer with no bonus to follow (or once its set is
// finished), on the buzz allowed after time called (no rebound), or, once anything is entered
// against it, when neither team has a turn left: each has buzzed wrongly, lost its turn, taken
// its Streak turn or answered a Jackpot twice, or is kept out by jail or the Double Jump lock.
// `entry` is the cycle's entry from cycleEntries().
function isClosed(cycle, rules, entry) {
  if (cycle.dead) return true;
  if (answered(cycle)) return cycle.bonus === null || bonusFinished(cycle.bonus, rules);
  if (cycle.allowAfterTime && cycle.buzzes.length > 0) return true;
  return hasEntry(cycle) && [0, 1].every(t => shutOut(entry, t) || teamOut(cycle, t, entry.format));
}

// A set's points, each kept apart: the controlling team's own parts (or its typed total), the
// other team's bounce-backs, and the sweep reward when the controlling team got every part itself.
// Each set is worked out from its own parts alone, so nothing carries from one set to the next.
function bonusPoints(cycle, rules) {
  const ownBonus = [0, 0], bounce = [0, 0], reward = [0, 0];
  if (!playsBonus(cycle)) return { ownBonus, bounce, reward };
  const team = controllingTeam(cycle), { parts, total } = cycle.bonus;
  const { partValue } = rules.bonus;
  const bounceValue = rules.bonus.bounce === 'same' ? partValue : (rules.bonus.bounce ?? 0);
  const count = test => parts.filter(test).length;
  ownBonus[team] = total ?? count(p => p.ctrl === 'got') * partValue;
  bounce[1 - team] = count(p => isOffered(p, rules) && p.other === 'got') * bounceValue;
  if (total === null && parts.length > 0 && parts.every(p => p.ctrl === 'got')) reward[team] = rules.bonus.reward;
  return { ownBonus, bounce, reward };
}

// Bonus numbers (spec 5), worked out in order from the record: per cycle, the set it plays as
// { number, heldKind }, or null when it plays none.
// - Paired: cycle n plays set n, so a dead or no-bonus cycle skips its set.
// - Next unused: a counter starting at 1 moves on only when a bonus is played.
// - UC held sets (paired only): a dead picture or music cycle queues its set. The next correct
//   normal starter plays the oldest held set instead of its own, which is skipped; a correct
//   picture or music starter plays its own set and leaves the queue alone. The starter type is
//   read from the record each time, so changing it during a bonus moves the set.
// A hand override changes only the number shown on its own cycle. `closed` is per cycle.
function bonusNumbers(match, closed) {
  const { rules } = match;
  const paired = rules.bonus.numbering === 'paired';
  const heldSets = paired && rules.bonus.heldSets && rules.starterTypes.on;
  const queue = [];
  let counter = 1;
  return match.cycles.map((cycle, index) => {
    if (!playsBonus(cycle)) {
      const dead = !answered(cycle) && closed[index];
      if (heldSets && dead && cycle.type !== 'normal') queue.push({ number: index + 1, kind: cycle.type });
      return null;
    }
    let set = { number: paired ? index + 1 : counter++, heldKind: null };
    if (heldSets && cycle.type === 'normal' && queue.length > 0) {
      const held = queue.shift();
      set = { number: held.number, heldKind: held.kind };
    }
    return { number: cycle.bonusNumberOverride ?? set.number, heldKind: set.heldKind };
  });
}

const noJail = () => [[false, false, false, false], [false, false, false, false]];

// The state each cycle starts from, worked out in order from the record (spec 5.1), then the
// same for the cycle the next starter action would create:
// - format: the cycle's own; for the next cycle, the one carried on from the last (CARRY_ON);
// - eligible: a Split's seats (a copy), otherwise null;
// - jailed: per seat, whether it is in jail (false for empty seats); jailedOut: per team, whether
//   every named seat is; lockedOut: per team, whether a Double Jump 2nd is closed to it, because
//   the other team got the 1st just before.
// A run of jailbreak cycles is one Jailbreak. A correct answerer is jailed from the next cycle on.
// After each cycle, a team with every named seat jailed breaks jail (all freed, its count up 1)
// when it has four named seats; a short team never does under Brick, and under No Advantage only
// while it has broken fewer times than the other team. Four-seat teams are checked first, so a
// short team can break in the same cycle as its opponents. Any other format ends the Jailbreak.
// A quarter marker ends all carrying on: the first cycle of a quarter carries nothing from the
// one before, so it plays as normal, nobody is jailed and nobody is locked out.
function cycleEntries(match) {
  const { rules } = match;
  const named = match.teams.map(team => [0, 1, 2, 3].filter(seat => seatName(team, seat) !== ''));
  const fullyJailed = (jail, t) => named[t].length > 0 && named[t].every(seat => jail[t][seat]);
  const breakOrder = [0, 1].filter(t => named[t].length === 4).concat([0, 1].filter(t => named[t].length < 4));
  const quarterEnds = new Set(match.markers.filter(m => m.type === 'quarter').map(m => m.afterCycleId));
  let jail = noJail(), breaks = [0, 0], prev = null;
  return [...match.cycles, null].map(cycle => {
    const before = prev && !quarterEnds.has(prev.id) ? prev : null;   // the cycle this one carries on from
    const carried = before ? CARRY_ON[formatOf(before, rules)] ?? 'normal' : 'normal';
    const format = cycle ? formatOf(cycle, rules) : carried;
    if (format !== 'jailbreak' || !before) { jail = noJail(); breaks = [0, 0]; }
    const locker = format === 'doubleJump2' && before && formatOf(before, rules) === 'doubleJump1' && answered(before)
      ? controllingTeam(before) : null;
    const entry = {
      format,
      eligible: format === 'split' ? (cycle ?? before)?.eligible?.map(seats => [...seats]) ?? null : null,
      jailed: jail.map((seats, t) => seats.map((inJail, seat) => inJail && named[t].includes(seat))),
      jailedOut: [0, 1].map(t => fullyJailed(jail, t)),
      lockedOut: [0, 1].map(t => locker !== null && locker !== t),
    };
    if (cycle && format === 'jailbreak') {
      for (const b of cycle.buzzes) if (isCorrect(b) && isTeam(b.team) && isSeat(b.seat)) jail[b.team][b.seat] = true;
      for (const t of breakOrder) {
        const mayBreak = named[t].length === 4 || (rules.trivia.shortJail === 'noAdvantage' && breaks[t] < breaks[1 - t]);
        if (mayBreak && fullyJailed(jail, t)) { jail[t] = [false, false, false, false]; breaks[t] += 1; }
      }
    }
    prev = cycle;
    return entry;
  });
}

// Entries an edit made impossible (spec 6.4): flagged here, never refused. Each flag is the code
// the live entry would have been refused with. (matchFlow adds 'after-end'.)
function cycleFlags(cycle, entry) {
  const flags = [];
  const anyBuzz = test => cycle.buzzes.some(test);
  const anyLost = test => cycle.lostTurn.some(test);
  if (anyBuzz(b => entry.lockedOut[b.team]) || anyLost(t => entry.lockedOut[t])) flags.push('double-jump-locked');
  if (anyBuzz(b => entry.jailed[b.team]?.[b.seat]) || anyLost(t => entry.jailedOut[t])) flags.push('jailed');
  if (entry.format === 'split' && anyBuzz(b => !(entry.eligible?.[b.team] ?? []).includes(b.seat))) flags.push('not-on-this-set');
  return flags;
}

// A cycle's points, from its own record and its entry from cycleEntries().
function scoreCycle(cycle, rules, entry) {
  const { format } = entry;
  const buzzes = cycle.buzzes.map((b, position) => {
    const points = buzzPoints(b, position, cycle, rules, format);
    return { team: b.team, seat: b.seat, result: b.result, points, penalised: points < 0 };
  });
  // A Streak turn scores its answers at the rules' value each, or 0 if it ended on a wrong answer.
  const streak = format !== 'streak' ? [] : cycle.streak.map(s => ({
    team: s.team, seat: s.seat, answers: s.answers, wrong: s.wrong,
    points: s.wrong ? 0 : s.answers * (rules.trivia.streak ?? 0),
  }));
  const tossupPoints = [0, 0];
  for (const b of [...buzzes, ...streak]) tossupPoints[b.team] += b.points;
  const { ownBonus, bounce, reward } = bonusPoints(cycle, rules);
  return {
    format, buzzes, streak, tossupPoints, ownBonus, bounce, reward,
    total: [0, 1].map(t => tossupPoints[t] + ownBonus[t] + bounce[t] + reward[t]),
  };
}

// The overtime rule for the nth overtime starter: under threeThenSuddenDeath the first three are
// 'threeStarters', scored normally with rebounds; every other one is 'suddenDeath'.
const overtimeMode = (rules, number) => (rules.overtime === 'threeThenSuddenDeath' && number <= 3 ? 'threeStarters' : 'suddenDeath');

// Whether some buzz in a cycle leaves the scores apart, counting from `start`, the scores before it.
function apartAfterABuzz(start, buzzes) {
  const score = [...start];
  return buzzes.some(b => {
    score[b.team] += b.points;
    return score[0] !== score[1];
  });
}

// Regulation, overtime and the end of the match (spec 6.3), worked out in order from the record:
// per cycle whether it is closed, whether it is an overtime starter and the running scores, and
// the phase. Regulation ends at the first of these to be reached: the rules' length in cycles
// closes; the length-th bonus round closes (dead starters are not bonus rounds); the cycle a
// time-called marker sits on closes (a marker before the first cycle ends it at once); the last
// quarter's marker is placed (trivia). If the scores are level then, overtime begins and ends the
// match itself: under sudden death once an overtime starter closes with the scores apart, and a
// buzz that leaves them apart closes it at once, with no rebound; under three starters, after the
// third if the scores are apart, otherwise by sudden death from the fourth. Every cycle but the
// last is history, so it counts as finished even if an edit left it open.
// The match ends at the first of: an ended marker; regulation ending with the scores apart (only
// End match is left to do); overtime being decided. Only an edit can leave cycles after that
// point (spec 6.4): they are kept but take no part, so they are left out of the scores, are not
// overtime and play no bonus round, and derive() flags them 'after-end'. `endAt` is the index of
// the first of them, or null.
function matchFlow(match, entries, scored) {
  const { rules, cycles, markers } = match;
  const n = cycles.length;
  const boundaryAfter = id => {
    if (id === null) return 0;
    const index = cycles.findIndex(c => c.id === id);
    return index < 0 ? null : index + 1;
  };
  // Where regulation ends, each as the index of the cycle it ends before; the bonus-round end is
  // added during the walk, once the length-th bonus round is found.
  const { length, unit } = rules.regulation;
  const ends = [];
  if (length != null && unit === 'cycles') ends.push(length);
  const time = markers.find(m => m.type === 'timeCalled');
  if (time) ends.push(boundaryAfter(time.afterCycleId));
  const quarterEnds = markers.filter(m => m.type === 'quarter').map(m => boundaryAfter(m.afterCycleId)).filter(b => b !== null);
  if (rules.trivia && quarterEnds.length >= rules.trivia.quarters) ends.push(Math.max(...quarterEnds));

  const endedMarker = markers.find(m => m.type === 'ended');
  let endAt = endedMarker ? boundaryAfter(endedMarker.afterCycleId) : null;

  const closed = [], overtime = [], running = [];
  const score = [0, 0];
  let regulationEnd = null, level = false, overtimeCount = 0, decided = false, rounds = 0;
  for (let i = 0; i <= n; i++) {
    // Regulation may end where the match does, but never after it.
    const pastEnd = endAt !== null && i > endAt;
    const reached = i < n || n === 0 || closed[n - 1];
    if (!pastEnd && regulationEnd === null && reached && ends.includes(i)) {
      regulationEnd = i;
      level = score[0] === score[1];
      if (!level) endAt = i;
    }
    if (i === n) break;
    if (endAt !== null && i >= endAt) {
      closed.push(isClosed(cycles[i], rules, entries[i]));
      overtime.push(false);
      running.push([...score]);
      continue;
    }
    const inOvertime = regulationEnd !== null && level;
    let isDone = isClosed(cycles[i], rules, entries[i]);
    let mode = null;
    if (inOvertime) {
      overtimeCount += 1;
      mode = overtimeMode(rules, overtimeCount);
      if (mode === 'suddenDeath') isDone ||= apartAfterABuzz(score, scored[i].buzzes);
    }
    closed.push(isDone);
    overtime.push(inOvertime);
    for (const t of [0, 1]) score[t] += scored[i].total[t];
    running.push([...score]);
    const finished = isDone || i < n - 1;
    if (finished && playsBonus(cycles[i])) {
      rounds += 1;
      if (unit === 'bonusRounds' && rounds === length) ends.push(i + 1);
    }
    if (inOvertime && finished && score[0] !== score[1] && (mode === 'suddenDeath' || overtimeCount === 3)) {
      decided = true;
      endAt = i + 1;
    }
  }

  const ended = decided || endedMarker !== undefined;
  // The overtime starter being played, or the next one; once the match has ended, the last.
  // None when the scores were not level at the end of regulation, or when a tie was ended by
  // hand before any overtime was played.
  let overtimePhase = null;
  if (regulationEnd !== null && level && (overtimeCount > 0 || !ended)) {
    const playing = ended || (n > 0 && overtime[n - 1] && !closed[n - 1]);
    const index = playing ? overtimeCount : overtimeCount + 1;
    overtimePhase = { mode: overtimeMode(rules, index), index };
  }
  return {
    closed, overtime, running, endAt,
    phase: {
      halftimeAfterCycleId: halftimeOf(match, closed, regulationEnd),
      regulationOver: regulationEnd !== null,
      overtime: overtimePhase,
      ended,
      et: rules.etLabel === true && ended && overtime.some(Boolean),
      lightning: rules.lightningAfter != null && rounds >= rules.lightningAfter,
      quarter: quarterOf(match),
    },
  };
}

// Halftime: after the cycle a halftime marker names; else after the rules' halftime cycle, once it
// has closed within regulation; null until then.
function halftimeOf(match, closed, regulationEnd) {
  const marker = match.markers.find(m => m.type === 'halftime');
  if (marker) return marker.afterCycleId;
  const after = match.rules.regulation.halftimeAfter, n = match.cycles.length;
  if (!Number.isInteger(after) || after < 1 || after > n) return null;
  const finished = closed[after - 1] || after < n;
  const inRegulation = regulationEnd === null || after <= regulationEnd;
  return finished && inRegulation ? match.cycles[after - 1].id : null;
}

// ---- Stats (spec 6.6, research 6.1) ---------------------------------------------------------
// Worked out from derive()'s own cycles, so they always agree with the scores. A cycle flagged
// 'after-end' is left out of everything (R24), as it is left out of the scores. Points and tallies
// count as soon as they are entered, so a team's stats add up to its score at every moment. A set
// is a bonus heard as soon as it is opened (it is being read to the team, and a set cut off by the
// gong still counts), so PPB never passes its maximum; a starter is heard once its cycle closes.

const ratio = (top, bottom) => (bottom === 0 ? 0 : top / bottom);
const twoDecimals = number => Math.round(number * 100) / 100;

const blankPlayer = (team, seat) => ({
  name: seatName(team, seat), seat,
  powers: 0, tens: 0, negs: 0, wrongs: 0, interruptsNoPenalty: 0, tossupPoints: 0, heard: 0, pp20: 0,
});

const blankTeamStats = score => ({
  score, tossupPoints: 0, ownBonus: 0, bonusesHeard: 0, ppb: 0, partsHeard: 0, partsGot: 0, conversion: 0,
  bounce: { points: 0, partsHeard: 0, partsGot: 0, conversion: 0 },
  rewards: 0, powers: 0, negs: 0, powersPerNeg: null,
});

// What one buzz adds to its player. A neg that cost nothing (a second team's, an unfined music or
// picture buzz, or any interruption under PACE or Schools' Challenge) is a wrong, and also an
// interrupt with no penalty. A Jackpot answer is its result like any buzz.
function tallyBuzz(player, buzz) {
  player.tossupPoints += buzz.points;
  if (buzz.result === 'power') player.powers += 1;
  else if (buzz.result === 'ten') player.tens += 1;
  else if (buzz.penalised) player.negs += 1;
  else {
    player.wrongs += 1;
    if (buzz.result === 'neg') player.interruptsNoPenalty += 1;
  }
}

// A set's parts for the two teams. The controlling team (`own`) heard the parts it marked got or
// missed (not passed, not cut off by the gong). The other team (`opponent`) heard the parts offered
// to it that it has answered; its points come from the cycle, valued by the rules' bounce-back value.
function tallyParts(cycle, rules, own, opponent) {
  for (const part of cycle.bonus.parts) {
    if (part.ctrl === 'got' || part.ctrl === 'missed') {
      own.partsHeard += 1;
      if (part.ctrl === 'got') own.partsGot += 1;
    }
    if (isOffered(part, rules) && part.other !== null) {
      opponent.bounce.partsHeard += 1;
      if (part.other === 'got') opponent.bounce.partsGot += 1;
    }
  }
}

// Per-player and per-team stats from the record and derive()'s cycles; `scores` are derive()'s.
function statsOf(match, cycles, scores) {
  const { rules } = match;
  const players = match.teams.map(team => [0, 1, 2, 3].map(seat => blankPlayer(team, seat)));
  const teams = scores.map(blankTeamStats);
  match.cycles.forEach((cycle, index) => {
    const derived = cycles[index];
    if (derived.flags.includes('after-end')) return;
    for (const buzz of derived.buzzes) tallyBuzz(players[buzz.team][buzz.seat], buzz);
    for (const turn of derived.streak) players[turn.team][turn.seat].tossupPoints += turn.points;
    for (const t of [0, 1]) {
      teams[t].tossupPoints += derived.tossupPoints[t];
      teams[t].ownBonus += derived.ownBonus[t];
      teams[t].bounce.points += derived.bounce[t];
      teams[t].rewards += derived.reward[t];
    }
    if (playsBonus(cycle)) {
      const ctrl = controllingTeam(cycle);
      tallyParts(cycle, rules, teams[ctrl], teams[1 - ctrl]);
      teams[ctrl].bonusesHeard += 1;
    }
    if (derived.closed) {
      for (const team of players) for (const player of team) if (player.name !== '') player.heard += 1;
    }
  });
  for (const team of players) for (const p of team) p.pp20 = ratio(20 * p.tossupPoints, p.heard);
  teams.forEach((team, t) => {
    team.powers = players[t].reduce((sum, p) => sum + p.powers, 0);
    team.negs = players[t].reduce((sum, p) => sum + p.negs, 0);
    team.ppb = twoDecimals(ratio(team.ownBonus, team.bonusesHeard));
    team.conversion = ratio(team.partsGot, team.partsHeard);
    team.bounce.conversion = ratio(team.bounce.partsGot, team.bounce.partsHeard);
    team.powersPerNeg = team.negs === 0 ? null : team.powers / team.negs;
  });
  return { players, teams };
}

// Whether a team may still answer: not kept out by jail or the Double Jump lock, with a turn left
// on the open cycle (if any), and on a Jackpot not yet tried on the clue being read.
function isLive(cycle, team, entry) {
  if (shutOut(entry, team)) return false;
  if (!cycle) return true;
  return !teamOut(cycle, team, entry.format) && !(entry.format === 'jackpot' && triedClue(cycle, team, cycle.clue));
}

// Whether an open starter is the one time was called on with a buzz allowed: it is marked
// allowAfterTime, or (a starter that already had a buzz in, which timeCalled leaves unmarked) it
// carries the time-called marker under rules that do not finish the cycle, since without the
// allowed buzz such a starter is closed or removed at time called.
const waitsAfterTime = (match, cycle) => cycle.allowAfterTime === true
  || (match.rules.atTime !== 'finishCycle' && match.markers.some(m => m.type === 'timeCalled' && m.afterCycleId === cycle.id));

// What can happen next. `cycle` is the open cycle, or null when there is none (the next starter
// action starts one, unless the stage is 'awaitingEnd' or 'ended'); `set` is its entry from
// bonusNumbers() and `entry` its entry from cycleEntries(), so with no cycle open the trivia
// fields describe the cycle the next starter action creates. `afterTimeBuzz`: the open starter
// waits for the one buzz allowed after time called (see waitsAfterTime).
function openState(match, cycle, set, entry, stage) {
  const { format } = entry;
  const clue = cycle?.clue ?? 0;
  return {
    cycleId: cycle?.id ?? null,
    stage,
    liveTeams: [0, 1].map(t => stage === 'starter' && isLive(cycle, t, entry)),
    canPower: stage === 'starter' && powersOn(match.rules),
    afterTimeBuzz: stage === 'starter' && cycle !== null && waitsAfterTime(match, cycle),
    bonus: stage === 'bonus' ? openBonus(cycle, match.rules, set) : null,
    format, clue,
    clueValue: format === 'jackpot' ? match.rules.trivia.jackpot[clue] : null,
    jailed: entry.jailed, eligible: entry.eligible,
  };
}

// The open set for the bonus panel: the controlling team, the set's number and held kind, each
// part with whether it has gone over to the other team, and whether Pass rest (an unmarked part
// left, where the rules allow it) and Enter total (never with bounce-backs) are on offer.
function openBonus(cycle, rules, set) {
  const { parts } = cycle.bonus;
  return {
    team: controllingTeam(cycle), number: set.number, heldKind: set.heldKind,
    parts: parts.map(p => ({ ctrl: p.ctrl, other: p.other, offered: isOffered(p, rules) })),
    canPassRest: rules.bonus.passRest && parts.some(p => p.ctrl === null),
    canTotal: !bounceOn(rules),
  };
}

// The quarter being played (spec 5.1): 1 plus the quarter markers placed, at most the rules'
// number of quarters; null under quizbowl rules.
function quarterOf(match) {
  const { trivia } = match.rules;
  if (!trivia) return null;
  return Math.min(1 + match.markers.filter(m => m.type === 'quarter').length, trivia.quarters);
}

const playerName = (match, team, seat) => seatName(match.teams[team], seat) || `${match.teams[team].name} seat ${seat + 1}`;

// What a buzz did, naming the Jackpot clue: "10", or "jackpot clue 2 (30)", or "jackpot clue 2, wrong".
function buzzWords(buzz, points, format) {
  if (format !== 'jackpot') return RESULT_WORDS[buzz.result];
  const clue = `jackpot clue ${(buzz.clue ?? 0) + 1}`;
  return isCorrect(buzz) ? `${clue} (${points})` : `${clue}, ${RESULT_WORDS[buzz.result]}`;
}

// The latest thing that happened, for the room board: "Q12: Smith, power", "Q8: Jones, streak 4 (20)".
function lastEvent(match, cycles) {
  for (let i = match.cycles.length - 1; i >= 0; i--) {
    const cycle = match.cycles[i], derived = cycles[i], q = `Q${derived.number}`;
    if (cycle.dead) return `${q}: dead`;
    const at = cycle.buzzes.length - 1;
    if (at >= 0) {
      const b = cycle.buzzes[at];
      return `${q}: ${playerName(match, b.team, b.seat)}, ${buzzWords(b, derived.buzzes[at].points, derived.format)}`;
    }
    const turn = derived.streak.at(-1);
    if (turn) {
      return `${q}: ${playerName(match, turn.team, turn.seat)}, streak ${turn.answers}${turn.wrong ? ', wrong' : ` (${turn.points})`}`;
    }
    const lost = cycle.lostTurn.at(-1);
    if (lost !== undefined) return `${q}: ${match.teams[lost].name} lost its turn`;
  }
  return '';
}

// derive()'s result, and for applyAction the open cycle's entry from cycleEntries() (the next
// cycle's when none is open).
function analyse(match) {
  const { rules } = match;
  const entries = cycleEntries(match);
  const scored = match.cycles.map((cycle, index) => scoreCycle(cycle, rules, entries[index]));
  const { closed, overtime, running, endAt, phase } = matchFlow(match, entries, scored);
  const sets = bonusNumbers(match, closed);
  const afterEnd = index => endAt !== null && index >= endAt;
  const cycles = match.cycles.map((cycle, index) => ({
    id: cycle.id, number: index + 1, overtime: overtime[index],
    bonusNumber: sets[index]?.number ?? null, heldKind: sets[index]?.heldKind ?? null,
    ...scored[index],
    running: running[index], closed: closed[index],
    flags: [...cycleFlags(cycle, entries[index]), ...(afterEnd(index) ? ['after-end'] : [])],
  }));
  // Only the last cycle can be open; every earlier one is history. None is open once the match
  // has ended or waits to be ended.
  const awaitingEnd = phase.regulationOver && phase.overtime === null;
  const last = match.cycles.at(-1);
  const openCycle = !phase.ended && !awaitingEnd && last && !closed.at(-1) ? last : null;
  let stage = openCycle && answered(openCycle) ? 'bonus' : 'starter';
  if (awaitingEnd) stage = 'awaitingEnd';
  if (phase.ended) stage = 'ended';
  const entry = openCycle ? entries.at(-2) : entries.at(-1);
  const scores = [...(running.at(-1) ?? [0, 0])];
  return {
    derived: {
      scores,
      cycles,
      open: openState(match, openCycle, openCycle ? sets.at(-1) : null, entry, stage),
      phase,
      stats: statsOf(match, cycles, scores),
      lastEvent: lastEvent(match, cycles),
    },
    entry,
  };
}

export function derive(match) {
  return analyse(match).derived;
}

// The scores a rule change would move (spec 6.4, "Changing a rule mid-match"): one entry per team
// whose score changes, labelled with the team's name, before and after. Nothing is changed.
export function ruleChangeDiff(match, newRules) {
  checkRules(newRules);
  const before = derive(match).scores;
  const after = derive({ ...match, rules: newRules }).scores;
  return [0, 1].filter(t => before[t] !== after[t])
    .map(t => ({ label: match.teams[t].name, before: before[t], after: after[t] }));
}
