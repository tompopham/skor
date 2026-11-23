// Standings and the afternoon brackets (Skor 1.16.0, SPEC-partB 7.6). No screen code here, so the tests run it. At lunch the
// TD check page adds up the morning's game files (td-check.js readGame and gameStats), ranks each pool by the TD's rule, and
// fills the afternoon's slots from the pools' order ("A1" is pool A's 1st), so the TD can make the afternoon link.
//
// The sums are YellowFruit 4.0.18's (StatSummaries.ts, read 22 and 23 Nov 2026), so a pool ranked by its own rule matches its
// screen: won-lost percentage, (W + T/2) / games, with no games last; points per bonus, bonus points / bonuses heard; points
// per tossup heard, points less overtime tossup points / tossups read less overtime tossups (times 20 for the page only).
// A forfeit counts in the record and adds nothing else. YellowFruit sorts by percentage, then points per tossup, on the raw
// figures, keeping the pool's order where both are level; the other two rules swap in their own second key.
//
// Never a coin flip: teams level on the record and the tie figure too are not placed until the TD says which goes first.
// A name in a game file is matched to the schedule's after folding (td-check.js fold) and never guessed: a game naming a
// team the schedule does not have is listed, not counted.

import { fold, locateTournament } from './td-check.js';
import { slotsText } from './schedule.js';

// The three tie rules (7.6), the first the default (Tom, 22 Nov 2026: "points per bonus i think"; ACF's formats page).
export const RULES = [
  { id: 'ppb', label: 'Record, then points per bonus', named: 'record, then points per bonus' },
  { id: 'p20', label: "Record, then points per 20 tossups (YellowFruit's order)", named: 'record, then points per 20 tossups, as YellowFruit orders a pool' },
  { id: 'h2h', label: 'Record, then head-to-head, then points per bonus', named: 'record, then head-to-head, then points per bonus' },
];
export const DEFAULT_RULE = 'ppb';
export const ruleOf = id => RULES.find(rule => rule.id === id) ?? RULES[0];
export const YF_DIFFERS = 'YellowFruit orders pools by points per 20 tossups, so its screen may differ here.';
export const CARRY_OVER = 'ACF carries over prelim games between teams in the same bracket. YellowFruit does this when it rebrackets.';
export const TIEBREAKER = 'If there is time, a tiebreaker game settles it.';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const joinAnd = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
// "1st", "2nd", "3rd", "11th", "22nd".
export const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
// A game file's round: inside the file first (what YellowFruit files it by), then its name, then its folder.
const roundOf = game => game.round?.inside ?? game.round?.fileName ?? game.round?.folder ?? null;
// A figure for sorting: NaN (nothing heard) goes last.
const sortValue = value => (Number.isNaN(value) ? -Infinity : value);

// "3-1", or "3-1-1" with ties, as YellowFruit writes a record.
export const recordText = ({ w, l, t }) => (t ? `${w}-${l}-${t}` : `${w}-${l}`);

// A team's figures as YellowFruit shows them: points per bonus to 2 places, points per 20 tossups heard to 1; a dash for
// nothing heard.
export const ppbText = (value, places = 2) => (Number.isFinite(value) ? value.toFixed(places) : '–');
export const p20Text = (value, places = 1) => (Number.isFinite(value) ? (value * 20).toFixed(places) : '–');

// The fewest places, from `places`, at which every different value in `values` reads differently (at most 6), so a tie
// sentence never says "17.50 over 17.50" for two figures that differ in the third place.
function placesFor(values, places, show) {
  const distinct = [...new Set(values.filter(Number.isFinite))];
  for (let p = places; p < 6; p += 1) {
    if (new Set(distinct.map(value => show(value, p))).size === distinct.length) return p;
  }
  return 6;
}

// ---- Matching the game files to the schedule ----------------------------------------------------------------------------------

// Which morning games have a file, which do not, and which files are counted. `games` are readGame's games (with stats).
function matchGames(schedule, games) {
  const morning = schedule.rounds.filter(round => !round.playoff);
  const afternoon = new Set(schedule.rounds.filter(round => round.playoff).map(round => round.round));
  const lastMorning = Math.max(0, ...morning.map(round => round.round));
  const firstAfternoon = Math.min(Infinity, ...afternoon);
  const teamOf = new Map();
  for (const pool of schedule.pools) for (const team of pool.teams) teamOf.set(fold(team), team);
  for (const round of morning) for (const game of round.games) for (const side of game.sides) if (side.team !== undefined) teamOf.set(fold(side.team), side.team);
  const pairKey = names => names.map(fold).sort().join('\n');
  const scheduled = morning.flatMap(round => round.games.filter(game => game.sides.every(side => side.team !== undefined))
    .map(game => ({ round: round.round, room: game.room, teams: game.sides.map(side => side.team), key: pairKey(game.sides.map(side => side.team)), files: [] })));
  const extras = [];
  const notCounted = [];
  let later = 0;
  for (const game of games) {
    const round = roundOf(game);
    if (round !== null && (afternoon.has(round) || round >= firstAfternoon)) { later += 1; continue; }
    if (!game.stats || game.stats.sides.length !== 2) continue;
    const names = game.sides.map(side => teamOf.get(fold(side.name)));
    const stranger = game.sides.find((side, i) => names[i] === undefined);
    if (stranger) {
      notCounted.push({ line: [`${game.path}: "${stranger.name}" is not one of the schedule's teams, so this game is not counted. The report's part 3 says which team it probably is.`] });
      continue;
    }
    if (names[0] === names[1]) {
      notCounted.push({ line: [`${game.path}: both teams are ${names[0]}, so this game is not counted.`] });
      continue;
    }
    const key = pairKey(names);
    const candidates = scheduled.filter(entry => entry.key === key);
    // The scheduled game in the file's own round, else the first of the pair's games with no file yet. A file with no round
    // never takes a game that already has one.
    const target = candidates.find(entry => entry.round === round)
      ?? candidates.find(entry => !entry.files.length)
      ?? (round === null ? null : candidates[0]);
    if (target) { target.files.push({ game, names }); continue; }
    if (round === null) {
      notCounted.push({ line: [`${game.path}: ${names[0]} v ${names[1]} has no round and is not a morning game in the schedule, so it is not counted.`] });
    } else if (round > lastMorning) {
      notCounted.push({ line: [`${game.path}: round ${round} is not in the schedule, so ${names[0]} v ${names[1]} is not counted.`] });
    } else {
      extras.push({ game, names });
    }
  }
  const counted = [...extras];
  const missing = [];
  for (const entry of scheduled) {
    const copies = new Map(entry.files.map(file => [file.game.print, file]));   // the same file twice is one game
    const where = `Round ${entry.round}, ${entry.room}: ${entry.teams[0]} v ${entry.teams[1]}`;
    if (copies.size === 1) counted.push([...copies.values()][0]);
    else if (copies.size === 0) missing.push({ kind: 'none', line: [`${where}, no game file yet`] });
    else missing.push({ kind: 'two', line: [`${where} has ${copies.size} different game files (${[...copies.values()].map(file => file.game.path).join(', ')}), so neither is counted. Take out the wrong one.`] });
  }
  const extraLines = extras.map(({ game, names }) => ({ line: [`${game.path}: ${names[0]} v ${names[1]} in round ${roundOf(game)} is not a game in the schedule. It is counted.`] }));
  return { scheduled, counted, missing, extras: extraLines, notCounted, later };
}

// ---- Adding up ------------------------------------------------------------------------------------------------------------------

function emptyTotals(team) {
  return { team, w: 0, l: 0, t: 0, scheduled: 0, played: 0, tuhTotal: 0, tuhRegulation: 0, pointsForPPG: 0, bonusPoints: 0, bonusesHeard: 0, results: [] };
}

// The pool's teams' totals from the counted games, as YellowFruit's PoolTeamStats.addMatchTeam adds them.
// Tossups read: YellowFruit counts none for a forfeit (FileParsing.ts sets them undefined) and the regulation count for a
// file that gives none (FileParsing.ts 741; found by the stage 4 review).
function addUp(teams, counted, scheduled, overtimeIncludesBonuses, regulation) {
  const totals = new Map(teams.map(team => [team, emptyTotals(team)]));
  for (const entry of scheduled) for (const team of entry.teams) if (totals.has(team)) totals.get(team).scheduled += 1;
  for (const { game, names } of counted) {
    const { stats } = game;
    names.forEach((team, i) => {
      const mine = totals.get(team);
      if (!mine) return;
      const side = stats.sides[i];
      const other = stats.sides[1 - i];
      mine.played += 1;
      const read = side.forfeit || other.forfeit ? 0 : stats.tossupsRead ?? regulation;
      mine.tuhTotal += read;
      mine.tuhRegulation += read - stats.overtimeRead;
      let result;
      if (side.forfeit && !other.forfeit) result = 'l';
      else if (other.forfeit && !side.forfeit) result = 'w';
      else if (side.forfeit && other.forfeit) result = null;
      else result = side.points > other.points ? 'w' : side.points < other.points ? 'l' : 't';
      if (result) mine[result] += 1;
      mine.results.push({ opponent: names[1 - i], result });
      if (side.forfeit || other.forfeit) return;
      mine.pointsForPPG += overtimeIncludesBonuses ? side.points : side.points - side.overtimePoints;
      mine.bonusPoints += side.bonusPoints;
      mine.bonusesHeard += overtimeIncludesBonuses ? side.bonusesHeard : side.bonusesHeard - side.overtimeHeard;
    });
  }
  for (const mine of totals.values()) {
    const games = mine.w + mine.l + mine.t;
    mine.winPct = (mine.w + mine.t / 2) / games;
    mine.ppb = mine.bonusPoints / mine.bonusesHeard;
    mine.pptuh = mine.pointsForPPG / (overtimeIncludesBonuses ? mine.tuhTotal : mine.tuhRegulation);
  }
  return totals;
}

// Head-to-head among a group on one record: each one's percentage in the games between them, or null when some pair of them
// has not played (then the rule falls through to points per bonus).
function headToHead(group) {
  const names = new Set(group.map(mine => mine.team));
  for (const a of group) {
    for (const b of group) {
      if (a !== b && !a.results.some(r => r.opponent === b.team && r.result)) return null;
    }
  }
  return new Map(group.map(mine => {
    const inside = mine.results.filter(r => names.has(r.opponent) && r.result);
    const w = inside.filter(r => r.result === 'w').length;
    const l = inside.filter(r => r.result === 'l').length;
    const t = inside.filter(r => r.result === 't').length;
    return [mine.team, { w, l, t, pct: (w + t / 2) / inside.length }];
  }));
}

// ---- Ranking a pool -------------------------------------------------------------------------------------------------------------

// The pool's totals in order by the rule: { order, groups }. `groups` are the record groups (one percentage) of two or more,
// each with its keys per team and whether head-to-head was used.
function rank(pool, totals, rule) {
  const list = pool.teams.map(team => totals.get(team));
  const pctOf = mine => (Number.isNaN(mine.winPct) ? -1 : mine.winPct);
  const byPct = new Map();
  for (const mine of list) byPct.set(pctOf(mine), [...(byPct.get(pctOf(mine)) ?? []), mine]);
  const keys = new Map();
  const h2hOf = new Map();
  for (const group of byPct.values()) {
    const h2h = rule === 'h2h' && group.length > 1 ? headToHead(group) : null;
    for (const mine of group) {
      if (h2h) h2hOf.set(mine.team, h2h.get(mine.team));
      keys.set(mine.team, rule === 'p20' ? [sortValue(mine.pptuh)] : h2h ? [h2h.get(mine.team).pct, sortValue(mine.ppb)] : [sortValue(mine.ppb)]);
    }
  }
  const compareKeys = (a, b) => {
    const ka = keys.get(a.team);
    const kb = keys.get(b.team);
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return 0;
  };
  const order = [...list].sort((a, b) => pctOf(b) - pctOf(a) || compareKeys(a, b));
  const level = (a, b) => pctOf(a) === pctOf(b) && compareKeys(a, b) === 0;
  return { order, level, h2hOf, pctOf };
}

// ---- The whole step -------------------------------------------------------------------------------------------------------------

// The step's content from the schedule (schedule.js) and the game files read (readGame's games). Options: `rule` ('ppb',
// 'p20' or 'h2h'); `choices`, the TD's order for each group level on both ({ key: [team, ...] }, key from the result's
// `choices`); `swaps`, pairs of teams the TD swapped ([[a, b], ...]), applied in turn; `overtimeIncludesBonuses`, the
// tournament's own rule (YellowFruit's ScoringRules; false unless the tournament file says so).
//
// Gives { rule, pools: [{ key, name, rows }], ties, choices, missing, extras, notCounted, later, badSlots, placement (Map slot ->
// team or null), brackets: [{ name, places: [{ slot, team }] }], filled (the schedule with the afternoon's teams in),
// complete (every afternoon slot has a team), swapped (Set of teams) }. Each row: { place, team, w, l, t, record, played,
// scheduled, ppb, pptuh, slot, bracket, pending, chosen, byTd }.
export function standings(schedule, games, { rule = DEFAULT_RULE, choices = {}, swaps = [], overtimeIncludesBonuses = false, regulationTossups = 20 } = {}) {
  const ruleId = ruleOf(rule).id;
  const matched = matchGames(schedule, games);
  const teams = schedule.pools.flatMap(pool => pool.teams);
  const totals = addUp(teams, matched.counted, matched.scheduled, overtimeIncludesBonuses, regulationTossups);
  const used = new Set(schedule.rounds.filter(round => round.playoff).flatMap(round => round.games.flatMap(game => game.sides.map(side => side.slot).filter(Boolean))));
  const bracketOf = slot => schedule.brackets.find(bracket => bracket.slots.includes(slot))?.name ?? null;
  const placement = new Map([...used].map(slot => [slot, null]));
  const ties = [];
  const choiceList = [];
  const pools = [];
  const figureName = ruleId === 'p20' ? 'points per 20 tossups' : 'points per bonus';

  for (const pool of schedule.pools) {
    const { order, level, h2hOf, pctOf } = rank(pool, totals, ruleId);
    const slotAt = place => (used.has(`${pool.key}${place}`) ? `${pool.key}${place}` : null);
    const rows = order.map((mine, i) => ({ mine, place: i + 1 }));
    // Groups level on both: the TD's order where given, else not placed.
    const pending = new Set();
    const chosen = new Set();
    for (let i = 0; i < rows.length;) {
      let j = i;
      while (j + 1 < rows.length && level(rows[i].mine, rows[j + 1].mine)) j += 1;
      const group = rows.slice(i, j + 1);
      if (group.length > 1 && group.some(row => slotAt(row.place))) {
        const names = group.map(row => row.mine.team);
        const key = `${pool.key}|${[...names].map(fold).sort().join('|')}`;
        const given = Array.isArray(choices[key]) ? choices[key].slice(0, names.length - 1) : [];
        const valid = given.length === names.length - 1 && new Set(given).size === given.length && given.every(name => names.includes(name));
        const mine = group[0].mine;
        choiceList.push({
          key, pool: pool.name, teams: names, places: group.map(row => ({ place: row.place, slot: slotAt(row.place), bracket: slotAt(row.place) ? bracketOf(slotAt(row.place)) : null })),
          record: recordText(mine), figure: ruleId === 'p20' ? p20Text(mine.pptuh) : ppbText(mine.ppb), figureName, given: valid ? [...given, names.find(name => !given.includes(name))] : null,
        });
        if (valid) {
          const ordered = [...given, names.find(name => !given.includes(name))];
          ordered.forEach((name, k) => { group[k] = { mine: totals.get(name), place: group[k].place }; chosen.add(name); });
          rows.splice(i, group.length, ...group);
        } else names.forEach(name => pending.add(name));
      }
      i = j + 1;
    }
    for (const row of rows) {
      const slot = slotAt(row.place);
      if (slot) placement.set(slot, pending.has(row.mine.team) ? null : row.mine.team);
    }

    // Ties that matter: a record group whose places go to more than one bracket (or to a bracket and none).
    for (let i = 0; i < rows.length;) {
      let j = i;
      while (j + 1 < rows.length && pctOf(rows[i].mine) === pctOf(rows[j + 1].mine)) j += 1;
      const group = rows.slice(i, j + 1);
      i = j + 1;
      if (group.length < 2) continue;
      const brackets = group.map(row => (slotAt(row.place) ? bracketOf(slotAt(row.place)) ?? slotAt(row.place) : null));
      if (new Set(brackets).size < 2) continue;
      const names = group.map(row => row.mine.team);
      const record = recordText(group[0].mine);
      const head = `${joinAnd(names)} are ${names.length === 2 ? 'both' : 'all'} ${record}.`;
      const stuck = group.filter(row => pending.has(row.mine.team));
      if (Number.isNaN(group[0].mine.winPct)) {
        ties.push({ pool: pool.name, line: [`${joinAnd(names)} have no game files yet, so their places cannot be worked out: read their files, or choose the order below.`] });
        continue;
      }
      if (stuck.length) {
        const shown = stuck[0].mine;
        const value = ruleId === 'p20' ? p20Text(shown.pptuh) : ppbText(shown.ppb);
        const level = stuck.length === group.length
          ? `${head.slice(0, -1)}, and level on ${figureName} too (${value}): choose which goes up.`
          : `${head} ${joinAnd(stuck.map(row => row.mine.team))} are level on ${figureName} too (${value}): choose which goes up.`;
        ties.push({ pool: pool.name, line: [`${level} ${TIEBREAKER}`] });
        continue;
      }
      // The deciding figure for each, as the rule used it.
      const h2hUsed = ruleId === 'h2h' && h2hOf.size > 0 && group.every(row => h2hOf.has(row.mine.team));
      const values = group.map(row => (ruleId === 'p20' ? row.mine.pptuh : row.mine.ppb));
      const places = placesFor(values, ruleId === 'p20' ? 1 : 2, ruleId === 'p20' ? p20Text : ppbText);
      const figure = row => {
        const value = ruleId === 'p20' ? p20Text(row.mine.pptuh, places) : ppbText(row.mine.ppb, places);
        if (!h2hUsed) return value;
        return `${recordText(h2hOf.get(row.mine.team))} between them, ${value} PPB`;
      };
      const decider = h2hUsed ? 'Head-to-head, then points per bonus,' : ruleId === 'p20' ? 'Points per 20 tossups' : 'Points per bonus';
      const why = ruleId === 'h2h' && !h2hUsed ? ' (not all of them have played each other, so head-to-head cannot decide)' : '';
      const named = row => `${row.mine.team} (${figure(row)})`;
      const tiers = [];
      group.forEach((row, k) => {
        const tier = brackets[k];
        if (!tiers.length || tiers.at(-1).tier !== tier) tiers.push({ tier, rows: [row] });
        else tiers.at(-1).rows.push(row);
      });
      const tierName = tier => (tier === null ? 'no afternoon game' : schedule.brackets.some(b => b.name === tier) ? `the ${tier} bracket` : tier);
      let body;
      if (group.some(row => chosen.has(row.mine.team))) {
        body = `${joinAnd(group.filter(row => chosen.has(row.mine.team)).map(row => row.mine.team))} are level on ${figureName} too, so the TD chose: ${tiers.map(t => `${joinAnd(t.rows.map(row => row.mine.team))} to ${tierName(t.tier)}`).join('; ')}.`;
      } else if (tiers.length === 2) {
        body = `${decider}${why} sends ${joinAnd(tiers[0].rows.map(named))} to ${tierName(tiers[0].tier)} over ${joinAnd(tiers[1].rows.map(named))}.`;
        if (tiers[1].tier !== null && tiers[0].tier === null) body = `${decider}${why} puts ${joinAnd(tiers[0].rows.map(named))} first, with no afternoon game, over ${joinAnd(tiers[1].rows.map(named))}.`;
      } else {
        body = `${decider}${why} puts them in this order: ${tiers.map(t => `${joinAnd(t.rows.map(named))} to ${tierName(t.tier)}`).join('; ')}.`;
      }
      ties.push({ pool: pool.name, line: [`${head} ${body} ${TIEBREAKER}`] });
    }

    pools.push({
      key: pool.key, name: pool.name,
      rows: rows.map(({ mine, place }) => ({
        place, team: mine.team, w: mine.w, l: mine.l, t: mine.t, record: recordText(mine), played: mine.played, scheduled: mine.scheduled,
        ppb: mine.ppb, pptuh: mine.pptuh, slot: slotAt(place), bracket: slotAt(place) ? bracketOf(slotAt(place)) : null,
        pending: pending.has(mine.team), chosen: chosen.has(mine.team), byTd: false,
      })),
    });
  }

  // Slots no pool can fill: a pool the schedule does not have, or a place past its size.
  const badSlots = [];
  for (const slot of used) {
    const key = slot.replace(/\d+$/, '');
    const place = Number(slot.match(/\d+$/)[0]);
    const pool = schedule.pools.find(p => p.key === key);
    if (!pool) badSlots.push({ line: [`${slot}: there is no pool ${key}, so this place cannot be filled.`] });
    else if (place > pool.teams.length) badSlots.push({ line: [`${slot}: ${pool.name} has ${plural(pool.teams.length, 'team')}, so it has no ${ordinal(place)} place.`] });
  }

  // The TD's swaps, in turn: two teams exchange their afternoon places (or one's place and the other's none). A team still
  // waiting for the TD's choice is never swapped: the choice places it (fixed after the stage 4 review).
  const swapped = new Set();
  const waiting = new Set(pools.flatMap(pool => pool.rows.filter(row => row.pending).map(row => row.team)));
  for (const pair of Array.isArray(swaps) ? swaps : []) {
    const [a, b] = pair ?? [];
    if (typeof a !== 'string' || typeof b !== 'string' || a === b || waiting.has(a) || waiting.has(b)) continue;
    const slotA = [...placement].find(([, team]) => team === a)?.[0] ?? null;
    const slotB = [...placement].find(([, team]) => team === b)?.[0] ?? null;
    if (slotA === null && slotB === null) continue;
    if (slotA) placement.set(slotA, b);
    if (slotB) placement.set(slotB, a);
    swapped.add(a);
    swapped.add(b);
  }
  for (const pool of pools) {
    for (const row of pool.rows) {
      const now = [...placement].find(([, team]) => team === row.team)?.[0] ?? null;
      if (swapped.has(row.team)) { row.byTd = true; row.slot = now; row.bracket = now ? bracketOf(now) : null; }
      if (row.chosen) row.byTd = true;
    }
  }

  const filled = {
    ...schedule,
    rounds: schedule.rounds.map(round => (!round.playoff ? round : {
      ...round,
      games: round.games.map(game => ({
        ...game,
        sides: game.sides.map(side => {
          if (!side.slot) return { ...side };
          const team = placement.get(side.slot);
          return team ? { slot: side.slot, team } : { slot: side.slot };
        }),
      })),
    })),
  };
  const complete = [...placement.values()].every(team => team !== null) && placement.size > 0;
  const brackets = schedule.brackets.map(bracket => ({ name: bracket.name, places: bracket.slots.map(slot => ({ slot, team: placement.get(slot) ?? null })) }));
  return {
    rule: ruleId, pools, ties, choices: choiceList, missing: matched.missing, extras: matched.extras, notCounted: matched.notCounted, later: matched.later,
    badSlots, placement, brackets, filled, complete, swapped,
  };
}

// The tournament file's regulation tossups (QBJ's ScoringRules.maximum_regulation_tossup_count), which YellowFruit counts for
// a game file that gives no tossups read; 20 when the file does not say.
export function regulationTossups(text) {
  try {
    const { tournament, deref } = locateTournament(JSON.parse(String(text ?? '').replace(/^\uFEFF/, '')));
    const n = deref(tournament?.scoring_rules)?.maximum_regulation_tossup_count;
    return Number.isInteger(n) && n > 0 ? n : 20;
  } catch {
    return 20;
  }
}

// Whether the tournament file says overtime tossups have bonuses (QBJ's ScoringRules.overtime_includes_bonuses, which
// YellowFruit reads); false for a file that does not say, as YellowFruit's default is.
export function overtimeIncludesBonuses(text) {
  try {
    const { tournament, deref } = locateTournament(JSON.parse(String(text ?? '').replace(/^\uFEFF/, '')));
    return deref(tournament?.scoring_rules)?.overtime_includes_bonuses === true;
  } catch {
    return false;
  }
}

// ---- Words ----------------------------------------------------------------------------------------------------------------------

// The line naming the rule above the standings, with YellowFruit's note when the rule is not its own.
export function ruleLines(rule) {
  const id = ruleOf(rule).id;
  return [`Ranked by ${ruleOf(rule).named}.`, ...(id === 'p20' ? [] : [YF_DIFFERS])];
}

// "Games" in a row: "3", or "2 of 3" when a scheduled game has no file counted (or a game not in the schedule is).
export const gamesText = row => (row.played === row.scheduled ? String(row.played) : `${row.played} of ${row.scheduled}`);

// Where a team goes: "A1, Top", "A2, Top, placed by the TD", "not placed yet", or "no afternoon game". `copied` for the text
// that goes to Discord, where there is no "above".
export function goesText(row, copied = false) {
  if (row.pending) return copied ? 'not placed yet: the TD has to choose' : 'not placed yet: choose above';
  const where = row.slot ? `${row.slot}${row.bracket ? `, ${row.bracket}` : ''}` : 'no afternoon game';
  return row.byTd ? `${where}, placed by the TD` : where;
}

// The afternoon's games, filled: [{ round, games: [{ room, text }] }], each "Kelpie A (A1) v Thistle (B2)", or "not placed
// yet (B2)" for a place still waiting on the TD.
export function afternoonGrid(result) {
  return result.filled.rounds.filter(round => round.playoff).map(round => ({
    round: round.round,
    games: round.games.map(game => ({
      room: game.room,
      text: game.sides.map(side => (side.slot ? `${side.team ?? 'not placed yet'} (${side.slot})` : side.team)).join(' v '),
    })),
  }));
}

// The standings as plain text for Discord (Copy standings).
export function standingsText(result, name) {
  const lines = [`${name ? `${name}: ` : ''}standings after the morning`, ...ruleLines(result.rule), ''];
  for (const pool of result.pools) {
    lines.push(pool.name);
    for (const row of pool.rows) {
      lines.push(`${row.place}. ${row.team}  ${row.record}${row.played === row.scheduled ? '' : ` (${gamesText(row)} games)`}  PPB ${ppbText(row.ppb)}  Pts/20 ${p20Text(row.pptuh)}  ${goesText(row, true)}`);
    }
    lines.push('');
  }
  for (const tie of result.ties) lines.push(tie.line.join(''));
  if (result.missing.length) lines.push(`Morning games not counted: ${result.missing.length}.`, ...result.missing.map(item => `- ${item.line.join('')}`));
  if (result.ties.length || result.missing.length) lines.push('');
  lines.push('Afternoon brackets');
  for (const bracket of result.brackets) {
    lines.push(`${bracket.name} (${slotsText(bracket.places.map(p => p.slot))}): ${bracket.places.map(p => `${p.slot} ${p.team ?? 'not placed yet'}`).join(', ')}`);
  }
  lines.push('', CARRY_OVER);
  return `${lines.join('\n')}\n`;
}
