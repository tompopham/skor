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
  moved: ['game probably in the wrong round', 'games probably in the wrong round'],
  filename: ['file name with the wrong round', 'file names with the wrong round'],
  unclear: ['game whose round is unclear', 'games whose round is unclear'],
  noround: ['game with no round inside', 'games with no round inside'],
  twice: ['game filed twice', 'games filed twice'],
  versions: ['game with two different files', 'games with two different files'],
  double: ['team with two games in a round', 'teams with two games in a round'],   // counted by team, not by item
  self: ['team on both sides of a game', 'teams on both sides of a game'],
  missing: ['game missing', 'games missing'],
  unscheduled: ['game not in the schedule', 'games not in the schedule'],
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
export function roundItem({ path, round }, { folderNames = new Map(), clashes = () => [], lastRound = null, busy = () => true } = {}) {
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
  // Of several rounds that fit, the one the other games are in beats one nobody else plays (a typo like 12 for 2).
  const lively = fitting.filter(r => busy(r));
  const real = groups.size === 1 ? candidates[0] : fitting.length === 1 ? fitting[0] : lively.length === 1 ? lively[0] : null;
  // A round later than the tournament's last: YellowFruit has no such round, and refuses the game (TournamentManager.ts:562-565).
  const beyond = has(inside) && lastRound !== null && inside > lastRound;
  const placed = n => (beyond ? `Round ${n} is later than any other game file. If the tournament has no round ${n}, YellowFruit refuses the game; if it has one, its main Import button will put the game there.` : MAIN_IMPORT(n));
  const wrong = candidates.filter(r => r !== real);
  const clashing = real === null ? [] : [...new Set(wrong.flatMap(r => clashes(r)))];
  const because = clashing.length
    ? ` ${joinAnd(clashing)} already ${clashing.length === 1 ? 'has' : 'have'} a game in ${wrong.length === 1 ? `round ${wrong[0]}` : `rounds ${joinAnd(wrong)}`}.` : '';
  if (has(inside)) {
    if (real === null) return item('unclear', 'Round unclear', 'Fix: Check the schedule for which round it was.', `${name}: ${said}. ${placed(inside)}`, { ...at, beyond });
    if (real === inside && has(folder) && folder !== real) {
      const target = folderNames.get(real);
      const right = groups.get(real).map(label => (label === 'the file name' ? 'its file name' : 'the round inside it'));
      // A file name that says another round too (all three places disagree) is part of the same fix (1.19.0).
      const nameRound = round.fileName;
      const nameWrong = has(nameRound) && nameRound !== real;
      return item('folder', 'Game in the wrong folder', `Fix: Move it to ${target ? `the "${target}" folder` : `a round ${real} folder`}${nameWrong ? ` and change the round in its file name to ${real}` : ''}.`,
        `${name} is in the "${folderRound(path).name}" folder${nameWrong ? ` and its file name says round ${nameRound}` : ''}, but ${joinAnd(right)} ${right.length === 1 ? 'says' : 'say'} round ${real}.${because} ${STILL(real)}`, { ...at, real });
    }
    if (real === inside) {
      return item('filename', 'Wrong round in a file name', `Fix: Change the round in its file name to ${real}.`,
        `${name}: ${said}.${because} YellowFruit will put it in round ${real} either way.`, at);
    }
    return item('inside', 'Wrong round inside a game file', LEAVE_OUT(real), `${name}: ${said}.${because} ${placed(inside)}`, { ...at, real, beyond });
  }
  const odd = round.insideText ?? null;
  const why = !odd ? 'has no round' : odd.quoted ? `has its round as text ("${odd.text}")` : `has a round that is not a round number (${odd.text})`;
  const fix = real !== null ? OWN_IMPORT(real) : "Fix: Check the schedule, then import it with that round's own Import button in YellowFruit.";
  const detail = given.length ? `${name}: ${said}, but the file itself ${why}, so YellowFruit's main Import button can't place it.${because}`
    : `${name}: the folder and the file name give no round, and the file itself ${why}, so YellowFruit's main Import button can't place it.`;
  return item('noround', 'No round inside a game file', fix, detail, { ...at, real });
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

// What YellowFruit 4.0.18 treats as one name before it scores anything: it lowercases and compares nothing else, so an
// apostrophe, an accent or a doubled space makes a different name (FileParsing.ts:41, 850-855, 924-930, 1182-1205). 1.19.0.
const lower = name => String(name ?? '').toLowerCase();

// THE FINISHED-TEAM RULE (1.19.0; the choice is Tom's and not yet made, 24 Nov 2026; built as recommended). With no
// schedule, a team that has no game after its last game in a later phase (the afternoon) is taken as knocked out or done,
// not as missing a game. Never in the first phase (a missing last-round game in the morning pools must be caught), and
// never with a schedule (the schedule decides). To change the rule, change this one function.
export function teamIsFinished({ phase, round, lastRound }) {
  return phase > 0 && lastRound !== null && lastRound !== undefined && round > lastRound;
}

// The rounds where a new phase starts, from each round's games as pairs of rows (1.19.0; spec 4.2). A phase is a stretch
// of rounds whose games keep the same pools. A new one starts at the first round whose games either
//  (a) join two groups of teams that had played apart until then, each of three or more teams and unchanged in the round
//      before (two small groups joined in round 2 of a round robin are not it: the second round always joins the first
//      round's pairs); or
//  (b) after a pool of four or more has played every other team in it (its round robin is complete), involve only half the
//      pool or fewer: a final, semis or a playoff among one pool's teams (review 3, 24 Nov 2026). A double round robin is
//      not it: the round after the first cycle that is partial because a game is missing is followed by a full one.
export function phaseStarts(roundPairs) {
  const rounds = [...roundPairs.keys()].sort((a, b) => a - b);
  if (!rounds.length) return [];
  const starts = [rounds[0]];
  let parent = new Map();
  let size = new Map();
  let changed = new Map();   // root -> the round its team set last changed in
  let members = new Map();   // root -> Set of teams
  let met = new Set();
  let cycle = new Map();     // root -> { rounds: rounds since complete, second: a second cycle is under way }
  const find = x => { if (!parent.has(x)) return undefined; while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const key = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const playing = (root, pairs) => pairs.filter(([x, y]) => find(x) === root).length * 2;
  const fresh = () => { parent = new Map(); size = new Map(); changed = new Map(); members = new Map(); met = new Set(); cycle = new Map(); };
  let previous = null;
  for (const [index, round] of rounds.entries()) {
    const pairs = roundPairs.get(round);
    const settled = x => parent.has(x) && size.get(find(x)) >= 3 && previous !== null && changed.get(find(x)) < previous;
    let boundary = pairs.some(([x, y]) => settled(x) && settled(y) && find(x) !== find(y));
    if (!boundary) {
      for (const root of new Set([...parent.keys()].map(find))) {
        const n = size.get(root);
        if (n < 4 || met.size === 0) continue;
        const have = [...members.get(root)].reduce((sum, x, i, all) => sum + all.slice(i + 1).filter(y => met.has(key(x, y))).length, 0);
        if (have < (n * (n - 1)) / 2) continue;   // its round robin is not complete
        const state = cycle.get(root) ?? { rounds: 0, second: false };
        cycle.set(root, state);
        const inRound = playing(root, pairs);
        const full = inRound >= n - 1;
        const perCycle = n % 2 === 0 ? n - 1 : n;
        if (inRound === 0) continue;   // a pool that sits a round out is not in it
        state.rounds += 1;
        if (full) { if (state.rounds === 1) state.second = true; continue; }
        if (inRound > n / 2) continue;   // a round with most of the pool in it, a game or two short
        if (state.second && state.rounds <= perCycle) continue;   // the second cycle of a double round robin
        const later = rounds[index + 1];
        if (state.rounds === 1 && later !== undefined && playing(root, roundPairs.get(later)) >= n - 1) { state.second = true; continue; }
        boundary = true;
      }
    }
    if (boundary) { starts.push(round); fresh(); }
    for (const [x, y] of pairs) {
      for (const team of [x, y]) if (!parent.has(team)) { parent.set(team, team); size.set(team, 1); changed.set(team, round); members.set(team, new Set([team])); }
      const rx = find(x);
      const ry = find(y);
      met.add(key(x, y));
      if (rx !== ry) {
        parent.set(rx, ry); size.set(ry, size.get(rx) + size.get(ry)); changed.set(ry, round);
        for (const m of members.get(rx)) members.get(ry).add(m);
        members.delete(rx); cycle.delete(rx); cycle.delete(ry);
      }
    }
    previous = round;
  }
  return starts;
}

// The whole report. `entries` are the files in path order: readGame()'s results and { path, kind: 'modaq' | 'other' } for
// the rest. `tournament` is readTournament()'s result (readTournamentFile()'s, with its `schedule`, when it has one), or
// null. Gives the three jobs' lists (each item with its `line`), the grid, and the files not read.
export function checkGames(entries, tournament) {
  const games = entries.filter(entry => entry.kind === 'game').map(entry => entry.game);
  const registered = tournament?.teams ?? [];

  // Rows: the registered teams in the file's order; then each name not in the file that is not matched to one.
  // A team registered twice under one name is one row. Names are the same only as YellowFruit takes them (lowercase).
  const rows = [];
  const rowOfFold = new Map();
  for (const team of registered) {
    if (rowOfFold.has(lower(team.name))) continue;
    rowOfFold.set(lower(team.name), rows.length);
    rows.push({ name: team.name, registered: true, roster: team.players });
  }
  const rowOfTeam = team => rowOfFold.get(lower(team.name));
  const strays = new Map();   // lowercase -> { name, players: Map(fold -> name), games: Set(path) }
  for (const game of games) {
    for (const side of game.sides) {
      const key = lower(side.name);
      if (rowOfFold.has(key)) continue;
      if (!strays.has(key)) strays.set(key, { name: side.name, players: new Map(), games: new Set() });
      const stray = strays.get(key);
      stray.games.add(game.path);
      for (const player of side.players) if (!stray.players.has(fold(player))) stray.players.set(fold(player), player);
    }
  }
  const strayList = [...strays.entries()].map(([key, stray]) => ({ key, ...stray, players: [...stray.players.values()] })).sort(byName);
  const names = tournament ? [] : null;
  const nameItems = new Map();   // stray key -> its name item
  const newRows = [];
  for (const stray of strayList) {
    const found = tournament ? suggestTeam(stray.name, stray.players, registered) : { team: null, tie: null, matched: [] };
    const yellowFruit = tournament ? yellowFruitTeam(stray.name, registered) : null;
    // No registered team shares a player with it, though it lists players: it is a team the file does not have (1.19.0), so
    // it stays its own row, not filed under the team YellowFruit picks, which would blame that team for its players.
    const unknown = Boolean(tournament) && stray.players.length > 0 && !found.team && !found.tie;
    // With no players listed, the grid takes the team YellowFruit will (a misspelt name in a game with no players listed).
    const into = unknown ? null : found.team ?? (found.tie ? null : yellowFruit);
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
        : unknown ? `Fix: Add "${stray.name}" to the tournament file, or check its name ${inThe} before importing.`
          : yellowFruit ? `Fix: Check that "${stray.name}" means "${yellowFruit.name}".`
            : `Fix: Find out which team "${stray.name}" is, and change it ${inThe} before importing.`;
    const nameItem = item('team', 'Team name not in the tournament file', fix, detail, fields);
    names.push(nameItem);
    nameItems.set(stray.key, nameItem);
  }
  const strayItemOfRow = new Map();   // row of a team not in the tournament file -> its name item (the knock-ons point at it)
  for (const stray of newRows) {
    rowOfFold.set(stray.key, rows.length);
    if (nameItems.has(stray.key)) strayItemOfRow.set(rows.length, nameItems.get(stray.key));
    rows.push({ name: stray.name, registered: false, roster: null });
  }
  const rowOf = name => rowOfFold.get(lower(name));

  // Each game's two rows. A game with one team on both sides whose players show which team the other side is gets that
  // side moved to that team (1.19.0), so the grid does not blame the right team for a missing game; the game's own item
  // says to change the name. `selfGames` holds the games with one team on both sides.
  const gameRows = new Map();   // path -> [row, row]
  const selfGames = new Map();  // path -> { side, team } (team: the registered team the side's players belong to, or null)
  for (const game of games) {
    const pair = game.sides.map(side => rowOf(side.name));
    if (pair[0] === pair[1]) {
      let suggested = null;
      if (tournament) {
        const guess = game.sides.map(side => suggestTeam(side.name, side.players, registered).team);
        const guessRow = guess.map(team => (team ? rowOfTeam(team) : null));
        const wrong = [0, 1].filter(s => guessRow[s] !== null && guessRow[s] !== pair[s]);
        if (wrong.length === 1 && guessRow[1 - wrong[0]] !== null && guessRow[1 - wrong[0]] === pair[1 - wrong[0]]) {
          suggested = { side: wrong[0], team: guess[wrong[0]] };
          pair[wrong[0]] = guessRow[wrong[0]];
        }
      }
      selfGames.set(game.path, suggested ?? { side: null, team: null });
    }
    gameRows.set(game.path, pair);
  }

  // Each game into its round's cells: the round YellowFruit will use, else the file name's, else the folder's.
  const hasGame = new Set();
  for (const game of games) for (const row of gameRows.get(game.path)) hasGame.add(row);
  const layout = roundOf => {
    const cells = rows.map(() => new Map());
    const placed = [];
    for (const game of games) {
      const round = roundOf(game);
      if (round === null || round === undefined) continue;
      const [a, b] = gameRows.get(game.path);
      placed.push({ game, round, rows: [a, b] });
      game.sides.forEach((side, s) => {
        const row = s === 0 ? a : b;
        const other = s === 0 ? b : a;
        const cell = cells[row].get(round) ?? [];
        if (cell.some(entry => entry.path === game.path)) return;
        const filedAs = lower(side.name) === lower(rows[row].name) ? null : side.name;
        // Whether YellowFruit takes the name filed as for this team on its own (so a "filed as" mark needs no fix).
        const filedOk = Boolean(filedAs) && Boolean(tournament) && rows[row].registered && lower(yellowFruitTeam(side.name, registered)?.name) === lower(rows[row].name);
        cell.push({ path: game.path, opponent: other + 1, opponentName: rows[other].name, filedAs, filedOk, print: game.print });
        cells[row].set(round, cell);
      });
    }
    return { cells, placed };
  };
  const initialRound = game => game.round.inside ?? game.round.fileName ?? game.round.folder;
  const first = layout(initialRound);

  // The rounds list first: a double or a gap that a game's wrong round explains says so.
  const folderNames = new Map();
  for (const game of games) {
    const at = folderRound(game.path);
    if (at && !folderNames.has(at.round)) folderNames.set(at.round, at.name);
  }
  // A copy of the same game (another file with the same text) is not a clash: it is the same game filed twice, which the
  // doubles below report, and counting it would make the copy's own round look taken.
  const clashes = game => r => [...new Set(gameRows.get(game.path))]
    .filter(row => (first.cells[row].get(r) ?? []).some(entry => entry.path !== game.path && entry.print !== game.print)).map(row => rows[row].name);
  // The last round the tournament has: the schedule's, else the latest round any other game file gives. A round later than
  // that is one YellowFruit does not have, and it refuses a game in it (TournamentManager.ts:562-565).
  const scheduled = tournament?.schedule?.rounds ?? [];
  const lastRoundFor = game => {
    const others = first.placed.filter(p => p.game.path !== game.path).map(p => p.round);
    const all = [...others, ...scheduled.map(r => r.round)];
    return all.length ? Math.max(...all) : null;
  };
  const busy = game => r => first.placed.some(p => p.round === r && p.game.path !== game.path);
  let rounds = games.map(game => roundItem(game, { folderNames, clashes: clashes(game), lastRound: lastRoundFor(game), busy: busy(game) })).filter(Boolean);

  // A game YellowFruit's main Import cannot place, or will refuse, is put in the grid in the round its item worked out,
  // since that is where the TD will import it (1.19.0); the others stay where YellowFruit will put them.
  const moveTo = new Map();
  for (const entry of rounds) {
    if (entry.real !== null && entry.real !== undefined && (entry.kind === 'noround' || (entry.kind === 'inside' && entry.beyond))) moveTo.set(entry.path, entry.real);
  }
  const { cells, placed } = layout(game => moveTo.get(game.path) ?? initialRound(game));
  const roundsSeen = new Set(placed.map(p => p.round));
  const seen = [...roundsSeen].sort((x, y) => x - y);

  // Phases (1.19.0): the schedule's rounds with every game between two named teams are exact; the others are judged in the
  // phase their round falls in, from where the games join pools.
  const roundPairs = new Map();
  for (const { round, rows: [a, b] } of placed) roundPairs.set(round, [...(roundPairs.get(round) ?? []), [a, b]]);
  const starts = phaseStarts(roundPairs);
  const phaseOf = round => starts.reduce((p, start, k) => (round >= start ? k : p), 0);
  const phases = starts.map(() => ({ parent: rows.map((_, i) => i), has: new Set(), played: new Map(), last: new Map(), size: new Map(), known: new Map(), met: new Set() }));
  const topIn = (ph, i) => { while (ph.parent[i] !== i) { ph.parent[i] = ph.parent[ph.parent[i]]; i = ph.parent[i]; } return i; };
  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  for (const { round, rows: [a, b] } of placed) {
    const ph = phases[phaseOf(round)];
    ph.has.add(a).add(b);
    ph.parent[topIn(ph, a)] = topIn(ph, b);
    ph.met.add(pairKey(a, b));
  }
  for (const [k, ph] of phases.entries()) {
    for (const { round, rows: [a, b] } of placed.filter(p => phaseOf(p.round) === k)) {
      const root = topIn(ph, a);
      if (!ph.played.has(root)) ph.played.set(root, new Set());
      ph.played.get(root).add(round);
      for (const row of [a, b]) ph.last.set(row, Math.max(ph.last.get(row) ?? 0, round));
    }
    for (const i of ph.has) {
      ph.size.set(topIn(ph, i), (ph.size.get(topIn(ph, i)) ?? 0) + 1);
      ph.known.set(topIn(ph, i), (ph.known.get(topIn(ph, i)) ?? true) && rows[i].registered);
    }
  }
  // The schedule's rounds that name every team: round -> [[row, row]].
  const exact = new Map();
  for (const entry of scheduled) {
    const pairs = entry.games.map(g => g.sides.map(side => (side.team !== undefined ? rowOfFold.get(lower(side.team)) : undefined)));
    if (pairs.length && pairs.every(pair => pair.length === 2 && pair.every(row => row !== undefined) && pair[0] !== pair[1])) exact.set(entry.round, pairs);
  }
  const inPair = (pairs, i) => pairs.some(([x, y]) => x === i || y === i);

  // A round between the first and the last with no game at all (a round's folder left out, say) gets its own column and
  // line; so many that the round numbers must be wrong get one line instead.
  const holes = [];
  for (let round = seen[0]; round < seen.at(-1); round += 1) if (!roundsSeen.has(round)) holes.push(round);
  const listHoles = holes.length <= 5;
  const gridRounds = listHoles ? [...seen, ...holes].sort((x, y) => x - y) : seen;
  const gridRows = rows.map((row, i) => {
    const rowCells = {};
    for (const round of gridRounds) {
      const list = (cells[i].get(round) ?? []).sort((x, y) => collator.compare(x.path, y.path));
      let state = 'none';
      if (list.length > 1) state = 'double';
      else if (list.length === 1) state = 'game';
      else if (exact.has(round)) state = inPair(exact.get(round), i) ? 'gap' : 'free';
      else {
        const k = phaseOf(round);
        const ph = phases[k];
        if (ph.has.has(i) && ph.played.get(topIn(ph, i))?.has(round)) state = teamIsFinished({ phase: k, round, lastRound: ph.last.get(i) }) ? 'finished' : 'gap';
      }
      rowCells[round] = { state, games: list };
    }
    return { n: i + 1, name: row.name, registered: row.registered, cells: rowCells };
  });
  const stateAt = (i, round) => gridRows[i].cells[round]?.state;

  // A game all of whose places agree on a round can still be in the wrong one: MODAQ not advanced to the next round gives
  // a team two games in one round and none in the next. When exactly one game, moved to exactly one round, clears the
  // doubles of both its teams and fills a gap for each, it is probably that game (1.19.0).
  const hasItem = new Set(rounds.map(entry => entry.path));
  const candidates = [];
  for (const { game, round, rows: [a, b] } of placed) {
    if (a === b || hasItem.has(game.path) || exact.has(round)) continue;
    if ((cells[a].get(round) ?? []).length !== 2 || (cells[b].get(round) ?? []).length !== 2) continue;
    const targets = gridRounds.filter(r => r !== round && !exact.has(r) && stateAt(a, r) === 'gap' && stateAt(b, r) === 'gap');
    if (targets.length === 1) candidates.push({ game, round, rows: [a, b], target: targets[0] });
  }
  for (const c of candidates) {
    const clash = candidates.some(o => o !== c && o.rows.some(row => c.rows.includes(row)) && o.round === c.round);
    if (clash) continue;
    const name = fileName(c.game.path);
    const teams = c.rows.map(row => rows[row].name);
    rounds.push(item('moved', 'Game probably in the wrong round',
      `Fix: If it was round ${c.target}, leave it out of the main import (choose Discard for it in the preview). Then import it with round ${c.target}'s own Import button.`,
      `${name} says round ${c.round}, but ${joinAnd(teams)} each have two games in round ${c.round} and none in round ${c.target}, and this is the one game that would fix both. YellowFruit will put it in round ${c.round}.`,
      { path: c.game.path, round: c.round, real: c.target }));
  }
  // A game YellowFruit will put in the wrong round gives its teams a double there and a gap in its real round. Those
  // items get the same fix as the game's own item, so one fix is not read as three.
  const causedBy = new Map();   // `${round}|${row}` -> the game's round item
  for (const entry of rounds.filter(r => (r.kind === 'inside' || r.kind === 'moved') && !r.beyond)) {
    for (const row of gameRows.get(entry.path)) {
      causedBy.set(`${entry.round}|${row}`, entry);
      causedBy.set(`${entry.real}|${row}`, entry);
    }
  }
  const causeOf = (round, teamRows) => teamRows.map(row => causedBy.get(`${round}|${row}`)).find(Boolean);
  const causeFix = entry => `Fix: Leave ${fileName(entry.path)} out of the main import and import it with round ${entry.real}'s own Import button (see Rounds that don't match). Then this goes away.`;
  // An item a wrong round causes keeps that game's path in `cause`, so the top line counts the one fix, not each item.
  const caused = entry => (entry ? { cause: entry.path, causeKind: entry.kind } : {});
  // A team not in the tournament file takes the place of a registered one: it has "no game" in the rounds it did not play,
  // and the team it stands for has none in the rounds it did (review 3). Those gaps point at the name item.
  const strayCause = (round, teamRows) => {
    for (const row of teamRows) if (strayItemOfRow.has(row)) return strayItemOfRow.get(row);
    for (const [row, nameItem] of strayItemOfRow) if ((cells[row].get(round) ?? []).length) return nameItem;
    return null;
  };
  const strayFix = nameItem => `Fix: Fix the team name "${nameItem.name}" first (see Names not in the tournament file). Then this goes away.`;
  const strayLink = nameItem => ({ cause: `name:${nameItem.name}`, causeKind: 'name' });

  const doubles = [];
  const gaps = [];
  const met = (k, x, y) => phases[k].met.has(pairKey(x, y));
  // File names, with their folder when two in one item have the same name ("Round 1/R01 A v B.qbj and Round 2/R01 A v B.qbj").
  const named = paths => {
    const plain = paths.map(fileName);
    return joinAnd(new Set(plain).size < plain.length ? paths.map(path => String(path).split('/').slice(-2).join('/')) : plain);
  };
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
    for (const { game, rows: [a, b] } of placed.filter(p => p.round === round && selfGames.has(p.game.path))) {
      const own = selfGames.get(game.path);
      const base = `${fileName(game.path)}, round ${round}.`;
      if (own.team) {
        // YellowFruit takes the side by its name, then looks for the side's players on that team, and stops at the first it
        // cannot find (FileParsing.ts:924-930), before it ever checks the teams differ (Match.ts:599-605).
        const side = game.sides[own.side];
        const wrongTeam = yellowFruitTeam(side.name, registered);
        const missing = wrongTeam ? side.players.find(player => !yellowFruitFindsPlayer(player, wrongTeam)) : null;
        const which = own.side === 0 ? 'first' : 'second';
        doubles.push(item('self', `${game.sides[0].name} on both sides of a game`,
          `Fix: Change the ${which} "${side.name}" to "${own.team.name}" inside the game file before importing.`,
          `${base} The ${which} side's players are ${own.team.name}'s.${missing ? ` YellowFruit will refuse it: it cannot find ${missing} on team ${wrongTeam.name}.` : ''}`,
          { round, teams: [side.name], files: [game.path] }));
        continue;
      }
      let stop = null;
      if (tournament) {
        const team = yellowFruitTeam(game.sides[0].name, registered);
        const missing = team ? game.sides.flatMap(side => side.players).find(player => !yellowFruitFindsPlayer(player, team)) : null;
        if (missing) stop = `YellowFruit will refuse it: it cannot find ${missing} on team ${team.name}.`;
      }
      doubles.push(item('self', `${rows[a].name} on both sides of a game`, 'Fix: Find out who the other team was, and correct its name in the file.',
        `${base} ${stop ?? 'YellowFruit will flag it: "A team cannot play itself".'}`, { round, teams: [rows[a].name], files: [game.path] }));
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
      const onePair = teams.length === 2 && entries.every(entry => lower(entry.opponentName) === lower(teams[1]));
      const same = entries.every(entry => entry.print === entries[0].print);
      if (onePair && same) {
        // When exactly one copy is in this round's folder, say to keep that one; the others' folders are then wrong too.
        const right = files.filter(path => roundFromFolder(path) === round);
        const keep = right.length === 1 && files.some(path => roundFromFolder(path) !== null && roundFromFolder(path) !== round) ? right[0] : null;
        if (keep) for (const path of files) if (path !== keep) covered.add(path);
        // Every copy in a wrong folder, each with its own "move it" item: one item says keep one and move it (1.19.0).
        const allMoves = !keep && files.every(path => rounds.some(entry => entry.path === path && entry.kind === 'folder' && entry.real === round));
        if (allMoves) for (const path of files) covered.add(path);
        const others = files.length === 2 ? 'other' : 'others';
        const target = folderNames.get(round);
        doubles.push(item('twice', `Same game filed ${files.length === 2 ? 'twice' : `${files.length} times`} in round ${round}`,
          keep ? `Fix: Keep the one in the "${folderRound(keep).name}" folder and delete the ${others}.`
            : allMoves ? `Fix: Keep one file and delete the ${others}. Move the one you keep to ${target ? `the "${target}" folder` : `a round ${round} folder`}.`
              : `Fix: Keep one file and delete the ${others}.`,
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
    const roundGaps = [];   // [row index, item]
    if (exact.has(round)) {
      if (!roundsSeen.has(round)) continue;   // a round with no files at all has its one "No games in round" item above
      // The schedule's pairings for this round, against the games filed in it (1.19.0): a scheduled game with no file is a
      // missing game; a team the schedule gives no game is not a gap (a bye); a game filed that the schedule does not have
      // gets its own item. A game filed in one round that the schedule has in another says so in its one item.
      const pairs = exact.get(round);
      const filed = placed.filter(p => p.round === round && p.rows[0] !== p.rows[1]);
      const hasFiled = (x, y) => filed.some(p => pairKey(p.rows[0], p.rows[1]) === pairKey(x, y));
      const elsewhere = (x, y) => placed.some(p => p.round !== round && pairKey(p.rows[0], p.rows[1]) === pairKey(x, y)
        && exact.has(p.round) && exact.get(p.round).every(([u, v]) => pairKey(u, v) !== pairKey(x, y)));
      const strayOpponent = row => filed.some(p => p.rows.includes(row) && p.rows.some(other => !rows[other].registered));
      for (const [x, y] of pairs) {
        if (hasFiled(x, y) || elsewhere(x, y) || strayOpponent(x) || strayOpponent(y)) continue;
        const cause = causeOf(round, [x, y]);
        const byName = cause ? null : strayCause(round, [x, y]);
        roundGaps.push([Math.min(x, y), item('missing', `Game missing in round ${round}`,
          cause ? causeFix(cause) : byName ? strayFix(byName) : `Fix: Find the round ${round} game file for ${rows[x].name} v ${rows[y].name}.`,
          `The schedule has ${rows[x].name} v ${rows[y].name} in round ${round}, but no game file has them playing each other.`,
          { round, teams: [rows[x].name, rows[y].name], ...(cause ? caused(cause) : byName ? strayLink(byName) : {}) })]);
      }
      for (const p of filed) {
        const [x, y] = p.rows;
        if (pairs.some(([u, v]) => pairKey(u, v) === pairKey(x, y)) || !rows[x].registered || !rows[y].registered) continue;
        const theirs = [x, y].map(row => pairs.find(pair => pair.includes(row))).filter(Boolean)
          .map(([u, v]) => `${rows[u].name} v ${rows[v].name}`);
        const later = [...exact].find(([r, ps]) => r !== round && ps.some(([u, v]) => pairKey(u, v) === pairKey(x, y)));
        const has = later ? `the schedule has them playing in round ${later[0]}`
          : theirs.length ? `the schedule has ${joinAnd([...new Set(theirs)])} in round ${round}` : `the schedule has no game for either team in round ${round}`;
        const cause = causeOf(round, [x, y]);
        roundGaps.push([Math.min(x, y), item('unscheduled', `Game not in the schedule: ${rows[x].name} v ${rows[y].name} in round ${round}`,
          cause ? causeFix(cause) : 'Fix: Check the round and both team names in the game file against the schedule.',
          `${fileName(p.game.path)} is ${rows[x].name} v ${rows[y].name} in round ${round}, but ${has}.`,
          { round, teams: [rows[x].name, rows[y].name], ...caused(cause) })]);
      }
      gaps.push(...roundGaps.sort((u, v) => u[0] - v[0]).map(([, entry]) => entry));
      continue;
    }
    // A team with no game in a round its opponents played. One a wrong round inside explains gets that game's fix. The rest
    // are judged within their pool (the teams joined by games in this phase), never across pools: exactly two that have not
    // met are probably one missing game, so they make one item; in a pool with an odd number of teams one team sits out each
    // round, so a lone gap there is probably a bye, and of three, the two that have not met are the missing game and the
    // third the bye. That needs a tournament file with every team of the pool in it (1.17.0, 23 Nov 2026); without one each
    // gap is a "no game" item. The page does not know the schedule, so it says "probably".
    const k = phaseOf(round);
    const ph = phases[k];
    const pools = new Map();   // group top -> uncaused gap rows
    for (const row of gapRows) {
      const cause = causeOf(round, [row.n - 1]);
      const byName = cause ? null : strayCause(round, [row.n - 1]);
      if (cause || byName) roundGaps.push([row.n - 1, item('nogame', `No game for ${row.name} in round ${round}`, cause ? causeFix(cause) : strayFix(byName),
        `Teams it plays have games in round ${round}, but no game file has ${row.name} in that round.`, { round, teams: [row.name], ...(cause ? caused(cause) : strayLink(byName)) })]);
      else pools.set(topIn(ph, row.n - 1), [...(pools.get(topIn(ph, row.n - 1)) ?? []), row]);
    }
    const missing = (x, y, rematch = false) => item('missing', `Game missing in round ${round}`, `Fix: Find the round ${round} game file for ${x.name} v ${y.name}.`,
      rematch ? `${x.name} and ${y.name} both have no game in round ${round}. Their pool has an even number of teams, so every team plays each round, and it is probably their game against each other (they have met before). If round ${round} was a playoff they were not in, ignore this.`
        : `${x.name} and ${y.name} both have no game in round ${round}, and they have not played each other, so it is probably their game against each other. If they both had a bye, ignore this.`,
      { round, teams: [x.name, y.name] });
    const bye = (row, size) => {
      row.cells[round].state = 'bye';
      return item('bye', `Probably a bye: ${row.name} in round ${round}`, `No fix needed if ${row.name} had a bye in round ${round}. If not, find its round ${round} game file.`,
        `${row.name}'s pool (the teams it plays, and the teams they play) has ${size} teams, an odd number, so one of them has no game each round. No game file has ${row.name} in round ${round}.`,
        { round, teams: [row.name] });
    };
    const notMet = (x, y) => !met(k, x.n - 1, y.n - 1);
    for (const [group, pool] of pools) {
      const size = ph.size.get(group) ?? 0;
      // A pool's size means something only when every team in it is a real one: with no tournament file, or a team not in
      // it, a misspelt name is a made-up extra team, and would turn an even pool odd.
      const oddPool = Boolean(tournament) && ph.known.get(group) === true && size % 2 === 1;
      const pairs = pool.flatMap((x, i) => pool.slice(i + 1).filter(y => notMet(x, y)).map(y => [x, y]));
      if (pool.length === 2 && pairs.length === 1) roundGaps.push([pool[0].n - 1, missing(...pool)]);
      else if (pool.length === 2 && tournament && ph.known.get(group) === true && size % 2 === 0) roundGaps.push([pool[0].n - 1, missing(...pool, true)]);
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
  // A pool of three has one game a round, so a missing game leaves no gap in it: nobody has a game that the others lack.
  // In the first phase, a pool of exactly three whose game count is not a whole round robin (3, 6, ...) is short of the
  // difference. When as many rounds of the phase as games are short have no game for it, those are the rounds; else the
  // item names the pair that has met fewest times and no round (review 3).
  if (starts.length) {
    const ph = phases[0];
    const phaseRounds = [...new Set(placed.filter(p => phaseOf(p.round) === 0).map(p => p.round))].sort((x, y) => x - y);
    for (const root of new Set([...ph.has].map(i => topIn(ph, i)))) {
      const team = [...ph.has].filter(i => topIn(ph, i) === root).sort((x, y) => x - y);
      if (team.length !== 3) continue;
      const own = placed.filter(p => phaseOf(p.round) === 0 && team.includes(p.rows[0]) && team.includes(p.rows[1]) && p.rows[0] !== p.rows[1]);
      const short = Math.ceil(own.length / 3) * 3 - own.length;
      if (!short || phaseRounds.some(r => exact.has(r))) continue;
      const have = new Set(own.map(p => p.round));
      const free = phaseRounds.filter(r => !have.has(r));
      const meetings = new Map();
      for (const p of own) meetings.set(pairKey(...p.rows), (meetings.get(pairKey(...p.rows)) ?? 0) + 1);
      const pairs = team.flatMap((x, i) => team.slice(i + 1).map(y => [x, y]));
      const [x, y, z] = team.map(i => rows[i].name);
      for (let k = 0; k < short; k += 1) {
        pairs.sort((u, v) => (meetings.get(pairKey(...u)) ?? 0) - (meetings.get(pairKey(...v)) ?? 0));
        const [a, b] = pairs[0];
        meetings.set(pairKey(a, b), (meetings.get(pairKey(a, b)) ?? 0) + 1);
        const names2 = [rows[a].name, rows[b].name];
        if (free.length === short) {
          gaps.push(item('missing', `Game missing in round ${free[k]}`, `Fix: Find the round ${free[k]} game file for ${names2[0]} v ${names2[1]}.`,
            `${x}, ${y} and ${z} are a pool of three, so one game is played in it each round, and none is filed in round ${free[k]}. ${names2[0]} and ${names2[1]} have met fewest times, so it is probably their game. If the pool had no round ${free[k]}, ignore this.`,
            { round: free[k], teams: names2 }));
        } else {
          gaps.push(item('missing', `Game missing in the pool of ${x}, ${y} and ${z}`, `Fix: Find the missing game file for ${names2[0]} v ${names2[1]}.`,
            `${x}, ${y} and ${z} have ${plural(own.length, 'game file')} between them, and a round robin of three has ${own.length + short}. ${names2[0]} and ${names2[1]} have met fewest times, so it is probably their game.`,
            { round: null, teams: names2 }));
        }
      }
    }
  }
  // A round the schedule names, after the last round with files or before the first, with no files at all (review 3).
  if (seen.length) {
    for (const entry of scheduled) {
      if (!entry.games.length || roundsSeen.has(entry.round) || (entry.round > seen[0] && entry.round < seen.at(-1))) continue;
      gaps.push(item('emptyround', `No game files for round ${entry.round} (in the schedule)`, `Fix: Find the round ${entry.round} game files, unless round ${entry.round} was not played.`,
        `The schedule has ${plural(entry.games.length, 'game')} in round ${entry.round}, and no game file is in it.`, { round: entry.round, teams: [] }));
    }
  }
  // With no game file at all, every team has "no games"; one line says so instead (summaryLines).
  if (games.length) {
    for (const row of gridRows) {
      if (row.registered && !hasGame.has(row.n - 1)) {
        gaps.push(item('noneatall', `No games for ${row.name}`, 'Fix: Find its game files, unless it did not play.',
          `${row.name} is in the tournament file, but no game file has it.`, { round: null, teams: [row.name] }));
      }
    }
  }

  // Players not on the roster of the team their game is under (registered by name, or matched above).
  let players = null;
  if (tournament) {
    const strayPlayers = new Map();
    for (const game of games) {
      for (const [s, side] of game.sides.entries()) {
        const rowIndex = gameRows.get(game.path)[s];   // not rowOf(name): a side a self game moved to its real team counts there
        const row = rows[rowIndex];
        if (!row.registered || !row.roster.length) continue;
        for (const player of side.players) {
          // The same name only as YellowFruit takes it as one: lowercase (1.19.0). "Zoe Lee" for "Zoë Lee" is not.
          if (row.roster.some(name => lower(name) === lower(player))) continue;
          const key = `${rowIndex}\u0000${lower(player)}`;
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
      if (!closest && taken) closest = { name: taken, how: 'close' };   // what YellowFruit takes it for is the closest name
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
    // What the check could not see (review 3): with no schedule for them, the last round of a later phase (the afternoon), where a
    // missing game looks like a team that was knocked out.
    notes: placed.some(p => phaseOf(p.round) > 0 && !exact.has(p.round)) ? [FINISHED_NOTE] : [],
    rounds,
    grid: { rounds: gridRounds, rows: games.length ? gridRows : [] },
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

export const FINISHED_NOTE = "Skor can't tell a team that was knocked out from one whose last game in the afternoon is missing: check the afternoon's last round against the bracket.";
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
  [cell => cell.state === 'finished', '–: its last game in this part of the event was in an earlier round (knocked out or finished).'],
  [cell => cell.state === 'free', '–: the schedule gives this team no game that round.'],
];
export const gridKey = rows => GRID_KEY.filter(([shows]) => rows.some(row => Object.values(row.cells).some(shows))).map(([, line]) => line);

// A grid row with something to fix: a name not in the tournament file, a gap or a double, a game filed under a name
// YellowFruit will not take, or a game against itself. A probable bye is not, nor a name YellowFruit takes on its own.
export const needsFixing = (row, report) => Boolean(report.tournament && !row.registered)
  || Object.values(row.cells).some(cell => cell.state === 'gap' || cell.state === 'double'
    || cell.games.some(entry => (entry.filedAs && !entry.filedOk) || entry.opponent === row.n));

const OPTIONAL = new Set(['bye', 'teamok', 'playerok']);
const allItems = report => [...report.rounds, ...report.doubles, ...report.gaps, ...(report.names ?? []), ...(report.players ?? [])];

// Nothing found in any of the three jobs.
export const clean = report => allItems(report).length === 0;

// The line at the top: how many things to fix, counted by kind in plain words. A double counts each team it gives two
// games. A problem a wrong round inside causes is listed with that game's fix, so it is not counted again: one sentence
// says how many follow from it. Items with no fix needed (probable byes, names YellowFruit matches) are named last.
export function countLine(report) {
  const items = allItems(report);
  if (!items.length && report.notes?.length) {
    return report.names ? 'Nothing to fix that the page can see: the rounds agree and every name is in the tournament file.'
      : 'Nothing to fix that the page can see in the rounds.';
  }
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
  // What the causes are, in words: a wrong round inside, a game in the wrong round, or a team name not in the file.
  const causeKinds = new Set(following.map(entry => entry.causeKind ?? 'inside'));
  const many = insides !== 1;
  const phrase = {
    inside: many ? 'the wrong rounds inside game files' : 'the wrong round inside a game file',
    moved: many ? 'games in the wrong round' : 'a game in the wrong round',
    name: many ? 'team names that are not in the tournament file' : 'a team name that is not in the tournament file',
  };
  const from = causeKinds.size === 1 ? phrase[[...causeKinds][0]] : 'the items above';
  const follow = following.length ? ` ${following.length} more ${following.length === 1 ? 'problem' : 'problems'} listed`
    + ` ${following.length === 1 ? 'comes' : 'come'} from ${from},`
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
  else lines.push('There are no game files to check. Choose the folder that holds them.');
  if (report.counts.games) lines.push(...(report.notes ?? []));
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
