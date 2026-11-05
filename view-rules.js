// The Rules screen (review 19/10/2026, change 13; SPEC-v2 9, Tom's decision 7): one screen for the rules, reached from
// New match (Rules) and from the scoring screen's menu (Edit rules). Its header stays at the top with the title and its
// buttons: Cancel and Review changes for a match being scored, Reset to this format and Done on New match. Below 900 px wide
// or 700 px tall the four groups of rules are chips (Starters, Bonuses or Trivia, Length, Clock), one group showing at a
// time; the others are only hidden, so what was typed in them stays. On a laptop all four show, two by two. Review changes
// is greyed until a rule differs, and its question lists the rules that changed before the scores that would.
// Also here: every rule as an input (rulesPanel, moved from view-setup.js), and the changed rules in words (pure, tested).

import { ruleChangeDiff } from './engine.js';
import { rulesFromPreset, presetUnverified } from './presets.js';
import { defaultClockRules } from './clock.js';
import { h } from './dom.js';
import { ensureStyles, fmt, refusalText } from './view-common.js';

// ---- Style -----------------------------------------------------------------------------------

const CSS = `
#rules-screen { display: grid; gap: 8px; min-width: 0; }
.rshead { position: sticky; top: 0; z-index: 3; background: var(--bg); border-bottom: 1px solid var(--line); padding: 4px 0 6px; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "title acts" "chips chips"; gap: 6px 8px; align-items: center; }
.rshead h1 { grid-area: title; font-size: 18px; margin: 0; min-width: 0; overflow-wrap: anywhere; }
.rshead .acts { grid-area: acts; display: flex; gap: 4px; }
.rshead .rchips { grid-area: chips; min-width: 0; }
.rshead .rchip { flex: 1 1 0; min-width: 0; padding: 6px 4px; }
@media (min-width: 640px) {
  .rshead { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-areas: "title chips acts"; }
  .rshead .rchip { flex: 0 1 auto; padding: 6px 12px; }
}
#rules-source { font-size: 13px; margin: 0; overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; cursor: pointer; }
#rules-source.open { display: block; }
#rules-screen .inner { display: grid; gap: 8px; }
#rules-screen .group { border: 1px solid var(--line); padding: 8px 10px 10px; align-content: start; }
#rules-screen .group + .group { border-top: 1px solid var(--line); padding-top: 8px; }
@media (max-width: 899px), (max-height: 699px) {
  #rules-screen .group[hidden] { display: none; }
}
@media (min-width: 900px) and (min-height: 700px) {
  .rshead .rchips { display: none; }
  .rshead { grid-template-areas: "title acts acts"; }
  #rules-screen .inner { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
`;

// ---- Rule inputs (moved from view-setup.js for version 1.6.0) -------------------------------------

const getAt = (object, path) => path.split('.').reduce((o, key) => o?.[key], object);
function setAt(object, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, key) => o[key], object)[last] = value;
}


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

// A group of the rules, keyed for the Rules screen's chips (Starters, Bonuses, Length, Clock, Trivia).
const group = (key, title, ...fields) => h('section', { class: 'group', 'data-group': key }, h('h3', {}, title), h('div', { class: 'grid2' }, fields));

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

  return group('clock', 'Clock and timeouts',
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
  panels.push(group('starters', 'Starters',
    numberField(rules, 'Starter value', 'tossup.ten', { min: 1, max: 100 }),
    optionalNumber(rules, 'Powers', 'tossup.power', 15, { min: 1, max: 100 }),
    numberField(rules, 'Neg: first team, wrong interruption', 'tossup.neg', { neg: true, max: 100 }),
    numberField(rules, 'Neg: second team, wrong interruption', 'tossup.secondNeg', { neg: true, max: 100 }),
    checkField(rules, 'Picture and music starters', 'starterTypes.on', typesOff),
    h('label', { class: 'f' }, h('span', {}, 'Music starter neg'), musicNeg),
    h('label', { class: 'f' }, h('span', {}, 'Picture starter neg'), pictureNeg)));

  if (!rules.trivia) {
    panels.push(group('bonuses', 'Bonuses',
      numberField(rules, 'Parts in a bonus', 'bonus.parts', { min: 1, max: 6 }),
      numberField(rules, 'Points a part', 'bonus.partValue', { min: 1, max: 100 }),
      checkField(rules, 'Pass rest allowed', 'bonus.passRest'),
      bounceField(rules),
      numberField(rules, 'Sweep reward (all parts got)', 'bonus.reward', { max: 100 }),
      selectField(rules, 'Bonus numbering', 'bonus.numbering', [['nextUnused', 'Next unused'], ['paired', 'Paired with the starter']]),
      checkField(rules, 'Held bonus sets for dead picture and music starters', 'bonus.heldSets')));
  }

  panels.push(group('length', 'Length of the match',
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
    panels.push(h('section', { class: 'group', 'data-group': 'trivia' }, h('h3', {}, 'Trivia formats'), jackpot,
      h('div', { class: 'grid2' },
        optionalNumber(rules, 'Streak (points an answer)', 'trivia.streak', 5, { min: 1, max: 100 }),
        selectField(rules, 'A short team under Jailbreak', 'trivia.shortJail', [['brick', 'Brick'], ['noAdvantage', 'No Advantage']]),
        numberField(rules, 'Quarters', 'trivia.quarters', { min: 1, max: 8 })),
      h('p', { class: 'hint' }, 'Brick: a short team never breaks jail. No Advantage: it breaks jail only as often as its opponents.')));
  }

  return h('div', { class: 'inner' }, panels);
}

// ---- The rules that changed, in words --------------------------------------------------------

const onOff = value => (value ? 'on' : 'off');
const orOff = value => (value === null || value === undefined ? 'off' : fmt(value));
const named = names => value => names[value] ?? String(value);
// Every rule the screen shows, in its order: where it is kept, what it is called on the screen, and how its value reads.
const RULE_WORDS = [
  ['tossup.ten', 'Starter value', fmt],
  ['tossup.power', 'Powers', orOff],
  ['tossup.neg', 'Neg: first team, wrong interruption', fmt],
  ['tossup.secondNeg', 'Neg: second team, wrong interruption', fmt],
  ['starterTypes.on', 'Picture and music starters', onOff],
  ['starterTypes.musicNeg', 'Music starter neg', fmt],
  ['starterTypes.pictureNeg', 'Picture starter neg', fmt],
  ['bonus.parts', 'Parts in a bonus', fmt],
  ['bonus.partValue', 'Points a part', fmt],
  ['bonus.passRest', 'Pass rest allowed', onOff],
  ['bonus.bounce', 'Bounce-backs', value => (value === null ? 'off' : value === 'same' ? 'same value as a part' : fmt(value))],
  ['bonus.reward', 'Sweep reward (all parts got)', fmt],
  ['bonus.numbering', 'Bonus numbering', named({ nextUnused: 'next unused', paired: 'paired with the starter' })],
  ['bonus.heldSets', 'Held bonus sets for dead picture and music starters', onOff],
  ['regulation.length', 'Fixed length', orOff],
  ['regulation.unit', 'Length counts', named({ cycles: 'starters (cycles)', bonusRounds: 'bonus rounds' })],
  ['regulation.halftimeAfter', 'Halftime after', orOff],
  ['lightningAfter', 'Lightning round after (bonus rounds)', orOff],
  ['overtime', 'Overtime', named({ suddenDeath: 'sudden death', threeThenSuddenDeath: 'three starters, then sudden death', none: 'none: a tie stands' })],
  ['atTime', 'When time is called', named({ finishCycle: 'finish the cycle', stopNow: 'stop at once', buzzMayAnswer: 'a buzz already in may answer' })],
  ['etLabel', 'Mark overtime results (ET)', onOff],
  ['clock.countdown', 'Countdown', value => (value ? `${value.length % 60 === 0 ? value.length / 60 : (value.length / 60).toFixed(1)} minutes a ${value.per}` : 'off')],
  ['clock.timeoutsPerTeam', 'Timeouts a team', value => (value === null ? 'no limit' : fmt(value))],
  ['clock.timeoutSeconds', 'Timeout length (seconds)', fmt],
  ['trivia.jackpot', 'Jackpot clues', value => value.join(', ')],
  ['trivia.streak', 'Streak (points an answer)', orOff],
  ['trivia.shortJail', 'A short team under Jailbreak', named({ brick: 'Brick', noAdvantage: 'No Advantage' })],
  ['trivia.quarters', 'Quarters', fmt],
];

// A record from before version 2 has no clock rules; the screen fills in the defaults, which is not a change.
const withClock = rules => ({ ...rules, clock: { ...defaultClockRules(), ...rules.clock } });
const stable = value => JSON.stringify(value, (key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

// Whether `after` differs from `before` in anything at all.
export const rulesDiffer = (before, after) => stable(withClock(before)) !== stable(withClock(after));

// The rules that differ, as "Halftime after: 10 to 99", in the screen's order.
export function ruleChangeLines(before, after) {
  const [a, b] = [withClock(before), withClock(after)];
  return RULE_WORDS.flatMap(([path, label, words]) => {
    const [x, y] = [getAt(a, path), getAt(b, path)];
    if (stable(x) === stable(y) || x === undefined || y === undefined) return [];
    return [`${label}: ${words(x)} to ${words(y)}`];
  });
}

// ---- The screen ------------------------------------------------------------------------------

const CHIPS = { starters: 'Starters', bonuses: 'Bonuses', length: 'Length', clock: 'Clock', trivia: 'Trivia' };

// The format and where its rules come from, cut to two lines; a tap shows all of it.
function sourceLine(rules) {
  const line = h('p', { class: 'hint', id: 'rules-source', title: `${rules.name}: ${rules.source}` }, `${rules.name}: ${rules.source}`,
    presetUnverified({ verified: rules.verified, source: rules.source ?? '' }) ? h('span', { class: 'tag' }, 'Unverified') : null);
  line.tabIndex = 0;
  line.addEventListener('click', () => line.classList.toggle('open'));
  line.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); line.classList.toggle('open'); }
  });
  return line;
}

// Draws the Rules screen over the scoring screen (Edit rules, state.ui.sub on 'score') or over New match (state.ui.sub on
// 'setup'). On New match the rules edited are the draft's own, as they were in the folded panel; on a match being scored
// they are a copy, applied only through Review changes.
export function renderRulesScreen(root, state, api) {
  ensureStyles('rules-style', CSS);
  const sub = state.ui.sub;
  const onSetup = state.screen === 'setup';
  const draft = state.ui.setup;
  const rules = onSetup ? draft.rules : (sub.draft ??= structuredClone(state.match.rules));

  const panel = rulesPanel(rules);
  const groups = [...panel.querySelectorAll('.group')];
  const keys = groups.map(section => section.dataset.group);
  if (!keys.includes(sub.group)) sub.group = keys[0];
  const chips = keys.map(key => h('button', { type: 'button', class: 'chip rchip', 'data-group': key, onclick: () => showGroup(key) }, CHIPS[key] ?? key));
  function showGroup(key) {
    sub.group = key;
    groups.forEach(section => { section.hidden = section.dataset.group !== key; });
    chips.forEach(chip => chip.setAttribute('aria-pressed', String(chip.dataset.group === key)));
    chips.forEach(chip => chip.classList.toggle('on', chip.dataset.group === key));
  }
  showGroup(sub.group);

  let acts;
  if (onSetup) {
    const reset = () => {
      draft.rules = rulesFromPreset(draft.presetId);
      api.setUi({});
    };
    acts = [h('button', { type: 'button', class: 'btn small', id: 'rules-reset', onclick: reset }, 'Reset to this format'),
      h('button', { type: 'button', class: 'btn small primary', id: 'rules-done', onclick: () => { api.setUi({ sub: null }); window.scrollTo(0, 0); } }, 'Done')];
  } else {
    const { match } = state;
    const reviewButton = h('button', { type: 'button', class: 'btn small primary', id: 'rules-review', disabled: !rulesDiffer(match.rules, rules) }, 'Review changes');
    const recheck = () => { reviewButton.disabled = !rulesDiffer(match.rules, rules); };
    panel.addEventListener('input', recheck);
    panel.addEventListener('change', recheck);
    reviewButton.addEventListener('click', async () => {
      let diff;
      try {
        diff = ruleChangeDiff(match, rules);
      } catch (error) {
        api.setUi({ msg: refusalText(error) });
        return;
      }
      const body = [
        ...ruleChangeLines(match.rules, rules).map(line => h('p', { class: 'dtext' }, h('b', {}, line))),
        ...(diff.length === 0 ? ['No score changes.']
          : ['These scores change:', ...diff.map(entry => h('p', { class: 'dtext' }, h('b', {}, `${entry.label} ${fmt(entry.before)} to ${fmt(entry.after)}`)))]),
        'The format and the questions already scored stay.',
      ];
      const choice = await api.ask({
        title: 'Apply these rules?', body,
        buttons: [{ label: 'Apply rules', value: 'apply', primary: true }, { label: 'Keep editing', value: 'cancel' }],
      });
      if (choice === 'apply') {
        const result = api.dispatch({ type: 'setRules', rules }, { sub: null });
        if (!result.ok) api.setUi({ msg: refusalText(result.error) });
      }
    });
    acts = [h('button', { type: 'button', class: 'btn small', id: 'rules-cancel', onclick: () => api.closeSub() }, 'Cancel'), reviewButton];
  }

  root.append(h('div', { id: 'rules-screen' },
    h('div', { class: 'rshead' }, h('h1', { tabindex: '-1' }, onSetup ? 'Rules' : 'Edit rules'),
      h('div', { class: 'chips rchips', role: 'group', 'aria-label': 'Which rules' }, chips), h('div', { class: 'acts' }, acts)),
    onSetup ? sourceLine(rules) : null,
    !onSetup && state.ui.msg ? h('p', { class: 'msg' }, state.ui.msg) : null,
    panel));
}
