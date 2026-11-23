// The tournament file on Setup (Skor 1.11.0, SPEC-partB 3.4 and 3.5): a QBJ registration or tournament file, the one the
// TD makes at quizbowlreader.com/createTournamentFile.html (MODAQ links it) or in YellowFruit, read by the TD check page's
// own reader (td-check.js readTournament: the three shapes MODAQ reads, $ref followed). It is kept as its text under
// scorer.tournament until removed, and read again each time Setup draws, so a damaged copy is ignored with a message. No
// screen code here, for the tests; view-setup.js draws it.

import { fold } from './td-check.js';
import { readTournamentFile, scheduleToPhases, mergeAfternoon } from './schedule.js';
import { loadTournamentText, saveTournamentText } from './storage.js';

export const NOT_IN_TOURNAMENT = 'not in the tournament file';
const DAMAGED = 'The saved tournament file is damaged, so it is not used. Remove it and load it again.';
const NOT_KEPT = 'The tournament file could not be kept on this device: its storage may be full or blocked.';
const ROUND_NEEDED = 'Type the round as a whole number from 1 to 999 in Match details: YellowFruit needs it to file the game.';
const GAME_FILE = 'This is a game file, not the tournament file. Games are checked on the TD check page (Home, TD check page).';

// The saved file, read: null when none is saved (or the store cannot be read), { ok: false, error } when it is damaged,
// otherwise readTournament's { ok: true, name, teams }, with `schedule` when the file holds one (1.16.0, schedule.js).
export function readSavedTournament(store) {
  const text = loadTournamentText(store);
  if (text === null) return null;
  const read = readTournamentFile(text);
  if (!read.ok) return { ok: false, error: DAMAGED };
  const made = linkMadeIn(text);
  return made ? { ...read, linkMade: made } : read;
}

// When the afternoon link last used on this device was made (`_skor_link_made` on the kept Tournament), or null.
function linkMadeIn(text) {
  try {
    const made = JSON.parse(text)?.objects?.[0]?._skor_link_made;
    return typeof made === 'string' && Number.isFinite(Date.parse(made)) ? made : null;
  } catch {
    return null;
  }
}

// The kept copy's text: the name, the teams and players, and the schedule (1.16.0) when there is one, as QBJ phases under
// `_skor_schedule`, with ids on the teams, which its matches name. `linkMade` is the afternoon link's time, when one was used.
function keptText({ name, teams, schedule, linkMade }) {
  const ids = new Map();
  teams.forEach((team, i) => { if (!ids.has(team.name)) ids.set(team.name, `team_${i + 1}`); });
  const teamRef = team => (ids.has(team) ? { $ref: ids.get(team) } : { name: team });
  return JSON.stringify({ version: '2.1.1', objects: [{ type: 'Tournament', ...(name ? { name } : {}), registrations: [{ type: 'Registration',
    teams: teams.map((team, i) => ({ ...(schedule ? { id: `team_${i + 1}` } : {}), name: team.name, players: team.players.map(player => ({ name: player })) })) }],
  ...(schedule ? { _skor_schedule: scheduleToPhases(schedule, teamRef) } : {}), ...(linkMade ? { _skor_link_made: linkMade } : {}) }] });
}

// Reads a file the person chose and keeps it only if it is a tournament file: { ok: true, tournament } or { ok: false, error }.
// Only its name, teams and players are kept, as a small tournament file of the same shape: a whole-tournament export with
// its games can run to megabytes, room the device's saved matches need. A schedule (1.16.0) is kept too, as its rounds,
// rooms, teams and slots with no scores; the teams then get ids, which its matches name.
export function saveTournamentFile(text, store) {
  const read = readTournamentFile(text);
  if (!read.ok) return /game file/.test(read.error) ? { ok: false, error: GAME_FILE } : read;
  if (!saveTournamentText(keptText(read), store).ok) return { ok: false, error: NOT_KEPT };
  return { ok: true, tournament: read };
}

// Use this schedule (the afternoon link, 7.5): the link's rounds go into the kept copy, replacing those rounds and keeping
// the morning's and the rosters, and the link's time is recorded, so an older link can be questioned. A team the link
// names is written as the registered team it folds to. With no kept copy (or `fresh`, when the person chose to replace one
// for another tournament), a copy is kept with the link's teams and no players, which the scorer then types.
// { ok: true, tournament, names: true when no players came with it } or { ok: false, error }.
export function keepAfternoon(afternoon, store, fresh = false) {
  const saved = fresh ? null : readSavedTournament(store);
  const base = saved?.ok ? saved : { name: afternoon.name, teams: afternoon.teams.map(name => ({ name, players: [] })) };
  const name = team => findTeam({ ok: true, teams: base.teams }, team)?.name ?? team;
  const schedule = mergeAfternoon(saved?.ok ? saved.schedule ?? null : null, afternoon, name);
  if (!saveTournamentText(keptText({ name: base.name, teams: base.teams, schedule, linkMade: afternoon.made }), store).ok) return { ok: false, error: NOT_KEPT };
  return { ok: true, tournament: readSavedTournament(store), names: !saved?.ok };
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
// `size` is the boxes a card has: 4, or 10 in a buzzer session (1.12.0), where the rest are not seated.
export function rosterSeats(team, size = 4) {
  const players = (team.players ?? []).map(name => String(name ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { seats: Array.from({ length: size }, (_, seat) => players[seat] ?? ''), bench: players.slice(size) };
}

// What picking `team` does to a team card that holds `card` ({ seats, bench }): 'none' when it is the team already filled
// in; 'fill' at once when every box is empty, or when the boxes still hold exactly the team filled in before (`previous`),
// so typing "Oxford B" past "Oxford" refills; otherwise 'ask', since names typed by hand are never replaced unasked. A team
// with no players (a tournament file kept from an afternoon link with names only, 1.16.0) is 'none': there is nothing to put in.
export function fillPlan(card, team, previous, size = 4) {
  if (!team?.players?.length) return 'none';
  const seats = Array.from({ length: Math.max(size, card.seats.length) }, (_, i) => card.seats[i] ?? '');
  const typed = [...seats, ...(card.bench ?? [])].map(name => String(name ?? '').trim());
  if (typed.every(name => name === '')) return 'fill';
  if (previous && previous === team) return 'none';
  if (previous) {
    const was = rosterSeats(previous, size);
    const held = [...was.seats, ...was.bench];
    const now = typed.filter((name, i) => i < size || name !== '');
    if (now.length === held.length && now.every((name, i) => name === held[i])) return 'fill';
  }
  return 'ask';
}

// With a tournament file loaded, the round must be a whole number from 1 to 999 before Start, as qbj.js writes it ('' when
// it is, with no usable file, or for a trivia match or a buzzer session, which save no QBJ file).
export function roundProblem(round, tournament, rules = null, session = false) {
  if (!tournament?.ok || rules?.trivia || session === true) return '';
  const typed = String(round ?? '').trim();
  return /^\d{1,3}$/.test(typed) && Number(typed) >= 1 ? '' : ROUND_NEEDED;
}
