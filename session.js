// Buzzer sessions (Skor 1.12.0, SPEC-partB section 6): a practice, not a game, with up to 10 named players a team and an
// Other place for everyone not named, where people arrive, leave and change team as numbers even out. Games are untouched.
//
// The record (spec 6.3). `match.session = true` marks a session; a game has no `session` field at all, so every older
// match, backup, link and Games file reads exactly as before. In a session each team's `seats` holds 11 places: 0 to 9
// for named players and 10 for Other. Place 10 is written 'Other' and always read as Other, whatever it holds: Other is
// the player with id 's10' on the team's list (playersOf gives it `other: true`), it sits in place 10 from start to end,
// and the engine refuses to swap, move or take it off ('other-fixed'); no action renames anyone. A late arrival or a
// moved player goes on the team's bench list underneath (no bench is shown in a session) and is seated by a marker, so
// lineup.js works out who sat where, question by question, just as it does for a game's swaps.
//
// The engine actions (engine.js lists them with the swaps). Each is one undoable version, between questions only:
// - { type: 'move', team, seat }: the player in place `seat` of `team` goes to the other team's first empty named place,
//   and their old place is emptied. Marker: { type: 'move', team, seat, player, toSeat, toPlayer, afterCycleId, at }:
//   `player` is their id on `team`, `toPlayer` their id on the other team: a new line on its list, or the line they had
//   there before if they came from it, so a player who moves back has one row a team. Figures stay with each team.
// - { type: 'addPlayer', team, name }: a late arrival, added to the team's list and seated in its first empty named place.
//   Marker: an ordinary swap, { type: 'sub', team, seat, player, afterCycleId, at }, so tossups heard count from the
//   next question and are never back-dated.
// Both are refused 'team-full' when the receiving team already has 10 named players seated, with the words the page shows
// (fullTeamText). Leaving ("Take off") is the swap { type: 'sub', team, seat, player: null }; in a session no swap is
// refused for being outside the rules' windows (decision 5b).
//
// engine.js and lineup.js import this file, and it imports them for RefusedError, lineupAt and playerName,
// used only inside functions, so the files importing each other is safe in any order (as protests.js does).

import { RefusedError } from './engine.js';
import { lineupAt, playerName } from './lineup.js';

export const GAME_SEATS = 4;           // a game's seats a team
export const NAMED_PLACES = 10;        // a session's named places, 0 to 9
export const OTHER_PLACE = 10;         // Other's place in a session
export const SESSION_PLACES = 11;      // a session's places a team: the named ones, then Other
export const OTHER_ID = 's10';
export const OTHER_NAME = 'Other';

export const isSession = match => match?.session === true;

// Trivia rules in a session (1.15.0, Tom's answers of 22 Nov 2026). Only the named places go to jail in a Jailbreak, never
// Other, which is several people. `trivia.sessionBreak` says when a team breaks out: 'four' when four of its named players are
// out (the default, and what a rules record without the field means), 'all' when every named player sitting is out.
export const SESSION_BREAKS = ['four', 'all'];
export const jailPlaces = () => Array.from({ length: NAMED_PLACES }, (_, place) => place);
export const sessionBreakOf = rules => (rules?.trivia?.sessionBreak === 'all' ? 'all' : 'four');

// Other is on every team already, so no named player may be called it (any case, trimmed): refused in Add player and at setup.
export const OTHER_NAME_TEXT = 'Other is already on every team. Use another name.';
export const isOtherName = name => String(name ?? '').trim().toLowerCase() === OTHER_NAME.toLowerCase();

// The places a team has: 4 in a game, 11 in a session. Every seat loop in engine.js, lineup.js and app.js runs to this.
export const seatCount = match => (isSession(match) ? SESSION_PLACES : GAME_SEATS);

// A team's `seats` given its full number of places (newMatch, and app.js withDefaults for a match from outside): a game
// is padded or cut to 4 as before; a session to 11, with Other written into place 10.
export function paddedSeats(match, seats) {
  const padded = Array.from({ length: seatCount(match) }, (_, seat) => seats?.[seat] ?? '');
  if (isSession(match)) padded[OTHER_PLACE] = OTHER_NAME;
  return padded;
}

// The team's name as the screen shows it (view-common.js teamName).
const teamWord = (match, team) => String(match.teams[team]?.name ?? '').trim() || `Team ${'AB'[team]}`;

// The refusal when a team has no named place left: "Nick already has 10 named players. Take one off first."
export const fullTeamText = (match, team) => `${teamWord(match, team)} already has ${NAMED_PLACES} named players. Take one off first.`;

// Who sits in each of the team's places for the next question: ids, or null for an empty place.
const nextSeats = (match, team) => lineupAt(match, match.cycles.length)[team];
const namedOnly = seats => seats.slice(0, NAMED_PLACES);

// The first empty named place (0 to 9) for the next question, or null when all 10 are filled.
export function firstEmptyPlace(match, team) {
  const place = namedOnly(nextSeats(match, team)).indexOf(null);
  return place < 0 ? null : place;
}

// How many named players sit for the next question (Other not counted).
export const namedCount = (match, team) => namedOnly(nextSeats(match, team)).filter(id => id !== null).length;

// How many named places the scoring screen shows for a team (spec 6.5): up to the highest named place used so far in the
// match, typed at setup or filled since by an arrival, a swap or a move (even one undone by a later swap before any
// question was played), so the grid never shrinks as players leave: an empty place stays as a blank box. 0 for a team
// with nobody named yet. Other is drawn after them. A game always shows its 4 seats.
export function shownPlaces(match, team) {
  if (!isSession(match)) return GAME_SEATS;
  const used = namedOnly(match.teams[team].seats ?? []).flatMap((name, place) => (String(name ?? '').trim() === '' ? [] : [place]));
  for (const marker of match.markers) {
    if (marker.type === 'sub' && marker.team === team && typeof marker.player === 'string') used.push(marker.seat);
    if (marker.type === 'move' && marker.team === 1 - team) used.push(marker.toSeat);
  }
  const named = used.filter(place => Number.isInteger(place) && place >= 0 && place < NAMED_PLACES);
  return named.length === 0 ? 0 : Math.max(...named) + 1;
}

// A team's places in the order the scoring screen draws them, which is also the order keys 1 to 9, 0 and - pick them:
// in a session the shown named places, then Other; in a game the 4 seats in the display's seat order (1 to 4 or 4 to 1).
export function screenPlaces(match, team) {
  if (!isSession(match)) return match.display?.seatOrder === 'desc' ? [3, 2, 1, 0] : [0, 1, 2, 3];
  return [...Array.from({ length: shownPlaces(match, team) }, (_, place) => place), OTHER_PLACE];
}

// ---- Engine hooks ------------------------------------------------------------------------------------

const isTeam = team => team === 0 || team === 1;
const isPlace = (match, seat) => Number.isInteger(seat) && seat >= 0 && seat < seatCount(match);
const OTHER_FIXED = 'Other always sits in its own place: it cannot be swapped, moved or taken off';

function checkSession(match) {
  if (!isSession(match)) throw new RefusedError('not-a-session', 'players change team or join mid-match only in a buzzer session');
}
function checkBetweenQuestions(open) {
  if (open.cycleId !== null) throw new RefusedError('question-open', 'finish the open question first');
}
function checkRoom(match, team) {
  if (firstEmptyPlace(match, team) === null) throw new RefusedError('team-full', fullTeamText(match, team));
}

// What a session adds to a swap's refusals (engine.js sub): nobody takes Other's place, and Other takes nobody's.
export function checkSessionSub(match, { team, seat, player }) {
  if (isSession(match) && (seat === OTHER_PLACE || player === OTHER_ID)) throw new RefusedError('other-fixed', OTHER_FIXED);
  const elsewhere = typeof player === 'string' ? playingElsewhere(match, team, player) : null;
  if (elsewhere !== null) throw new RefusedError('playing-elsewhere', `${playerName(match, team, player)} is playing for ${elsewhere}. Move them with Players.`);
}

// A session player who moved has a line on each team, and the two are one person. When the other team's line is seated now,
// this is that team's name (so the swap screen and the engine both leave this line out); otherwise null.
export function playingElsewhere(match, team, player) {
  if (!isSession(match) || !isTeam(team) || typeof player !== 'string') return null;
  const lines = [[team, player]];
  for (let grew = true; grew;) {
    grew = false;
    for (const m of match.markers) {
      if (m.type !== 'move') continue;
      const pair = [[m.team, m.player], [1 - m.team, m.toPlayer]];
      const has = pair.map(([t, id]) => lines.some(([lt, lid]) => lt === t && lid === id));
      for (let i = 0; i < 2; i += 1) {
        if (has[1 - i] && !has[i]) { lines.push(pair[i]); grew = true; }
      }
    }
  }
  const away = lines.find(([t, id]) => t !== team && nextSeats(match, t).includes(id));
  return away ? teamWord(match, away[0]) : null;
}

// Deleting a marker must not strand a buzz: a player who sat in a place only because of the marker, and has a buzz there,
// would lose it from the player rows. `match` is the record before the delete and `left` the record without the marker.
// Returns refusal text or null.
export function strandedBuzzText(match, left) {
  if (!isSession(match)) return null;
  const was = match.cycles.map((_, c) => lineupAt(match, c));
  const now = match.cycles.map((_, c) => lineupAt(left, c));
  for (let c = 0; c < match.cycles.length; c += 1) {
    for (const b of match.cycles[c].buzzes) {
      const id = was[c][b.team][b.seat];
      if (id !== null && id !== now[c][b.team][b.seat]) return `${playerName(match, b.team, id)} has answers after joining. Change those first.`;
    }
  }
  return null;
}

// A new line on a team's list (its bench underneath), returning its id.
function newListEntry(match, team, name) {
  const side = match.teams[team];
  if (!Array.isArray(side.bench)) side.bench = [];
  side.bench.push(name);
  return `b${side.bench.length - 1}`;
}

// The player's own line on the other team's list, when an earlier move brought them from there and that line is not
// seated there now; otherwise null.
function formerLine(match, team, player) {
  const to = 1 - team;
  const came = [...match.markers].reverse().find(m => m.type === 'move' && m.team === to && m.toPlayer === player);
  if (!came || typeof came.player !== 'string') return null;
  return nextSeats(match, to).includes(came.player) ? null : came.player;
}

// Deleting a marker in a session must not strand a later move: every move marker left must still find its player in the
// place it empties, just before it. `left` is the match without the deleted marker. Returns refusal text or null.
export function strandedMoveText(left) {
  if (!isSession(left)) return null;
  for (let k = 0; k < left.markers.length; k += 1) {
    const marker = left.markers[k];
    if (marker.type !== 'move') continue;
    const before = { ...left, markers: left.markers.slice(0, k) };
    if (lineupAt(before, left.cycles.length)[marker.team][marker.seat] !== marker.player) {
      return `${playerName(left, marker.team, marker.player)}'s move to ${teamWord(left, 1 - marker.team)} depends on this. Delete that move first.`;
    }
  }
  return null;
}

// The arrival side of the same rule: a later arrival (Add player, a swap or a move's new place) that went into an empty place
// must still find it empty without the deleted marker, or it would silently overwrite whoever was left there. `match` is
// the record before the delete and `index` the marker deleted. Returns refusal text or null.
export function strandedArrivalText(match, index) {
  if (!isSession(match)) return null;
  const seatsBefore = (markers, k) => lineupAt({ ...match, markers: markers.slice(0, k) }, match.cycles.length);
  const left = match.markers.filter((_, place) => place !== index);
  for (let k = index + 1; k < match.markers.length; k += 1) {
    const marker = match.markers[k];
    const fills = marker.type === 'sub' && typeof marker.player === 'string' ? { team: marker.team, seat: marker.seat, player: marker.player }
      : marker.type === 'move' ? { team: 1 - marker.team, seat: marker.toSeat, player: marker.toPlayer } : null;
    if (!fills) continue;
    const was = seatsBefore(match.markers, k)[fills.team][fills.seat];
    const now = seatsBefore(left, k - 1)[fills.team][fills.seat];
    if (was === null && now !== null) {
      return `${playerName(match, fills.team, fills.player)} joins ${teamWord(match, fills.team)} in the place this frees. Delete that first.`;
    }
  }
  return null;
}

const lastCycleId = match => match.cycles.at(-1)?.id ?? null;

// The move action (engine.js 'move'), with the engine's handler arguments.
export function movePlayer(match, { team, seat }, open, _entry, _phase, now) {
  checkSession(match);
  if (!isTeam(team) || !isPlace(match, seat)) throw new RefusedError('bad-action', `a move needs team 0 or 1 and a place 0 to ${NAMED_PLACES - 1}`);
  checkBetweenQuestions(open);
  if (seat === OTHER_PLACE) throw new RefusedError('other-fixed', OTHER_FIXED);
  const player = nextSeats(match, team)[seat];
  if (player === null) throw new RefusedError('empty-seat', `${teamWord(match, team)} has nobody in place ${seat + 1}`);
  const to = 1 - team;
  checkRoom(match, to);
  const toSeat = firstEmptyPlace(match, to);
  const toPlayer = formerLine(match, team, player) ?? newListEntry(match, to, playerName(match, team, player));
  match.markers.push({ type: 'move', team, seat, player, toSeat, toPlayer, afterCycleId: lastCycleId(match), at: now });
}

// The Add player action (engine.js 'addPlayer'): the name trimmed and otherwise kept as typed, as a bench name is.
export function addPlayer(match, { team, name }, open, _entry, _phase, now) {
  checkSession(match);
  if (!isTeam(team) || typeof name !== 'string') throw new RefusedError('bad-action', 'Add player needs team 0 or 1 and a name');
  if (name.trim() === '') throw new RefusedError('empty-name', 'a new player needs a name');
  if (isOtherName(name)) throw new RefusedError('reserved-name', OTHER_NAME_TEXT);
  checkBetweenQuestions(open);
  checkRoom(match, team);
  const seat = firstEmptyPlace(match, team);
  match.markers.push({ type: 'sub', team, seat, player: newListEntry(match, team, name.trim()), afterCycleId: lastCycleId(match), at: now });
}

// A session's stats rows for one team (engine.js statsOf), from its rows for all 11 places and then its list: the named
// players who sat (in any question, or for the next one), places first and then the list in the order people joined,
// then Other last. Other's points per 20 is blank (null): Other is several people. A row with figures is never dropped.
export function sessionRows(rows, team, lineups) {
  const sat = new Set(lineups.flatMap(lineup => lineup[team]));
  const tallied = row => row.heard > 0 || row.tossupPoints !== 0 || row.powers + row.tens + row.negs + row.wrongs > 0;
  const named = rows.filter(row => row.id !== OTHER_ID && row.name !== '' && (sat.has(row.id) || tallied(row)));
  const other = rows.find(row => row.id === OTHER_ID);
  return [...named, { ...other, other: true, pp20: null }];
}
