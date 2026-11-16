// The tournament file on Setup (Skor 1.11.0, SPEC-partB 3.4 and 3.5): a QBJ registration or tournament file, the one the
// TD makes at quizbowlreader.com/createTournamentFile.html (MODAQ links it) or in YellowFruit, read by the TD check page's
// own reader (td-check.js readTournament: the three shapes MODAQ reads, $ref followed). It is kept as its text under
// scorer.tournament until removed, and read again each time Setup draws, so a damaged copy is ignored with a message. No
// screen code here, for the tests; view-setup.js draws it.

import { readTournament, fold } from './td-check.js';
import { loadTournamentText, saveTournamentText } from './storage.js';

export const NOT_IN_TOURNAMENT = 'not in the tournament file';
const DAMAGED = 'The saved tournament file is damaged, so it is not used. Remove it and load it again.';
const NOT_KEPT = 'The tournament file could not be kept on this device: its storage may be full or blocked.';
const ROUND_NEEDED = 'Type the round as a whole number from 1 to 999 in Match details: YellowFruit needs it to file the game.';
const GAME_FILE = 'This is a game file, not the tournament file. Games are checked on the TD check page (Home, TD check page).';

// The saved file, read: null when none is saved (or the store cannot be read), { ok: false, error } when it is damaged,
// otherwise readTournament's { ok: true, name, teams }.
export function readSavedTournament(store) {
  const text = loadTournamentText(store);
  if (text === null) return null;
  const read = readTournament(text);
  return read.ok ? read : { ok: false, error: DAMAGED };
}

// Reads a file the person chose and keeps it only if it is a tournament file: { ok: true, tournament } or { ok: false, error }.
// Only its name, teams and players are kept, as a small tournament file of the same shape: a whole-tournament export with
// its games can run to megabytes, room the device's saved matches need.
export function saveTournamentFile(text, store) {
  const read = readTournament(text);
  if (!read.ok) return /game file/.test(read.error) ? { ok: false, error: GAME_FILE } : read;
  const kept = { version: '2.1.1', objects: [{ type: 'Tournament', ...(read.name ? { name: read.name } : {}), registrations: [{ type: 'Registration',
    teams: read.teams.map(team => ({ name: team.name, players: team.players.map(name => ({ name })) })) }] }] };
  if (!saveTournamentText(JSON.stringify(kept), store).ok) return { ok: false, error: NOT_KEPT };
  return { ok: true, tournament: read };
}

// "Tournament: Deep Bench 2026 (24 teams)", or "Tournament file (24 teams)" for a file with no tournament name.
export function tournamentLine(tournament) {
  const teams = `${tournament.teams.length} team${tournament.teams.length === 1 ? '' : 's'}`;
  return tournament.name ? `Tournament: ${tournament.name} (${teams})` : `Tournament file (${teams})`;
}

// The registered team a typed name means: the same name, else the same after folding case, accents, apostrophes and
// repeated spaces (td-check.js fold). Null for none, or with no file.
export function findTeam(tournament, name) {
  if (!tournament?.ok) return null;
  const typed = String(name ?? '').trim();
  if (!typed) return null;
  return tournament.teams.find(team => team.name === typed) ?? tournament.teams.find(team => fold(team.name) === fold(typed)) ?? null;
}

// MODAQ's rule for a picked team: its first four players in the seats, the rest on the bench. Names are tidied as a name box
// shows them (spaces round them and line breaks go), so the boxes can be compared with the roster afterwards.
export function rosterSeats(team) {
  const players = (team.players ?? []).map(name => String(name ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { seats: [0, 1, 2, 3].map(seat => players[seat] ?? ''), bench: players.slice(4) };
}

// What picking `team` does to a team card that holds `card` ({ seats, bench }): 'none' when it is the team already filled
// in; 'fill' at once when every box is empty, or when the boxes still hold exactly the team filled in before (`previous`),
// so typing "Oxford B" past "Oxford" refills; otherwise 'ask', since names typed by hand are never replaced unasked.
export function fillPlan(card, team, previous) {
  const typed = [...card.seats, ...(card.bench ?? [])].map(name => String(name ?? '').trim());
  if (typed.every(name => name === '')) return 'fill';
  if (previous && previous === team) return 'none';
  if (previous) {
    const was = rosterSeats(previous);
    const held = [...was.seats, ...was.bench];
    const now = typed.filter((name, i) => i < 4 || name !== '');
    if (now.length === held.length && now.every((name, i) => name === held[i])) return 'fill';
  }
  return 'ask';
}

// With a tournament file loaded, the round must be a whole number from 1 to 999 before Start, as qbj.js writes it ('' when
// it is, with no usable file, or for a trivia match, which saves no QBJ file).
export function roundProblem(round, tournament, rules = null) {
  if (!tournament?.ok || rules?.trivia) return '';
  const typed = String(round ?? '').trim();
  return /^\d{1,3}$/.test(typed) && Number(typed) >= 1 ? '' : ROUND_NEEDED;
}
