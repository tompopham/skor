// Win percentage on the screens (SPEC-partB.md 2.3, version 1.10.0): Menu, More, Win % (load or remove the ratings
// file, and the two ticks); the slot beside each score on the scoring screen, where the favourite's says "Win 62%"; the
// line under the scores on the room board; the line of chances on the scoresheet; and the "not rated" marks on Setup.
// The sums are winprob.js's. With no file loaded, or the tick off, every screen is drawn exactly as before 1.10.0.
// Only team chances are ever shown, never a player's rating.

import { h } from './dom.js';
import { derive } from './engine.js';
import { loadSettings, saveSettings, loadRatingsText, saveRatingsText, removeRatingsText } from './storage.js';
import { readRatings, lookUp, matchChance, chanceLine, favourite, unsupported } from './winprob.js';
import { fmt, teamName, leftRight, check } from './view-common.js';

// ---- The file and the ticks ----------------------------------------------------------------------

// The file as read, kept while the saved text is unchanged. A saved text that no longer reads (damaged on the device)
// counts as no file, and Win % says so.
let cache = { text: null, ratings: null, message: '' };
export function ratingsNow() {
  const text = loadRatingsText();
  if (text !== cache.text) {
    const read = text === null ? { ok: false, message: '' } : readRatings(text);
    cache = { text, ratings: read.ok ? read.ratings : null, message: read.ok ? '' : read.message };
  }
  return cache.ratings;
}

// "Show on this screen" is on and "Show on the room board" off until changed (Tom, 5 Nov 2026, W1).
const ticks = () => {
  const settings = loadSettings();
  return { screen: settings.winScreen !== false, board: settings.winBoard === true };
};

// The ratings, when the chance is to be shown for this match on `where` ('screen' or 'board'), else null.
function shownFor(match, where) {
  const ratings = ratingsNow();
  return ratings && ticks()[where] && !unsupported(match.rules) ? ratings : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const madeText = made => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(made);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : made;
};
export const fileLine = ratings => `${ratings.count.toLocaleString('en-GB')} players, made ${madeText(ratings.made)}`;
// The Win % button's second line in More: the file's date, or null with no file.
export const winMenuLine = () => { const ratings = ratingsNow(); return ratings ? `made ${madeText(ratings.made)}` : null; };

// ---- The scoring screen ------------------------------------------------------------------------

// A team's score, and beside it, with the file loaded and the tick on, a slot of fixed width: the favourite's says
// "Win 62%" (both say "Win 50%" when level), the other's is empty, so nothing moves as the chance changes.
// The sum runs once per drawing of the screen (c is made afresh for each), and anything it cannot read draws the
// score alone, as without the file.
export function scoreHead(c, team) {
  const score = h('div', { class: 'score', 'data-score': team }, fmt(c.d.scores[team]));
  const ratings = shownFor(c.match, 'screen');
  if (!ratings) return score;
  if (!('win' in c)) {
    try { c.win = favourite(matchChance(c.match, c.d, ratings, c.api.now())); } catch { c.win = undefined; }
  }
  if (c.win === undefined) return score;
  const fav = c.win;
  const text = fav && (fav.team === team || fav.team === null) ? fav.text : '';
  return h('div', { class: 'scorerow' }, score,
    h('span', { class: 'win', 'data-win': team, 'aria-label': text ? `${teamName(c.match, team)}: ${text} chance to win` : null }, text ? `Win ${text}` : ''));
}

// ---- The room board ------------------------------------------------------------------------------

// The board's line under the scores: "Edinburgh A 62% to win", or null when it is not to be shown (no file, the tick
// off, rules it does not work out). An empty line once the match is over.
export function boardWinText(match) {
  try {
    const ratings = match ? shownFor(match, 'board') : null;
    if (!ratings) return null;
    const fav = favourite(matchChance(match, derive(match), ratings, Date.now()));
    if (!fav) return '';
    return fav.team === null ? 'Level: 50% each to win' : `${teamName(match, fav.team)} ${fav.text} to win`;
  } catch {
    return null;   // a record the board cannot read: no line, and the board carries on as before
  }
}

// ---- The scoresheet --------------------------------------------------------------------------------

// The chance after each question as a black line on white, 0 to 100% with a 50% line, for the team on the left: an
// inline SVG that prints. Nothing (an empty list) without the file or under rules it does not work out.
export function winChart(match, d) {
  try {
    return chartOf(match, d);
  } catch {
    return [];
  }
}

function chartOf(match, d) {
  const ratings = shownFor(match, 'screen');
  if (!ratings) return [];
  const line = chanceLine(match, d, ratings);
  if (line.length < 2) return [];
  const left = leftRight(match)[0];
  const chance = point => (left === 0 ? point.a : point.b);
  const W = 640, H = 200, padL = 44, padR = 8, padT = 10, padB = 26;
  const last = line.at(-1).number || 1;
  const x = n => padL + ((W - padL - padR) * n) / last, y = p => padT + (H - padT - padB) * (1 - p);
  const svg = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  };
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'winchart', role: 'img',
    'aria-label': `Chance ${teamName(match, left)} wins: ${Math.round(100 * chance(line[0]))}% before Q1, ${Math.round(100 * chance(line.at(-1)))}% after Q${line.at(-1).number}` });
  chart.append(svg('rect', { x: 0, y: 0, width: W, height: H, class: 'wc-bg' }));
  for (const p of [0, 0.5, 1]) {
    chart.append(svg('line', { x1: padL, x2: W - padR, y1: y(p), y2: y(p), class: p === 0.5 ? 'wc-mid' : 'wc-edge' }));
    const label = svg('text', { x: padL - 6, y: y(p) + 4, 'text-anchor': 'end', class: 'wc-text' });
    label.textContent = `${100 * p}%`;
    chart.append(label);
  }
  const ticksAt = [0, ...line.map(point => point.number).filter(n => n > 0 && (n % 5 === 0 || n === last))];
  for (const n of new Set(ticksAt)) {
    const label = svg('text', { x: x(n), y: H - 8, 'text-anchor': 'middle', class: 'wc-text' });
    label.textContent = n === 0 ? 'Start' : `Q${n}`;
    chart.append(label);
  }
  chart.append(svg('polyline', { points: line.map(point => `${x(point.number).toFixed(1)},${y(chance(point)).toFixed(1)}`).join(' '), class: 'wc-line' }));
  return [h('section', { class: 'winsheet', id: 'win-chart' },
    h('h2', {}, `Chance ${teamName(match, left)} wins, after each question`),
    chart,
    h('p', { class: 'hint' }, `From the ratings file of ${madeText(ratings.made)}, kept on this device. For fun: team chances only, no player's rating.`))];
}

// ---- Setup ---------------------------------------------------------------------------------------

// For one team card: mark(input) gives the slot beside a name box that says "not rated" when the file does not know the
// name, and `line` says which names two players share (neither is used). Both are null without the file, so the card is
// drawn as before; with it, every box has its slot, so nothing moves as names are typed.
export function ratingMarks() {
  const ratings = ratingsNow();
  if (!ratings) return { mark: () => null, line: null };
  const boxes = [];
  const line = h('p', { class: 'msg', role: 'status' });
  const refresh = () => {
    const shared = new Map();
    for (const { input, slot } of boxes) {
      const found = lookUp(ratings, input.value);
      slot.textContent = found.status === 'unrated' || found.status === 'shared' ? 'not rated' : '';
      if (found.status === 'shared') shared.set(input.value.trim(), found.count);
    }
    line.textContent = [...shared].map(([name, count]) => `${count} players called ${name}: not rated`).join('. ');
  };
  return {
    line,
    mark: input => {
      const slot = h('span', { class: 'unrated', 'aria-live': 'polite' });
      boxes.push({ input, slot });
      input.addEventListener('input', refresh);
      queueMicrotask(refresh);
      return slot;
    },
  };
}

// ---- Menu, More, Win % ---------------------------------------------------------------------------

// Load or remove the file, and the two ticks. The file picker opens inside the Load button's own click handler (iPhone
// Safari's rule), and the dialog is drawn again once a file is in. The screen is drawn again when it closes.
export async function winDialog(api, match) {
  let said = null;
  for (;;) {
    const ratings = ratingsNow();
    const t = ticks();
    const why = match ? unsupported(match.rules) : null;
    const choice = await api.ask({
      title: 'Win %',
      body: finish => {
        const note = h('p', { class: said?.bad ? 'msg' : 'hint', id: 'win-msg', role: 'status' }, said?.text ?? '');
        const say = (text, bad = false) => { said = { text, bad }; note.textContent = text; note.className = bad ? 'msg' : 'hint'; };
        const load = h('button', { type: 'button', class: ratings ? 'btn' : 'btn primary', id: 'win-load', onclick: () => pickFile(say, () => finish('loaded')) },
          ratings ? 'Load another file' : 'Load ratings file');
        const setTick = key => on => saveSettings({ ...loadSettings(), [key]: on });
        return ratings ? [
          h('p', { class: 'dtext', id: 'win-file' }, fileLine(ratings)),
          check('Show on this screen', t.screen, setTick('winScreen'), { id: 'win-screen' }),
          check('Show on the room board', t.board, setTick('winBoard'), { id: 'win-board' }),
          h('p', { class: 'hint' }, 'Each team\'s chance of winning, from the buzzpoint ratings. For fun: only team chances show, never a player\'s rating. Not checked for University Challenge, where no team has a rating from UC play.'),
          why ? h('p', { class: 'hint', id: 'win-rules' }, `This match: ${why}`) : null,
          load, note,
        ] : [
          h('p', { class: 'dtext', id: 'win-none' }, 'Win % needs a ratings file from Tom\'s Buzzpoints folder.'),
          cache.message ? h('p', { class: 'msg' }, `The file saved here could not be read: ${cache.message}`) : null,
          load, note,
        ];
      },
      buttons: [...(ratings ? [{ label: 'Remove file', value: 'remove' }] : []), { label: 'Close', value: 'cancel' }],
    });
    if (choice === 'remove') {
      const sure = await api.ask({ title: 'Remove the ratings file?', body: ['Win % stops showing on this device until a file is loaded again. Your matches are not touched.'], buttons: [{ label: 'Remove', value: 'yes', primary: true }, { label: 'Cancel', value: 'cancel' }] });
      if (sure === 'yes') {
        const done = removeRatingsText();
        said = done.ok ? { text: 'Ratings file removed.', bad: false } : { text: `It could not be removed: ${done.error}`, bad: true };
      }
      continue;
    }
    if (choice === 'loaded') continue;
    api.setUi({});
    return;
  }
}

// Opens the file picker and saves the file chosen, if it reads; then `done`.
function pickFile(say, done) {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { say(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB, too large to be a ratings file.`, true); return; }
    let text;
    try {
      text = await file.text();
    } catch {
      say(`${file.name} could not be read. If it is in iCloud, open it in Files once so it downloads, then load it again.`, true);
      return;
    }
    const read = readRatings(text);
    if (!read.ok) { say(read.message, true); return; }
    const saved = saveRatingsText(text);
    if (!saved.ok) { say(`It could not be saved on this device: ${saved.error}`, true); return; }
    say(`Loaded: ${fileLine(read.ratings)}.`);
    done();
  });
  document.body.append(input);
  input.click();
}
