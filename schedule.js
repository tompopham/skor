// The schedule (Skor 1.16.0, SPEC-partB 7.3 and 7.4). No screen code here, so the tests run it. It reads the table a TD
// pastes from a spreadsheet on the TD check page (one row per game: Round, Room, Team, Team, and an optional Bracket),
// says what it read and every fault line by line, and writes and reads the schedule where QBJ keeps one: the Tournament's
// `phases`, each with `pools` and `rounds`, each round with `matches` naming a room (`location`) and two `match_teams`, and
// no scores. A team not known until the morning is played is a slot, "A1" for pool A's first place, written in the
// MatchTeam's `card`, which QBJ 2.1.1 types as a String (quizbowl/schema 85abfc1, match.graphql, checked 23 Nov 2026). The
// phases go under the Tournament's own Skor key, `_skor_schedule`, not `phases`: see withSchedule.
// Setup's Round and Room pickers use the read schedule: they are a shortcut that fills the teams, never a lock (7.2).
//
// The model: { rounds: [{ round, playoff, games: [{ room, sides: [side, side], bracket? }] }], pools: [{ key, name, teams }],
// brackets: [{ name, slots }] }, where a side is { team }, { slot } or, once the afternoon is filled, both.

import { fold, bigram, readTournament, locateTournament } from './td-check.js';

// A slot: one to three letters (the pool) then one or two digits (the place), "A1", "b12". A registered team of that name
// is read as the team.
export const SLOT = /^[A-Za-z]{1,3}\d{1,2}$/;
const ROUND = /^(?:r|round)?\s*(\d{1,3})$/i;
const POOL_ROW = /^pool\b\s*(.*)$/i;
export const NOT_FILLED = 'not filled yet: open the afternoon link from Discord';
const list = value => (Array.isArray(value) ? value : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// "3", "R3", "Round 3": 3; anything else, or a number outside 1 to 999, null.
export function roundNumber(text) {
  const match = String(text ?? '').trim().match(ROUND);
  const n = match ? Number(match[1]) : NaN;
  return n >= 1 && n <= 999 ? n : null;
}

// A room as the schedule shows it: a bare number is "Room 2", anything else as typed (spaces tidied).
export const roomName = text => {
  const room = String(text ?? '').replace(/\s+/g, ' ').trim();
  return /^\d+$/.test(room) ? `Room ${Number(room)}` : room;
};
const roomKey = text => fold(roomName(text));

// ---- The table ------------------------------------------------------------------------------------------------------------

// The separator of one pasted line: a tab if it has one outside quotes, else a comma, else a semicolon (a spreadsheet
// copies with tabs; a CSV file has commas; some European spreadsheets save semicolons).
function separatorOf(line) {
  let quoted = false;
  const seen = new Set();
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === '\t' || c === ',' || c === ';')) seen.add(c);
  }
  if (seen.has('\t')) return '\t';
  // A semicolon line with a comma inside a name ("1;1;a, b;Puffin"): the semicolon, when the comma would not give a first
  // cell that is a round or a Pools row and the semicolon would.
  if (seen.has(',') && seen.has(';')) {
    const startsWell = sep => { const first = cellsOf(line, sep)[0]; return roundNumber(first) !== null || /^pool\b\s*[A-Za-z]{0,3}$/i.test(first); };
    return !startsWell(',') && startsWell(';') ? ';' : ',';
  }
  return seen.has(',') ? ',' : seen.has(';') ? ';' : null;
}

// One line's cells, quotes as in CSV: a cell that starts with " runs to the closing ", and "" inside is one ". Spaces round
// a cell go, and runs of spaces become one.
export function splitLine(line) {
  return cellsOf(line, separatorOf(line));
}

function cellsOf(line, sep) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === sep) { cells.push(cell); cell = ''; } else if (c === '"' && cell.trim() === '') { quoted = true; cell = ''; } else cell += c;
  }
  cells.push(cell);
  return cells.map(text => text.replace(/\s+/g, ' ').trim());
}

// The table's rows that hold anything, each { line, cells } with its line number in the paste (from 1) and no empty
// cells at its end.
function rowsOf(text) {
  const rows = [];
  String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/).forEach((raw, i) => {
    const cells = splitLine(raw);
    while (cells.length && cells.at(-1) === '') cells.pop();
    if (cells.length) rows.push({ line: i + 1, cells });
  });
  return rows;
}

const BRACKET_HEADER = /bracket|pool|group|tier/i;

// The registered team a name means (the same name, else the same after folding), or null. `teams` is readTournament's list.
function registeredName(name, teams) {
  const found = teams.find(team => team.name === name) ?? teams.find(team => fold(team.name) === fold(name));
  return found ? found.name : null;
}

// The registered team closest to a name not in the file: the best score on YellowFruit's measure over folded names (the
// last key suggestTeam uses; a schedule row has no players for its first keys). Null when nothing shares a letter pair.
function closestName(name, teams) {
  let best = null;
  let score = 0;
  for (const team of teams) {
    const s = bigram(fold(name), fold(team.name));
    if (s > score) { score = s; best = team.name; }
  }
  return best;
}

// The pool key a pool's name gives: "Pool A" is A, "Pool red" is RED; null when it is not one to three letters.
function poolKey(name) {
  const rest = String(name ?? '').replace(/^pool\b\s*/i, '').trim();
  return /^[A-Za-z]{1,3}$/.test(rest) ? rest.toUpperCase() : null;
}
const slotParts = slot => ({ pool: slot.replace(/\d+$/, '').toUpperCase(), place: Number(slot.match(/\d+$/)[0]) });
const letters = n => (n < 26 ? String.fromCharCode(65 + n) : letters(Math.floor(n / 26) - 1) + letters(n % 26));

// Groups the items `pairs` link ([a, b] each), in order of first appearance: the sets of teams (or slots) that meet.
function connected(pairs) {
  const parent = new Map();
  const order = [];
  const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  const add = x => { if (!parent.has(x)) { parent.set(x, x); order.push(x); } };
  for (const [a, b] of pairs) {
    add(a); add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const groups = new Map();
  for (const x of order) groups.set(find(x), [...(groups.get(find(x)) ?? []), x]);
  return [...groups.values()];
}

// Brackets ordered by the best place each holds (the bracket holding A1 is first), then by pool letter; named Top and
// Bottom for two, Top, Middle and Bottom for three, else Bracket 1 to n, unless the TD named them. Slots in each are in
// pool then place order.
function orderBrackets(groups) {
  const sorted = groups.map(({ name, slots }) => ({
    name,
    slots: [...slots].sort((a, b) => slotParts(a).pool.localeCompare(slotParts(b).pool) || slotParts(a).place - slotParts(b).place),
  }));
  const best = slots => Math.min(...slots.map(slot => slotParts(slot).place));
  const firstPool = slots => slots.map(slot => slotParts(slot).pool).sort()[0] ?? '';
  sorted.sort((a, b) => best(a.slots) - best(b.slots) || firstPool(a.slots).localeCompare(firstPool(b.slots)));
  const names = sorted.length === 2 ? ['Top', 'Bottom'] : sorted.length === 3 ? ['Top', 'Middle', 'Bottom'] : sorted.map((_, i) => `Bracket ${i + 1}`);
  return sorted.map((bracket, i) => ({ name: bracket.name ?? names[i], slots: bracket.slots }));
}

// "A1 to A3, B1 and B2": a run of three or more places in a pool is a range.
export function slotsText(slots) {
  const byPool = new Map();
  for (const slot of slots) {
    const { pool, place } = slotParts(slot);
    byPool.set(pool, [...(byPool.get(pool) ?? []), place]);
  }
  const parts = [];
  for (const [pool, places] of byPool) {
    const sorted = [...new Set(places)].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
      if (j - i >= 2) parts.push(`${pool}${sorted[i]} to ${pool}${sorted[j]}`);
      else for (let k = i; k <= j; k += 1) parts.push(`${pool}${sorted[k]}`);
      i = j + 1;
    }
  }
  return parts.join(', ');
}

// What the page says it read: "6 rounds, 4 rooms, 2 pools of 4, 2 brackets: Top (A1, A2, B1, B2), Bottom (A3, A4, B3, B4)".
export function scheduleSummary(schedule) {
  const rooms = new Set(schedule.rounds.flatMap(round => round.games.map(game => roomKey(game.room))));
  const parts = [plural(schedule.rounds.length, 'round'), plural(rooms.size, 'room')];
  const sizes = schedule.pools.map(pool => pool.teams.length);
  if (sizes.length) {
    parts.push(sizes.every(size => size === sizes[0]) ? `${plural(sizes.length, 'pool')} of ${sizes[0]}` : `${sizes.length} pools (${joinAnd(sizes.map(String))} teams)`);
  }
  let text = parts.join(', ');
  if (schedule.brackets.length) {
    text += `, ${plural(schedule.brackets.length, 'bracket')}: ${schedule.brackets.map(bracket => `${bracket.name} (${slotsText(bracket.slots)})`).join(', ')}`;
  }
  return text;
}

// Reads the pasted table against the tournament file's teams (`teams`, readTournament's list; [] with no file, when no
// name is checked). Gives { schedule, summary, faults }: `faults` is a list of lines, empty when the schedule can be saved;
// `schedule` is null when no game could be read.
export function readScheduleTable(text, teams = []) {
  const faults = [];
  const rows = rowsOf(text);
  const checking = teams.length > 0;
  const unknown = new Map();   // a name not in the file: its lines
  const side = (name, line, slotsAllowed = true) => {
    const registered = checking ? registeredName(name, teams) : null;
    if (registered) return { team: registered };
    if (slotsAllowed && SLOT.test(name)) return { slot: name.toUpperCase() };
    if (checking) unknown.set(name, [...(unknown.get(name) ?? []), line]);
    return { team: name };
  };

  // The header: the first row that is not a Pools row, when its first cell is not a round.
  const firstGameRow = rows.find(row => !POOL_ROW.test(row.cells[0]));
  const header = firstGameRow && roundNumber(firstGameRow.cells[0]) === null && !SLOT.test(firstGameRow.cells[0]) ? firstGameRow : null;
  const bracketColumn = !header || BRACKET_HEADER.test(header.cells[4] ?? '');

  const poolRows = [];
  const games = [];   // { round, room, sides, bracket, line }
  for (const row of rows) {
    if (row === header) continue;
    const [first, room, left, right, bracket] = row.cells;
    const pool = first.match(POOL_ROW);
    if (pool) {
      const name = `Pool ${pool[1]}`.trim();
      poolRows.push({ name, key: poolKey(name), teams: row.cells.slice(1).filter(Boolean).map(cell => side(cell, row.line, false).team), line: row.line });
      if (!poolKey(name)) faults.push(`Line ${row.line}: "${first}" needs a letter after Pool, as in Pool A, so slots can name it.`);
      continue;
    }
    const round = roundNumber(first);
    if (round === null) { faults.push(`Line ${row.line}: "${first}" is not a round. A round is a number from 1 to 999, as 3, R3 or Round 3.`); continue; }
    if (!room || !left || !right) { faults.push(`Line ${row.line}: a game needs a round, a room and two teams.`); continue; }
    const sides = [side(left, row.line), side(right, row.line)];
    const holdsSlot = sides.some(s => s.slot);
    games.push({ round, room: roomName(room), sides, bracket: bracketColumn && holdsSlot ? (bracket ?? '') : '', line: row.line });
  }

  for (const [name, lines] of unknown) {
    const near = closestName(name, teams);
    faults.push(`${name} is not in the tournament file (line${lines.length === 1 ? '' : 's'} ${joinAnd(lines.map(String))})${near ? `: the closest is ${near}` : ''}.`);
  }

  // Each round: a team or slot with two games, a room with two games, a team on both sides.
  const byRound = new Map();
  for (const game of games) byRound.set(game.round, [...(byRound.get(game.round) ?? []), game]);
  const sideKey = s => (s.team !== undefined ? `t:${fold(s.team)}` : `s:${s.slot}`);
  const sideText = s => (s.team !== undefined ? s.team : `Slot ${s.slot}`);
  for (const [round, played] of [...byRound].sort((a, b) => a[0] - b[0])) {
    const seen = new Map();
    const rooms = new Map();
    for (const game of played) {
      if (sideKey(game.sides[0]) === sideKey(game.sides[1])) faults.push(`Line ${game.line}: ${sideText(game.sides[0])} is on both sides of the game.`);
      for (const s of new Map(game.sides.map(x => [sideKey(x), x])).values()) seen.set(sideKey(s), [...(seen.get(sideKey(s)) ?? []), { s, game }]);
      rooms.set(roomKey(game.room), [...(rooms.get(roomKey(game.room)) ?? []), game]);
    }
    for (const entries of seen.values()) {
      if (entries.length > 1) faults.push(`Round ${round}: ${sideText(entries[0].s)} has ${entries.length} games (${joinAnd(entries.map(e => e.game.room))}).`);
    }
    for (const inRoom of rooms.values()) {
      if (inRoom.length > 1) faults.push(`Round ${round}: ${inRoom[0].room} has ${inRoom.length} games (lines ${joinAnd(inRoom.map(g => String(g.line)))}).`);
    }
  }

  // Morning and afternoon: the afternoon starts at the first round holding a slot.
  const firstSlotRound = Math.min(...games.filter(game => game.sides.some(s => s.slot)).map(game => game.round));
  const morningTeams = [];
  for (const game of games) {
    if (game.round >= firstSlotRound) continue;
    for (const s of game.sides) if (s.team !== undefined && !morningTeams.includes(s.team)) morningTeams.push(s.team);
  }

  // Pools: the Pools block, else the sets of teams that meet in the morning, lettered by first appearance.
  let pools;
  if (poolRows.length) {
    pools = poolRows.map(row => ({ key: row.key ?? '', name: row.name, teams: [...new Set(row.teams)] }));
    const rowsFor = new Map();
    for (const row of poolRows) if (row.key) rowsFor.set(row.key, [...(rowsFor.get(row.key) ?? []), row]);
    for (const same of rowsFor.values()) {
      if (same.length > 1) faults.push(`${same[0].name} has ${same.length} rows (lines ${joinAnd(same.map(row => String(row.line)))}): put its teams on one row.`);
    }
    const home = new Map();
    for (const pool of pools) {
      for (const team of pool.teams) home.set(fold(team), [...(home.get(fold(team)) ?? []), pool.name]);
    }
    for (const [, names] of home) if (names.length > 1) faults.push(`${pools.flatMap(p => p.teams).find(t => home.get(fold(t)) === names)} is in ${names.length} pools: ${joinAnd(names)}.`);
    const missing = morningTeams.filter(team => !home.has(fold(team)));
    if (missing.length) faults.push(`In no pool, though ${missing.length === 1 ? 'it plays' : 'they play'} in the morning: ${joinAnd(missing)}.`);
  } else {
    const pairs = games.filter(game => game.round < firstSlotRound).map(game => game.sides.map(s => s.team));
    pools = connected(pairs).map((group, i) => ({ key: letters(i), name: `Pool ${letters(i)}`, teams: group }));
  }

  // Slots: each must name a pool there is and a place inside it.
  const slotFaults = new Set();
  for (const game of games) {
    for (const s of game.sides) {
      if (!s.slot) continue;
      const { pool, place } = slotParts(s.slot);
      const found = pools.find(p => p.key === pool);
      let fault = null;
      if (!found) fault = `Line ${game.line}: slot ${s.slot} names pool ${pool}, and there is no pool ${pool}${pools.length ? ` (the pools are ${joinAnd(pools.map(p => p.key || p.name))})` : ''}.`;
      else if (place < 1 || place > found.teams.length) fault = `Line ${game.line}: slot ${s.slot} is place ${place} in pool ${pool}, which has ${plural(found.teams.length, 'team')}.`;
      if (fault && !slotFaults.has(fault)) { slotFaults.add(fault); faults.push(fault); }
    }
  }

  // Brackets: named in the fifth column, else the sets of slots that meet in the afternoon.
  const afternoon = games.filter(game => game.round >= firstSlotRound);
  const named = afternoon.some(game => game.bracket);
  let brackets;
  if (named) {
    const where = new Map();
    for (const game of afternoon) {
      if (!game.sides.some(s => s.slot)) continue;
      if (!game.bracket) { faults.push(`Line ${game.line}: the Bracket cell is empty, though other rows name a bracket.`); continue; }
      for (const s of game.sides) if (s.slot) where.set(s.slot, new Set([...(where.get(s.slot) ?? []), game.bracket]));
    }
    for (const [slot, names] of where) if (names.size > 1) faults.push(`Slot ${slot} is in ${names.size} brackets: ${joinAnd([...names])}.`);
    const groups = new Map();
    for (const [slot, names] of where) { const name = [...names][0]; groups.set(name, [...(groups.get(name) ?? []), slot]); }
    brackets = orderBrackets([...groups].map(([name, slots]) => ({ name, slots })));
  } else {
    const pairs = afternoon.map(game => game.sides.filter(s => s.slot).map(s => s.slot)).filter(p => p.length).map(p => [p[0], p.at(-1)]);
    brackets = orderBrackets(connected(pairs).map(slots => ({ name: undefined, slots })));
  }
  const bracketOf = slot => brackets.find(bracket => bracket.slots.includes(slot))?.name;

  const rounds = [...byRound.keys()].sort((a, b) => a - b).map(round => ({
    round,
    playoff: round >= firstSlotRound,
    games: byRound.get(round).map(game => {
      const slot = game.sides.find(s => s.slot)?.slot;
      return { room: game.room, sides: game.sides.map(s => ({ ...s })), ...(slot && bracketOf(slot) ? { bracket: bracketOf(slot) } : {}) };
    }),
  }));
  const schedule = rounds.length ? { rounds, pools: pools.map(p => ({ ...p })), brackets } : null;
  if (!rows.length) return { schedule: null, summary: '', faults: [] };
  if (!schedule && !faults.length) faults.push('No games in the table: one row a game, Round, Room, Team, Team.');
  return { schedule, summary: schedule ? scheduleSummary(schedule) : '', faults };
}

// ---- QBJ out and in -------------------------------------------------------------------------------------------------------

// The schedule as QBJ phases: Prelims (the rounds before the first slot) then Playoffs. `teamRef(name)` gives the { $ref }
// of a registered team. Pools are parallel, so each has position 1; brackets are ranked 1 (top) down. A bracket has no
// teams until the afternoon is filled, so its slots are kept in a Skor key, `_skor_slots` (QBJ's Pool has no field for it).
export function scheduleToPhases(schedule, teamRef) {
  const roundOut = round => ({
    id: `round_${round.round}`,
    name: String(round.round),
    matches: round.games.map((game, i) => ({
      id: `match_${round.round}_${i + 1}`,
      location: game.room,
      match_teams: game.sides.map(s => ({ ...(s.team !== undefined ? { team: teamRef(s.team) } : {}), ...(s.slot ? { card: s.slot } : {}) })),
    })),
  });
  const phases = [];
  const morning = schedule.rounds.filter(round => !round.playoff);
  const afternoon = schedule.rounds.filter(round => round.playoff);
  // The Prelims phase holds the pools, so it is written whenever there is an afternoon, even one with no morning rounds: the
  // reader takes the first phase as the morning's (fixed after the stages 1-2 review, 23 Nov 2026).
  if (morning.length || afternoon.length) {
    phases.push({
      id: 'phase_prelims', name: 'Prelims',
      pools: schedule.pools.map(pool => ({ id: `pool_${pool.key || pool.name}`, name: pool.name, position: 1, pool_teams: pool.teams.map(team => ({ team: teamRef(team) })) })),
      rounds: morning.map(roundOut),
    });
  }
  if (afternoon.length) {
    phases.push({
      id: 'phase_playoffs', name: 'Playoffs',
      pools: schedule.brackets.map((bracket, i) => ({ id: `bracket_${i + 1}`, name: bracket.name, position: i + 1, pool_teams: [], _skor_slots: bracket.slots })),
      rounds: afternoon.map(roundOut),
    });
  }
  return phases;
}

// The schedule a parsed QBJ file holds, or null: the Tournament's `_skor_schedule` (Skor's own key, laid out as QBJ phases),
// else its `phases` (a YellowFruit export's played games read as what happened), rounds
// whose name is a round number (as YellowFruit reads them), and matches with two sides. The first phase is the morning.
export function scheduleFromData(data) {
  const { tournament, deref } = locateTournament(data);
  if (!tournament) return null;
  const phases = list(tournament._skor_schedule).length ? list(tournament._skor_schedule) : list(tournament.phases);
  const byRound = new Map();
  let pools = null;
  const bracketGroups = [];
  phases.map(deref).filter(Boolean).forEach((phase, p) => {
    if (p === 0) {
      pools = list(phase.pools).map(deref).filter(pool => typeof pool?.name === 'string').map((pool, i) => ({
        key: poolKey(pool.name) ?? letters(i), name: pool.name,
        teams: list(pool.pool_teams).map(entry => deref(deref(entry)?.team)?.name).filter(name => typeof name === 'string'),
      }));
    } else {
      for (const pool of list(phase.pools).map(deref)) {
        const slots = list(pool?._skor_slots).filter(slot => typeof slot === 'string' && SLOT.test(slot)).map(slot => slot.toUpperCase());
        if (typeof pool?.name === 'string' && slots.length) bracketGroups.push({ name: pool.name, slots });
      }
    }
    for (const round of list(phase.rounds).map(deref)) {
      const number = roundNumber(round?.name);
      if (number === null) continue;
      for (const match of list(round.matches).map(deref)) {
        const sides = list(match?.match_teams).map(deref).map(entry => {
          const team = deref(entry?.team)?.name;
          const card = typeof entry?.card === 'string' && SLOT.test(entry.card.trim()) ? entry.card.trim().toUpperCase() : null;
          return { ...(typeof team === 'string' && team.trim() ? { team } : {}), ...(card ? { slot: card } : {}) };
        }).filter(s => s.team !== undefined || s.slot);
        if (sides.length !== 2) continue;
        const entry = byRound.get(number) ?? { round: number, playoff: p > 0, games: [] };
        // A game with no room (a YellowFruit export without locations) is "Game 1", "Game 2" in its round, so it can be picked.
        const room = roomName(typeof match.location === 'string' ? match.location : '')
          || `Game ${entry.games.filter(game => /^Game \d+$/.test(game.room)).length + 1}`;
        entry.games.push({ room, sides });
        byRound.set(number, entry);
      }
    }
  });
  if (!byRound.size) return null;
  const rounds = [...byRound.values()].sort((a, b) => a.round - b.round);
  if (!pools?.length) {
    pools = connected(rounds.filter(r => !r.playoff).flatMap(r => r.games.map(g => g.sides.map(s => s.team ?? s.slot))))
      .map((group, i) => ({ key: letters(i), name: `Pool ${letters(i)}`, teams: group }));
  }
  const brackets = bracketGroups.length ? orderBrackets(bracketGroups)
    : orderBrackets(connected(rounds.filter(r => r.playoff).map(r => r.games.map(g => g.sides.filter(s => s.slot).map(s => s.slot)))
      .flat().filter(p => p.length).map(p => [p[0], p.at(-1)])).map(slots => ({ name: undefined, slots })));
  for (const round of rounds) {
    for (const game of round.games) {
      const slot = game.sides.find(s => s.slot)?.slot;
      const bracket = slot ? brackets.find(b => b.slots.includes(slot))?.name : undefined;
      if (bracket) game.bracket = bracket;
    }
  }
  return { rounds, pools, brackets };
}

// readTournament's result, with the schedule under `schedule` when the file holds one (and no `schedule` key when not, so a
// file with no schedule reads exactly as before 1.16.0).
export function readTournamentFile(text) {
  const read = readTournament(text);
  if (!read.ok) return read;
  let schedule = null;
  try { schedule = scheduleFromData(JSON.parse(String(text ?? '').replace(/^﻿/, ''))); } catch { schedule = null; }
  return schedule ? { ...read, schedule } : read;
}

// The tournament file with the schedule, as the TD saves it (7.3): the loaded file's own registrations, untouched but for
// an id added to each team that lacks one (a match names its teams by id), inside a Tournament object, which gains the
// schedule under `_skor_schedule`, laid out as QBJ phases. Not in `phases` itself: YellowFruit 4.0.18's Open QBJ Tournament
// fails on scheduled matches there (no carryover_phases, a slot with no team, a bracket with no teams), and would read any
// it could as 0-0 games; with `_skor_schedule` it opens the file as if there were no schedule (run 23 Nov 2026,
// Workings/Build 1.16.0). Any `phases` the file had are left as they were. A file that was a bare list of registrations, or registrations alone, is put in a Tournament.
export function withSchedule(text, schedule) {
  const data = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  let file;
  let tournament;
  if (Array.isArray(data)) {
    tournament = { type: 'Tournament', registrations: data };
    file = { version: '2.1.1', objects: [tournament] };
  } else if (Array.isArray(data?.objects)) {
    file = data;
    const found = locateTournament(data);
    tournament = found.tournament;
    if (!tournament) {
      tournament = { type: 'Tournament', registrations: data.objects.filter(object => object?.type === 'Registration') };
      file.objects = [tournament, ...data.objects.filter(object => object?.type !== 'Registration')];
    }
  } else {
    tournament = data;
    file = { version: '2.1.1', objects: [tournament] };
  }
  const { registrations, deref } = locateTournament(file);
  const used = new Set();
  const ids = new Map();
  const collectIds = value => {
    if (Array.isArray(value)) value.forEach(collectIds);
    else if (value && typeof value === 'object') { if (typeof value.id === 'string') used.add(value.id); Object.values(value).forEach(collectIds); }
  };
  collectIds(file);
  let next = 1;
  for (const registration of registrations.map(deref)) {
    for (const team of list(registration?.teams).map(deref)) {
      if (typeof team?.name !== 'string' || ids.has(team.name)) continue;
      if (typeof team.id !== 'string') {
        while (used.has(`team_${next}`)) next += 1;
        team.id = `team_${next}`;
        used.add(team.id);
      }
      ids.set(team.name, team.id);
    }
  }
  tournament._skor_schedule = scheduleToPhases(schedule, name => (ids.has(name) ? { $ref: ids.get(name) } : { name }));
  return JSON.stringify(file, null, 1);
}

// "<Tournament> - tournament file with schedule.qbj", with the characters a file name cannot hold taken out; "... with
// afternoon filled.qbj" for the file the standings step saves (7.6), once the afternoon's slots have teams.
export function scheduleFileName(tournamentName, filled = false) {
  const name = String(tournamentName ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).replace(/^\.+|\.+$/g, '');
  return `${name || 'Tournament'} - tournament file with ${filled ? 'afternoon filled' : 'schedule'}.qbj`;
}

// ---- The Round and Room pickers (7.4) -------------------------------------------------------------------------------------

const sideLabel = s => s.team ?? s.slot;
const filled = game => game.sides.every(s => s.team !== undefined);

// The round a typed Round box means in the schedule, or null.
function roundIn(schedule, round) {
  const n = roundNumber(round);
  return n === null ? null : schedule.rounds.find(r => r.round === n) ?? null;
}

// The Round picker's choices: [{ value: '3', label: 'Round 3' }].
export const roundChoices = schedule => schedule.rounds.map(round => ({ value: String(round.round), label: `Round ${round.round}` }));

// The Room picker's choices for a round: "Room 2: Kelpie A v Puffin", or "Room 2: A1 v B2, not filled yet: open the afternoon
// link from Discord" while a side is still a slot.
export function roomChoices(schedule, round) {
  const found = roundIn(schedule, round);
  if (!found) return [];
  return found.games.map(game => ({
    value: game.room,
    label: `${game.room}: ${sideLabel(game.sides[0])} v ${sideLabel(game.sides[1])}${filled(game) ? '' : `, ${NOT_FILLED}`}`,
    filled: filled(game),
  }));
}

// The scheduled game for a round and room as typed (a bare room number is "Room 2"), or null.
export function scheduledGame(schedule, round, room) {
  const found = roundIn(schedule, round);
  if (!found || !String(room ?? '').trim()) return null;
  return found.games.find(game => roomKey(game.room) === roomKey(room)) ?? null;
}

// What picking a round and room fills: { round, room, teams } with the teams left first as the row lists them, or with
// teams null while a side is still a slot (Round and Room only are filled then). Null when there is no such game.
export function pickGame(schedule, round, room) {
  const game = scheduledGame(schedule, round, room);
  if (!game) return null;
  return { round: String(roundNumber(round)), room: game.room, teams: filled(game) ? game.sides.map(s => s.team) : null };
}

// The line under a team card whose name is not one of the scheduled game's teams: "Not the scheduled game (Kelpie A v
// Puffin)". Nothing for an empty box, no scheduled game, or a game still holding a slot.
export function offScheduleLine(game, name) {
  const typed = String(name ?? '').trim();
  if (!game || !typed || !filled(game)) return '';
  if (game.sides.some(s => fold(s.team) === fold(typed))) return '';
  return `Not the scheduled game (${game.sides[0].team} v ${game.sides[1].team})`;
}

// Where the next Setup on this device starts: the same room in the next round of the schedule after the last match's
// ({ round, room }), or null when there is none (the last round, or a room the next round does not use).
export function nextPlace(schedule, last) {
  const n = roundNumber(last?.round);
  if (n === null || !String(last?.room ?? '').trim()) return null;
  const later = schedule.rounds.find(round => round.round > n);
  if (!later) return null;
  const game = later.games.find(g => roomKey(g.room) === roomKey(last.room));
  return game ? { round: String(later.round), room: game.room } : null;
}

// The schedule as a table to paste or edit (tabs, a header, the Pools block, a Bracket column): what Add a schedule shows
// for a tournament file that already has one. Reading it back gives the same schedule.
export function scheduleTable(schedule) {
  const cell = text => (/[\t"]/.test(text) ? `"${String(text).replace(/"/g, '""')}"` : String(text));
  const row = cells => cells.map(cell).join('\t');
  return [
    row(['Round', 'Room', 'Team', 'Team', 'Bracket']),
    ...schedule.pools.map(pool => row([pool.name, ...pool.teams])),
    ...schedule.rounds.flatMap(round => round.games.map(game => row([String(round.round), game.room, ...game.sides.map(s => s.team ?? s.slot), ...(game.bracket ? [game.bracket] : [])]))),
  ].join('\n');
}

// What a fresh Setup starts with after a match (7.4: scorers stay in one room): the next round's game in the last match's
// room, as pickGame gives it, when the last match was a game (not a session) changed in the last 12 hours, so a match from
// another day never steers a new tournament. `last` is that match's record (or null); `at` is now, in ms.
export const SAME_DAY_MS = 12 * 60 * 60 * 1000;
export function nextPick(schedule, last, at) {
  if (!schedule || !last || last.session === true || !(at - (last.changedAt ?? last.createdAt ?? 0) <= SAME_DAY_MS)) return null;
  // The last match must be this schedule's game in its round and room (either order, folded), so another event's Round 1,
  // Room 3 never steers this one; a game still holding slots cannot be checked by name (fixed after the stages 1-2 review).
  const played = scheduledGame(schedule, last.details?.round, last.details?.room);
  if (!played) return null;
  if (filled(played)) {
    const names = list(last.teams).map(team => fold(team?.name ?? '')).sort();
    if (names.join('\n') !== played.sides.map(s => fold(s.team)).sort().join('\n')) return null;
  }
  const place = nextPlace(schedule, last.details ?? {});
  return place ? pickGame(schedule, place.round, place.room) : null;
}

// What the Round and Room pickers set when one changes (7.4; fixed after the stages 1-2 review): { round, room, teams,
// picked }. `round` and `room` are Match details' new values, or null to leave the box; `teams` the two name boxes', each a
// name, '' to empty it, or null to leave it. Only what the pickers themselves put in (`picked`: { round, room, teams }, or
// null) is ever emptied, and only while the box (`current`: { room, teams }) still holds it, so a name typed by hand stays
// and a room the next round does not use does not linger. `picked` in the result is what the pickers have now put in.
export function pickerPlan(schedule, round, room, picked, current) {
  const game = pickGame(schedule, round, room);
  const holds = (now, was) => typeof was === 'string' && was !== '' && String(now ?? '').trim() === was;
  const n = roundNumber(round);
  const roundOut = n === null ? null : String(n);
  const teams = [0, 1].map(t => (game?.teams ? game.teams[t] : holds(current?.teams?.[t], picked?.teams?.[t]) ? '' : null));
  return {
    round: roundOut,
    room: game ? game.room : holds(current?.room, picked?.room) ? '' : null,
    teams,
    picked: { round: roundOut, room: game ? game.room : null, teams: game?.teams ? [...game.teams] : [null, null] },
  };
}

// Match details with Round and Room emptied while they still hold what the schedule put there (`picked`), for a switch to a
// buzzer session, which has no round (7.4). A Round or Room typed since stays.
export function withoutPicked(details, picked) {
  const out = { ...details };
  for (const key of ['round', 'room']) {
    if (picked && typeof picked[key] === 'string' && picked[key] !== '' && String(out[key] ?? '').trim() === picked[key]) out[key] = '';
  }
  return out;
}

// ---- The afternoon link's rounds in the kept schedule (7.5) ---------------------------------------------------------------

// The schedule with an afternoon link's rounds put in (`afternoon` as schedule-link.js afternoonFrom gives it): each of
// the link's rounds replaces the round of that number, and the other rounds (the morning's) stay as they were. A game in
// a room the old round used keeps that game's slots and bracket, so the file still says which bracket each game is in.
// With no schedule, the link's rounds are the whole schedule. `name(team)` gives the registered name a team stands for.
export function mergeAfternoon(schedule, afternoon, name = team => team) {
  const base = schedule ?? { rounds: [], pools: [], brackets: [] };
  const old = new Map(base.rounds.map(round => [round.round, round]));
  // A link round numbered as one of this phone's morning rounds is left out: the morning is kept (spec 7.5; fixed after the
  // stage 4 review, for a link from another tournament whose kept file has no name).
  const incoming = afternoon.rounds.filter(round => old.get(round.round)?.playoff !== false).map(round => {
    const was = old.get(round.round);
    return {
      round: round.round, playoff: was?.playoff ?? true,
      games: round.games.map(game => {
        const before = was?.games.find(g => roomKey(g.room) === roomKey(game.room));
        return {
          room: game.room,
          sides: game.sides.map((side, i) => ({ team: name(side.team), ...(before?.sides[i]?.slot ? { slot: before.sides[i].slot } : {}) })),
          ...(before?.bracket ? { bracket: before.bracket } : {}),
        };
      }),
    };
  });
  const replaced = new Set(incoming.map(round => round.round));
  return { ...base, rounds: [...base.rounds.filter(round => !replaced.has(round.round)), ...incoming].sort((a, b) => a.round - b.round) };
}
