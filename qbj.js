// QBJ export (Skor 1.11.0, SPEC-partB section 3; Tom, 5 Nov 2026, decisions 5 and 12, Q1): one bare QB Schema Match per
// game, in the shape MODAQ exports, which YellowFruit 4 imports (File, QBJ Schema, Import Games Only), quizbowlbuzzpoints.com
// takes as an upload, and NAQT gets inside the TD's YellowFruit file. Pure functions of the match record and derive()'s
// result, so the tests run them in Node; the scoresheet's Save QBJ file hands the text to offerFile.
//
// What each reader needs (SPEC-partB 3.1, checked on their code): snake_case keys only, since YellowFruit wipes camelCase
// ones (its own YfData aside); exactly two teams, the left team first; every named player, with tossups heard and
// answer_counts (an empty list when none, which quizbowlbuzzpoints.com reads as "this line-up is complete"); bonus_points,
// never points; one match_questions entry per tossup read, dead ones too, with each buzz's points as Skor scored them (a
// wrong answer after the end is 0: the site does not re-score); overtime counted apart, since YellowFruit refuses 21
// tossups in a 20-tossup game otherwise; _round as a number. Lineups carry the `reason` the schema requires (MODAQ leaves
// it out; neither reader reads lineups). Packet mode's buzz_position and packets come later (SPEC-partB 5.5).

import { derive } from './engine.js';
import { lineupsOf, playerName, playersOf } from './lineup.js';
import { leftRight, teamName } from './view-common.js';
import { isSession } from './session.js';

export const QBJ_TRIVIA = 'QBJ files cannot hold trivia formats';

// Consensus and GradWrite (trivia rules) have jackpots, streaks and quarters a QBJ file has no field for.
// A buzzer session (1.12.0) has up to 10 players a team, which a QBJ file cannot hold: no file, and this line in the button's place.
export const QBJ_SESSION = 'No QBJ file from a buzzer session: QBJ allows 4 players a team.';
export const canSaveQbj = match => !match.rules?.trivia && !isSession(match);
// The line that stands in the QBJ button's place when there is no file, or null when there is one.
export const qbjReason = match => (canSaveQbj(match) ? null : isSession(match) ? QBJ_SESSION : QBJ_TRIVIA);

// The round as YellowFruit and the site need it: a whole number from 1 to 999 (as the TD check page reads a round), typed
// in Match details; otherwise none.
export function qbjRound(match) {
  const typed = String(match.details?.round ?? '').trim();
  return /^\d{1,3}$/.test(typed) && Number(typed) >= 1 ? Number(typed) : null;
}

const STATUS = { open: 'open', upheld: 'upheld', denied: 'denied', withdrawn: 'withdrawn' };
const oneLine = text => String(text ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
const counts = byValue => [...byValue].filter(([value, number]) => value !== 0 && number > 0)
  .sort(([a], [b]) => b - a).map(([value, number]) => ({ answer_type: { value }, number }));
const tally = (map, value) => map.set(value, (map.get(value) ?? 0) + 1);

// The schema's reason for a line-up that starts at question `index` + 1 (index from 1), from what sits between that
// question and the one before: a timeout by the team (own) or the other team, halftime, the start of overtime. A swap at
// none of them (Skor allows one where the rules list no windows) is the schema's catch-all, a break between segments.
function lineupReason(match, d, team, index) {
  const before = match.cycles[index - 1].id;
  const timeout = match.markers.filter(m => m.type === 'timeout' && m.afterCycleId === before);
  if (timeout.some(m => m.team === team)) return 'own_timeout';
  if (timeout.length > 0) return 'other_timeout';
  if (d.phase.halftimeAfterCycleId === before || match.markers.some(m => m.type === 'halftime' && m.afterCycleId === before)) return 'halftime';
  if (d.cycles[index]?.overtime && !d.cycles[index - 1].overtime) return 'before_overtime';
  return 'segment_break';
}

// The QB Schema Match for a buzzer-format match. `d` is derive(match), passed in when the caller has it.
export function toQbj(match, d = derive(match)) {
  if (!canSaveQbj(match)) throw new Error(qbjReason(match));
  const { rules } = match;
  const order = leftRight(match);
  const lineups = lineupsOf(match);
  // The cycles that count: all but those an edit left after the end of the match (spec 6.4). An open question counts:
  // its entries are in Skor's score, so they are in the file, which then adds up to it.
  const counted = d.cycles.map((dc, index) => ({ dc, index, cycle: match.cycles[index] })).filter(({ dc }) => !dc.flags.includes('after-end'));

  // Every named player of each team, as MODAQ lists them (starters by seat, then the bench), with one who never sat at 0
  // tossups heard and no answers. quizbowlbuzzpoints.com needs that: it takes a game's list as complete only when some
  // listed player has no answer (aggregate.ts line 1396), and otherwise credits a teammate missing from the list with the
  // whole game. YellowFruit's sum is unchanged by it while four sit (it expects min(players listed, 4) x tossups read).
  // A buzz from a seat with nobody named in it (a name cleared after the buzz) is the seat's starter, as on the scoresheet.
  const seatId = (index, team, seat) => lineups[index][team][seat] ?? `s${seat}`;
  const nameOf = (team, id) => playerName(match, team, id) || `${teamName(match, team)} seat ${Number(id.slice(1)) + 1}`;
  const players = [0, 1].map(team => {
    const known = playersOf(match, team).map(p => p.id);
    const extra = new Set();
    for (const { dc, index } of counted) for (const b of dc.buzzes) if (b.team === team && !known.includes(seatId(index, team, b.seat))) extra.add(seatId(index, team, b.seat));
    return [...known, ...extra];
  });
  const teamRef = team => ({ name: teamName(match, team), players: players[team].map(id => ({ name: nameOf(team, id) })) });
  const refs = [teamRef(0), teamRef(1)];

  // Packet tossup numbers, MODAQ's sequential rule: each thrown-out tossup moves every later tossup on by one, and the
  // cycle it was thrown out of reads the next one (Deep Bench: thrown out at Q6, so Q6 reads tossup 7 and Q7 tossup 8).
  let thrownSoFar = 0;
  const notes = [];
  const statusLines = [];
  const cycleNotes = [];
  const answers = [0, 1].map(() => new Map());   // per team: id -> Map(value -> count)
  const overtimeBuzzes = [new Map(), new Map()];
  const bonusPoints = [0, 0], bouncePoints = [0, 0];
  const partValue = rules.bonus.partValue;
  const bounceOn = rules.bonus.bounce != null;
  const bounceValue = rules.bonus.bounce === 'same' ? partValue : (rules.bonus.bounce ?? 0);

  const questions = counted.map(({ dc, index, cycle }) => {
    const original = dc.number + thrownSoFar;
    const thrown = (cycle.thrownOut ?? []).filter(t => t.part === 'tossup').length;
    thrownSoFar += thrown;
    const read = { question_number: original + thrown, type: 'tossup', parts: 1 };
    for (let k = 0; k < thrown; k++) notes.push(`Tossup thrown out on question ${original + k}`);
    // A bonus thrown out before the cycle's tossup was thrown out went with that tossup; only one thrown out after the last
    // tossup throw-out is the bonus in the file.
    const throws = cycle.thrownOut ?? [];
    const lastTossupThrow = throws.map(t => t.part).lastIndexOf('tossup');
    const bonusThrown = throws.filter((t, i) => t.part === 'bonus' && i > lastTossupThrow).length;
    if (dc.bonusNumber !== null) for (let k = 0; k < bonusThrown; k++) notes.push(`Bonus thrown out on question ${dc.bonusNumber}`);

    const buzzes = dc.buzzes.map(b => {
      const id = seatId(index, b.team, b.seat);
      tally(answers[b.team].get(id) ?? answers[b.team].set(id, new Map()).get(id), b.points);
      if (dc.overtime) tally(overtimeBuzzes[b.team], b.points);
      return { player: { name: nameOf(b.team, id) }, team: refs[b.team], result: { value: b.points } };
    });
    const q = { question_number: dc.number, tossup_question: read };
    if (thrown > 0) q.replacement_tossup_question = { ...read };
    q.buzzes = buzzes;

    // A bonus played: one part per part, a missed part 0 (and 0 bounced back when bounce-backs are on); a typed total is
    // one part holding it. The sweep reward is in the team's bonus_points but in no part.
    for (const t of [0, 1]) {
      bonusPoints[t] += dc.ownBonus[t] + dc.reward[t];
      bouncePoints[t] += dc.bounce[t];
    }
    if (dc.bonusNumber !== null && cycle.bonus) {
      const set = cycle.bonus;
      const parts = set.total !== null
        ? [{ controlled_points: set.total, ...(bounceOn ? { bounceback_points: 0 } : {}) }]
        : set.parts.map(p => ({
          controlled_points: p.ctrl === 'got' ? partValue : 0,
          ...(bounceOn ? { bounceback_points: p.ctrl === 'missed' && p.other === 'got' ? bounceValue : 0 } : {}),
        }));
      const question = { question_number: dc.bonusNumber, type: 'bonus', parts: parts.length };
      if (bonusThrown > 0) {
        // As MODAQ writes a protest replacement: the set read first is a bare marker, the replacement holds the parts.
        q.bonus = { question: { ...question }, parts: [] };
        q.replacement_bonus = { question, parts };
      } else q.bonus = { question, parts };
    }

    // Protests in MODAQ's words, by the tossup or bonus actually read; then Skor's own status line for each, and the note.
    const protests = cycle.protests ?? [];
    for (const p of protests.filter(p => p.part === 'tossup')) {
      notes.push(`Tossup protest on tossup #${read.question_number}. Team "${teamName(match, p.team)}" protested because of this reason: "${oneLine(p.text)}".`);
    }
    for (const p of protests.filter(p => p.part !== 'tossup')) {
      notes.push(`Bonus protest on bonus #${dc.bonusNumber ?? '?'}. Team "${teamName(match, p.team)}" protested part ${p.part} because of this reason: "${oneLine(p.text)}".`);
    }
    for (const p of [...protests.filter(p => p.part === 'tossup'), ...protests.filter(p => p.part !== 'tossup')]) {
      statusLines.push(`Protest status: Q${dc.number} ${p.part === 'tossup' ? 'tossup' : `bonus part ${p.part}`}, ${STATUS[p.status] ?? 'open'}.`);
    }
    for (const t of cycle.thrownOut ?? []) {
      if (oneLine(t.note)) cycleNotes.push(`Q${dc.number} ${t.part === 'tossup' ? 'tossup' : 'bonus'} thrown out: ${oneLine(t.note)}`);
    }
    if (oneLine(cycle.note)) cycleNotes.push(`Q${dc.number} note: ${oneLine(cycle.note)}`);
    return q;
  });

  const read = counted.length;
  const overtimeRead = counted.filter(({ dc }) => dc.overtime).length;
  // A seat's own id (s3) stands for a buzz from a seat with nobody named in it: it heard every question that seat was empty.
  const heard = (team, id) => counted.filter(({ index }) => lineups[index][team].includes(id)
    || (/^s\d$/.test(id) && lineups[index][team][Number(id.slice(1))] == null)).length;

  const matchTeam = team => {
    const out = { team: refs[team], bonus_points: bonusPoints[team] };
    if (bounceOn) out.bonus_bounceback_points = bouncePoints[team];
    // A line-up from Q1, then one at each question where the team's seats change.
    out.lineups = counted.flatMap(({ index }, k) => {
      const seats = lineups[index][team];
      if (k > 0 && seats.join() === lineups[counted[k - 1].index][team].join()) return [];
      return [{ first_question: k + 1, players: seats.filter(Boolean).map(id => ({ name: nameOf(team, id) })), reason: k === 0 ? 'initial' : lineupReason(match, d, team, index) }];
    });
    out.match_players = players[team].map(id => ({
      player: { name: nameOf(team, id) }, tossups_heard: heard(team, id), answer_counts: counts(answers[team].get(id) ?? []),
    }));
    if (overtimeRead > 0) out.YfData = { overTimeBuzzes: counts(overtimeBuzzes[team]) };
    return out;
  };

  const qbj = { tossups_read: read };
  if (overtimeRead > 0) qbj.overtime_tossups_read = overtimeRead;
  qbj.match_teams = order.map(matchTeam);
  qbj.match_questions = questions;
  const round = qbjRound(match);
  if (round !== null) qbj._round = round;
  const detail = key => String(match.details?.[key] ?? '').trim();
  if (detail('room')) qbj.location = detail('room');
  if (detail('reader')) qbj.moderator = detail('reader');
  if (detail('scorer')) qbj.scorekeeper = detail('scorer');
  const allNotes = [...notes, ...statusLines, ...cycleNotes];
  if (allNotes.length > 0) qbj.notes = allNotes.join('\n');
  return qbj;
}

// The file's text: the Match as JSON, two spaces deep, ending in a newline.
export const qbjText = (match, d = derive(match)) => `${JSON.stringify(toQbj(match, d), null, 2)}\n`;

// ---- The file name (SPEC-partB 3.6) ----------------------------------------------------------------------------------

const pad = number => String(number).padStart(2, '0');
// Text fit for a file name, as files.js cleans a team name: no characters a file system refuses, one space at a time,
// accents and emoji kept, cut by letters so an emoji on the cut goes whole.
const edges = text => text.replace(/^[\s.]+|[\s.]+$/g, '');
const clean = (text, limit) => edges(Array.from(edges(String(text ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ')))
  .slice(0, limit).join(''));

// "R03 Room2 Edinburgh A v Oxford B.qbj": the round as two digits, the room with its spaces taken out (a room typed as a
// bare number is "Room4"), then the teams, the left one first. With no round the day the match started goes after the
// teams in brackets ("Edinburgh A v Oxford B (2026-11-07).qbj"), so two practice games between the same teams do not
// share a name, and quizbowlbuzzpoints.com, which takes a file's round from the first number followed by a space, _ or .,
// does not read the day as the round. At most 120 characters and 240 bytes (file systems allow 255).
export function qbjFileName(match) {
  const round = qbjRound(match);
  const roomText = clean(match.details?.room, 20).replace(/\s+/g, '');
  const room = /^\d+$/.test(roomText) ? `Room${roomText}` : roomText;
  const teams = leftRight(match).map(team => clean(teamName(match, team), 40) || `Team ${'AB'[team]}`);
  const created = typeof match.createdAt === 'number' ? new Date(match.createdAt) : null;
  const day = created && Number.isFinite(created.getTime()) ? `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}` : '';
  const pieces = [round !== null ? `R${pad(round)}` : '', room, `${teams[0]} v ${teams[1]}`, round === null && day ? `(${day})` : ''];
  let stem = Array.from(pieces.filter(Boolean).join(' ')).slice(0, 116);
  while (new TextEncoder().encode(stem.join('')).length > 236) stem = stem.slice(0, -1);
  return `${edges(stem.join(''))}.qbj`;
}
