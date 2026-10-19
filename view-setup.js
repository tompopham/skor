// The Setup screen (spec 6.2): pick a format, check or edit its rules, name the teams and players,
// then Start. Everything typed lives in a draft kept in state.ui.setup, so changing the format
// never loses a name, and leaving for Home and coming back finds the form as it was. Each team has bench
// boxes under its four seats (two to begin with, and "Add a bench player" for more), behind its Bench button: the
// bench names go into the record as team.bench when the match starts (v2 4.1), and an empty box is ignored.
// Laid out to fit one window (review 19/10/2026, change 3; Tom's decision 3): the format is one dropdown in the top bar
// with Rules and Details beside it and a one-line summary under it, then the two team cards with no labels (the seat
// number in a gutter), then Rules and Match details (shown only when opened), and Start in a bar held at the bottom.

import { PRESETS, DEFAULT_PRESET_ID, rulesFromPreset } from './presets.js';
import { newMatch } from './engine.js';
import { defaultClockRules } from './clock.js';
import { loadRoster, saveRoster } from './storage.js';
import { h, newId } from './dom.js';

// ---- Small helpers -------------------------------------------------------------------------

const getAt = (object, path) => path.split('.').reduce((o, key) => o?.[key], object);
function setAt(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, key) => o[key], object)[last] = value;
}

const SIDE = ['A', 'B'];
const DETAIL_FIELDS = [
  ['competition', 'Competition'], ['venue', 'Venue'], ['round', 'Round'], ['reader', 'Reader'], ['scorer', 'Scorer'],
];

function freshDraft() {
  return {
    presetId: DEFAULT_PRESET_ID,
    rules: rulesFromPreset(DEFAULT_PRESET_ID),
    teams: [0, 1].map(() => ({ name: '', seats: ['', '', '', ''], bench: ['', ''], captain: null })),
    details: { competition: '', venue: '', round: '', reader: '', scorer: '' },
    open: { rules: false, details: false, bench: [false, false] },
  };
}

// ---- Near-duplicate names (research 9, recommendation 19) -----------------------------------

// The number of single-letter changes (add, drop, swap) between two words.
export function editDistance(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return previous[y.length];
}

// The pairs of seats on one team whose names are nearly the same: both over 3 letters, and no more
// than 2 changes apart ignoring capitals. Returns [[seatA, seatB], ...], seats counted from 0.
export function nearDuplicateSeats(seats) {
  const names = seats.map(name => name.trim().toLowerCase().normalize('NFC'));
  const pairs = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const long = Array.from(names[i]).length > 3 && Array.from(names[j]).length > 3;
      if (long && editDistance(names[i], names[j]) <= 2) pairs.push([i, j]);
    }
  }
  return pairs;
}

// ---- Rule inputs ---------------------------------------------------------------------------

// A whole-number input. `read()` gives the number to show, `write(n)` takes each valid number as it
// is typed. With `neg`, a positive number typed is kept as its negative: a neg is always a loss, and
// a phone's number pad has no minus sign to hand.
function numberInput({ read, write, min = 0, max = 1000, neg = false, label }) {
  const input = h('input', { type: 'number', step: '1', min: neg ? -max : min, max: neg ? 0 : max, 'aria-label': label });
  input.value = read();
  input.addEventListener('input', () => {
    const value = input.valueAsNumber;
    if (!Number.isInteger(value)) return;
    const kept = neg && value > 0 ? -value : value;
    if (kept >= (neg ? -max : min) && kept <= (neg ? 0 : max)) write(kept);
  });
  // Leaving the box shows what is actually kept, so an empty or refused entry cannot mislead.
  input.addEventListener('change', () => { input.value = read(); });
  return input;
}

const pathNumber = (rules, path, options = {}) => numberInput({
  read: () => getAt(rules, path),
  write: value => setAt(rules, path, value),
  ...options,
});

function numberField(rules, text, path, options = {}) {
  return h('label', { class: 'f' }, h('span', {}, text), pathNumber(rules, path, { ...options, label: text }));
}

// A tick box on a row of its own across the grid.
function checkField(rules, text, path, onChange) {
  const box = h('input', { type: 'checkbox' });
  box.checked = Boolean(getAt(rules, path));
  box.addEventListener('change', () => { setAt(rules, path, box.checked); onChange?.(box.checked); });
  return h('label', { class: 'chk wide' }, box, h('span', {}, text));
}

function selectField(rules, text, path, options) {
  const select = h('select', {}, options.map(([value, name]) => h('option', { value }, name)));
  select.value = getAt(rules, path);
  select.addEventListener('change', () => setAt(rules, path, select.value));
  return h('label', { class: 'f' }, h('span', {}, text), select);
}

// A value that can be switched off (stored as null): a tick box and a number beside it.
function optionalNumber(rules, text, path, fallback, options = {}) {
  let memo = getAt(rules, path) ?? fallback;
  const box = h('input', { type: 'checkbox' });
  box.checked = getAt(rules, path) !== null;
  const number = numberInput({
    read: () => memo,
    write: value => { memo = value; if (box.checked) setAt(rules, path, value); },
    label: `${text}: value`,
    ...options,
  });
  number.disabled = !box.checked;
  box.addEventListener('change', () => {
    number.disabled = !box.checked;
    setAt(rules, path, box.checked ? memo : null);
  });
  return h('div', { class: 'optnum' }, h('label', { class: 'chk' }, box, h('span', {}, text)), number);
}

// Bounce-backs: off, the same value as a part, or a fixed value.
function bounceField(rules) {
  let memo = typeof rules.bonus.bounce === 'number' ? rules.bonus.bounce : 5;
  const mode = rules.bonus.bounce === null ? 'off' : rules.bonus.bounce === 'same' ? 'same' : 'fixed';
  const select = h('select', {}, [['off', 'Off'], ['same', 'Same value as a part'], ['fixed', 'A fixed value']]
    .map(([value, name]) => h('option', { value }, name)));
  select.value = mode;
  const number = numberInput({
    read: () => memo,
    write: value => { memo = value; if (select.value === 'fixed') rules.bonus.bounce = value; },
    min: 1,
    label: 'Bounce-back value',
  });
  number.disabled = mode !== 'fixed';
  select.addEventListener('change', () => {
    number.disabled = select.value !== 'fixed';
    rules.bonus.bounce = select.value === 'off' ? null : select.value === 'same' ? 'same' : memo;
  });
  return h('div', { class: 'optnum' }, h('label', { class: 'f' }, h('span', {}, 'Bounce-backs'), select), number);
}

const group = (title, ...fields) => h('section', { class: 'group' }, h('h3', {}, title), h('div', { class: 'grid2' }, fields));

// Clock and timeouts (v2 3.1), written into `rules.clock`: a countdown that is off or a number of whole
// minutes for a half or the whole game, the timeouts a team may take (a number, or no limit) and how long
// one lasts. A record from before version 2 has no clock rules, so the defaults are put in first. The boxes
// of a switched-off value keep what they last showed, so ticking a box back on gives that back
// (11 minutes a half, 1 timeout, until something else is typed).
function clockFields(rules) {
  rules.clock = { ...defaultClockRules(), ...rules.clock };
  const { clock } = rules;
  const memo = { minutes: clock.countdown ? Math.round(clock.countdown.length / 60) : 11, per: clock.countdown?.per ?? 'half', limit: clock.timeoutsPerTeam ?? 1 };

  const countdownBox = h('input', { type: 'checkbox', 'aria-label': 'Countdown on' });
  countdownBox.checked = clock.countdown !== null;
  const minutes = numberInput({
    read: () => memo.minutes, write: value => { memo.minutes = value; if (clock.countdown) clock.countdown.length = value * 60; },
    min: 1, max: 600, label: 'Countdown length in minutes',
  });
  const per = h('select', { 'aria-label': 'Countdown is for' }, [['half', 'A half'], ['game', 'A game']].map(([value, name]) => h('option', { value }, name)));
  per.value = memo.per;
  per.addEventListener('change', () => { memo.per = per.value; if (clock.countdown) clock.countdown.per = per.value; });
  const countdownOff = () => { minutes.disabled = !countdownBox.checked; per.disabled = !countdownBox.checked; };
  countdownOff();
  countdownBox.addEventListener('change', () => {
    clock.countdown = countdownBox.checked ? { length: memo.minutes * 60, per: memo.per } : null;
    countdownOff();
  });

  const noLimit = h('input', { type: 'checkbox', 'aria-label': 'No limit on timeouts' });
  noLimit.checked = clock.timeoutsPerTeam === null;
  const limit = numberInput({
    read: () => memo.limit, write: value => { memo.limit = value; if (!noLimit.checked) clock.timeoutsPerTeam = value; },
    min: 0, max: 20, label: 'Timeouts a team',
  });
  limit.disabled = noLimit.checked;
  noLimit.addEventListener('change', () => {
    limit.disabled = noLimit.checked;
    clock.timeoutsPerTeam = noLimit.checked ? null : memo.limit;
  });

  return group('Clock and timeouts',
    h('div', { class: 'optnum' }, h('label', { class: 'chk' }, countdownBox, h('span', {}, 'Countdown (minutes)')), minutes),
    h('label', { class: 'f' }, h('span', {}, 'Countdown is for'), per),
    h('label', { class: 'f' }, h('span', {}, 'Timeouts a team'), limit),
    h('label', { class: 'chk' }, noLimit, h('span', {}, 'No limit')),
    h('label', { class: 'f' }, h('span', {}, 'Timeout length (seconds)'),
      pathNumber(rules, 'clock.timeoutSeconds', { min: 1, max: 600, label: 'Timeout length in seconds' })));
}

// Every value of the rules as an input (spec 5, "the values a preset holds"), plus the trivia
// values for Consensus and GradWrite (spec 5.1). Edits go straight into `rules`.
export function rulesPanel(rules) {
  const panels = [];

  const musicNeg = pathNumber(rules, 'starterTypes.musicNeg', { neg: true, label: 'Music starter neg' });
  const pictureNeg = pathNumber(rules, 'starterTypes.pictureNeg', { neg: true, label: 'Picture starter neg' });
  const typesOff = () => { musicNeg.disabled = !rules.starterTypes.on; pictureNeg.disabled = !rules.starterTypes.on; };
  typesOff();
  panels.push(group('Starters',
    numberField(rules, 'Starter value', 'tossup.ten', { min: 1, max: 100 }),
    optionalNumber(rules, 'Powers', 'tossup.power', 15, { min: 1, max: 100 }),
    numberField(rules, 'Neg: first team, wrong interruption', 'tossup.neg', { neg: true, max: 100 }),
    numberField(rules, 'Neg: second team, wrong interruption', 'tossup.secondNeg', { neg: true, max: 100 }),
    checkField(rules, 'Picture and music starters', 'starterTypes.on', typesOff),
    h('label', { class: 'f' }, h('span', {}, 'Music starter neg'), musicNeg),
    h('label', { class: 'f' }, h('span', {}, 'Picture starter neg'), pictureNeg)));

  if (!rules.trivia) {
    panels.push(group('Bonuses',
      numberField(rules, 'Parts in a bonus', 'bonus.parts', { min: 1, max: 6 }),
      numberField(rules, 'Points a part', 'bonus.partValue', { min: 1, max: 100 }),
      checkField(rules, 'Pass rest allowed', 'bonus.passRest'),
      bounceField(rules),
      numberField(rules, 'Sweep reward (all parts got)', 'bonus.reward', { max: 100 }),
      selectField(rules, 'Bonus numbering', 'bonus.numbering', [['nextUnused', 'Next unused'], ['paired', 'Paired with the starter']]),
      checkField(rules, 'Held bonus sets for dead picture and music starters', 'bonus.heldSets')));
  }

  panels.push(group('Length of the match',
    optionalNumber(rules, 'Fixed length', 'regulation.length', 20, { min: 1 }),
    selectField(rules, 'Length counts', 'regulation.unit', [['cycles', 'Starters (cycles)'], ['bonusRounds', 'Bonus rounds']]),
    optionalNumber(rules, 'Halftime after', 'regulation.halftimeAfter', 10, { min: 1 }),
    optionalNumber(rules, 'Lightning round after (bonus rounds)', 'lightningAfter', 25, { min: 1 }),
    selectField(rules, 'Overtime', 'overtime', [['suddenDeath', 'Sudden death'], ['threeThenSuddenDeath', 'Three starters, then sudden death'], ['none', 'None: a tie stands']]),
    selectField(rules, 'When time is called', 'atTime', [['finishCycle', 'Finish the cycle'], ['stopNow', 'Stop at once'], ['buzzMayAnswer', 'A buzz already in may answer']]),
    checkField(rules, 'Mark overtime results (ET)', 'etLabel')));

  panels.push(clockFields(rules));

  if (rules.trivia) {
    const jackpot = h('div', { class: 'four' }, [0, 1, 2, 3].map(clue =>
      h('label', { class: 'f' }, h('span', {}, `Jackpot clue ${clue + 1}`),
        pathNumber(rules, `trivia.jackpot.${clue}`, { max: 1000, label: `Jackpot clue ${clue + 1}` }))));
    panels.push(h('section', { class: 'group' }, h('h3', {}, 'Trivia formats'), jackpot,
      h('div', { class: 'grid2' },
        optionalNumber(rules, 'Streak (points an answer)', 'trivia.streak', 5, { min: 1, max: 100 }),
        selectField(rules, 'A short team under Jailbreak', 'trivia.shortJail', [['brick', 'Brick'], ['noAdvantage', 'No Advantage']]),
        numberField(rules, 'Quarters', 'trivia.quarters', { min: 1, max: 8 })),
      h('p', { class: 'hint' }, 'Brick: a short team never breaks jail. No Advantage: it breaks jail only as often as its opponents.')));
  }

  return h('div', { class: 'inner' }, panels);
}

// ---- The screen ----------------------------------------------------------------------------

// A preset is tagged "Unverified" when it has no primary source or its source says a rule is unverified.
export function presetUnverified(preset) {
  return preset.verified === false || /unverified/i.test(preset.source);
}

// One line that says what a set of rules plays like, shown under the Format dropdown (review 19/10/2026, change 3), e.g.
// "Starters 10, power 15, neg −5 · bonus 3 × 10 · 20 questions, halftime after 10". Built from the rules, not the preset,
// so it follows any edit. A true minus sign (U+2212), middle dots and a times sign.
const minus = n => (n < 0 ? `−${-n}` : String(n));
const clockText = seconds => (seconds % 60 === 0 ? null : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);

function lengthText(rules) {
  const parts = [];
  const { length, unit, halftimeAfter } = rules.regulation;
  if (length !== null) {
    parts.push(`${length} ${unit === 'bonusRounds' ? 'bonus rounds' : 'questions'}`);
    if (halftimeAfter !== null) parts.push(`halftime after ${halftimeAfter}`);
  }
  const countdown = rules.clock?.countdown;
  if (countdown) {
    const exact = clockText(countdown.length);
    const minutes = countdown.length / 60;
    if (countdown.per === 'half') parts.push(exact ? `${exact} halves` : `${minutes}-minute halves`);
    else parts.push(exact ? `${exact} game` : `${minutes}-minute game`);
  }
  return parts.length ? parts.join(', ') : 'no fixed length';
}

export function rulesSummary(rules) {
  const { tossup } = rules;
  const negText = tossup.neg ? `neg ${minus(tossup.neg)}` : 'no neg';
  let pieces;
  if (rules.trivia) {
    const { jackpot, streak, quarters } = rules.trivia;
    pieces = [
      `${quarters} quarters`,
      `starters ${tossup.ten}, ${negText}`,
      `Jackpot ${jackpot.join(', ')}`,
      streak === null ? 'no Streak' : `Streak ${streak} an answer`,
    ];
  } else {
    const starters = [`Starters ${tossup.ten}`, tossup.power !== null ? `power ${tossup.power}` : null, negText].filter(Boolean).join(', ');
    const { parts, partValue, bounce } = rules.bonus;
    const bonus = parts > 0 ? `bonus ${parts} × ${partValue}${bounce !== null ? ', bounce-backs' : ''}` : 'no bonuses';
    pieces = [starters, bonus, lengthText(rules)];
  }
  if (presetUnverified({ verified: rules.verified, source: rules.source ?? '' })) pieces.push('Unverified');
  return pieces.join(' · ');
}

function formatSelect(draft, onPick) {
  const select = h('select', { id: 'format', 'aria-label': 'Format' },
    PRESETS.map(preset => h('option', { value: preset.presetId }, preset.name)));
  select.value = draft.presetId;
  select.addEventListener('change', () => onPick(select.value));
  return select;
}

// The line at the top of the Rules section: the format and where its rules come from.
function sourceLine(rules) {
  return [`${rules.name}: ${rules.source}`, presetUnverified({ verified: rules.verified, source: rules.source ?? '' }) ? h('span', { class: 'tag' }, 'Unverified') : null];
}

// A team card (review change 3): no labels over the boxes. Row 0 is the team name, in bold, and the Bench button; rows 1 to 4
// are the seats, each with its number in a narrow gutter (it stays in view after a name is typed) and Captain. The Bench
// button shows how many bench names are typed, and opens the bench boxes under the seats.
function teamCard(draft, t, rosterId) {
  const team = draft.teams[t];
  const side = t === 0 ? 'Left' : 'Right';
  const warning = h('p', { class: 'msg' });
  const showWarning = () => {
    warning.replaceChildren(...nearDuplicateSeats(team.seats).map(([i, j]) =>
      h('span', {}, `Seats ${i + 1} and ${j + 1} are nearly the same name ("${team.seats[i].trim()}" and "${team.seats[j].trim()}"). Check they are two different players.`, h('br'))));
  };
  const gutter = text => h('span', { class: 'gut', 'aria-hidden': 'true' }, text);

  const name = h('input', {
    id: `team${t}-name`, class: 'tbold', maxlength: 60, placeholder: `Team ${SIDE[t]}`, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false',
    'aria-label': `${side} team name`,
  });
  name.value = team.name;
  name.addEventListener('input', () => { team.name = name.value; });

  team.bench ??= ['', ''];
  draft.open.bench ??= [false, false];
  const benchCount = () => team.bench.filter(entry => entry.trim() !== '').length;
  const benchButton = h('button', { type: 'button', class: 'btn small', id: `team${t}-bench`, 'aria-expanded': String(draft.open.bench[t]) });
  const showBenchCount = () => { benchButton.textContent = `Bench (${benchCount()})`; };
  showBenchCount();

  const captains = [];
  const markCaptain = () => captains.forEach((button, seat) => button.setAttribute('aria-pressed', String(team.captain === seat)));
  const seatRows = [0, 1, 2, 3].map(seat => {
    const input = h('input', {
      id: `team${t}-seat${seat}`, list: rosterId, maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
      placeholder: seat === 3 ? 'Leave empty if playing three' : 'Name',
      'aria-label': `${side} team, seat ${seat + 1}`,
    });
    input.value = team.seats[seat];
    input.addEventListener('input', () => { team.seats[seat] = input.value; showWarning(); });
    const captain = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', 'aria-label': `${side} team, seat ${seat + 1} is the captain` }, 'Captain');
    captain.addEventListener('click', () => { team.captain = team.captain === seat ? null : seat; markCaptain(); });
    captains.push(captain);
    return h('div', { class: 'trow' }, gutter(String(seat + 1)), input, captain);
  });
  markCaptain();
  showWarning();

  // The bench: a box for each name in the draft, and a button that adds another. A box is for a name only (no captain).
  const benchBox = place => {
    const input = h('input', {
      id: `team${t}-bench${place}`, list: rosterId, maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
      placeholder: 'Bench player', 'aria-label': `${side} team, bench player ${place + 1}`,
    });
    input.value = team.bench[place] ?? '';
    input.addEventListener('input', () => { team.bench[place] = input.value; showBenchCount(); });
    return h('div', { class: 'trow bench' }, gutter(`B${place + 1}`), input);
  };
  const addBench = h('button', { type: 'button', class: 'btn', id: `team${t}-add-bench` }, 'Add a bench player');
  const benchBlock = h('div', { class: 'benchrows', id: `team${t}-benchrows` }, team.bench.map((_, place) => benchBox(place)), addBench);
  benchBlock.hidden = !draft.open.bench[t];
  addBench.addEventListener('click', () => {
    team.bench.push('');
    const box = benchBox(team.bench.length - 1);
    addBench.before(box);
    box.querySelector('input').focus();
  });
  benchButton.addEventListener('click', () => {
    draft.open.bench[t] = !draft.open.bench[t];
    benchBlock.hidden = !draft.open.bench[t];
    benchButton.setAttribute('aria-expanded', String(draft.open.bench[t]));
    if (draft.open.bench[t]) benchBlock.querySelector('input')?.focus();
  });

  return h('div', { class: 'card tcard' }, h('h2', {}, `${side} team`),
    h('div', { class: 'trow' }, gutter(''), name, benchButton), seatRows, benchBlock, warning);
}

// A section after the teams that shows only when its button in the top bar has opened it (Rules, Match details). The
// button says whether it is open; opening it brings the section into view, and its own heading row closes it.
function openedSection(draft, key, title, id, content, button) {
  const section = h('details', { class: 'fold shut', id }, h('summary', {}, title), content);
  section.open = draft.open[key];
  const mark = () => button.setAttribute('aria-expanded', String(section.open));
  mark();
  section.addEventListener('toggle', () => { draft.open[key] = section.open; mark(); });
  button.addEventListener('click', () => {
    section.open = !section.open;
    draft.open[key] = section.open;
    mark();
    if (section.open) section.scrollIntoView({ block: 'start' });
  });
  return section;
}

const detailsContent = draft => h('div', { class: 'inner' }, h('div', { class: 'grid2' }, DETAIL_FIELDS.map(([key, text]) => {
  const input = h('input', { maxlength: 80, autocomplete: 'off' });
  input.value = draft.details[key];
  input.addEventListener('input', () => { draft.details[key] = input.value; });
  return h('label', { class: 'f' }, h('span', {}, text), input);
})));

// What Start makes of the draft: blank team names become Team A and Team B, and a team with no
// names typed gets seats A1 to A4 (B1 to B4), as the bare-bones page did. The bench is the names typed in its
// boxes, trimmed, with the empty boxes left out.
function teamsFromDraft(draft) {
  return draft.teams.map((team, t) => {
    const seats = team.seats.map(name => name.trim());
    const typed = seats.some(Boolean);
    return {
      name: team.name.trim() || `Team ${SIDE[t]}`,
      seats: typed ? seats : [1, 2, 3, 4].map(n => `${SIDE[t]}${n}`),
      bench: (team.bench ?? []).map(name => name.trim()).filter(Boolean),
      captain: typed && team.captain !== null && seats[team.captain] ? team.captain : null,
    };
  });
}

export function renderSetup(root, state, api) {
  if (!state.ui.setup) api.setUi({ setup: freshDraft() }, false);
  const draft = state.ui.setup;

  const rosterId = 'roster-names';
  const roster = h('datalist', { id: rosterId }, loadRoster().map(name => h('option', { value: name })));

  // The summary line follows the rules as they are edited; the Rules section opens with where they come from.
  const summary = h('p', { class: 'hint', id: 'format-summary' });
  const source = h('p', { class: 'hint', id: 'rules-source' });
  const showRules = () => {
    summary.textContent = rulesSummary(draft.rules);
    source.replaceChildren(...sourceLine(draft.rules).filter(Boolean));
  };
  const rulesHost = h('div', {}, rulesPanel(draft.rules));
  rulesHost.addEventListener('input', showRules);
  rulesHost.addEventListener('change', showRules);
  showRules();

  // Picking another format replaces the rules, and nothing else: names and details stay.
  const format = formatSelect(draft, id => {
    draft.presetId = id;
    draft.rules = rulesFromPreset(id);
    rulesHost.replaceChildren(rulesPanel(draft.rules));
    showRules();
  });
  const rulesButton = h('button', { type: 'button', class: 'btn small', id: 'setup-rules' }, 'Rules');
  const detailsButton = h('button', { type: 'button', class: 'btn small', id: 'setup-details', 'aria-label': 'Match details' }, 'Details');
  const rulesSection = openedSection(draft, 'rules', 'Rules', 'rules-fold', h('div', { class: 'inner' }, source, rulesHost), rulesButton);
  const detailsSection = openedSection(draft, 'details', 'Match details', 'details-fold', detailsContent(draft), detailsButton);

  // Start: the typed names go to the roster, the draft becomes a match, and the page takes over.
  function startFromDraft() {
    const teams = teamsFromDraft(draft);
    const typed = draft.teams.flatMap(team => [...team.seats, ...(team.bench ?? [])].map(name => name.trim()).filter(Boolean));
    saveRoster([...typed, ...loadRoster()]);
    const match = newMatch({
      rules: draft.rules,
      teams,
      details: Object.fromEntries(Object.entries(draft.details).map(([key, value]) => [key, value.trim()])),
      id: newId(),
      now: api.now(),
    });
    api.setUi({ setup: null }, false);
    api.startMatch(match);
  }

  const start = h('button', { type: 'button', class: 'btn primary', id: 'start-match', onclick: startFromDraft }, 'Start match');
  const form = h('form', { novalidate: true, autocomplete: 'off' },
    summary,
    h('div', { class: 'grid2 tcards' }, teamCard(draft, 0, rosterId), teamCard(draft, 1, rosterId)),
    rulesSection,
    detailsSection,
    h('div', { class: 'startbar' }, start),
    h('p', { class: 'hint', id: 'setup-hint' }, 'Names are saved on this device for next time. A team with no names gets seats A1 to A4 (B1 to B4).'));

  // Only the Start button starts a match. The form never submits, so Enter or a phone keyboard's
  // Go key in a name or a rule box does nothing, and a half-typed form cannot start by accident.
  form.addEventListener('submit', event => event.preventDefault());

  const back = h('button', { type: 'button', class: 'btn small', onclick: () => api.go('home') }, 'Home');
  root.append(
    h('div', { class: 'top setuptop' }, h('h1', { tabindex: '-1' }, 'New match'),
      h('div', { class: 'fmt' }, format, rulesButton, detailsButton), h('div', { class: 'acts' }, back)),
    form, roster);
}
