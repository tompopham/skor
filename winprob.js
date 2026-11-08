// Win percentage (SPEC-partB.md section 2; Skor win percentage plan, 22/10/2026): each team's chance of winning,
// from a ratings file kept on this device (scorer.ratings, made by Buzzpoints/Workings/tools/skor_export.py). No
// screen code lives here, so every number can be tested in Node, and nothing here is ever stored in a match: the
// record stays the only truth, and without the file Skor is exactly as before. No player's own rating leaves this
// file: the screens are given team chances only.
//
// Each tossup is neg_elo.py's "chance each team gets it" (lines 345 to 354, read 5 Nov 2026) with the players
// seated now, averaged over five trap levels around the league's average (league.tauSd; the held-out check of
// 8 Nov 2026 chose 0.8). Then bonuses at each team's own rate so far, shrunk to the typical one; the tossups left
// from the rules, or from the pace of the game for University Challenge; and the win chance added up exactly over
// every way the rest of the match can go, with no random draws.

import { fold } from './td-check.js';
import { lineupAt, playerName } from './lineup.js';
import { played } from './clock.js';

export const RATINGS_KIND = 'skor-ratings';
export const RATINGS_VERSION = 1;
const LEAGUE_FIGURES = ['D1', 'D2', 'b2', 'tau', 'qL', 'eL', 'powerShare', 'ppb'];
const UC_FIGURES = ['startersPerGame', 'startersSd', 'bonusConversion', 'pacePrior', 'paceSpread'];
// Five trap levels and their weights (Gauss-Hermite for a normal spread of 1), the same five as skor_export.py.
const GH = [[-2.856970013872806, 0.011257411327721], [-1.355626179974266, 0.222075922005613], [0, 0.533333333333333],
  [1.355626179974266, 0.222075922005613], [2.856970013872806, 0.011257411327721]];
const SHRINK = 5;
const MAX_TOSSUPS = 60;   // a longer custom match would make the sum slow enough to hold up the scoring screen   // a team's own points per bonus counts as much as the typical one after 5 bonuses (the plan)

const finite = x => typeof x === 'number' && Number.isFinite(x);
const sig = x => 1 / (1 + Math.exp(-x));

// ---- The file -----------------------------------------------------------------------------------

// The file's text, checked: { ok: true, ratings } or { ok: false, message } saying what is wrong. A player row
// that is not in the right shape is left out and counted. ratings.index maps each folded name to its player, or
// to null when two players share it; ratings.shared counts the players behind each shared name.
export function readRatings(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return { ok: false, message: 'This is not a ratings file: it is not readable as JSON.' };
  }
  if (data === null || typeof data !== 'object' || data.kind !== RATINGS_KIND) {
    return { ok: false, message: 'This is not a Skor ratings file. Use skor-ratings.json from Tom\'s Buzzpoints folder.' };
  }
  if (data.version !== RATINGS_VERSION) {
    return { ok: false, message: `This ratings file is version ${String(data.version)}, which this Skor cannot read. Reload Skor to update it.` };
  }
  const league = data.league ?? {};
  const missing = [...LEAGUE_FIGURES.filter(key => !finite(league[key])),
    ...(finite(league.newcomer?.speed) && league.newcomer.speed > 0 && finite(league.newcomer?.acc) ? [] : ['newcomer'])];
  const ucMissing = UC_FIGURES.filter(key => !finite(data.uc?.[key]));
  if (missing.length > 0 || ucMissing.length > 0) {
    return { ok: false, message: `This ratings file is damaged: ${[...missing, ...ucMissing.map(key => `uc ${key}`)].join(', ')} missing.` };
  }
  const players = [];
  let skipped = 0;
  for (const row of Array.isArray(data.players) ? data.players : []) {
    const names = Array.isArray(row?.names) ? row.names.filter(name => typeof name === 'string' && fold(name) !== '') : [];
    const good = names.length > 0 && finite(row.speed) && row.speed > 0 && finite(row.acc)
      && finite(row.negs) && row.negs >= 0 && finite(row.wrong) && row.wrong >= 0;
    if (good) players.push({ names, speed: row.speed, acc: row.acc, negs: row.negs, wrong: row.wrong });
    else skipped += 1;
  }
  if (players.length === 0) return { ok: false, message: 'This ratings file has no players in it.' };
  const index = new Map(), owners = new Map();
  for (const player of players) {
    for (const key of new Set(player.names.map(fold))) {
      if (!owners.has(key)) owners.set(key, new Set());
      owners.get(key).add(player);
    }
  }
  const shared = new Map();
  for (const [key, set] of owners) {
    index.set(key, set.size === 1 ? [...set][0] : null);
    if (set.size > 1) shared.set(key, set.size);
  }
  return {
    ok: true,
    ratings: {
      made: typeof data.made === 'string' ? data.made : '', model: typeof data.model === 'string' ? data.model : '',
      league: { ...league, tauSd: finite(league.tauSd) && league.tauSd >= 0 ? league.tauSd : 0 }, uc: data.uc,
      count: players.length, skipped, index, shared,
    },
  };
}

// A seat's name against the file: 'empty' (nobody sits there), 'rated', 'unrated' (not in the file) or 'shared'
// (two or more players have that name, so neither is used; `count` says how many). Anyone not rated plays as a newcomer.
export function lookUp(ratings, name) {
  const key = fold(name);
  if (key === '') return { status: 'empty' };
  if (ratings.shared.has(key)) return { status: 'shared', count: ratings.shared.get(key) };
  return ratings.index.has(key) ? { status: 'rated' } : { status: 'unrated' };
}

// The seat a name plays as: { speed, acc, share }, share being the chance that a wrong first buzz is a neg rather
// than a wrong answer at the end, (negs + 5 qL) / (wrong + 5) as neg_elo.py has it. Null for an empty seat.
export function seatOf(ratings, name) {
  const key = fold(name);
  if (key === '') return null;
  const { league } = ratings;
  const player = ratings.index.get(key);
  if (!player) return { speed: league.newcomer.speed, acc: league.newcomer.acc, share: league.qL };
  return { speed: player.speed, acc: player.acc, share: (player.negs + 5 * league.qL) / (player.wrong + 5) };
}

// ---- One tossup -----------------------------------------------------------------------------------

// neg_elo.py's lines with the tossup's trap level at `tau`, written out by outcome. room = [team 0's seats, team 1's].
// right: first buzz and right; neg / endWrong: a wrong first buzz that is a neg / an answer at the end; negThen /
// endThen: that, and then the other team takes it; nobody: no buzz at all; get: each team's chance to get it.
export function splitAt(room, league, tau) {
  const T = room.map(seats => seats.reduce((sum, s) => sum + s.speed, 0));
  const S = T[0] + T[1];
  const R = room.map((seats, t) => (T[t] ? seats.reduce((sum, s) => sum + s.speed * sig(s.acc - tau + league.b2), 0) / (T[t] + league.D2) : 0));
  const o = { right: [0, 0], neg: [0, 0], negThen: [0, 0], endWrong: [0, 0], endThen: [0, 0] };
  room.forEach((seats, t) => {
    for (const s of seats) {
      const first = s.speed / (S + league.D1), pr = sig(s.acc - tau), wrong = first * (1 - pr);
      o.right[t] += first * pr;
      o.neg[t] += wrong * s.share;
      o.negThen[t] += wrong * s.share * R[1 - t];
      o.endWrong[t] += wrong * (1 - s.share);
      o.endThen[t] += wrong * (1 - s.share) * (T[1 - t] ? league.eL : 0);
    }
  });
  o.nobody = league.D1 / (S + league.D1);
  o.get = [0, 1].map(t => o.right[t] + o.negThen[1 - t] + o.endThen[1 - t]);
  return o;
}

// splitAt averaged over the five trap levels (league.tauSd 0: at the average alone).
export function tossupSplit(room, league) {
  if (!league.tauSd) return splitAt(room, league, league.tau);
  const out = { right: [0, 0], neg: [0, 0], negThen: [0, 0], endWrong: [0, 0], endThen: [0, 0], nobody: 0, get: [0, 0] };
  for (const [x, w] of GH) {
    const o = splitAt(room, league, league.tau + league.tauSd * x);
    for (const key of Object.keys(out)) {
      if (Array.isArray(out[key])) for (const t of [0, 1]) out[key][t] += w * o[key][t];
      else out[key] += w * o[key];
    }
  }
  return out;
}

// What a tossup can do to the score: [{ p, pts: [team 0's, team 1's], bonus: the team that hears a bonus, or null }].
// A power is the league's share of first-buzz gets, where the rules have powers; a get after the other team was
// wrong is worth 10; a neg costs the rules' neg (0 under PACE); a wrong answer at the end costs nothing.
export function tossupOutcomes(split, rules, powerShare) {
  const { ten, power, neg } = rules.tossup;
  const out = [];
  const add = (p, a, b, bonus) => { if (p > 0) out.push({ p, pts: [a, b], bonus }); };
  const pts = (t, mine, theirs) => (t === 0 ? [mine, theirs] : [theirs, mine]);
  for (const t of [0, 1]) {
    const share = power != null ? powerShare : 0;
    add(split.right[t] * share, ...pts(t, power ?? ten, 0), t);
    add(split.right[t] * (1 - share), ...pts(t, ten, 0), t);
    add(split.negThen[t], ...pts(t, neg, ten), 1 - t);
    add(split.neg[t] - split.negThen[t], ...pts(t, neg, 0), null);
    add(split.endThen[t], ...pts(t, 0, ten), 1 - t);
  }
  const rest = 1 - out.reduce((sum, o) => sum + o.p, 0);
  add(rest, 0, 0, null);
  return out;
}

// A bonus's points: each part got with chance `conversion`, [{ pts, p }].
export function bonusSpread(conversion, parts, value) {
  const c = Math.min(1, Math.max(0, conversion));
  const out = [];
  let choose = 1;
  for (let k = 0; k <= parts; k += 1) {
    out.push({ pts: k * value, p: choose * c ** k * (1 - c) ** (parts - k) });
    choose = (choose * (parts - k)) / (k + 1);
  }
  return out;
}

// A team's chance per part: (typical x 5 + its bonus points so far) / (5 + bonuses heard), as a share of the most a
// bonus can score (the plan's "Bonuses").
export const conversionOf = (typical, points, heard, most) => (most > 0 ? ((typical * most) * SHRINK + points) / (SHRINK + heard) / most : 0);

// ---- Adding it up ---------------------------------------------------------------------------------

// One tossup's effect on the lead (team 0's score less team 1's), bonuses in: [[change, p]].
function steps(outcomes, bonuses) {
  const map = new Map();
  const put = (change, p) => map.set(change, (map.get(change) ?? 0) + p);
  for (const o of outcomes) {
    const base = o.pts[0] - o.pts[1];
    if (o.bonus === null || !bonuses) put(base, o.p);
    else for (const b of bonuses[o.bonus]) put(base + (o.bonus === 0 ? b.pts : -b.pts), o.p * b.p);
  }
  return [...map];
}

function advance(dist, moves) {
  const next = new Map();
  for (const [lead, p] of dist) {
    for (const [change, q] of moves) {
      const key = lead + change;
      next.set(key, (next.get(key) ?? 0) + p * q);
    }
  }
  return next;
}

// Who wins a sudden-death tossup: a right answer wins it, a neg loses it, and a dead one is played again. When the
// rules' neg costs nothing, a neg only loses if the other team then gets it.
function suddenDeath(split, rules) {
  const negLoses = rules.tossup.neg < 0;
  const win = [0, 1].map(t => split.right[t] + (negLoses ? split.neg[1 - t] : split.negThen[1 - t]) + split.endThen[1 - t]);
  return win[0] + win[1] > 0 ? win[0] / (win[0] + win[1]) : 0.5;
}

// The chance each side wins from a lead, with `left` the chance of each number of tossups still to come
// ([P(0), P(1), ...]), then any overtime the rules play on a tie. Returns { a, b, draw }: team 0's chance, team 1's,
// and a tie that stands (rules with no overtime). A side that cannot be caught gets b (or a) exactly 0.
export function winFrom({ lead, left, outcomes, bonuses, split, rules, overtime = rules.overtime }) {
  const moves = steps(outcomes, bonuses);
  const tieSplit = suddenDeath(split, rules);
  const plain = steps(outcomes, null);
  const result = { a: 0, b: 0, draw: 0 };
  // The end of regulation: a lead wins; a tie goes to overtime.
  const settle = (dist, weight) => {
    for (const [d, p] of dist) {
      if (d > 0) result.a += weight * p;
      else if (d < 0) result.b += weight * p;
      else if (overtime === 'none') result.draw += weight * p;
      else if (overtime === 'threeThenSuddenDeath') {
        let ot = new Map([[0, p]]);
        for (let k = 0; k < 3; k += 1) ot = advance(ot, plain);
        for (const [e, q] of ot) {
          if (e > 0) result.a += weight * q;
          else if (e < 0) result.b += weight * q;
          else { result.a += weight * q * tieSplit; result.b += weight * q * (1 - tieSplit); }
        }
      } else {
        result.a += weight * p * tieSplit;
        result.b += weight * p * (1 - tieSplit);
      }
    }
  };
  let dist = new Map([[lead, 1]]);
  left.forEach((weight, k) => {
    if (k > 0) dist = advance(dist, moves);
    if (weight > 0) settle(dist, weight);
  });
  // Rounding leaves the three a hair off adding to 1; shared out, so a side no path reaches stays exactly 0.
  const total = result.a + result.b + result.draw;
  return { a: result.a / total, b: result.b / total, draw: result.draw / total };
}

// ---- Tossups left ---------------------------------------------------------------------------------

// The normal spread at whole numbers from 0: [P(0), P(1), ...], each the chance of being within half a step of it.
function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const cdf = (x, mean, sd) => 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)));
function wholeNumbers(mean, sd, from = 0) {
  if (sd <= 0) return Array.from({ length: Math.max(from, Math.round(mean)) + 1 }, (_, k) => (k === Math.max(from, Math.round(mean)) ? 1 : 0));
  const top = Math.max(from, Math.ceil(mean + 5 * sd));
  const out = [];
  for (let k = 0; k <= top; k += 1) out.push(k < from ? 0 : cdf(k === top ? Infinity : k + 0.5, mean, sd) - cdf(k === from ? -Infinity : k - 0.5, mean, sd));
  const total = out.reduce((sum, p) => sum + p, 0);
  return out.map(p => p / total);
}

// University Challenge's starters still to come, after `played` starters and a share `share` of the game's time
// (null when the clock has not been run): the pace model fitted on the 108 BBC games (skor_export.py, uc_pace).
// `open`: one starter is under way now, which this leaves out of the count.
export function ucLeft(uc, done, share, open) {
  if (share === null) {
    // No clock: the usual number of starters a game, given at least this many.
    const total = wholeNumbers(uc.startersPerGame, uc.startersSd, done + (open ? 1 : 0));
    return total.slice(done + (open ? 1 : 0));
  }
  const u = Math.min(1, Math.max(0, share));
  if (u >= 1) return [1];
  const rate = (done + uc.pacePrior) / (u + uc.pacePrior / uc.startersPerGame);
  const expected = Math.max(0, rate * (1 - u) - (open ? 1 : 0));
  return wholeNumbers(expected, uc.paceSpread * Math.sqrt(Math.max(0.5, expected)));
}

// ---- The match ------------------------------------------------------------------------------------

// How the rules count tossups: 'fixed' (a number in the rules), 'pace' (University Challenge's game clock), or null.
const paceOf = rules => (rules.regulation?.unit === 'cycles' && Number.isInteger(rules.regulation.length) && rules.regulation.length > 0 ? 'fixed'
  : rules.regulation?.length == null && rules.clock?.countdown?.per === 'game' && rules.clock.countdown.length > 0 ? 'pace' : null);

// Why these rules get no win percentage, or null when they do.
export function unsupported(rules) {
  if (rules.trivia) return 'Win % is for quizbowl and University Challenge rules, not trivia formats.';
  if (rules.bonus.bounce != null) return 'Win % does not work out bounce-backs.';
  if (rules.lightningAfter != null) return 'Win % does not work out lightning rounds.';
  if (paceOf(rules) === null) return 'Win % needs a set number of tossups in the rules, or University Challenge\'s game clock.';
  if (rules.regulation.length > MAX_TOSSUPS) return `Win % works out matches of up to ${MAX_TOSSUPS} tossups.`;
  return null;
}

const isRight = buzz => buzz.result === 'power' || buzz.result === 'ten';

// Everything the sum needs, at a point in the match. `upTo` is the number of cycles counted (all of them for now,
// or i + 1 for "after question i + 1"); `current` is the question under way, or null. The question under way does not
// count towards its team's points per bonus.
function stateAt(match, d, ratings, upTo, current) {
  const { rules } = match;
  const lineup = lineupAt(match, current ? upTo - 1 : upTo);
  const room = [0, 1].map(t => lineup[t].map(id => seatOf(ratings, id === null ? '' : playerName(match, t, id))).filter(Boolean));
  const most = rules.bonus.parts * rules.bonus.partValue;
  const typical = paceOf(rules) === 'pace' ? ratings.uc.bonusConversion : ratings.league.ppb / 30;
  const points = [0, 0], heard = [0, 0];
  let doneReg = 0, doneOver = 0, lead = 0;
  for (let i = 0; i < (current ? upTo - 1 : upTo); i += 1) {
    const c = d.cycles[i];
    if (c.flags.includes('after-end')) continue;
    if (c.overtime) doneOver += 1;
    else doneReg += 1;
    const right = c.buzzes.find(isRight);
    if (right && c.bonusNumber !== null && !c.flags.includes('bonus-in-overtime')) {
      points[right.team] += c.ownBonus[right.team];
      heard[right.team] += 1;
    }
    lead = c.running[0] - c.running[1];
  }
  const conv = [0, 1].map(t => conversionOf(typical, points[t], heard[t], most));
  return { room, conv, doneReg, doneOver, lead };
}

// What is left of the question under way: 'bonus' (its bonus is being read), 'rebound' (the other team may still
// answer after a wrong buzz), 'over' (nobody can still answer it) or null (nothing entered yet: it counts as to come).
function openKind(open, d) {
  if (!open) return null;
  if (d.open.stage === 'bonus') return 'bonus';
  const wrong = open.buzzes.find(b => !isRight(b));
  if (!wrong) return null;
  return d.open.liveTeams[1 - wrong.team] ? 'rebound' : 'over';
}

// The chance each team wins, from the record and the file, at `now`: { a, b, draw } or null (no file, rules it does
// not work out, or a match that is over). `line` gives the chance after the first `upTo` questions instead, with `at`
// the time the last of them closed (null when not recorded: then the clock is treated as not run).
export function matchChance(match, d, ratings, now, { upTo = d.cycles.length, at = null, line = false } = {}) {
  const { rules } = match;
  const live = !line;
  if (!ratings || unsupported(rules) || (live && (d.phase.ended || d.open.stage === 'awaitingEnd'))) return null;
  const openCycle = live && d.open.cycleId !== null ? match.cycles.find(c => c.id === d.open.cycleId) : null;
  const kind = openKind(openCycle, d);
  const open = kind === null ? null : openCycle;
  // A question opened with nothing in it yet (a picture or music starter chosen) is still to come, not played.
  const s = openCycle && !open ? stateAt(match, d, ratings, upTo - 1, null) : stateAt(match, d, ratings, upTo, open);
  const split = tossupSplit(s.room, ratings.league);
  const outcomes = tossupOutcomes(split, rules, ratings.league.powerShare);
  const bonuses = s.conv.map(c => bonusSpread(c, rules.bonus.parts, rules.bonus.partValue));
  const lead = live ? d.scores[0] - d.scores[1] : s.lead;
  const fixed = k => Array.from({ length: Math.max(0, k) + 1 }, (_, i) => (i === Math.max(0, k) ? 1 : 0));

  // The tossups still to come after the question under way (if one is), and what a tie then leads to.
  const last = d.cycles[upTo - 1];
  const inOvertime = live ? d.phase.overtime !== null : Boolean(last?.overtime)
    || (last && !last.overtime && rules.overtime !== 'none' && last.running[0] === last.running[1] && s.doneReg >= (rules.regulation.length ?? Infinity));
  let left, overtime = rules.overtime;
  if (inOvertime && rules.overtime === 'threeThenSuddenDeath' && s.doneOver + (open ? 1 : 0) < 3) {
    left = fixed(3 - s.doneOver - (open ? 1 : 0));
    overtime = 'suddenDeath';
  } else if (inOvertime || (live && (d.phase.regulationOver || match.markers.some(m => m.type === 'timeCalled')))) {
    // Time called: only the question under way, if any, is left.
    left = [1];
    if (inOvertime) overtime = 'suddenDeath';
  } else if (paceOf(rules) === 'fixed') {
    left = fixed(rules.regulation.length - s.doneReg - (open ? 1 : 0));
  } else {
    const ms = live ? played(match, now) : upTo === 0 || at === null ? null : played(match, at);
    left = ucLeft(ratings.uc, s.doneReg, ms === null ? null : ms / 1000 / rules.clock.countdown.length, Boolean(open));
  }
  const noBonus = inOvertime;
  const sum = start => winFrom({ lead: start, left, outcomes, bonuses: noBonus ? null : bonuses, split, rules, overtime });
  if (!open || kind === 'over') return sum(lead);

  // The question under way: its bonus still being read, or the other team still to answer after a wrong buzz.
  const mix = parts => {
    const out = { a: 0, b: 0, draw: 0 };
    for (const [change, p] of parts) {
      const r = sum(lead + change);
      for (const key of ['a', 'b', 'draw']) out[key] += p * r[key];
    }
    return out;
  };
  const sign = t => (t === 0 ? 1 : -1);
  if (kind === 'bonus') {
    if (noBonus) return sum(lead);
    const team = d.open.bonus.team;
    const unmarked = d.open.bonus.parts.filter(part => part.ctrl === null).length;
    return mix(bonusSpread(s.conv[team], unmarked, rules.bonus.partValue).map(b => [sign(team) * b.pts, b.p]));
  }
  const t = open.buzzes.find(b => !isRight(b)).team, o = 1 - t;
  const neg = open.buzzes.find(b => !isRight(b)).result === 'neg';   // an interrupt, fined or not (PACE fines none)
  const chance = neg ? (split.neg[t] > 0 ? split.negThen[t] / split.neg[t] : 0) : (split.endWrong[t] > 0 ? split.endThen[t] / split.endWrong[t] : 0);
  const gets = noBonus ? [[sign(o) * rules.tossup.ten, 1]]
    : bonusSpread(s.conv[o], rules.bonus.parts, rules.bonus.partValue).map(b => [sign(o) * (rules.tossup.ten + b.pts), b.p]);
  return mix([...gets.map(([change, p]) => [change, p * chance]), [0, 1 - chance]]);
}

// Each team's chance before the first question and after each closed question, for the scoresheet's line:
// [{ number: 0 (the start) or the question's number, a, b }]. Questions after the end are left out.
export function chanceLine(match, d, ratings) {
  if (!ratings || unsupported(match.rules)) return [];
  const out = [];
  const start = matchChance(match, d, ratings, 0, { upTo: 0, line: true });
  if (start) out.push({ number: 0, a: start.a, b: start.b });
  d.cycles.forEach((c, i) => {
    if (!c.closed || c.flags.includes('after-end')) return;
    const endsHere = d.phase.ended && d.cycles.slice(i + 1).every(x => x.flags.includes('after-end'));
    const r = endsHere ? { a: c.running[0] > c.running[1] ? 1 : 0, b: c.running[0] < c.running[1] ? 1 : 0 }
      : matchChance(match, d, ratings, 0, { upTo: i + 1, at: match.cycles[i].closedAt ?? null, line: true });
    if (r) out.push({ number: c.number, a: r.a, b: r.b });
  });
  return out;
}

// A chance as the screens show it: whole per cent, "100%" only when the other side cannot win or tie, never "0%"
// for a side that still can.
export function percent(p, otherCanStillWin) {
  if (!otherCanStillWin) return '100%';
  return `${Math.min(99, Math.max(1, Math.round(100 * p)))}%`;
}

// The favourite and its chance: { team, text } (team null at exactly level), from matchChance's result.
export function favourite(chance) {
  if (!chance) return null;
  if (chance.a === chance.b) return { team: null, text: percent(0.5, true) };
  const team = chance.a > chance.b ? 0 : 1;
  const mine = team === 0 ? chance.a : chance.b, other = (team === 0 ? chance.b : chance.a) + chance.draw;
  return { team, text: percent(mine, other > 0) };
}
