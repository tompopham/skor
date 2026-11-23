// The afternoon link (Skor 1.16.0, SPEC-partB 7.5): the afternoon's rounds, once the TD check page has filled the
// brackets, carried in a link the TD posts in Discord, with no server. The link is Skor's address, then "#s1.", then the
// schedule as JSON (UTF-8), squeezed with raw deflate and written in base64url, the machinery of the match link (link.js,
// "#m1."). "s1" is the format's version. What it carries is Skor's compact form, not QBJ: { v: 1, t: the tournament's name,
// made: when the TD made it (ISO time), teams: [names], rooms: [names], rounds: [{ r: round number, g: [[room, left team,
// right team], ...] }] }, teams and rooms by their place in the lists. Names only: the players are already on the phone in
// the tournament file. Compact because Discord caps a message at 2,000 characters on a free account, and a 40-team
// afternoon in QBJ's own form comes to about 1,700 (7.5's table). No screen code here; view-schedule.js draws it.

import { toBase64Url, fromBase64Url, pipe, canLink, LINK_UNSUPPORTED } from './link.js';
import { fold } from './td-check.js';

const FORMAT = 1;
const LINK = /#s(\d+)\.([A-Za-z0-9_-]*)([\s\S]*)$/;
const AROUND = /[^\s(<[{'"]*#s\d+\.[A-Za-z0-9_-]*/;   // the link itself, inside pasted text
const MAX_TEXT = 1_000_000;   // a 40-team whole day is about 7,000 characters of JSON; a link that opens into more is not one
export const LINK_LIMIT = 1900;   // under Discord's 2,000, with room for a line of text in the same message

export const SCHEDULE_DAMAGED = 'This link is cut short or damaged, so the schedule cannot be read. Ask the TD to post it again.';
export const SCHEDULE_NEWER = 'This schedule was made in a newer Skor. Reload Skor to update it, then open the link again.';
export const NOT_A_SCHEDULE = 'This link does not hold a schedule Skor can read. Ask the TD to post it again.';
export const TOO_LONG = 'Too long for one Discord message: save the tournament file with the afternoon filled and post that instead.';
export const NOT_PLACED = 'Every afternoon place needs a team before the link can be made.';
export const NO_AFTERNOON = 'The schedule has no afternoon rounds, so there is nothing to send.';
export { LINK_UNSUPPORTED };

// Whether some text (an address, its # part, or a pasted message) holds an afternoon link.
export const isScheduleLink = text => typeof text === 'string' && /#s\d+\./.test(text);

// What the link carries, from a schedule whose afternoon (the rounds holding slots) has every side filled: { ok: true,
// payload } or { ok: false, error }. `made` is an ISO time.
export function afternoonPayload(schedule, name, made) {
  const rounds = (schedule?.rounds ?? []).filter(round => round.playoff);
  if (!rounds.length) return { ok: false, error: NO_AFTERNOON };
  if (rounds.some(round => round.games.some(game => game.sides.some(side => typeof side.team !== 'string')))) return { ok: false, error: NOT_PLACED };
  const teams = [];
  const rooms = [];
  const at = (items, value) => {
    let i = items.indexOf(value);
    if (i < 0) { i = items.length; items.push(value); }
    return i;
  };
  const out = rounds.map(round => ({ r: round.round, g: round.games.map(game => [at(rooms, game.room), at(teams, game.sides[0].team), at(teams, game.sides[1].team)]) }));
  return { ok: true, payload: { v: FORMAT, t: String(name ?? ''), made, teams, rooms, rounds: out } };
}

// The link for a payload: { ok: true, link } or, past 1,900 characters, { ok: false, error, length }. `base` is
// link.js linkBase(location).
export async function scheduleLink(payload, base) {
  if (!canLink()) return { ok: false, error: LINK_UNSUPPORTED };
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const link = `${base}#s${FORMAT}.${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
  return link.length > LINK_LIMIT ? { ok: false, error: TOO_LONG, length: link.length } : { ok: true, link };
}

const isIndex = (value, length) => Number.isInteger(value) && value >= 0 && value < length;
const isName = value => typeof value === 'string' && value.trim() !== '' && value.length <= 200;

// The afternoon a payload holds, checked in full, or null: { name, made, teams, rounds: [{ round, games: [{ room, sides:
// [{ team }, { team }] }] }] }, rounds in order. Anything out of place (a team or room number past its list, a round outside
// 1 to 999 or twice, a team against itself, a time that is not one) makes it not a schedule.
export function afternoonFrom(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.v !== FORMAT) return null;
  const { t, made, teams, rooms, rounds } = payload;
  if (typeof t !== 'string' || typeof made !== 'string' || !Number.isFinite(Date.parse(made))) return null;
  if (!Array.isArray(teams) || !teams.length || !teams.every(isName)) return null;
  if (!Array.isArray(rooms) || !rooms.length || !rooms.every(isName)) return null;
  if (!Array.isArray(rounds) || !rounds.length) return null;
  const seen = new Set();
  const out = [];
  for (const round of rounds) {
    if (!round || !Number.isInteger(round.r) || round.r < 1 || round.r > 999 || seen.has(round.r)) return null;
    seen.add(round.r);
    if (!Array.isArray(round.g) || !round.g.length) return null;
    const games = [];
    for (const game of round.g) {
      if (!Array.isArray(game) || game.length !== 3) return null;
      const [room, left, right] = game;
      if (!isIndex(room, rooms.length) || !isIndex(left, teams.length) || !isIndex(right, teams.length) || left === right) return null;
      games.push({ room: rooms[room], sides: [{ team: teams[left] }, { team: teams[right] }] });
    }
    out.push({ round: round.r, games });
  }
  out.sort((a, b) => a.round - b.round);
  return { name: t, made, teams: [...teams], rounds: out };
}

// Reads the afternoon in a link (or in pasted text holding one): { ok: true, afternoon, link } with the link itself out of
// the text, or { ok: false, error } with a sentence saying what to do. As readLink does for a match: the link must end
// where its letters do (a space, the end, or the end of a sentence may follow), and anything that cannot be undone back to
// JSON is a link cut short or damaged.
export async function readScheduleLink(text) {
  const found = typeof text === 'string' ? LINK.exec(text) : null;
  if (!found) return { ok: false, error: SCHEDULE_DAMAGED };
  const [, format, data, after] = found;
  if (format !== String(FORMAT)) return { ok: false, error: Number(format) > FORMAT ? SCHEDULE_NEWER : SCHEDULE_DAMAGED };
  if (!canLink()) return { ok: false, error: LINK_UNSUPPORTED };
  const bytes = data === '' || !/^([.,;:!?)\]}>'"]*)(\s|$)/.test(after) ? null : fromBase64Url(data);
  if (!bytes) return { ok: false, error: SCHEDULE_DAMAGED };
  let payload;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_TEXT)));
  } catch {
    return { ok: false, error: SCHEDULE_DAMAGED };
  }
  const afternoon = afternoonFrom(payload);
  if (!afternoon) return { ok: false, error: NOT_A_SCHEDULE };
  return { ok: true, afternoon, link: AROUND.exec(text)[0] };
}

const pad = n => String(n).padStart(2, '0');

// "13:52" for a time today (`now`, in ms), "22/11 13:52" for another day, in the phone's own time; '' for no time.
export function madeAt(iso, now = Date.now()) {
  const date = new Date(Date.parse(iso));
  if (!Number.isFinite(date.getTime())) return '';
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString() ? time : `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${time}`;
}

// The receive screen's lines: a summary, then each round's rooms with their teams ("Room 2: Kelpie A v Puffin").
export function afternoonLines(afternoon) {
  const rooms = new Set(afternoon.rounds.flatMap(round => round.games.map(game => game.room)));
  const first = afternoon.rounds[0].round;
  const last = afternoon.rounds.at(-1).round;
  const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return {
    summary: `${first === last ? `Round ${first}` : `Rounds ${first} to ${last}`}, ${n(rooms.size, 'room')}, ${n(afternoon.teams.length, 'team')}.`,
    rounds: afternoon.rounds.map(round => ({ title: `Round ${round.round}`, games: round.games.map(game => `${game.room}: ${game.sides[0].team} v ${game.sides[1].team}`) })),
  };
}

// What Use this schedule must ask first, given the kept tournament file (tournament.js readSavedTournament, or null):
// 'older' when the link used last on this device was made later than this one; 'other' when the kept file is another
// tournament's (both named, and the names differ after folding); otherwise null.
export function useQuestion(saved, afternoon) {
  if (!saved?.ok) return null;
  if (saved.linkMade && Date.parse(afternoon.made) < Date.parse(saved.linkMade)) return 'older';
  if (saved.name && afternoon.name && fold(saved.name) !== fold(afternoon.name)) return 'other';
  return null;
}
