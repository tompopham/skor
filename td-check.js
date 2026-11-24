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
function joinOr(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

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

// The roster name YellowFruit 4.0.18 takes a player's name for (FileParsing.ts getYfPlayerFromName): the best score over
// both forms of the name, a tie going to the later name, if 0.80 or more; else null, and it refuses the game.
function yellowFruitPlayer(player, roster) {
  let best = 0;
  let choice = null;
  for (const rostered of roster) {
    for (const name of [player, player.replace(/\s*\([^)]*\)\s*$/, '')]) {
      const score = bigram(name, rostered);
      if (score >= best) { best = score; choice = rostered; }
    }
  }
  return best >= 0.8 ? choice : null;
}

// ---- Where a game's round comes from ------------------------------------------------------------------------------------

// "Round 1", "Round_1", "R01", "Rd 1", "Rd. 4", never followed by a letter or digit ("R2D2" is not round 2).
// A range ("Round 1-6", "R1-R6") is not one round.
const LEADING_ROUND = /^(?:round|rd|r)\.?[\s_-]*0*(\d{1,3})(?![\p{L}\p{N}])(?!\s*[-–]\s*(?:round|rd|r)?\.?\s*\d)/iu;
const ANY_ROUND = /(?:^|[^\p{L}\p{N}])(?:round|rd)\.?[\s_-]*0*(\d{1,3})(?![\p{L}\p{N}])(?!\s*[-–]\s*(?:round|rd|r)?\.?\s*\d)/iu;
const asRound = match => (match && Number(match[1]) >= 1 ? Number(match[1]) : null);

// The round a folder gives, from the folder nearest the file: "Round 1", "R01", "Rd 1", or "Prelims - Round 3". With
// folderRound, the folder's own name as well, so the report can say which folder a game is in and which to move it to.
function folderRound(path) {
  const folders = String(path).split('/').slice(0, -1);
  for (let i = folders.length - 1; i >= 0; i -= 1) {
    const round = asRound(LEADING_ROUND.exec(folders[i])) ?? asRound(ANY_ROUND.exec(folders[i]));
    if (round !== null) return { round, name: folders[i] };
  }
  return null;
}
export const roundFromFolder = path => folderRound(path)?.round ?? null;

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
    game: { path, round: { folder: roundFromFolder(path), fileName: roundFromFileName(path), inside, insideText }, sides, print: fingerprint(body), stats: gameStats(data) },
  };
}

// What YellowFruit 4.0.18 adds up from a game file for its standings (1.16.0, SPEC-partB 7.6; read in its code 22 and 23 Nov
// 2026: StatSummaries.ts PoolTeamStats.addMatchTeam, MatchTeam.ts, MatchPlayer.ts and FileParsing.ts parseMatchTeam), so the
// TD check page's standings match its screen. For each side, in the file's order: points, the file's own `points` if it has
// them (Skor and MODAQ write none), else tossup points (each answer's value times its number, over every player) plus
// bonus_points, bonus_bounceback_points and lightning_points; bonus points, which is points less tossup, bounce-back and
// lightning points; bonuses heard, the side's answers worth more than 0; the same two from overtime (YellowFruit's own
// YfData.overTimeBuzzes, which Skor writes for a match that went to overtime); and a forfeit. A number that is not one
// counts 0, as YellowFruit's `|| 0` does. The match's tossups read (null when the file gives none: YellowFruit then takes the
// regulation count) and overtime tossups read go with them.
const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
function answerSums(counts) {
  let points = 0;
  let positive = 0;
  for (const entry of list(counts)) {
    const value = count((entry?.answer_type ?? entry?.answerType)?.value);
    const number = count(entry?.number);
    points += value * number;
    if (value > 0) positive += number;
  }
  return { points, positive };
}
export function gameStats(data) {
  const sides = list(data?.match_teams).map(side => {
    let tossupPoints = 0;
    let heard = 0;
    for (const entry of list(side?.match_players)) {
      const sums = answerSums(entry?.answer_counts);
      tossupPoints += sums.points;
      heard += sums.positive;
    }
    const overtime = answerSums(side?.YfData?.overTimeBuzzes);
    const bounce = count(side?.bonus_bounceback_points);
    const lightning = count(side?.lightning_points);
    const points = typeof side?.points === 'number' && Number.isFinite(side.points) ? side.points : tossupPoints + count(side?.bonus_points) + bounce + lightning;
    return {
      points, tossupPoints, bonusPoints: points - tossupPoints - bounce - lightning, bonusesHeard: heard,
      overtimePoints: overtime.points, overtimeHeard: overtime.positive, forfeit: side?.forfeit_loss === true,
    };
  });
  const read = data?.tossups_read;
  return { tossupsRead: typeof read === 'number' && Number.isFinite(read) ? read : null, overtimeRead: count(data?.overtime_tossups_read), sides };
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

// The parsed file's Tournament object (null for a bare list of registrations or registrations alone), its registrations,
// and `deref`, which follows a { $ref } to the object with that id. Shared with schedule.js, which reads the phases.
export function locateTournament(data) {
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
  return { tournament, registrations, deref };
}

function tournamentFrom(data) {
  const { tournament, registrations, deref } = locateTournament(data);
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

// ---- The report's items ----------------------------------------------------------------------------------------------------

// Every problem the report lists is one item in the same three parts (readability fixes, 22 Nov 2026), so a TD can read
// down the bold words and the "Fix:" lines alone: `title`, the problem in a few words (bold on the page); `fix`, what to
// do, starting "Fix:" ("No fix needed:" for a name YellowFruit will match on its own); and `detail`, the file's name
// (not its path, as YellowFruit's own Import Preview shows it) and what YellowFruit will do (small print on the page).
// `kind` counts it in the line at the top. The page and Copy report both build their words from these, so they agree.
//
// Two ways into YellowFruit 4.0.18 matter here (GamesPage.tsx and TournamentManager.importMatchesFromQbj, read 23 Nov
// 2026): the main Import button above the rounds takes each game's round from inside its file; each round's own Import
// button puts the games chosen into that round, whatever the file says.
const fileName = path => String(path).split('/').at(-1);
const MAIN_IMPORT = n => `YellowFruit's main Import button will put it in round ${n}.`;
const STILL = n => `YellowFruit goes by the round inside, so its main Import button will still put it in round ${n}.`;
const OWN_IMPORT = n => `Fix: Import it with round ${n}'s own Import button in YellowFruit.`;
// A wrong round inside: the main Import button imports every game left on Keep in its preview, by the round inside, so the
// file must stay out of it (MatchImportResultsManager.ts:47 and the Discard toggle, MatchImportResultDialog.tsx:225).
const LEAVE_OUT = n => `Fix: Leave it out of the main import (choose Discard for it in the preview). Then import it with round ${n}'s own Import button.`;

// The words for each kind, one and many, in the order the top line counts them. The last two need no fix.
const KINDS = {
  folder: ['game in the wrong folder', 'games in the wrong folder'],
  inside: ['game with the wrong round inside', 'games with the wrong round inside'],
  filename: ['file name with the wrong round', 'file names with the wrong round'],
  unclear: ['game whose round is unclear', 'games whose round is unclear'],
  noround: ['game with no round inside', 'games with no round inside'],
  twice: ['game filed twice', 'games filed twice'],
  versions: ['game with two different files', 'games with two different files'],
  double: ['team with two games in a round', 'teams with two games in a round'],   // counted by team, not by item
  self: ['team on both sides of a game', 'teams on both sides of a game'],
  missing: ['game missing', 'games missing'],
  nogame: ['team with no game in a round', 'teams with no game in a round'],
  emptyround: ['round with no games', 'rounds with no games'],
  manyempty: ['run of empty rounds', 'runs of empty rounds'],
  noneatall: ['team with no games at all', 'teams with no games at all'],
  team: ['team name not in the tournament file', 'team names not in the tournament file'],
  player: ['player not on their roster', 'players not on their rosters'],
  bye: null,
  teamok: null,
  playerok: null,
};
const item = (kind, title, fix, detail, extra = {}) => ({ kind, title, fix, detail, ...extra });

const PLACES = [['folder', 'the folder'], ['fileName', 'the file name'], ['inside', 'the file itself']];

// The item for a game whose round places disagree, or that YellowFruit's main Import button cannot place; null when there
// is nothing to say. A place that gives no round is left out of the comparison (spec 4.2 job 1). Which place is wrong is
// judged from the other games, not by two places outvoting the third: MODAQ and Skor write the file name from the round
// inside, so those two agree even when both are wrong. (The Deep Bench note, 2 Nov 2026: Round_2_Negmund Quizgerald_not
// really.qbj sits in the Round 1 folder and says round 2 in its name and inside, but it is its two teams' round 1 game,
// since each already has a round 2 game and none in round 1.) `clashes(r)` gives the game's teams that already have
// another game in round r; the one round where none does is the game's round. With no single such round, the schedule
// decides. `folderNames` maps a round to the name of a folder holding it, so the fix can name a real folder.
export function roundItem({ path, round }, { folderNames = new Map(), clashes = () => [] } = {}) {
  const name = fileName(path);
  const { folder, inside } = round;
  const has = value => value !== null && value !== undefined;
  const given = PLACES.filter(([key]) => has(round[key]));
  const groups = new Map();
  for (const [key, label] of given) groups.set(round[key], [...(groups.get(round[key]) ?? []), label]);
  if (has(inside) && groups.size < 2) return null;
  const said = [...groups].map(([value, labels]) => `${joinAnd(labels)} ${labels.length === 1 ? 'says' : 'say'} round ${value}`).join(', ');
  const at = { path, round: has(inside) ? inside : null, real: null };
  const candidates = [...groups.keys()];
  const fitting = candidates.filter(r => clashes(r).length === 0);
  const real = groups.size === 1 ? candidates[0] : fitting.length === 1 ? fitting[0] : null;
  const wrong = candidates.filter(r => r !== real);
  const clashing = real === null ? [] : [...new Set(wrong.flatMap(r => clashes(r)))];
  const because = clashing.length
    ? ` ${joinAnd(clashing)} already ${clashing.length === 1 ? 'has' : 'have'} a game in ${wrong.length === 1 ? `round ${wrong[0]}` : `rounds ${joinAnd(wrong)}`}.` : '';
  if (has(inside)) {
    if (real === null) return item('unclear', 'Round unclear', 'Fix: Check the schedule for which round it was.', `${name}: ${said}. ${MAIN_IMPORT(inside)}`, at);
    if (real === inside && has(folder) && folder !== real) {
      const target = folderNames.get(real);
      const right = groups.get(real).map(label => (label === 'the file name' ? 'its file name' : 'the round inside it'));
      return item('folder', 'Game in the wrong folder', `Fix: Move it to ${target ? `the "${target}" folder` : `a round ${real} folder`}.`,
        `${name} is in the "${folderRound(path).name}" folder, but ${joinAnd(right)} ${right.length === 1 ? 'says' : 'say'} round ${real}.${because} ${STILL(real)}`, at);
    }
    if (real === inside) {
      return item('filename', 'Wrong round in a file name', `Fix: Change the round in its file name to ${real}.`,
        `${name}: ${said}.${because} YellowFruit will put it in round ${real} either way.`, at);
    }
    return item('inside', 'Wrong round inside a game file', LEAVE_OUT(real), `${name}: ${said}.${because} ${MAIN_IMPORT(inside)}`, { ...at, real });
  }
  const odd = round.insideText ?? null;
  const why = !odd ? 'has no round' : odd.quoted ? `has its round as text ("${odd.text}")` : `has a round that is not a round number (${odd.text})`;
  const fix = real !== null ? OWN_IMPORT(real) : "Fix: Check the schedule, then import it with that round's own Import button in YellowFruit.";
  const detail = given.length ? `${name}: ${said}, but the file itself ${why}, so YellowFruit's main Import button can't place it.${because}`
    : `${name}: the folder and the file name give no round, and the file itself ${why}, so YellowFruit's main Import button can't place it.`;
  return item('noround', 'No round inside a game file', fix, detail, at);
}

// An item as plain text, its three parts on three lines.
export const textOf = entry => [entry.title, entry.fix, entry.detail].join('\n');

// Up to three file names, then how many more, as the start of a sentence: "R01 x.qbj has a team called "A"." or
// "3 games have a team called "A": a.qbj, b.qbj and c.qbj." `what` is "a team called "A"".
function filesHave(paths, what) {
  const names = [...paths].sort(collator.compare).map(fileName);
  if (names.length === 1) return `${names[0]} has ${what}.`;
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} more`] : names;
  return `${names.length} games have ${what}: ${joinAnd(shown)}.`;
}

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
    const these = stray.games.size === 1 ? 'the game' : 'these games';
    const inThe = stray.games.size === 1 ? 'inside the game file' : 'inside the game files';
    const said = found.team ? `It is probably ${found.team.name}, which has ${joinAnd(found.matched.map(m => HOW_SAID[m.how](m)))}.`
      : found.tie ? `${joinAnd(found.tie.map(team => team.name))} each share ${plural(found.matched.length, 'player')} with it.`
        : 'No team in the tournament file shares a player with it.';
    let yf;
    if (!yellowFruit) yf = `YellowFruit will refuse ${these} until the name is changed.`;
    else if (yellowFruit !== found.team) {
      // It then looks for each player on that team, and refuses the game at the first it cannot find (the Deep Bench note).
      const missing = stray.players.find(player => !yellowFruitFindsPlayer(player, yellowFruit));
      yf = `YellowFruit will match it to ${yellowFruit.name} without a warning${missing ? `, then refuse ${these} because ${missing} is not on that team` : ''}.`;
    }
    const detail = [filesHave(stray.games, `a team called "${stray.name}"`), said, yf].filter(Boolean).join(' ');
    const fields = { name: stray.name, games: stray.games.size, team: found.team?.name ?? null, tie: found.tie?.map(team => team.name) ?? null, yellowFruit: yellowFruit?.name ?? null };
    if (yellowFruit && yellowFruit === found.team) {
      names.push(item('teamok', 'Team name spelt differently', `No fix needed: YellowFruit will match "${stray.name}" to "${yellowFruit.name}".`, detail, fields));
      continue;
    }
    const fix = found.team ? `Fix: Change "${stray.name}" to "${found.team.name}" ${inThe} before importing.`
      : found.tie ? `Fix: Find out whether "${stray.name}" is ${joinOr(found.tie.map(team => `"${team.name}"`))}, and change it ${inThe} before importing.`
        : yellowFruit ? `Fix: Check that "${stray.name}" means "${yellowFruit.name}".`
          : `Fix: Find out which team "${stray.name}" is, and change it ${inThe} before importing.`;
    names.push(item('team', 'Team name not in the tournament file', fix, detail, fields));
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
  const gameRows = new Map();   // path -> [row, row]
  for (const game of games) {
    const [a, b] = game.sides.map(side => rowOf(side.name));
    gameRows.set(game.path, [a, b]);
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

  // The rounds list first: a double or a gap that a game's wrong round explains says so.
  const folderNames = new Map();
  for (const game of games) {
    const at = folderRound(game.path);
    if (at && !folderNames.has(at.round)) folderNames.set(at.round, at.name);
  }
  // A copy of the same game (another file with the same text) is not a clash: it is the same game filed twice, which the
  // doubles below report, and counting it would make the copy's own round look taken.
  const clashes = game => r => [...new Set(gameRows.get(game.path))]
    .filter(row => (cells[row].get(r) ?? []).some(entry => entry.path !== game.path && entry.print !== game.print)).map(row => rows[row].name);
  let rounds = games.map(game => roundItem(game, { folderNames, clashes: clashes(game) })).filter(Boolean);
  // A game YellowFruit will put in the wrong round gives its teams a double there and a gap in its real round. Those
  // items get the same fix as the game's own item, so one fix is not read as three.
  const causedBy = new Map();   // `${round}|${row}` -> the game's round item
  for (const entry of rounds.filter(r => r.kind === 'inside')) {
    for (const row of gameRows.get(entry.path)) {
      causedBy.set(`${entry.round}|${row}`, entry);
      causedBy.set(`${entry.real}|${row}`, entry);
    }
  }
  const causeOf = (round, teamRows) => teamRows.map(row => causedBy.get(`${round}|${row}`)).find(Boolean);
  const causeFix = entry => `Fix: Leave ${fileName(entry.path)} out of the main import and import it with round ${entry.real}'s own Import button (see Rounds that don't match). Then this goes away.`;
  // An item a wrong round inside causes keeps that game's path in `cause`, so the top line counts the one fix, not each item.
  const caused = entry => (entry ? { cause: entry.path } : {});

  const doubles = [];
  const gaps = [];
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const met = new Set(placed.map(({ rows: [a, b] }) => pairKey(a, b)));
  // File names, with their folder when two in one item have the same name ("Round 1/R01 A v B.qbj and Round 2/R01 A v B.qbj").
  const named = paths => {
    const plain = paths.map(fileName);
    return joinAnd(new Set(plain).size < plain.length ? paths.map(path => String(path).split('/').slice(-2).join('/')) : plain);
  };
  const groupSize = new Map();   // group top -> how many teams with a game are in it
  const groupKnown = new Map();  // group top -> whether every team in it is in the tournament file
  for (const i of hasGame) {
    groupSize.set(top(i), (groupSize.get(top(i)) ?? 0) + 1);
    groupKnown.set(top(i), (groupKnown.get(top(i)) ?? true) && rows[i].registered);
  }
  const covered = new Set();     // copies a "filed twice" item says to delete: their own round items are left out
  if (!listHoles) {
    gaps.push(item('manyempty', 'Round numbers look wrong', 'Fix: Check the round inside each game file: one probably has a typo.',
      `${holes.length} rounds between round ${seen[0]} and round ${seen.at(-1)} have no games.`, { round: null, teams: [] }));
  }
  for (const round of gridRounds) {
    if (!roundsSeen.has(round)) {
      gaps.push(item('emptyround', `No games in round ${round}`, `Fix: Find the round ${round} game files, unless round ${round} was not played.`,
        'There are games in the rounds before and after it.', { round, teams: [] }));
    }
    for (const { game, rows: [a, b] } of placed.filter(p => p.round === round && p.rows[0] === p.rows[1])) {
      doubles.push(item('self', `${rows[a].name} on both sides of a game`, 'Fix: Find out who the other team was, and correct its name in the file.',
        `${fileName(game.path)}, round ${round}. YellowFruit will flag it: "A team cannot play itself".`, { round, teams: [rows[a].name], files: [game.path] }));
    }
    // Two or more files for a team in a round. The same files for both teams of one game make one item, not two.
    const groups = new Map();
    const gapRows = [];
    for (const row of gridRows) {
      const cell = row.cells[round];
      if (cell.state === 'double') {
        const files = cell.games.map(entry => entry.path);
        const key = files.join('\u0000');
        if (!groups.has(key)) groups.set(key, { files, games: cell.games, teams: [], teamRows: [] });
        groups.get(key).teams.push(row.name);
        groups.get(key).teamRows.push(row.n - 1);
      } else if (cell.state === 'gap') gapRows.push(row);
    }
    for (const { files, games: entries, teams, teamRows } of groups.values()) {
      const fields = { round, teams, files };
      const onePair = teams.length === 2 && entries.every(entry => fold(entry.opponentName) === fold(teams[1]));
      const same = entries.every(entry => entry.print === entries[0].print);
      if (onePair && same) {
        // When exactly one copy is in this round's folder, say to keep that one; the others' folders are then wrong too.
        const right = files.filter(path => roundFromFolder(path) === round);
        const keep = right.length === 1 && files.some(path => roundFromFolder(path) !== null && roundFromFolder(path) !== round) ? right[0] : null;
        if (keep) for (const path of files) if (path !== keep) covered.add(path);
        const others = files.length === 2 ? 'other' : 'others';
        doubles.push(item('twice', `Same game filed ${files.length === 2 ? 'twice' : `${files.length} times`} in round ${round}`,
          keep ? `Fix: Keep the one in the "${folderRound(keep).name}" folder and delete the ${others}.` : `Fix: Keep one file and delete the ${others}.`,
          `${named(files)} hold the same game, ${teams[0]} v ${teams[1]}.`, fields));
      } else if (onePair) {
        doubles.push(item('versions', `Two versions of one game in round ${round}`, 'Fix: Check which file is right, and delete the other.',
          `${named(files)} are both ${teams[0]} v ${teams[1]}, but they differ. YellowFruit warns about the later file only.`, fields));
      } else {
        const cause = causeOf(round, teamRows);
        doubles.push(item('double', `${files.length} games for ${joinAnd(teams)} in round ${round}`, cause ? causeFix(cause) : `Fix: Check which one is really round ${round}.`,
          `${named(files)}. YellowFruit warns about the later file only.`, { ...fields, ...caused(cause) }));
      }
    }
    // A team with no game in a round its opponents played. One a wrong round inside explains gets that game's fix. The rest
    // are judged within their pool (the teams joined by games), never across pools: exactly two that have not met are
    // probably one missing game, so they make one item; in a pool with an odd number of teams one team sits out each
    // round, so a lone gap there is probably a bye, and of three, the two that have not met are the missing game and the
    // third the bye. That needs a tournament file with every team of the pool in it (1.17.0, 23 Nov 2026); without one each
    // gap is a "no game" item. The page does not know the schedule, so it says "probably".
    const roundGaps = [];   // [row index, item]
    const pools = new Map();   // group top -> uncaused gap rows
    for (const row of gapRows) {
      const cause = causeOf(round, [row.n - 1]);
      if (cause) roundGaps.push([row.n - 1, item('nogame', `No game for ${row.name} in round ${round}`, causeFix(cause),
        `Teams it plays have games in round ${round}, but no game file has ${row.name} in that round.`, { round, teams: [row.name], ...caused(cause) })]);
      else pools.set(top(row.n - 1), [...(pools.get(top(row.n - 1)) ?? []), row]);
    }
    const missing = (x, y) => item('missing', `Game missing in round ${round}`, `Fix: Find the round ${round} game file for ${x.name} v ${y.name}.`,
      `${x.name} and ${y.name} both have no game in round ${round}, and they have not played each other, so it is probably their game against each other. If they both had a bye, ignore this.`,
      { round, teams: [x.name, y.name] });
    const bye = (row, size) => {
      row.cells[round].state = 'bye';
      return item('bye', `Probably a bye: ${row.name} in round ${round}`, `No fix needed if ${row.name} had a bye in round ${round}. If not, find its round ${round} game file.`,
        `${row.name}'s pool (the teams it plays, and the teams they play) has ${size} teams, an odd number, so one of them has no game each round. No game file has ${row.name} in round ${round}.`,
        { round, teams: [row.name] });
    };
    const notMet = (x, y) => !met.has(pairKey(x.n - 1, y.n - 1));
    for (const [group, pool] of pools) {
      const size = groupSize.get(group) ?? 0;
      // A pool's size means something only when every team in it is a real one: with no tournament file, or a team not in
      // it, a misspelt name is a made-up extra team, and would turn an even pool odd.
      const oddPool = Boolean(tournament) && groupKnown.get(group) === true && size % 2 === 1;
      const pairs = pool.flatMap((x, i) => pool.slice(i + 1).filter(y => notMet(x, y)).map(y => [x, y]));
      if (pool.length === 2 && pairs.length === 1) roundGaps.push([pool[0].n - 1, missing(...pool)]);
      else if (oddPool && pool.length === 1) roundGaps.push([pool[0].n - 1, bye(pool[0], size)]);
      else if (oddPool && pool.length === 3 && pairs.length === 1) {
        const third = pool.find(row => !pairs[0].includes(row));
        roundGaps.push([pairs[0][0].n - 1, missing(...pairs[0])], [third.n - 1, bye(third, size)]);
      } else {
        for (const row of pool) {
          roundGaps.push([row.n - 1, item('nogame', `No game for ${row.name} in round ${round}`, `Fix: Find its round ${round} game file, unless it had a bye.`,
            `Teams it plays have games in round ${round}, but no game file has ${row.name} in that round.`, { round, teams: [row.name] })]);
        }
      }
    }
    gaps.push(...roundGaps.sort((x, y) => x[0] - y[0]).map(([, entry]) => entry));
  }
  for (const row of gridRows) {
    if (row.registered && !hasGame.has(row.n - 1)) {
      gaps.push(item('noneatall', `No games for ${row.name}`, 'Fix: Find its game files, unless it did not play.',
        `${row.name} is in the tournament file, but no game file has it.`, { round: null, teams: [row.name] }));
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
      const these = stray.games.size === 1 ? 'the game' : 'these games';
      const inThe = stray.games.size === 1 ? 'inside the game file' : 'inside the game files';
      const taken = yellowFruitPlayer(stray.name, stray.roster);
      const has = closest ? `${stray.team} has ${closest.name}${closest.how === 'initial' ? ' (same surname and first letter)' : ''}.`
        : `No name on ${stray.team}'s roster is close.`;
      const detail = [filesHave(stray.games, `a player called "${stray.name}" on ${stray.team}`), has, taken ? '' : `YellowFruit will refuse ${these} until it is changed.`].filter(Boolean).join(' ');
      const fields = { name: stray.name, team: stray.team, games: stray.games.size, closest: closest?.name ?? null };
      if (taken) return item('playerok', 'Player name spelt differently', `No fix needed: YellowFruit will match "${stray.name}" to "${taken}".`, detail, fields);
      const fix = closest ? `Fix: Change "${stray.name}" to "${closest.name}" ${inThe} before importing.`
        : `Fix: Add "${stray.name}" to the roster of "${stray.team}" before importing, or correct the name ${inThe}.`;
      return item('player', 'Player not on the roster', fix, detail, fields);
    });
  }

  rounds = rounds.filter(entry => !covered.has(entry.path));
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

// ---- The report's shape: the top line, the sections, Copy report -----------------------------------------------------------

export const BYE_LINE = 'A "no game" cell can be a bye: check it against the schedule.';
export const MODAQ_HEAD = 'Not a game file YellowFruit can import: open it in MODAQ and use Export QBJ';
export const NO_TOURNAMENT = 'Load the tournament file to check team names.';
// The grid's key, a short list under it: only the marks in the rows shown, so it never explains a mark the TD cannot see.
const GRID_KEY = [
  [cell => cell.state === 'gap', 'no game: the teams it plays had games that round, but no game file has this team in it.'],
  [cell => cell.state === 'double', '2 games: two game files have this team in that round.'],
  [cell => cell.state === 'bye', 'bye?: no game that round, probably a bye: its pool has an odd number of teams.'],
  [cell => cell.games.some(entry => entry.filedAs), "filed as: the name this team has in that game file, which is not the tournament file's."],
  [cell => cell.state === 'none', '–: none of the teams it plays had a game that round.'],
];
export const gridKey = rows => GRID_KEY.filter(([shows]) => rows.some(row => Object.values(row.cells).some(shows))).map(([, line]) => line);

// A grid row with something to fix: a name not in the tournament file, a gap or a double, a game filed under another name,
// or a game against itself. A probable bye is not.
export const needsFixing = (row, report) => Boolean(report.tournament && !row.registered)
  || Object.values(row.cells).some(cell => cell.state === 'gap' || cell.state === 'double'
    || cell.games.some(entry => entry.filedAs || entry.opponent === row.n));

const OPTIONAL = new Set(['bye', 'teamok', 'playerok']);
const allItems = report => [...report.rounds, ...report.doubles, ...report.gaps, ...(report.names ?? []), ...(report.players ?? [])];

// Nothing found in any of the three jobs.
export const clean = report => allItems(report).length === 0;

// The line at the top: how many things to fix, counted by kind in plain words. A double counts each team it gives two
// games. A problem a wrong round inside causes is listed with that game's fix, so it is not counted again: one sentence
// says how many follow from it. Items with no fix needed (probable byes, names YellowFruit matches) are named last.
export function countLine(report) {
  const items = allItems(report);
  if (!items.length) {
    return report.names ? 'Nothing to fix: the rounds agree, no game is missing or doubled, and every name is in the tournament file.'
      : 'Nothing to fix in the rounds, and no game is missing or doubled.';
  }
  const weight = entry => (entry.kind === 'double' ? entry.teams.length : 1);
  const optional = items.filter(entry => OPTIONAL.has(entry.kind));
  const following = items.filter(entry => entry.cause && !OPTIONAL.has(entry.kind));
  const needed = items.filter(entry => !entry.cause && !OPTIONAL.has(entry.kind));
  const total = needed.reduce((sum, entry) => sum + weight(entry), 0);
  const parts = Object.keys(KINDS).filter(kind => KINDS[kind])
    .map(kind => [kind, needed.filter(entry => entry.kind === kind).reduce((sum, entry) => sum + weight(entry), 0)])
    .filter(([, n]) => n).map(([kind, n]) => `${n} ${KINDS[kind][n === 1 ? 0 : 1]}`);
  const byes = optional.filter(entry => entry.kind === 'bye').length;
  const names = optional.length - byes;
  const extras = [byes ? `${byes} probable ${byes === 1 ? 'bye' : 'byes'}` : null,
    names ? `${names === 1 ? '1 name' : `${names} names`} YellowFruit will match on its own` : null].filter(Boolean);
  if (!total) return `Nothing needs fixing. Listed below with no fix needed: ${joinAnd(extras)}.`;
  const insides = new Set(following.map(entry => entry.cause)).size;
  const follow = following.length ? ` ${following.length} more ${following.length === 1 ? 'problem' : 'problems'} listed`
    + ` ${following.length === 1 ? 'comes' : 'come'} from the wrong ${insides === 1 ? 'round inside a game file' : 'rounds inside game files'},`
    + ` and ${following.length === 1 ? 'goes' : 'go'} once ${insides === 1 ? 'it is' : 'they are'} fixed.` : '';
  return `${plural(total, 'thing')} to fix: ${joinAnd(parts)}.${follow}${extras.length ? ` Also listed, with no fix needed: ${joinAnd(extras)}.` : ''}`;
}

// The words above the report: the tournament, the files read, and the count line once there are games.
export function summaryLines(report) {
  const lines = [report.tournament
    ? `Tournament: ${report.tournament.name ?? 'no name'} (${plural(report.tournament.teams, 'team')})`
    : 'No tournament file loaded.'];
  const rest = report.counts.modaq + report.counts.other + report.counts.bad;
  lines.push(`${plural(report.counts.games, 'game file')} read.${rest ? ` ${plural(rest, 'other file')} listed at the end.` : ''}`);
  if (report.counts.games) lines.push(countLine(report));
  return lines;
}

// The report's sections in order, each with its heading and items. One with nothing in it is left out, not shown as "None".
export function sections(report) {
  const out = [];
  const add = (id, heading, items) => { if (items.length) out.push({ id, heading: `${heading} (${items.length})`, items }); };
  add('rounds', "Rounds that don't match", report.rounds);
  add('games', 'Missing or doubled games', [...report.doubles, ...report.gaps]);
  if (report.names) add('names', 'Names not in the tournament file', [...report.names, ...report.players]);
  return out;
}

// The line after the last item, which stands for every section left out and closes the list; null with nothing listed
// (the top line then says so).
export function nothingElse(report) {
  if (!sections(report).length) return null;
  if (allItems(report).every(entry => OPTIONAL.has(entry.kind))) return report.names ? 'Nothing else was found.' : 'Nothing else was found in the rounds and games.';
  return report.names ? 'That is everything to fix.' : 'That is everything to fix in the rounds and games.';
}

// Copy report: the same words as the page, in the same order, as plain text for the TD's notes or Discord.
export function reportText(report) {
  const out = ['Skor TD check', ...summaryLines(report), ''];
  for (const section of sections(report)) {
    out.push(section.heading);
    for (const entry of section.items) out.push(`- ${entry.title}`, `  ${entry.fix}`, `  ${entry.detail}`);
    out.push('');
  }
  const after = [nothingElse(report), report.names ? null : NO_TOURNAMENT].filter(Boolean);
  if (after.length) out.push(...after, '');
  const files = (heading, lines) => out.push(heading, ...lines.map(line => `- ${line}`), '');
  if (report.modaq.length) files(`${MODAQ_HEAD} (${report.modaq.length})`, report.modaq);
  if (report.bad.length) files(`Could not be read (${report.bad.length})`, report.bad.map(entry => entry.line[0]));
  if (report.other.length) files(`Skipped: not .qbj files (${report.other.length})`, report.other);
  return `${out.join('\n').trim()}\n`;
}
