// The Setup screen (spec 6.2): pick a format, check or edit its rules, name the teams and players,
// then Start. Everything typed lives in a draft kept in state.ui.setup, so changing the format
// never loses a name, and leaving for Home and coming back finds the form as it was. Each team has bench
// boxes under its four seats (two to begin with, and "Add a bench player" for more), behind its Bench button: the
// bench names go into the record as team.bench when the match starts (v2 4.1), and an empty box is ignored.
// Laid out to fit one window (review 19/10/2026, change 3; Tom's decision 3): the format is one dropdown in the top bar
// with Rules and Details beside it and a one-line summary under it, then the two team cards with no labels (the seat
// number in a gutter), then Match details (shown only when opened), and Start in a bar held at the bottom. Rules opens the
// Rules screen (view-rules.js; review change 13, Tom's decision 7), which edits the draft's rules and comes back here.
// Version 1.9.0 (review change 19; SPEC-v2 11, Tom's decisions 16 and 17): no Captain buttons (a saved match still carries
// captain: null), Enter in a name box moves to the next one and never starts the match, switching format after the rules were
// edited asks first, and two names that look alike get one short line under seat 4 and a heavier border.

import { PRESETS, DEFAULT_PRESET_ID, rulesFromPreset, presetUnverified } from './presets.js';
import { newMatch } from './engine.js';
import { loadRoster, saveRoster } from './storage.js';
import { h, newId } from './dom.js';
import { renderRulesScreen, rulesDiffer } from './view-rules.js';
import { ratingMarks } from './view-win.js';

// ---- Small helpers -------------------------------------------------------------------------

const SIDE = ['A', 'B'];
const DETAIL_FIELDS = [
  ['competition', 'Competition'], ['venue', 'Venue'], ['round', 'Round'], ['reader', 'Reader'], ['scorer', 'Scorer'],
];

function freshDraft() {
  return {
    presetId: DEFAULT_PRESET_ID,
    rules: rulesFromPreset(DEFAULT_PRESET_ID),
    teams: [0, 1].map(() => ({ name: '', seats: ['', '', '', ''], bench: ['', ''] })),
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

// The warning under seat 4 (review change 19): "Seats 1 and 2 look alike", or '' when no names do. Seats that look alike in a
// chain are one group ("Seats 1, 2 and 3 look alike"); a second group follows ("Seats 1 and 2 look alike; so do 3 and 4").
export function alikeWarning(seats) {
  const groups = [];
  for (const [i, j] of nearDuplicateSeats(seats)) {
    const joined = groups.filter(group => group.has(i) || group.has(j));
    const merged = new Set([i, j, ...joined.flatMap(group => [...group])]);
    groups.splice(0, groups.length, ...groups.filter(group => !joined.includes(group)), merged);
  }
  const words = groups.map(group => [...group].sort((a, b) => a - b).map(seat => seat + 1))
    .sort((a, b) => a[0] - b[0])
    .map(list => (list.length === 2 ? `${list[0]} and ${list[1]}` : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`));
  if (words.length === 0) return '';
  return `Seats ${words[0]} look alike${words.slice(1).map(w => `; so do ${w}`).join('')}`;
}

// The name boxes in the order Enter walks them (review change 19, Tom's decision 17): each team's name, its four seats, then its
// bench boxes while they are open. The box after `id`, or null after the last one (and for any other box), so Enter can never
// reach Start.
function nameBoxes(draft) {
  return [0, 1].flatMap(t => [`team${t}-name`, ...[0, 1, 2, 3].map(seat => `team${t}-seat${seat}`),
    ...(draft.open?.bench?.[t] ? (draft.teams[t].bench ?? []).map((_, place) => `team${t}-bench${place}`) : [])]);
}
export function nextBox(draft, id) {
  const boxes = nameBoxes(draft);
  const at = boxes.indexOf(id);
  return at < 0 || at === boxes.length - 1 ? null : boxes[at + 1];
}

// Whether picking another format must ask first (review change 19): the draft's rules differ, by value, from its format's.
export const formatSwitchAsks = draft => rulesDiffer(draft.rules, rulesFromPreset(draft.presetId));

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
// are the seats, each with its number in a narrow gutter (it stays in view after a name is typed). The Bench button shows how
// many bench names are typed, and opens the bench boxes under the seats. `changed` is told when the boxes Enter walks change.
function teamCard(draft, t, rosterId, changed) {
  const team = draft.teams[t];
  const side = t === 0 ? 'Left' : 'Right';
  const warning = h('p', { class: 'msg', id: `team${t}-alike` });
  const seatBoxes = [];
  const showWarning = () => {
    warning.textContent = alikeWarning(team.seats);
    const alike = new Set(nearDuplicateSeats(team.seats).flat());
    seatBoxes.forEach((box, seat) => box.classList.toggle('alike', alike.has(seat)));
  };
  const gutter = text => h('span', { class: 'gut', 'aria-hidden': 'true' }, text);
  const marks = ratingMarks();   // win % (1.10.0): "not rated" beside a name the ratings file does not know; nothing with no file

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

  const seatRows = [0, 1, 2, 3].map(seat => {
    const input = h('input', {
      id: `team${t}-seat${seat}`, list: rosterId, maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
      placeholder: seat === 3 ? 'Leave empty if playing three' : 'Name',
      'aria-label': `${side} team, seat ${seat + 1}`,
    });
    input.value = team.seats[seat];
    input.addEventListener('input', () => { team.seats[seat] = input.value; showWarning(); });
    seatBoxes.push(input);
    return h('div', { class: 'trow' }, gutter(String(seat + 1)), input, marks.mark(input));
  });
  showWarning();

  // The bench: a box for each name in the draft, and a button that adds another.
  const benchBox = place => {
    const input = h('input', {
      id: `team${t}-bench${place}`, list: rosterId, maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false',
      placeholder: 'Bench player', 'aria-label': `${side} team, bench player ${place + 1}`,
    });
    input.value = team.bench[place] ?? '';
    input.addEventListener('input', () => { team.bench[place] = input.value; showBenchCount(); });
    return h('div', { class: 'trow bench' }, gutter(`B${place + 1}`), input, marks.mark(input));
  };
  const addBench = h('button', { type: 'button', class: 'btn', id: `team${t}-add-bench` }, 'Add a bench player');
  const benchBlock = h('div', { class: 'benchrows', id: `team${t}-benchrows` }, team.bench.map((_, place) => benchBox(place)), addBench);
  benchBlock.hidden = !draft.open.bench[t];
  addBench.addEventListener('click', () => {
    team.bench.push('');
    const box = benchBox(team.bench.length - 1);
    addBench.before(box);
    changed();
    box.querySelector('input').focus();
  });
  benchButton.addEventListener('click', () => {
    draft.open.bench[t] = !draft.open.bench[t];
    benchBlock.hidden = !draft.open.bench[t];
    benchButton.setAttribute('aria-expanded', String(draft.open.bench[t]));
    changed();
    if (draft.open.bench[t]) benchBlock.querySelector('input')?.focus();
  });

  return h('div', { class: 'card tcard' }, h('h2', {}, `${side} team`),
    h('div', { class: 'trow' }, gutter(''), name, benchButton), seatRows, warning, marks.line, benchBlock);
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
// boxes, trimmed, with the empty boxes left out. No captain is asked for since 1.9.0, so none is recorded.
export function teamsFromDraft(draft) {
  return draft.teams.map((team, t) => {
    const seats = team.seats.map(name => name.trim());
    const typed = seats.some(Boolean);
    return {
      name: team.name.trim() || `Team ${SIDE[t]}`,
      seats: typed ? seats : [1, 2, 3, 4].map(n => `${SIDE[t]}${n}`),
      bench: (team.bench ?? []).map(name => name.trim()).filter(Boolean),
      captain: null,
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

  // Picking another format replaces the rules, and nothing else: names and details stay. Rules that were edited are asked about
  // first; Cancel puts the dropdown back. Once switched, the rules are the format's again, so the next arrow-key step does not ask.
  const format = formatSelect(draft, async id => {
    if (formatSwitchAsks(draft)) {
      const choice = await api.ask({
        title: 'Switch format?', body: 'Switching format replaces the rules you changed.',
        buttons: [{ label: 'Switch format', value: 'switch', primary: true }, { label: 'Cancel', value: 'cancel' }],
      });
      if (choice !== 'switch') { format.value = draft.presetId; return; }
    }
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
  // The phone keyboard's Enter key says Next in every name box but the last, where it says Done.
  const keyLabels = () => form.querySelectorAll('.tcard input').forEach(box => box.setAttribute('enterkeyhint', nextBox(draft, box.id) === null ? 'done' : 'next'));
  const form = h('form', { novalidate: true, autocomplete: 'off' },
    summary,
    h('div', { class: 'grid2 tcards' }, teamCard(draft, 0, rosterId, () => keyLabels()), teamCard(draft, 1, rosterId, () => keyLabels())),
    detailsSection,
    h('div', { class: 'startbar' }, start),
    h('p', { class: 'hint', id: 'setup-hint' }, 'Names are saved on this device for next time. A team with no names gets seats A1 to A4 (B1 to B4).'));

  // Only the Start button starts a match. The form never submits, so Enter or a phone keyboard's
  // Go key in a rule or details box does nothing, and a half-typed form cannot start by accident. In a name box Enter moves to
  // the next name box (review change 19, Tom's decision 17); in the last it only closes a phone's keyboard. A key that finishes
  // an accent or a character being composed is left alone.
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('keydown', event => {
    const box = event.target;
    // keyCode 229: Safari ends the composition before the Enter that picks a Japanese or Chinese candidate, so isComposing is false.
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || !(box instanceof HTMLInputElement) || !box.closest('.tcard')) return;
    event.preventDefault();
    const next = nextBox(draft, box.id);
    if (next) document.getElementById(next)?.focus();
    else box.blur();
  });
  keyLabels();
  // With a mouse, the first name box is ready for typing when New match opens (app.js focuses it in place of the heading).
  if (globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches) form.querySelector('#team0-name')?.setAttribute('data-autofocus', '');

  const back = h('button', { type: 'button', class: 'btn small', onclick: () => api.go('home') }, 'Home');
  root.append(
    h('div', { class: 'top setuptop' }, h('h1', { tabindex: '-1' }, 'New match'),
      h('div', { class: 'fmt' }, format, rulesButton, detailsButton), h('div', { class: 'acts' }, back)),
    form, roster);
}
