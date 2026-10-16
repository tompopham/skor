// What the scoring screen and the editors share: how names, scores and refusals are worded, the small
// form controls, and the trivia format list. Nothing here touches the match or the app's state.

import { FORMATS } from './engine.js';
import { h } from './dom.js';

// ---- Words and numbers -----------------------------------------------------------------------

export const MINUS = '\u2212';
export const fmt = number => (number < 0 ? `${MINUS}${-number}` : String(number));
export const teamName = (match, team) => String(match.teams[team].name ?? '').trim() || `Team ${'AB'[team]}`;
export const seatName = (match, team, seat) => String(match.teams[team].seats[seat] ?? '').trim();
export const isCorrect = buzz => buzz.result === 'power' || buzz.result === 'ten';
// The team shown on the left, then the one on the right.
export const leftRight = match => (match.display?.leftTeam === 1 ? [1, 0] : [0, 1]);
// The most answers a Streak turn can be given: the scoring screen's counter and the editor's box stop here.
export const STREAK_MAX = 20;

const FLAG_TEXT = {
  'after-end': 'after the end of the match, so it is not counted',
  jailed: 'a player who is in jail is entered',
  'double-jump-locked': 'a team locked out of this Double Jump is entered',
  'not-on-this-set': 'a player who is not on this Split set is entered',
};
export const flagText = flag => FLAG_TEXT[flag] ?? flag;

// A refusal as a sentence for the person: the engine's "code: detail" without its code.
export function refusalText(error) {
  const text = String(error?.message ?? error);
  const detail = typeof error?.code === 'string' && text.startsWith(`${error.code}: `) ? text.slice(error.code.length + 2) : text;
  return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}${/[.!?]$/.test(detail) ? '' : '.'}`;
}

// The question formats the rules allow, as [key, label] pairs: every format, less Streak where the
// rules have none (spec 5.1). Only asked under trivia rules.
export const triviaFormats = rules => Object.keys(FORMATS)
  .filter(key => key !== 'streak' || rules.trivia.streak != null)
  .map(key => [key, FORMATS[key]]);

// ---- Small form controls ---------------------------------------------------------------------

export const field = (text, ...controls) => h('label', { class: 'f' }, h('span', {}, text), ...controls);

export function select(options, value, onChange, attrs = {}) {
  const el = h('select', attrs, options.map(([v, text]) => h('option', { value: v }, text)));
  el.value = String(value);
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function check(text, checked, onChange, attrs = {}) {
  const box = h('input', { type: 'checkbox', ...attrs });
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'chk' }, box, h('span', {}, text));
}

// A whole-number box that reports on change (when it is left), with null for an empty box.
export function numberBox(value, onChange, attrs = {}) {
  const input = h('input', { type: 'number', inputmode: 'numeric', step: '1', ...attrs });
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value.trim() === '' ? null : Number(input.value)));
  return input;
}

// ---- Style -----------------------------------------------------------------------------------

// Adds a view's own stylesheet once, the first time the view is drawn. What the shared controls need (a long
// name wrapping rather than pushing a row wider than its card, Review Focus 3) is in index.html.
export function ensureStyles(id, css) {
  if (!document.getElementById(id)) document.head.append(h('style', { id }, css));
}
