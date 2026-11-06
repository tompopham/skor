// The TD check page's logic (Skor 1.8.0, SPEC-partB section 4; Tom, 5 Nov 2026, D1 and T2). No screen code here, so the
// tests run it on the real Deep Bench 2026 files. It does the three jobs YellowFruit 4.0.18 misses (the Deep Bench note,
// 2 Nov 2026): a game whose folder, file name and inside disagree on its round; a team with no game, or two, in a round;
// and a team or player name that is not in the tournament file, with the registered one it probably means. It reads
// game files and changes none (T2). Every report line is built here, as text and bold parts, so the page and the copied
// report say the same thing.

// A game file is about 30 KB; anything far bigger is not one, and is not read.
export const MAX_BYTES = 5 * 1024 * 1024;

const collator = new Intl.Collator('en-GB', { numeric: true });
export const sortPaths = paths => [...paths].sort(collator.compare);
const byName = (a, b) => collator.compare(a.name, b.name);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function joinAnd(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
// The same for bold parts: [{ b: 'A' }, ', ', { b: 'B' }, ' and ', { b: 'C' }].
const joinAndParts = parts => parts.flatMap((part, i) => (i === 0 ? [part] : [i === parts.length - 1 ? ' and ' : ', ', part]));

// ---- Names -------------------------------------------------------------------------------------------------------------

// YellowFruit's own measure (string-similarity-js 2.1.4, which FileParsing.ts uses with pairs of two): the share of
// two-letter pairs the names have in common, case ignored, each pair used once. Under two letters scores 0.
export function bigram(first, second) {
  const a = String(first).toLowerCase();
  const b = String(second).toLowerCase();
  if (a.length < 2 || b.length < 2) return 0;
  const pairs = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const pair = a.slice(i, i + 2);
    pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
  }
  let shared = 0;
  for (let j = 0; j < b.length - 1; j += 1) {
    const pair = b.slice(j, j + 2);
    const left = pairs.get(pair) ?? 0;
    if (left > 0) { pairs.set(pair, left - 1); shared += 1; }
  }
  return (shared * 2) / (a.length + b.length - 2);
}

// Two names are the same name when they differ only in case, accents, apostrophes or repeated spaces (spec 4.2 job 3).
// Only the accents of Latin, Greek and Cyrillic letters go (U+0300 to U+036F): a vowel sign in Hindi is part of the name.
export const fold = name => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/['’‘ʼ`´]/g, '').replace(/\s+/g, ' ').trim();

// How a player's name on a game sheet matches one on a roster: 'same' (folded), 'close' (0.80 or more on YellowFruit's
// measure, "Ben Russell Jones" for "Ben Russell-Jones"), 'initial' (same surname and first letter, "Nick Winter" for
// "Nicholas Winter", which the measure scores 0.67), or null.
export function playerMatch(filed, roster) {
  const a = fold(filed);
  const b = fold(roster);
  if (!a || !b) return null;
  if (a === b) return 'same';
  if (bigram(a, b) >= 0.8) return 'close';
  const wa = a.split(/[\s-]+/).filter(Boolean);
  const wb = b.split(/[\s-]+/).filter(Boolean);
  if (wa.length > 1 && wb.length > 1 && wa.at(-1) === wb.at(-1) && wa[0][0] === wb[0][0]) return 'initial';
  return null;
}
const STRENGTH = { same: 3, close: 2, initial: 1 };

// Pairs a game's players with a roster, strongest pairs first, each roster name used once.
function pairUp(players, roster) {
  const options = [];
  players.forEach((filed, i) => roster.forEach((name, j) => {
    const how = playerMatch(filed, name);
    if (how) options.push({ i, j, how });
  }));
  options.sort((x, y) => STRENGTH[y.how] - STRENGTH[x.how]);
  const usedFiled = new Set();
  const usedRoster = new Set();
  const pairs = [];
  for (const option of options) {
    if (usedFiled.has(option.i) || usedRoster.has(option.j)) continue;
    usedFiled.add(option.i);
    usedRoster.add(option.j);
    pairs.push(option);
  }
  return pairs.sort((x, y) => x.i - y.i).map(({ i, j, how }) => ({ roster: roster[j], filed: players[i], how }));
}

// The registered team a name not in the tournament file probably means: the one whose roster shares the most players
// with the players filed under that name; then the stronger matches (the same name before a surname and first letter);
// then the one with the fewest players besides them (so a solo player's short name finds the solos team, not a quads
// team he is also on); then the closer team name. A tie, or no shared player, says so. `teams` is readTournament()'s list.
export function suggestTeam(name, players, teams) {
  const distinct = [...new Map(players.map(player => [fold(player), player])).values()];
  let best = [];
  let bestKey = null;
  const better = (a, b) => { for (let k = 0; k < a.length; k += 1) if (a[k] !== b[k]) return a[k] > b[k] ? 1 : -1; return 0; };
  for (const team of teams) {
    const matched = pairUp(distinct, team.players);
    if (!matched.length) continue;
    const strength = matched.reduce((sum, m) => sum + STRENGTH[m.how], 0);
    const key = [matched.length, strength, -(distinct.length + team.players.length - matched.length), bigram(fold(name), fold(team.name))];
    const order = bestKey ? better(key, bestKey) : 1;
    if (order > 0) { best = [{ team, matched }]; bestKey = key; } else if (order === 0) best.push({ team, matched });
  }
  if (!best.length) return { team: null, tie: null, matched: [] };
  if (best.length > 1) return { team: null, tie: best.map(entry => entry.team), matched: best[0].matched };
  return { team: best[0].team, tie: null, matched: best[0].matched };
}

// The team YellowFruit 4.0.18 itself will take for a name (FileParsing.ts): the best score on its measure, a tie going
// to the later team in its list, if 0.80 or more; else null, and it refuses the game.
export function yellowFruitTeam(name, teams) {
  let best = 0;
  let choice = null;
  for (const team of teams) {
    const score = bigram(name, team.name);
    if (score >= best) { best = score; choice = team; }
  }
  return best >= 0.8 ? choice : null;
}

// Whether YellowFruit 4.0.18 finds a player on a team (FileParsing.ts): 0.80 or more on its measure against the team's
// players, also with a trailing "(...)" taken off the name.
const yellowFruitFindsPlayer = (player, team) => [player, player.replace(/\s*\([^)]*\)\s*$/, '')]
  .some(name => team.players.some(rostered => bigram(name, rostered) >= 0.8));

// ---- Where a game's round comes from ------------------------------------------------------------------------------------

// "Round 1", "Round_1", "R01", "Rd 1", "Rd. 4", never followed by a letter or digit ("R2D2" is not round 2).
// A range ("Round 1-6", "R1-R6") is not one round.
const LEADING_ROUND = /^(?:round|rd|r)\.?[\s_-]*0*(\d{1,3})(?![\p{L}\p{N}])(?!\s*[-–]\s*(?:round|rd|r)?\.?\s*\d)/iu;
const ANY_ROUND = /(?:^|[^\p{L}\p{N}])(?:round|rd)\.?[\s_-]*0*(\d{1,3})(?![\p{L}\p{N}])(?!\s*[-–]\s*(?:round|rd|r)?\.?\s*\d)/iu;
const asRound = match => (match && Number(match[1]) >= 1 ? Number(match[1]) : null);

// The round a folder gives, from the folder nearest the file: "Round 1", "R01", "Rd 1", or "Prelims - Round 3".
export function roundFromFolder(path) {
  const folders = String(path).split('/').slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const round = asRound(LEADING_ROUND.exec(folders[i])) ?? asRound(ANY_ROUND.exec(folders[i]));
    if (round !== null) return round;
  }
  return null;
}

// The round a file name gives: only a leading "Round_2_", "R02" or "Round 2", since team names follow it.
export const roundFromFileName = path => asRound(LEADING_ROUND.exec(String(path).split('/').at(-1)));

// ---- Files ---------------------------------------------------------------------------------------------------------------

// What the page does with a file before reading it: 'qbj' (read it), 'modaq' (a MODAQ save file, listed apart), 'hidden'
// (.DS_Store and the like, ignored), 'big' (too large to be a game) or 'other' (listed as skipped).
export function fileKind(path, size) {
  const parts = String(path).split('/');
  if (parts.some(part => part.startsWith('.') || part === '__MACOSX')) return 'hidden';
  const lower = parts.at(-1).toLowerCase();
  if (lower.endsWith('_game.json')) return 'modaq';
  if (lower.endsWith('.qbj')) return size > MAX_BYTES ? 'big' : 'qbj';
  return 'other';
}
export const tooBig = (path, size) => ({ path, kind: 'bad', reason: `is ${(size / 1048576).toFixed(1)} MB, too large to be a game file` });

// A short fingerprint of a file's text, so two files holding the same game can be told apart from two different games.
function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${text.length}:${hash.toString(16)}`;
}
const isName = value => typeof value === 'string' && value.trim() !== '';
const list = value => (Array.isArray(value) ? value : []);

// One .qbj file's text, judged on its own: { path, kind: 'game', game } or { path, kind: 'bad', reason }. A game is a bare
// QBJ Match as MODAQ writes it (SPEC-partB 3.1): two match_teams, each with team.name and match_players, and _round.
export function readGame(path, text) {
  const bad = reason => ({ path, kind: 'bad', reason });
  const body = String(text ?? '').replace(/^﻿/, '');
  if (!body.trim()) return bad('is empty');
  let data;
  try { data = JSON.parse(body); } catch { return bad('is not JSON: it may be damaged, or not a QBJ file'); }
  if (Array.isArray(data)) return bad('holds a list, not one game');
  if (!data || typeof data !== 'object') return bad('is not a game: it has no teams in it');
  if (Array.isArray(data.objects)) {
    return data.objects.some(object => object?.type === 'Match')
      ? bad('is a whole-tournament QBJ file, with its games inside it; this page reads one game per file')
      : bad('is a tournament file, not a game: load it in step 1');
  }
  if (data.type === 'Tournament' || Array.isArray(data.registrations)) return bad('is a tournament file, not a game: load it in step 1');
  const teams = data.match_teams;
  if (!Array.isArray(teams) || teams.length === 0) return bad('is not a game: it has no teams in it');
  if (teams.length !== 2) return bad(`has ${plural(teams.length, 'team')}, not 2`);
  const sides = teams.map(side => ({
    name: isName(side?.team?.name) ? side.team.name : '',
    players: list(side?.match_players).map(entry => entry?.player?.name).filter(isName),
  }));
  if (sides.some(side => !side.name)) return bad('has a team with no name');
  // A round YellowFruit can place is a whole number; 1 to 999 is any real tournament's. Anything else is shown as it is.
  const raw = data._round;
  const inside = Number.isInteger(raw) && raw >= 1 && raw <= 999 ? raw : null;
  const shown = raw === undefined || raw === null || inside !== null ? null : (typeof raw === 'string' ? raw : JSON.stringify(raw));
  const insideText = shown === null ? null : { text: shown.length > 40 ? `${shown.slice(0, 40)}…` : shown, quoted: typeof raw === 'string' };
  return {
    path,
    kind: 'game',
    game: { path, round: { folder: roundFromFolder(path), fileName: roundFromFileName(path), inside, insideText }, sides, print: fingerprint(body) },
  };
}

// The tournament file (step 1), in any of the three shapes MODAQ reads (SPEC-partB 3.4): { version, objects: [Tournament] },
// a Tournament object, or a bare list of registrations; references by id ($ref) are followed. Gives
// { ok: true, name, teams: [{ name, players: [names] }] } in the file's order, or { ok: false, error }.
export function readTournament(text) {
  const error = message => ({ ok: false, error: message });
  let data;
  try { data = JSON.parse(String(text ?? '').replace(/^﻿/, '')); } catch { return error('This file is not JSON, so it is not a QBJ tournament file.'); }
  if (data && !Array.isArray(data) && Array.isArray(data.match_teams)) return error('This is a game file, not the tournament file. Load it in step 2.');
  try { return tournamentFrom(data); } catch { return error('This file could not be read as a tournament file: it is not laid out as one.'); }
}

function tournamentFrom(data) {
  const ids = new Map();
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      if (typeof value.id === 'string' && !ids.has(value.id)) ids.set(value.id, value);
      Object.values(value).forEach(collect);
    }
  };
  collect(data);
  const deref = value => (value && typeof value === 'object' && typeof value.$ref === 'string' ? ids.get(value.$ref) ?? null : value);
  let tournament = null;
  let registrations = [];
  if (Array.isArray(data)) registrations = data;
  else if (data && Array.isArray(data.objects)) {
    const objects = data.objects.map(deref);
    tournament = objects.find(object => object?.type === 'Tournament') ?? null;
    registrations = tournament ? list(tournament.registrations) : objects.filter(object => object?.type === 'Registration');
  } else if (data && typeof data === 'object') {
    tournament = data;
    registrations = list(data.registrations);
  }
  const teams = [];
  for (const registration of registrations.map(deref)) {
    for (const team of list(registration?.teams).map(deref)) {
      if (!isName(team?.name)) continue;
      teams.push({ name: team.name, players: list(team.players).map(deref).map(player => player?.name).filter(isName) });
    }
  }
  if (!teams.length) return { ok: false, error: NO_TEAMS };
  return { ok: true, name: isName(tournament?.name) ? tournament.name : null, teams };
}

const NO_TEAMS = 'No teams in this file. Load the tournament or registration file (.qbj) that the scorers use.';

// ---- The round line ------------------------------------------------------------------------------------------------------

const PLACES = [['folder', 'folder'], ['fileName', 'file name'], ['inside', 'file']];

// The line for a game whose round places disagree, or that YellowFruit cannot place; null when there is nothing to say.
// A place that gives no round is left out of the comparison (spec 4.2 job 1).
export function roundLine({ path, round }) {
  const given = PLACES.filter(([key]) => round[key] !== null && round[key] !== undefined);
  const groups = new Map();
  for (const [key, label] of given) groups.set(round[key], [...(groups.get(round[key]) ?? []), label]);
  const said = [...groups].map(([value, labels]) => `${joinAnd(labels)} ${labels.length === 1 ? 'says' : 'say'} round ${value}`).join(', ');
  if (round.inside !== null && round.inside !== undefined) return groups.size < 2 ? null : `${path}: ${said}. YellowFruit will use round ${round.inside}.`;
  const odd = round.insideText ?? null;
  const why = !odd ? 'the file has no round inside'
    : odd.quoted ? `the file has its round as text ("${odd.text}")` : `the file's round (${odd.text}) is not a round number`;
  if (!given.length) {
    return odd ? `${path}: ${why}, so YellowFruit cannot place it.`
      : `${path}: no round in the folder, the file name or the file, so YellowFruit cannot place it.`;
  }
  return `${path}: ${said}; ${why}, so YellowFruit cannot place it.`;
}

// A report line as plain text: its parts joined, bold parts as their words.
export const textOf = item => (Array.isArray(item.line) ? item.line : [item.line]).map(part => (typeof part === 'string' ? part : part.b)).join('');

// ---- The check -----------------------------------------------------------------------------------------------------------

const HOW_SAID = {
  same: m => m.roster,
  close: m => `${m.roster} (filed as ${m.filed})`,
  initial: m => `${m.roster} (filed as ${m.filed}: same surname and first letter)`,
};

// The whole report. `entries` are the files in path order: readGame()'s results and { path, kind: 'modaq' | 'other' } for
// the rest. `tournament` is readTournament()'s result, or null. Gives the three jobs' lists (each item with its `line`),
// the grid, and the files not read.
export function checkGames(entries, tournament) {
  const games = entries.filter(entry => entry.kind === 'game').map(entry => entry.game);
  const registered = tournament?.teams ?? [];

  // Rows: the registered teams in the file's order; then each name not in the file that is not matched to one.
  // A team registered twice under one name is one row.
  const rows = [];
  const rowOfFold = new Map();
  for (const team of registered) {
    if (rowOfFold.has(fold(team.name))) continue;
    rowOfFold.set(fold(team.name), rows.length);
    rows.push({ name: team.name, registered: true, roster: team.players });
  }
  const rowOfTeam = team => rowOfFold.get(fold(team.name));
  const strays = new Map();   // fold -> { name, players: Map(fold -> name), games: Set(path) }
  for (const game of games) {
    for (const side of game.sides) {
      const key = fold(side.name);
      if (rowOfFold.has(key)) continue;
      if (!strays.has(key)) strays.set(key, { name: side.name, players: new Map(), games: new Set() });
      const stray = strays.get(key);
      stray.games.add(game.path);
      for (const player of side.players) if (!stray.players.has(fold(player))) stray.players.set(fold(player), player);
    }
  }
  const strayList = [...strays.entries()].map(([key, stray]) => ({ key, ...stray, players: [...stray.players.values()] })).sort(byName);
  const names = tournament ? [] : null;
  const newRows = [];
  for (const stray of strayList) {
    const found = tournament ? suggestTeam(stray.name, stray.players, registered) : { team: null, tie: null, matched: [] };
    const yellowFruit = tournament ? yellowFruitTeam(stray.name, registered) : null;
    // With no shared player, the grid takes the team YellowFruit will (a misspelt name in a game with no players listed).
    const into = found.team ?? (found.tie ? null : yellowFruit);
    if (into) rowOfFold.set(stray.key, rowOfTeam(into));
    else newRows.push(stray);
    if (!tournament) continue;
    const line = [`"${stray.name}" (${plural(stray.games.size, 'game')}): `];
    if (found.team) line.push('probably ', { b: found.team.name }, `, which has ${joinAnd(found.matched.map(m => HOW_SAID[m.how](m)))}.`);
    else if (found.tie) line.push('a tie between ', ...joinAndParts(found.tie.map(team => ({ b: team.name }))), `, which each share ${plural(found.matched.length, 'player')} with it.`);
    else line.push('no registered team shares a player with it.');
    if (!yellowFruit) line.push(' YellowFruit will refuse these games until the name is changed.');
    else if (yellowFruit === found.team) line.push(' YellowFruit will match it to the same team.');
    else {
      // It then looks for each player on that team, and refuses the game at the first it cannot find (the Deep Bench note).
      const missing = stray.players.find(player => !yellowFruitFindsPlayer(player, yellowFruit));
      line.push(' YellowFruit will match it to ', { b: yellowFruit.name }, missing
        ? ` without a warning, then refuse these games because ${missing} is not on that team.`
        : ' without a warning.');
    }
    names.push({ name: stray.name, games: stray.games.size, team: found.team?.name ?? null, tie: found.tie?.map(team => team.name) ?? null, yellowFruit: yellowFruit?.name ?? null, line });
  }
  for (const stray of newRows) {
    rowOfFold.set(stray.key, rows.length);
    rows.push({ name: stray.name, registered: false, roster: null });
  }
  const rowOf = name => rowOfFold.get(fold(name));

  // Each game into its round's cells: the round YellowFruit will use, else the file name's, else the folder's.
  const cells = rows.map(() => new Map());
  const parent = rows.map((_, i) => i);
  const top = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const played = new Map();   // group top -> Set(round)
  const roundsSeen = new Set();
  const placed = [];
  const hasGame = new Set();
  for (const game of games) {
    const [a, b] = game.sides.map(side => rowOf(side.name));
    hasGame.add(a).add(b);
    parent[top(a)] = top(b);
    const { inside, fileName, folder } = game.round;
    const round = inside ?? fileName ?? folder;
    if (round === null) continue;
    roundsSeen.add(round);
    placed.push({ game, round, rows: [a, b] });
  }
  for (const { game, round, rows: [a, b] } of placed) {
    const group = top(a);
    if (!played.has(group)) played.set(group, new Set());
    played.get(group).add(round);
    game.sides.forEach((side, s) => {
      const row = s === 0 ? a : b;
      const other = s === 0 ? b : a;
      const cell = cells[row].get(round) ?? [];
      if (cell.some(entry => entry.path === game.path)) return;
      const filedAs = fold(side.name) === fold(rows[row].name) ? null : side.name;
      cell.push({ path: game.path, opponent: other + 1, opponentName: rows[other].name, filedAs, print: game.print });
      cells[row].set(round, cell);
    });
  }
  // A round between the first and the last with no game at all (a round's folder left out, say) gets its own column and
  // line; so many that the round numbers must be wrong get one line instead.
  const seen = [...roundsSeen].sort((x, y) => x - y);
  const holes = [];
  for (let round = seen[0]; round < seen.at(-1); round += 1) if (!roundsSeen.has(round)) holes.push(round);
  const listHoles = holes.length <= 5;
  const gridRounds = listHoles ? [...seen, ...holes].sort((x, y) => x - y) : seen;
  const gridRows = rows.map((row, i) => {
    const groupRounds = played.get(top(i)) ?? new Set();
    const rowCells = {};
    for (const round of gridRounds) {
      const list = (cells[i].get(round) ?? []).sort((x, y) => collator.compare(x.path, y.path));
      const state = list.length > 1 ? 'double' : list.length === 1 ? 'game' : groupRounds.has(round) ? 'gap' : 'none';
      rowCells[round] = { state, games: list };
    }
    return { n: i + 1, name: row.name, registered: row.registered, cells: rowCells };
  });

  const doubles = [];
  const gaps = [];
  if (!listHoles) {
    gaps.push({ round: null, team: null, line: [`${holes.length} rounds between round ${seen[0]} and round ${seen.at(-1)} have no game at all: check the round numbers in section 1 and inside the files.`] });
  }
  for (const round of gridRounds) {
    if (!roundsSeen.has(round)) gaps.push({ round, team: null, line: [`Round ${round}: no game at all.`] });
    for (const { game, rows: [a, b] } of placed.filter(p => p.round === round && p.rows[0] === p.rows[1])) {
      doubles.push({ round, team: rows[a].name, files: [game.path], same: false, line: [`Round ${round}: ${rows[a].name} is on both sides of ${game.path}.`] });
    }
    for (const row of gridRows) {
      const cell = row.cells[round];
      if (cell.state === 'double') {
        const files = cell.games.map(entry => entry.path);
        const same = cell.games.every(entry => entry.print === cell.games[0].print);
        const tail = same ? ` ${files.length === 2 ? 'The two files' : 'The files'} hold the same game.` : '';
        doubles.push({ round, team: row.name, files, same, line: [`Round ${round}: ${row.name} has ${files.length} games: ${joinAnd(files)}.${tail}`] });
      } else if (cell.state === 'gap') gaps.push({ round, team: row.name, line: [`Round ${round}: ${row.name} has no game.`] });
    }
  }
  for (const row of gridRows) {
    if (row.registered && !hasGame.has(row.n - 1)) {
      gaps.push({ round: null, team: row.name, line: [`${row.name} has no games at all.`] });
    }
  }

  // Players not on the roster of the team their game is under (registered by name, or matched above).
  let players = null;
  if (tournament) {
    const strayPlayers = new Map();
    for (const game of games) {
      for (const side of game.sides) {
        const row = rows[rowOf(side.name)];
        if (!row.registered || !row.roster.length) continue;
        for (const player of side.players) {
          if (row.roster.some(name => playerMatch(player, name) === 'same')) continue;
          const key = `${rowOf(side.name)}\u0000${fold(player)}`;
          if (!strayPlayers.has(key)) strayPlayers.set(key, { name: player, team: row.name, roster: row.roster, games: new Set() });
          strayPlayers.get(key).games.add(game.path);
        }
      }
    }
    players = [...strayPlayers.values()].sort((x, y) => byName(x, y) || collator.compare(x.team, y.team)).map(stray => {
      let closest = null;
      for (const name of stray.roster) {
        const how = playerMatch(stray.name, name);
        if (how && (!closest || STRENGTH[how] > STRENGTH[closest.how])) closest = { name, how };
      }
      const head = `"${stray.name}" on ${stray.team} (${plural(stray.games.size, 'game')}): not on its roster`;
      const line = closest
        ? `${head}; the closest name on it is ${closest.name}${closest.how === 'initial' ? ' (same surname and first letter)' : ''}.`
        : `${head}, and no name on it is close.`;
      return { name: stray.name, team: stray.team, games: stray.games.size, closest: closest?.name ?? null, line: [line] };
    });
  }

  const rounds = games.map(game => ({ path: game.path, text: roundLine(game) })).filter(entry => entry.text).map(entry => ({ path: entry.path, line: [entry.text] }));
  const kindPaths = kind => entries.filter(entry => entry.kind === kind).map(entry => entry.path);
  const bad = entries.filter(entry => entry.kind === 'bad').map(entry => ({ path: entry.path, reason: entry.reason, line: [`${entry.path}: ${entry.reason}.`] }));
  const modaq = kindPaths('modaq');
  const other = kindPaths('other');
  return {
    tournament: tournament ? { name: tournament.name, teams: registered.length } : null,
    counts: { games: games.length, modaq: modaq.length, other: other.length, bad: bad.length },
    rounds,
    grid: { rounds: gridRounds, rows: gridRows },
    doubles,
    gaps,
    names,
    players,
    modaq,
    other,
    bad,
  };
}

// ---- The report as plain text (Copy report) ------------------------------------------------------------------------------

export const BYE_LINE = 'An empty cell can be a bye: check it against the schedule.';
export const MODAQ_HEAD = 'Not a game file YellowFruit can import: open it in MODAQ and use Export QBJ';
export const NO_TOURNAMENT = 'Load the tournament file to check team names.';

// Nothing found in any of the three jobs.
export const clean = report => !report.rounds.length && !report.doubles.length && !report.gaps.length
  && !report.names?.length && !report.players?.length;

// The words above the report: the tournament, the count, and "Nothing to report" when that is so.
export function summaryLines(report) {
  const lines = [report.tournament
    ? `Tournament: ${report.tournament.name ?? 'no name'} (${plural(report.tournament.teams, 'team')})`
    : 'No tournament file loaded.'];
  const rest = report.counts.modaq + report.counts.other + report.counts.bad;
  lines.push(`${plural(report.counts.games, 'game file')} read.${rest ? ` ${plural(rest, 'other file')} listed at the end.` : ''}`);
  if (report.counts.games && clean(report)) {
    lines.push(report.names
      ? 'Nothing to report: the rounds agree, no team has a gap or a double, and every name is in the tournament file.'
      : 'Nothing to report in the rounds or the grid.');
  }
  return lines;
}

export function reportText(report) {
  const out = ['Skor TD check', ...summaryLines(report), ''];
  const section = (heading, items, empty) => {
    out.push(heading);
    if (items.length) for (const item of items) out.push(`- ${textOf(item)}`);
    else if (empty) out.push(empty);
    out.push('');
  };
  section(`1. Round does not match (${report.rounds.length})`, report.rounds, 'None.');
  out.push(`2. Team by round grid: doubles and gaps (${report.doubles.length + report.gaps.length})`, BYE_LINE);
  for (const item of [...report.doubles, ...report.gaps]) out.push(`- ${textOf(item)}`);
  if (!report.doubles.length && !report.gaps.length) out.push('None.');
  out.push('');
  if (report.names) {
    section(`3. Names not in the tournament file (${report.names.length})`, report.names, 'None.');
    section(`Players not on their team's roster (${report.players.length})`, report.players, 'None.');
  } else {
    out.push('3. Names not in the tournament file', NO_TOURNAMENT, '');
  }
  if (report.modaq.length) section(`${MODAQ_HEAD} (${report.modaq.length})`, report.modaq.map(path => ({ line: [path] })));
  if (report.bad.length) section(`Could not be read (${report.bad.length})`, report.bad);
  if (report.other.length) section(`Skipped: not .qbj files (${report.other.length})`, report.other.map(path => ({ line: [path] })));
  return `${out.join('\n').trim()}\n`;
}
