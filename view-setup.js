// The Setup screen (spec 6.2): pick a format, check or edit its rules, name the teams and players,
// then Start. Everything typed lives in a draft kept in state.ui.setup, so changing the format
// never loses a name, and leaving for Home and coming back finds the form as it was. Each team has bench
// boxes under its four seats (two to begin with, and "Add a bench player" for more), behind its Bench button: the
// bench names go into the record as team.bench when the match starts (v2 4.1), and an empty box is ignored.
// Laid out to fit one window (review 19/10/2026, change 3; Tom's decision 3): the format is one dropdown in the top bar
// with Rules and Details beside it and a one-line summary under it, then the two team cards with no labels (the seat
// number in a gutter), then Match details (shown only when opened), and Start in a bar held at the bottom. Rules opens the
// Rules screen (view-rules.js; review change 13, Tom's decision 7), which edits the draft's rules and comes back here.

import { PRESETS, DEFAULT_PRESET_ID, rulesFromPreset, presetUnverified } from './presets.js';
import { newMatch } from './engine.js';
import { loadRoster, saveRoster } from './storage.js';
import { h, newId } from './dom.js';
import { renderRulesScreen } from './view-rules.js';

// ---- Small helpers -------------------------------------------------------------------------

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
    open: { details: false, bench: [false, false] },
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

// ---- The screen ----------------------------------------------------------------------------

// presetUnverified moved to presets.js in 1.6.0 (view-rules.js needs it too); it is passed on from here for the tests.
export { presetUnverified };

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
  if (state.ui.sub?.kind === 'rules') { renderRulesScreen(root, state, api); return; }

  const rosterId = 'roster-names';
  const roster = h('datalist', { id: rosterId }, loadRoster().map(name => h('option', { value: name })));

  // The summary line says what the rules play like, as they now are.
  const summary = h('p', { class: 'hint', id: 'format-summary' }, rulesSummary(draft.rules));

  // Picking another format replaces the rules, and nothing else: names and details stay.
  const format = formatSelect(draft, id => {
    draft.presetId = id;
    draft.rules = rulesFromPreset(id);
    summary.textContent = rulesSummary(draft.rules);
  });
  const rulesButton = h('button', {
    type: 'button', class: 'btn small', id: 'setup-rules',
    onclick: () => { api.setUi({ sub: { kind: 'rules' } }); window.scrollTo(0, 0); },
  }, 'Rules');
  const detailsButton = h('button', { type: 'button', class: 'btn small', id: 'setup-details', 'aria-label': 'Match details' }, 'Details');
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
