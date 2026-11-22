// The reading pane (Skor 1.14.0, SPEC-partB 5.4): in packet mode, in a window at least 1024 px wide, the packet's text sits
// on the left of the scoring screen and the 1.6.0 scoring layout on the right. The reader reads the tossup from it and
// scores in the same window; the word marker records where each buzz came, and scoring never waits for it.
//
// The marker (never required): when a tossup opens it sits on word 0. A click on a word puts it there; ← and → move it a
// word, ↑ and ↓ a sentence (packet.js sentenceAt), End to the end of the question. When a result is entered, the buzz takes
// the marker's word if the marker was moved or clicked at any point during this tossup (spec 5.4; an undo and a re-entry keep
// it); otherwise the buzz has no word (app.js asks wordForBuzz). After a buzz entered with no word, the next click gives that buzz its word (the 'word'
// action) instead of moving the marker for the next buzz. During a bonus the pane shows the bonus, with a line saying where
// the tossup's buzz came and Mark word, which shows the tossup again so a click can give the buzz its word.
// Packet text is built as text nodes from packet.js's pieces, never innerHTML. The room board never shows the pane.

import { h } from './dom.js';
import { formatPieces, sentenceAt } from './packet.js';
import { currentTossup, matchPacket, tossupNumbers, tossupText, wordState } from './packet-match.js';
import { packetWindow } from './view-packet.js';

// Whether the pane shows: a match with a sound packet, in a wide window.
export const paneActive = match => matchPacket(match) !== null && packetWindow();

// The marker for the tossup being read now; a new one at word 0 when the tossup or the match changes.
function markerFor(state, d) {
  const tossup = currentTossup(state.match, d);
  const m = state.ui.marker;
  if (!m || m.matchId !== state.match.id || m.tossup !== tossup) state.ui.marker = { matchId: state.match.id, tossup, word: 0, moved: false, late: false };
  return state.ui.marker;
}

// app.js: the word a buzz being entered takes, or undefined. Only when the pane shows, for the tossup it shows.
export function wordForBuzz(state, d) {
  if (!state.match || !paneActive(state.match)) return undefined;
  const m = markerFor(state, d);
  return m.moved ? m.word : undefined;
}
// app.js, once a buzz is in: `moved` lasts the whole tossup, so it is not reset here; a buzz that took no word (the marker
// never moved on this tossup) waits for a click.
export function buzzEntered(state, gotWord) {
  const m = state.ui.marker;
  if (!m) return;
  m.late = !gotWord && !m.moved;
}

// ---- Drawing ------------------------------------------------------------------------------------------------------------

const FMT_CLASS = { b: 'pb', u: 'pu', i: 'pi', sub: 'psub', sup: 'psup' };
const classesOf = fmt => Object.keys(FMT_CLASS).filter(key => fmt?.[key]).map(key => FMT_CLASS[key]);
// Formatted text with no words (an answer line, a lead-in, a part): spans with the formatting classes, and line breaks.
export function formatted(html, cls) {
  return h('span', { class: cls }, formatPieces(html).map(p => (p.br ? h('br') : classesOf(p.fmt).length ? h('span', { class: classesOf(p.fmt).join(' ') }, p.text) : p.text)));
}

// A question's words as spans, each word with data-word and the end-of-question slot last. `buzzWords` marks where the
// buzzes already entered came ({ word, label }).
export function questionView(question, { marker = null, buzzWords = [], onWord = null } = {}) {
  const spans = question.pieces.map(p => {
    if (p.br) return h('br');
    const cls = [...classesOf(p.fmt), p.kind === 'word' ? 'w' : p.kind === 'power' ? 'pmark' : p.kind === 'skip' ? 'pskip' : p.kind === 'tag' ? 'ptag' : null].filter(Boolean);
    return p.word === null ? (cls.length ? h('span', { class: cls.join(' ') }, p.text) : p.text) : h('span', { class: cls.join(' '), 'data-word': String(p.word) }, p.text);
  });
  const end = h('span', { class: 'w wend', 'data-word': String(question.end), title: 'End of question' }, '■ end');
  const body = h('p', { class: 'ptext', id: 'pane-text' }, spans, ' ', end);
  for (const { word, label } of buzzWords) {
    for (const el of body.querySelectorAll(`[data-word="${word}"]`)) { el.classList.add('wbuzz'); el.setAttribute('data-buzz', label); }
  }
  if (marker !== null) for (const el of body.querySelectorAll(`[data-word="${marker}"]`)) el.classList.add('wmark');
  if (onWord) body.addEventListener('click', event => {
    const word = event.target.closest?.('[data-word]')?.getAttribute('data-word');
    if (word !== undefined && word !== null) onWord(Number(word));
  });
  return body;
}

// The word the marker sits on, shown on the screen without a redraw (nothing else on the screen moves).
let live = null;   // { state, api, end, words, body } for the pane on screen
function showMarker(word) {
  if (!live) return;
  const m = live.state.ui.marker;
  m.word = Math.max(0, Math.min(word, live.end));
  for (const el of live.body.querySelectorAll('.wmark')) el.classList.remove('wmark');
  const marked = [...live.body.querySelectorAll(`[data-word="${m.word}"]`)];
  for (const el of marked) el.classList.add('wmark');
  marked[0]?.scrollIntoView?.({ block: 'nearest' });
  const line = document.getElementById('pane-word');
  if (line) line.textContent = markerLine(live.words, m.word, live.end);
}
const markerLine = (words, word, end) => (word >= end ? 'Marker: end of question' : `Marker: word ${word + 1}, “${words[word]}”`);

// Arrow keys move the marker while the pane shows, unless a box or a dialog has the keys.
function onPaneKey(event) {
  if (!live || !document.body.contains(live.body) || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.dialog'))) return;
  const m = live.state.ui.marker;
  const sentence = sentenceAt(live.words, m.word);
  let to = null;
  if (event.key === 'ArrowRight') to = m.word + 1;
  else if (event.key === 'ArrowLeft') to = m.word - 1;
  else if (event.key === 'ArrowDown') to = m.word >= live.end ? live.end : sentence.end + 1;
  else if (event.key === 'ArrowUp') to = m.word > sentence.start ? sentence.start : sentenceAt(live.words, sentence.start - 1).start;
  else if (event.key === 'End') to = live.end;
  else if (event.key === 'Home') to = 0;
  if (to === null) return;
  event.preventDefault();
  m.moved = true;
  m.late = false;
  showMarker(to);
}
let keysOn = false;

const partMark = mark => ({ got: 'got', missed: 'missed', passed: 'passed', unheard: 'not read' }[mark] ?? '');

// The pane for the scoring screen. `c` is view-score.js's context; `askNumber` its number dialog.
export function renderPane(c, askNumber) {
  if (!keysOn) { document.addEventListener('keydown', onPaneKey); keysOn = true; }
  const { state, api, match, d } = c;
  const packet = matchPacket(match);
  const numbers = tossupNumbers(match, d);
  const openIndex = d.open.cycleId == null ? -1 : match.cycles.findIndex(x => x.id === d.open.cycleId);
  const openCycle = openIndex >= 0 ? match.cycles[openIndex] : null;
  const marker = markerFor(state, d);
  const number = marker.tossup;
  const tossup = packet.tossups[number - 1] ?? null;
  const question = tossupText(match, number);
  live = null;

  const change = h('button', {
    type: 'button', class: 'btn small', id: 'pane-number',
    onclick: async () => {
      const typed = await askNumber(api, { title: 'Tossup number', text: 'The tossup being read, from the packet. The next question goes back to the lowest one not yet read.', initial: number, min: 1, max: 999 });
      if (typed !== undefined && typed !== null) c.act({ type: 'tossupNumber', number: typed }, {});
    },
  }, 'Change');
  if (d.open.stage !== 'bonus') state.ui.paneTossup = false;   // the tossup-again view belongs to one bonus; set directly, no redraw
  const showTossupAgain = state.ui.paneTossup === true && d.open.stage === 'bonus';

  // A bonus: its lead-in, each part with its value, answer and mark, and where the tossup's buzz came.
  if (d.open.stage === 'bonus' && !showTossupAgain) {
    const bonusNumber = d.open.bonus.number;
    const bonus = packet.bonuses[bonusNumber - 1] ?? null;
    const lastBuzz = openCycle?.buzzes.at(-1) ?? null;
    const read = numbers.cycles[openIndex];
    const buzzLine = lastBuzz && read && read.end !== null && question
      ? h('div', { class: 'pbuzzline' },
        h('span', { id: 'pane-buzzline' }, wordState(lastBuzz, read) === 'ok'
          ? `Tossup ${read.read}: buzz on ${lastBuzz.word >= read.end ? 'the end of the question' : `word ${lastBuzz.word + 1}, “${question.words[lastBuzz.word]}”`}.`
          : `Tossup ${read.read}: no word marked.`),
        h('button', { type: 'button', class: 'btn small', id: 'pane-markword', onclick: () => api.setUi({ paneTossup: true }) }, wordState(lastBuzz, read) === 'ok' ? 'Change word' : 'Mark word'))
      : null;
    const parts = bonus ? bonus.parts.map((part, k) => h('li', { class: 'ppart' },
      h('div', { class: 'ppartq' }, h('span', { class: 'pval' }, `[${bonus.values[k]}] `), formatted(part, 'pq')),
      h('div', { class: 'pans' }, h('span', { class: 'plabel' }, 'Answer: '), formatted(bonus.answers[k], 'pa')),
      h('div', { class: 'pmarkline' }, partMark(openCycle?.bonus?.parts?.[k]?.ctrl)))) : [];
    return h('section', { class: 'pane', id: 'pane', 'aria-label': 'Packet' },
      h('div', { class: 'phead' }, h('h2', {}, `Bonus ${bonusNumber}`), h('span', { class: 'pmeta' }, bonus?.metadata ?? '')),
      buzzLine,
      bonus ? h('div', { class: 'pbody' }, h('p', { class: 'ptext' }, formatted(bonus.leadin, 'pq')), h('ol', { class: 'pparts' }, parts))
        : h('p', { class: 'msg' }, `This packet has no bonus ${bonusNumber}.`));
  }

  if (!question) {
    return h('section', { class: 'pane', id: 'pane', 'aria-label': 'Packet' },
      h('div', { class: 'phead' }, h('h2', {}, `Tossup ${number}`), change),
      h('p', { class: 'msg' }, `This packet has no tossup ${number}. Score as usual; the pane comes back with the next tossup in the packet.`));
  }

  // The tossup: its words, the marker, and the buzzes entered so far on it.
  const buzzWords = (openCycle?.buzzes ?? []).flatMap((b, k) => (wordState(b, numbers.cycles[openIndex]) === 'ok' ? [{ word: b.word, label: String(k + 1) }] : []));
  const onWord = word => {
    const cycle = openCycle;
    if (showTossupAgain && cycle) {
      c.act({ type: 'word', cycleId: cycle.id, buzz: 'last', word }, { paneTossup: false });
      return;
    }
    if (marker.late && cycle && cycle.buzzes.length > 0 && wordState(cycle.buzzes.at(-1), numbers.cycles[openIndex]) !== 'ok') {
      marker.late = false;
      marker.moved = true;   // a click is a move of the marker for this tossup (5.4)
      marker.word = word;
      c.act({ type: 'word', cycleId: cycle.id, buzz: 'last', word }, {});
      return;
    }
    marker.moved = true;
    marker.late = false;
    showMarker(word);
  };
  const body = questionView(question, { marker: marker.word, buzzWords, onWord });
  live = { state, api, end: question.end, words: question.words, body };
  return h('section', { class: 'pane', id: 'pane', 'aria-label': 'Packet' },
    h('div', { class: 'phead' }, h('h2', {}, `Tossup ${number}`), h('span', { class: 'pmeta' }, tossup?.metadata ?? ''), change),
    showTossupAgain ? h('p', { class: 'pbuzzline' }, 'Click the word the buzz came on.', h('button', { type: 'button', class: 'btn small', onclick: () => api.setUi({ paneTossup: false }) }, 'Back to the bonus')) : null,
    h('div', { class: 'pbody' }, body, h('p', { class: 'pans' }, h('span', { class: 'plabel' }, 'Answer: '), formatted(tossup.answer, 'pa'))),
    h('p', { class: 'hint pword', id: 'pane-word' }, markerLine(question.words, marker.word, question.end)));
}
