// Who sits where (v2 4.1 to 4.3): the players of a team, the line-up in each question, and which swap
// windows are open. The record holds only facts: `team.seats` (the starters), `team.bench` (names), and
// the swap markers { type: 'sub', team, seat, player, afterCycleId, at }. Everything here is worked out
// from them, never stored (v2 1.3), and none of it changes a score (v2 1.4).
//
// A player is an id: 's0' to 's3' for the starter in that seat, 'b0', 'b1'... for the bench place in
// `team.bench`. The id, not the name, ties stats to a person, so two players with one name never merge.
// A line-up is four seats a team, each an id or null (nobody there). A swap marker after cycle p
// (afterCycleId null: before Q1) takes effect from cycle p + 1, so a swap never reaches back.
//
// engine.js imports this file. This file imports engine.js for derive() alone, which swapWindow() calls
// when it is not handed derive()'s result; neither file calls the other while it loads, so the two
// importing each other is safe.
//
// A buzzer session (SPEC-partB 6, session.js) has 11 places a team instead of 4 seats: 's0' to 's9' for named places and
// 's10' for Other, who is always seated and always named Other (playersOf marks it `other: true`). A session's move is
// one marker, { type: 'move', team, seat, player, toSeat, toPlayer, afterCycleId, at }, that empties its old place and
// fills the new one on the other team at the same boundary. Nothing here changes for a game.

import { derive } from './engine.js';
import { isSession, OTHER_NAME, OTHER_PLACE, seatCount } from './session.js';

// The swap rules of a record that has none (anything saved before version 2): no windows listed, so a swap
// never warns. Always a new object, so no caller can change the next one.
export function defaultSubsRules() {
  return { windows: null, source: '' };
}

// The match's swap rules with every field present.
export const subsRules = match => ({ ...defaultSubsRules(), ...match.rules?.subs });

const isTeam = team => team === 0 || team === 1;
const isSeat = (seat, match) => Number.isInteger(seat) && seat >= 0 && seat < seatCount(match);
const seatNumbers = match => Array.from({ length: seatCount(match) }, (_, seat) => seat);
const trimmed = value => (typeof value === 'string' ? value.trim() : '');
const benchOf = team => (Array.isArray(team?.bench) ? team.bench : []);
const starterName = (team, seat) => trimmed(team?.seats?.[seat]);
const isOtherSeat = (match, seat) => isSession(match) && seat === OTHER_PLACE;
// The name in a seat of team `t`: what the record holds, trimmed; a session's place 10 is always Other.
const seatName = (match, t, seat) => (isOtherSeat(match, seat) ? OTHER_NAME : starterName(match.teams[t], seat));

// An id's name, trimmed: '' for an unnamed place, an id that is not there, or anything that is not an id.
export function playerName(match, team, id) {
  const parsed = typeof id === 'string' ? /^([sb])(0|[1-9]\d*)$/.exec(id) : null;
  const t = match.teams?.[team];
  if (!parsed || !t) return '';
  const place = Number(parsed[2]);
  if (parsed[1] === 's') return place < seatCount(match) ? seatName(match, team, place) : '';
  return trimmed(benchOf(t)[place]);
}

// The players a team can field: its named starters in seat order, then its named bench. `seat` is the
// starter's own seat, and null for the bench. An unnamed starter seat or bench place is nobody. A session's Other
// (place 10) is one of its players, marked `other: true`.
export function playersOf(match, team) {
  const t = match.teams[team];
  const starters = seatNumbers(match).flatMap(seat => (seatName(match, team, seat) === '' ? []
    : [{ id: `s${seat}`, name: seatName(match, team, seat), seat, ...(isOtherSeat(match, seat) ? { other: true } : {}) }]));
  const bench = benchOf(t).flatMap((name, place) => (trimmed(name) === '' ? [] : [{ id: `b${place}`, name: trimmed(name), seat: null }]));
  return [...starters, ...bench];
}

// The seats a marker changes: a swap its one seat; a session's move two, its old place emptied and its new one on the
// other team filled. Anything else, or a marker that is not well formed, changes none.
function seatChanges(match, marker) {
  if (marker.type === 'sub' && isTeam(marker.team) && isSeat(marker.seat, match)) {
    return [{ team: marker.team, seat: marker.seat, player: typeof marker.player === 'string' ? marker.player : null }];
  }
  if (marker.type === 'move' && isSession(match) && isTeam(marker.team) && isSeat(marker.seat, match) && isSeat(marker.toSeat, match)
    && typeof marker.toPlayer === 'string') {
    return [{ team: marker.team, seat: marker.seat, player: null }, { team: 1 - marker.team, seat: marker.toSeat, player: marker.toPlayer }];
  }
  return [];
}

// The seat changes in marker order, each with the cycle it takes effect from (`boundary`: the index of
// the first cycle it reaches). A marker whose cycle is not in the record, or that is not well formed, is left out.
function swapsOf(match) {
  const position = new Map(match.cycles.map((cycle, index) => [cycle.id, index + 1]));
  return match.markers.flatMap(marker => {
    const changes = seatChanges(match, marker);
    if (changes.length === 0) return [];
    const boundary = (marker.afterCycleId ?? null) === null ? 0 : position.get(marker.afterCycleId);
    return boundary === undefined ? [] : changes.map(change => ({ boundary, ...change }));
  });
}

// The seats each team starts with: its named starters (and a session's Other).
const startingSeats = match => match.teams.map((_, t) => seatNumbers(match).map(seat => (seatName(match, t, seat) === '' ? null : `s${seat}`)));

// The seats at cycle `index`: the starting seats with every swap that has taken effect by then applied, in marker order.
const seatsAt = (start, swaps, index) => {
  const seats = start.map(team => [...team]);
  for (const swap of swaps) if (swap.boundary <= index) seats[swap.team][swap.seat] = swap.player;
  return seats;
};

// The line-up for the cycle at position `index` (0 is Q1): [team A's four seats, team B's four seats] (a session's 11
// places), each an id or null. An index equal to the number of cycles is the next cycle, the one not yet started.
export function lineupAt(match, index) {
  return seatsAt(startingSeats(match), swapsOf(match), index);
}

// The line-up of every cycle, and then of the next one: lineupAt(match, i) for i from 0 to the number of cycles.
export function lineupsOf(match) {
  const start = startingSeats(match), swaps = swapsOf(match);
  return Array.from({ length: match.cycles.length + 1 }, (_, index) => seatsAt(start, swaps, index));
}

// The windows open for a swap placed after the last cycle (v2 4.2), in this order, given derive()'s phase.
// The caller makes sure no cycle is open:
// - halftime: the last cycle is the halftime cycle;
// - beforeOvertime: regulation has ended with the scores level, and no overtime starter has been played;
// - timeout: a timeout marker sits after the last cycle;
// - quarter: a quarter marker sits after the last cycle (Consensus and GradWrite).
export function windowsOpen(match, phase) {
  const last = match.cycles.at(-1) ?? null;
  const id = last?.id ?? null;
  const markedAfter = type => match.markers.some(marker => marker.type === type && (marker.afterCycleId ?? null) === id);
  const open = [];
  if (last && phase.halftimeAfterCycleId === id) open.push('halftime');
  if (phase.regulationOver && phase.overtime?.index === 1 && !phase.ended) open.push('beforeOvertime');
  if (markedAfter('timeout')) open.push('timeout');
  if (markedAfter('quarter')) open.push('quarter');
  return open;
}

// Whether a swap now is inside the rules' windows: always when the rules list none (windows null, unknown),
// otherwise when one of the windows they list is open. An empty list is never inside.
export function inWindow(match, phase) {
  const { windows } = subsRules(match);
  if (!Array.isArray(windows)) return true;
  const open = windowsOpen(match, phase);
  return windows.some(window => open.includes(window));
}

// The windows open right now, from the record alone (derive() is worked out unless the caller has it
// to hand). None while a question is open: nothing can be swapped then.
export function swapWindow(match, derived = derive(match)) {
  return derived.open.cycleId === null ? windowsOpen(match, derived.phase) : [];
}
