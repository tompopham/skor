// Packet mode's text (Skor 1.14.0, SPEC-partB section 5), no screen code: a packet file read and checked, a question's
// words under buzzpoints.org's word rule, the pieces the reading pane shows, and sentences. Pure functions, so the
// tests run them in Node.
//
// The word rule (SPEC-partB 5.3) is buzzpoints.org's, since the site splits the packet into words itself and reads each
// buzz's word_index against its own list (buzzpoints-multi api/_lib/aggregate.ts `tokenize`, read 5 and 20 Nov 2026,
// written here from that description): every tag comes out with no space left in its place; entities are decoded, a
// non-breaking space becoming a space; three kinds of span are marked, a pronunciation guide (a bracket opened with a
// straight or curly quote, to the first closing bracket), a reader direction ((pause), (emphasize), (emphasise), (read
// slowly), in round or square brackets, any case) and the power mark (*); the text splits on whitespace; a token whose
// first character is marked is not a word, and any other token is a word without its marked characters. Words count from
// 0, and the slot after the last word, the word count, is "end of question". MODAQ agrees in every format with powers
// (checked on its 1,725 buzzes in the 72 Deep Bench games: test/packet-text.test.mjs).
//
// Packet text is shown as text (SPEC-partB 5.4): a short allow list of tags sets bold, underline, italics, sub and sup,
// <br> breaks a line, and every other tag is shown as plain text with its attributes dropped. Nothing here returns HTML:
// the pane builds every piece with textContent, never innerHTML.

// ---- Tags and entities ------------------------------------------------------------------------------------------------

// The allow list: each tag and the formatting it sets. MODAQ's <req> marks a required part of an answer: bold underline.
const ALLOWED = { b: ['b'], strong: ['b'], u: ['u'], i: ['i'], em: ['i'], sub: ['sub'], sup: ['sup'], req: ['b', 'u'] };
const FMT_KEYS = ['b', 'u', 'i', 'sub', 'sup'];
const TAG = /<[^>]+>/g;                                   // as the site removes tags: a literal < ... > goes too
const TAG_NAME = /^<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9]*)/;

// Entities a packet uses. Spaces of every width become a space and the invisible ones vanish, as on the site, since those
// change the words; the rest are the characters a reader sees.
const NAMED = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '',
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
  ndash: '–', mdash: '—', hellip: '…', middot: '·', bull: '•', laquo: '«', raquo: '»',
  deg: '°', times: '×', divide: '÷', minus: '−', copy: '©', reg: '®', trade: '™',
  sect: '§', para: '¶', szlig: 'ß', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ',
};
const MARKS = { acute: '́', grave: '̀', uml: '̈', circ: '̂', tilde: '̃', cedil: '̧', ring: '̊', caron: '̌' };
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi;

function entityText(whole, name) {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
    return code === 0xa0 ? ' ' : String.fromCodePoint(code);
  }
  if (Object.hasOwn(NAMED, name)) return NAMED[name];
  if (Object.hasOwn(NAMED, name.toLowerCase())) return NAMED[name.toLowerCase()];
  const accent = /^([a-z])(acute|grave|uml|circ|tilde|cedil|ring|caron)$/i.exec(name);
  if (accent) return (accent[1] + MARKS[accent[2].toLowerCase()]).normalize('NFC');
  return whole;
}

const fmtOf = counts => Object.freeze(Object.fromEntries(FMT_KEYS.map(key => [key, counts[key] > 0])));

// The text with its tags out and entities decoded, as a list of characters each with its formatting, and the things
// the pane shows between characters: a line break, or a tag outside the allow list shown as text. `events[k]` holds those
// that come before character k.
function plainText(html) {
  const source = typeof html === 'string' ? html : '';
  const counts = Object.fromEntries(FMT_KEYS.map(key => [key, 0]));
  let fmt = fmtOf(counts);
  const stripped = [];                  // { ch, fmt }, tags out, entities not yet decoded
  const events = new Map();
  const addEvent = event => { const list = events.get(stripped.length) ?? []; list.push(event); events.set(stripped.length, list); };
  const addText = text => { for (const ch of text.split('')) stripped.push({ ch, fmt }); };
  let last = 0;
  for (const m of source.matchAll(TAG)) {
    addText(source.slice(last, m.index));
    last = m.index + m[0].length;
    const named = TAG_NAME.exec(m[0]);
    const name = named?.[2].toLowerCase();
    if (name === 'br') { addEvent({ br: true }); continue; }
    if (named && Object.hasOwn(ALLOWED, name)) {
      if (/\/\s*>$/.test(m[0]) && !named[1]) continue;     // <b/> sets nothing
      for (const key of ALLOWED[name]) counts[key] = Math.max(0, counts[key] + (named[1] ? -1 : 1));
      fmt = fmtOf(counts);
      continue;
    }
    // Any other tag is shown as text: its name only, attributes dropped; one that cannot be read is shown as it stands.
    addEvent({ text: named ? `<${named[1] ?? ''}${named[2]}>` : m[0], fmt });
  }
  addText(source.slice(last));

  // Entities decoded over the text with its tags out, as the site does; a decoded character keeps the formatting of
  // its '&', and an event keeps its place.
  const joined = stripped.map(c => c.ch).join('');
  const chars = [];
  const placed = new Map();
  const moveEvents = (from, to) => { for (let k = from; k < to; k++) if (events.has(k)) placed.set(chars.length, [...(placed.get(chars.length) ?? []), ...events.get(k)]); };
  let at = 0;
  for (const m of joined.matchAll(ENTITY)) {
    for (; at < m.index; at++) { moveEvents(at, at + 1); chars.push(stripped[at]); }
    moveEvents(at, m.index + m[0].length);
    for (const ch of entityText(m[0], m[1]).split('')) chars.push({ ch, fmt: stripped[at].fmt });
    at = m.index + m[0].length;
  }
  for (; at < stripped.length; at++) { moveEvents(at, at + 1); chars.push(stripped[at]); }
  moveEvents(stripped.length, stripped.length + 1);
  for (const c of chars) if (c.ch === ' ') c.ch = ' ';
  return { chars, events: placed };
}

// ---- Words --------------------------------------------------------------------------------------------------------------

const GUIDE = /\([“"][^)]*\)/g;
const DIRECTION = /[([](?:emphasi[sz]e|pause|read slowly)[)\]]/gi;
const POWER = /\(\*\)/g;
const SKIP = 1, POWER_MARK = 2;

// A question's words under the site's rule, the end-of-question slot (its word count), the last word before the power
// mark (null with none), and the pieces the reading pane shows: { text, fmt, word, kind } with `word` the index of the
// word the piece belongs to (null for a space, a dropped guide or direction, the power mark or a tag shown as text) and
// `kind` one of 'word', 'space', 'skip', 'power', 'tag'; and { br: true } for a line break.
export function readQuestion(html) {
  const { chars, events } = plainText(html);
  const text = chars.map(c => c.ch).join('');
  const mark = new Uint8Array(text.length);
  for (const [re, kind] of [[GUIDE, SKIP], [DIRECTION, SKIP], [POWER, POWER_MARK]]) {
    for (const m of text.matchAll(re)) mark.fill(kind, m.index, m.index + m[0].length);
  }
  const words = [];
  const wordOf = new Array(text.length).fill(null);
  const kindOf = new Array(text.length).fill('space');
  let powerAfter = null;
  let powerSeen = false;
  for (const m of text.matchAll(/\S+/g)) {
    const start = m.index, end = start + m[0].length;
    if (!powerSeen && /\(\*\)/.test(m[0])) { powerSeen = true; powerAfter = words.length - 1 >= 0 ? words.length - 1 : null; }
    if (mark[start]) {
      for (let k = start; k < end; k++) kindOf[k] = mark[start] === POWER_MARK || mark[k] === POWER_MARK ? 'power' : 'skip';
      continue;
    }
    let spoken = '';
    for (let k = start; k < end; k++) if (!mark[k]) spoken += text[k];
    if (spoken.trim() === '') continue;
    for (let k = start; k < end; k++) {
      if (mark[k]) kindOf[k] = mark[k] === POWER_MARK ? 'power' : 'skip';
      else { kindOf[k] = 'word'; wordOf[k] = words.length; }
    }
    words.push(spoken.trim());
  }

  const pieces = [];
  const pushEvents = k => {
    for (const event of events.get(k) ?? []) pieces.push(event.br ? { br: true } : { text: event.text, fmt: event.fmt, word: null, kind: 'tag' });
  };
  for (let k = 0; k < chars.length; k++) {
    pushEvents(k);
    const last = pieces.at(-1);
    const { ch, fmt } = chars[k];
    if (last && !last.br && last.kind !== 'tag' && last.fmt === fmt && last.word === wordOf[k] && last.kind === kindOf[k]) last.text += ch;
    else pieces.push({ text: ch, fmt, word: wordOf[k], kind: kindOf[k] });
  }
  pushEvents(chars.length);
  return { words, end: words.length, powerAfter, pieces };
}

export const packetWords = html => readQuestion(html).words;

// Formatted text with no words: an answer line, a bonus lead-in or part. { text, fmt } pieces, and { br: true }.
export function formatPieces(html) {
  const { chars, events } = plainText(html);
  const pieces = [];
  const pushEvents = k => { for (const event of events.get(k) ?? []) pieces.push(event.br ? { br: true } : { text: event.text, fmt: event.fmt }); };
  for (let k = 0; k < chars.length; k++) {
    pushEvents(k);
    const last = pieces.at(-1);
    if (last && !last.br && last.fmt === chars[k].fmt) last.text += chars[k].ch;
    else pieces.push({ text: chars[k].ch, fmt: chars[k].fmt });
  }
  pushEvents(chars.length);
  return pieces;
}

// ---- Sentences ---------------------------------------------------------------------------------------------------------

// A word ends a sentence when, without closing quotes and brackets, it ends in . ? or !, unless it is an initial (one
// letter that is not a Roman numeral), an initialism (U.S.) or a common abbreviation. Best effort: ↑ and ↓ move the
// marker by these sentences, and the Buzz points CSV names the clue sentence a buzz came in.
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'vs', 'etc', 'no', 'mt', 'ft', 'gen', 'col', 'rev', 'prof', 'capt', 'lt', 'gov', 'fig', 'ca', 'inc', 'ltd', 'co']);
function endsSentence(word) {
  const bare = word.replace(/[)"”’'\]]+$/, '');
  if (!/[.?!]$/.test(bare)) return false;
  if (/(?:[A-Za-z]\.){2,}$/.test(bare)) return false;
  const core = bare.replace(/[.?!]+$/, '');
  if (/^[A-Za-z]$/.test(core) && !/^[IVXLCDM]$/i.test(core)) return false;
  return !ABBREVIATIONS.has(core.toLowerCase());
}

// The sentence holding word `index` (the end slot belongs to the last): its first and last word.
export function sentenceAt(words, index) {
  if (words.length === 0) return { start: 0, end: -1 };
  const at = Math.max(0, Math.min(index, words.length - 1));
  let start = at;
  while (start > 0 && !endsSentence(words[start - 1])) start -= 1;
  let end = at;
  while (end < words.length - 1 && !endsSentence(words[end])) end += 1;
  return { start, end };
}

// ---- The packet file -----------------------------------------------------------------------------------------------------

export const PACKET_LIMITS = { tossups: 100, bonuses: 100, chars: 500_000 };

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string';
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NOT_PACKET = 'This file is not a packet: it has no list of tossups.';

function packetName(value, fileName) {
  if (isText(value.name) && value.name.trim()) return value.name.trim();
  const set = value.packet?.set?.name;
  if (isText(set) && set.trim() && value.packet?.number != null) return `${set.trim()} packet ${value.packet.number}`;
  const stem = isText(fileName) ? fileName.replace(/\.(json|qbj|docx|txt)$/i, '').trim() : '';
  return stem || 'Packet';
}

function readTossup(t, number) {
  if (!isObject(t) || !isText(t.question) || t.question.trim() === '') throw new Error(`Tossup ${number} has no question text.`);
  if (!isText(t.answer)) throw new Error(`Tossup ${number} has no answer line.`);
  return { question: t.question, answer: t.answer, metadata: isText(t.metadata) ? t.metadata : '' };
}

function readBonus(b, number) {
  if (!isObject(b)) throw new Error(`Bonus ${number} is not a bonus.`);
  const parts = Array.isArray(b.parts) ? b.parts : [];
  if (parts.length === 0) throw new Error(`Bonus ${number} has no parts.`);
  parts.forEach((p, k) => { if (!isText(p)) throw new Error(`Bonus ${number} part ${k + 1} has no text.`); });
  const answers = Array.isArray(b.answers) ? b.answers : [];
  if (answers.length !== parts.length) throw new Error(`Bonus ${number} has ${parts.length} parts but ${answers.length} answers.`);
  answers.forEach((a, k) => { if (!isText(a)) throw new Error(`Bonus ${number} answer ${k + 1} has no text.`); });
  let values = parts.map(() => 10);                       // qbreader's own fallback
  if (b.values !== undefined && b.values !== null) {
    if (!Array.isArray(b.values) || b.values.length !== parts.length) throw new Error(`Bonus ${number} has ${parts.length} parts but ${Array.isArray(b.values) ? b.values.length : 0} values.`);
    if (!b.values.every(v => typeof v === 'number' && Number.isFinite(v))) throw new Error(`Bonus ${number} has a part value that is not a number.`);
    values = [...b.values];
  }
  const modifiers = Array.isArray(b.difficultyModifiers) && b.difficultyModifiers.length === parts.length && b.difficultyModifiers.every(isText)
    ? [...b.difficultyModifiers] : null;
  return { leadin: isText(b.leadin) ? b.leadin : '', parts: [...parts], answers: [...answers], values, difficultyModifiers: modifiers, metadata: isText(b.metadata) ? b.metadata : '' };
}

// A packet from a parsed file or a qbreader answer (MODAQ's shape: tossups with question, answer and metadata; bonuses
// with leadin, parts, answers, values, difficultyModifiers and metadata; qbreader's modaq=true adds `packet` with the set
// name and number). Returns { ok: true, packet, summary } with only those fields kept, or { ok: false, message }.
export function readPacket(value, { fileName } = {}) {
  try {
    if (!isObject(value) || !Array.isArray(value.tossups)) throw new Error(NOT_PACKET);
    if (value.tossups.length === 0) throw new Error('This packet has no tossups.');
    if (value.tossups.length > PACKET_LIMITS.tossups) throw new Error(`This file has more than ${PACKET_LIMITS.tossups} tossups, so it is not one packet.`);
    const rawBonuses = value.bonuses ?? [];
    if (!Array.isArray(rawBonuses)) throw new Error('The bonuses in this packet are not a list.');
    if (rawBonuses.length > PACKET_LIMITS.bonuses) throw new Error(`This file has more than ${PACKET_LIMITS.bonuses} bonuses, so it is not one packet.`);
    if (JSON.stringify([value.tossups, rawBonuses]).length > PACKET_LIMITS.chars) throw new Error('This packet is too big to be one packet.');
    const tossups = value.tossups.map((t, k) => readTossup(t, k + 1));
    const bonuses = rawBonuses.map((b, k) => readBonus(b, k + 1));
    const set = value.packet?.set?.name;
    const number = Number(value.packet?.number);
    const packet = {
      name: packetName(value, fileName),
      setName: isText(set) && set.trim() ? set.trim() : null,
      packetNumber: Number.isInteger(number) && number > 0 ? number : null,
      tossups, bonuses,
    };
    return { ok: true, packet, summary: `${packet.name} has ${plural(tossups.length, 'tossup', 'tossups')} and ${plural(bonuses.length, 'bonus', 'bonuses')}` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}
