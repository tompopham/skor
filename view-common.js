// What the scoring screen and the editors share: how names, scores and refusals are worded, the small
// form controls, and the trivia format list. Nothing here touches the match or the app's state.

import { FORMATS, derive } from './engine.js';
import { h } from './dom.js';

// ---- Words and numbers -----------------------------------------------------------------------

export const MINUS = '\u2212';
export const fmt = number => (number < 0 ? `${MINUS}${-number}` : String(number));
export const teamName = (match, team) => String(match.teams[team].name ?? '').trim() || `Team ${'AB'[team]}`;
export const seatName = (match, team, seat) => String(match.teams[team].seats[seat] ?? '').trim();
export const isCorrect = buzz => buzz.result === 'power' || buzz.result === 'ten';
// A match still being played: one that is there and has not ended. Home offers Resume only for such a match, and Past
// matches tags only it "In progress" (review 19/10/2026, change 10).
export const isLive = match => Boolean(match) && !derive(match).phase.ended;
// The team shown on the left, then the one on the right.
export const leftRight = match => (match.display?.leftTeam === 1 ? [1, 0] : [0, 1]);
// The most answers a Streak turn can be given: the scoring screen's counter and the editor's box stop here.
export const STREAK_MAX = 20;

const FLAG_TEXT = {
  'after-end': 'after the end of the match, so it is not counted',
  jailed: 'a player who is in jail is entered',
  'double-jump-locked': 'a team locked out of this Double Jump is entered',
  'not-on-this-set': 'a player who is not on this Split set is entered',
  'bonus-in-overtime': 'bonus in overtime',
  'replacement-missing': 'replacement not entered',
};
export const flagText = flag => FLAG_TEXT[flag] ?? flag;
// The warning for a typed bonus number that was already played (v2 2.1): `question` is the Q number that first played it.
export const repeatText = (number, question) => `Bonus ${number} was already played at Q${question}`;

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
// The same, worded for the scoring screen's Format box, whose closed text then names itself: "Format: Normal" (review change
// 11), so it needs no label beside it on a phone.
export const formatOptions = rules => triviaFormats(rules).map(([key, label]) => [key, `Format: ${label}`]);

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

// ---- The browser ------------------------------------------------------------------------------

function isStandalone() {
  return navigator.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)').matches === true;
}

// A browser tab on an iPhone or iPad running Safari, not a scorer already added to the home screen. Such a tab keeps its
// saved matches apart from the home-screen Skor's, and Safari clears them after seven days unused.
export function isIosSafariTab() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !isStandalone();
}

// ---- The clipboard ---------------------------------------------------------------------------

// Puts `text` on the clipboard. Where the browser will not take it, `box` (a text box, or any element, showing the same text)
// is brought into view, selected and copied the old way, which still works where the clipboard is shut. Resolves whether it
// worked; when it did not, the box is left showing and selected, for the person to copy by hand.
export async function copyText(text, box = null) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!box) return false;
    box.hidden = false;
    box.focus();
    if (typeof box.select === 'function') { box.select(); box.setSelectionRange?.(0, box.value.length); }   // the iPhone selects a box only by range
    else window.getSelection?.()?.selectAllChildren(box);
    try { return document.execCommand('copy'); } catch { return false; }
  }
}

// ---- Style -----------------------------------------------------------------------------------

// Adds a view's own stylesheet once, the first time the view is drawn. What the shared controls need (a long
// name wrapping rather than pushing a row wider than its card, Review Focus 3) is in index.html.
export function ensureStyles(id, css) {
  if (!document.getElementById(id)) document.head.append(h('style', { id }, css));
}
