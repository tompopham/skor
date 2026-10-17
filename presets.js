// Preset rules for the match scorer: one object per row of SPEC.md section 5, then the two
// trivia formats of section 5.1. Every preset holds every field of the Rules shape, so a match can
// keep a full copy and edit any value. `source` is the spec's Source column, shown on the setup
// screen; "unverified" wording is kept in the text, and `verified: false` would mark a preset with
// no primary source at all (none since Schools' Challenge was cut). The BuzzerQuiz, QLL buzzer and
// Schools' Challenge presets were cut on 16/10/2026 at Tom's request; a match saved under one keeps
// its own copy of the rules, and test/helpers.mjs keeps their values for the tests.

export const DEFAULT_PRESET_ID = 'ukqb';

const NO_STARTER_TYPES = { on: false, musicNeg: 0, pictureNeg: 0 };

// The clock group (v2 3.1): `countdown` is null or { length in seconds, per: 'half' | 'game' }, and
// `timeoutsPerTeam` a number or null for no limit. `source` is the rulebook clause behind the limit,
// for the page's question when a team asks for another timeout; empty where there is no limit. ACF C.8
// (one 30 s timeout a team), NAQT F.2 and F.9 (11:00 a half college, 10:00 high school) and PACE C.8
// (one timeout of up to 30 s, with no game clock under C.2) are from the rulebooks. University
// Challenge's 26:00 game is from broadcasts (the gong at about 26 minutes), unverified for the trials.
// Neither Consensus nor GradWrite has a game clock or a timeout limit (checked 16/10/2026).
//
// The subs group (v2 4.1): `windows` lists when a swap is allowed, drawn from 'halftime', 'beforeOvertime',
// 'timeout' (straight after one) and 'quarter', or null when unknown (no warning); `source` is the clause
// shown in the warning. ACF C.12 (halftime, before overtime), NAQT D.4 (adds after a timeout) and PACE C.13
// (halftime, or after regulation if and only if the scores are level; never in a timeout) are from the
// rulebooks. University Challenge's Eligibility Requirements 10 and 12 (Series 32 and 33) let a reserve replace a
// player only between matches and for the rest of the series, so every swap there warns (research note of
// 17/10/2026). Consensus and GradWrite swap between quarters, as both rulebooks have it.

export const PRESETS = [
  {
    presetId: 'ukqb',
    name: 'UK quizbowl',
    source: 'UKQB intro, undated; ACF mirrors',
    verified: true,
    tossup: { ten: 10, power: 15, neg: -5, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 3, partValue: 10, passRest: false, bounce: null, reward: 0, numbering: 'nextUnused', heldSets: false },
    regulation: { length: 20, unit: 'cycles', halftimeAfter: 10 },
    lightningAfter: null,
    overtime: 'suddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: null,
    clock: { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: 1, source: 'ACF C.8' },
    subs: { windows: ['halftime', 'beforeOvertime'], source: 'ACF C.12' },
  },
  {
    presetId: 'acf',
    name: 'ACF',
    source: 'ACF Gameplay Rules, 26 Jul 2024',
    verified: true,
    tossup: { ten: 10, power: null, neg: -5, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 3, partValue: 10, passRest: false, bounce: null, reward: 0, numbering: 'nextUnused', heldSets: false },
    regulation: { length: 20, unit: 'cycles', halftimeAfter: 10 },
    lightningAfter: null,
    overtime: 'suddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: null,
    clock: { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: 1, source: 'ACF C.8' },
    subs: { windows: ['halftime', 'beforeOvertime'], source: 'ACF C.12' },
  },
  {
    presetId: 'naqt-college',
    name: 'NAQT college',
    source: 'NAQT Gameplay Rules, 1 Aug 2026',
    verified: true,
    tossup: { ten: 10, power: 15, neg: -5, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 3, partValue: 10, passRest: true, bounce: null, reward: 0, numbering: 'paired', heldSets: false },
    regulation: { length: null, unit: 'cycles', halftimeAfter: null },
    lightningAfter: null,
    overtime: 'threeThenSuddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: null,
    clock: { countdown: { length: 660, per: 'half' }, timeoutSeconds: 30, timeoutsPerTeam: 1, source: 'NAQT F.9' },
    subs: { windows: ['halftime', 'timeout', 'beforeOvertime'], source: 'NAQT D.4' },
  },
  {
    // The spec's Source cell for this row reads "As above"; it points at the NAQT college row.
    presetId: 'naqt-hs',
    name: 'NAQT high school',
    source: 'NAQT Gameplay Rules, 1 Aug 2026',
    verified: true,
    tossup: { ten: 10, power: 15, neg: -5, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 3, partValue: 10, passRest: true, bounce: null, reward: 0, numbering: 'paired', heldSets: false },
    regulation: { length: null, unit: 'cycles', halftimeAfter: null },
    lightningAfter: null,
    overtime: 'threeThenSuddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: null,
    clock: { countdown: { length: 600, per: 'half' }, timeoutSeconds: 30, timeoutsPerTeam: 1, source: 'NAQT F.9' },
    subs: { windows: ['halftime', 'timeout', 'beforeOvertime'], source: 'NAQT D.4' },
  },
  {
    presetId: 'pace',
    name: 'PACE NSC',
    source: 'PACE Gameplay Rules, 1 Feb 2026',
    verified: true,
    tossup: { ten: 10, power: 20, neg: 0, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 3, partValue: 10, passRest: false, bounce: null, reward: 0, numbering: 'nextUnused', heldSets: false },
    regulation: { length: 20, unit: 'cycles', halftimeAfter: 10 },
    lightningAfter: null,
    overtime: 'suddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: null,
    clock: { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: 1, source: 'PACE C.8' },
    subs: { windows: ['halftime', 'beforeOvertime'], source: 'PACE C.13' },
  },
  {
    presetId: 'uc',
    name: 'University Challenge',
    source: '107 BBC episodes, Jul 2023 to Aug 2026 (research 3.2) for the neg rule, music and picture, 3 x 5, held sets, the gong and the tiebreak. *No power, no bounce-backs and paired numbering rest on secondary pages: unverified',
    verified: true,
    tossup: { ten: 10, power: null, neg: -5, secondNeg: 0 },
    starterTypes: { on: true, musicNeg: 0, pictureNeg: 0 },
    bonus: { parts: 3, partValue: 5, passRest: false, bounce: null, reward: 0, numbering: 'paired', heldSets: true },
    regulation: { length: null, unit: 'cycles', halftimeAfter: null },
    lightningAfter: null,
    overtime: 'suddenDeath',
    atTime: 'stopNow',
    etLabel: false,
    trivia: null,
    clock: { countdown: { length: 1560, per: 'game' }, timeoutSeconds: 30, timeoutsPerTeam: null, source: '' },
    subs: { windows: [], source: 'UC eligibility rules 10 and 12: a reserve comes in only between matches, for good' },
  },
  {
    presetId: 'consensus',
    name: 'Consensus',
    source: 'Consensus Trivia Rules Summary, 2026-27 (consensustrivia.com/resources), checked 16/10/2026. A wrong answer scores 0: the rules give no penalty. A tie stands: the 2025-26 results list drawn games',
    verified: true,
    tossup: { ten: 10, power: null, neg: 0, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 0, partValue: 0, passRest: false, bounce: null, reward: 0, numbering: 'nextUnused', heldSets: false },
    regulation: { length: null, unit: 'cycles', halftimeAfter: null },
    lightningAfter: null,
    overtime: 'none',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: { jackpot: [40, 30, 20, 10], streak: 5, shortJail: 'brick', quarters: 4 },
    clock: { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: null, source: '' },
    subs: { windows: ['quarter'], source: 'the rulebook' },
  },
  {
    presetId: 'gradwrite',
    name: 'GradWrite',
    source: 'GradWrite Gameplay Rules, 10 Mar 2026, and Question Formats, 26 May 2026 (gradwritetrivia.org/Resources), checked 16/10/2026. A wrong answer scores 0: the rules award no points for it. The rules say nothing on a tie, so sudden death is Skor\'s own choice',
    verified: true,
    tossup: { ten: 10, power: null, neg: 0, secondNeg: 0 },
    starterTypes: { ...NO_STARTER_TYPES },
    bonus: { parts: 0, partValue: 0, passRest: false, bounce: null, reward: 0, numbering: 'nextUnused', heldSets: false },
    regulation: { length: null, unit: 'cycles', halftimeAfter: null },
    lightningAfter: null,
    overtime: 'suddenDeath',
    atTime: 'finishCycle',
    etLabel: false,
    trivia: { jackpot: [30, 25, 15, 10], streak: null, shortJail: 'noAdvantage', quarters: 4 },
    clock: { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: null, source: '' },
    subs: { windows: ['quarter'], source: 'the rulebook' },
  },
];

// A deep copy, so editing a match's rules never changes the preset itself.
export function rulesFromPreset(id) {
  const preset = PRESETS.find(p => p.presetId === id);
  if (!preset) throw new Error(`Unknown preset: ${id}`);
  return structuredClone(preset);
}
