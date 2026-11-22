// Packet mode's record (Skor 1.14.0, SPEC-partB 5.3), no screen code: the packet a match keeps, the tossup each cycle
// reads, and the two actions packet mode adds, marking a buzz's word after the result ('word') and typing a tossup number
// ('tossupNumber'). engine.js lists the actions and checks a word as a buzz is entered; this file imports engine.js for
// derive and the refusals, used only inside functions, so the two importing each other is safe in either order.
//
// The record (Claude's design, from the spec): `match.packet` is { ref: { source, name, setName, packetNumber, fileName,
// loadedAt }, tossups, bonuses }, copied in at Start; a match with no packet has no such field (every record before 1.14.0
// reads as having none). A buzz's word is `word`, the index under the site's word rule (packet.js), present only when
// marked, with `wordTossup`, the tossup it was marked on (22 Nov 2026). A cycle's typed tossup number is `tossupNumberOverride`, present only when typed. Every version of a match
// shares one packet object (applyAction copies the rest), and nothing changes a packet once it is in a match.

import { RefusedError, cycleIndex, derive } from './engine.js';
import { readPacket, readQuestion } from './packet.js';

// The formats packet mode is offered for (Claude's choice, told to Tom on 20 Nov 2026): the quizbowl ones. University
// Challenge's picture and music starters and 5-point parts, and the trivia formats, do not fit a quizbowl packet.
export const PACKET_FORMATS = ['ukqb', 'acf', 'naqt-college', 'naqt-hs', 'pace'];
export const packetAllowed = rules => PACKET_FORMATS.includes(rules?.presetId) && !rules?.trivia;

// The match's packet when it has a sound one, else null. A packet is sound when its tossups and bonuses read as a
// packet (storage.js drops a damaged one as a backup loads, so this is the screens' guard).
export function matchPacket(match) {
  const packet = match?.packet;
  if (packet === null || typeof packet !== 'object' || !Array.isArray(packet.tossups) || !Array.isArray(packet.bonuses)) return null;
  return packet;
}
export const soundPacket = packet => packet !== null && typeof packet === 'object' && packet.ref !== null && typeof packet.ref === 'object'
  && readPacket({ tossups: packet.tossups, bonuses: packet.bonuses }).ok;

// What goes into a match at Start from a packet kept on this device (storage.js loadPacket): its text, and where it came
// from as `ref`.
export const packetForMatch = kept => ({
  ref: { source: kept.source ?? null, name: kept.name, setName: kept.setName ?? null, packetNumber: kept.packetNumber ?? null, fileName: kept.fileName ?? null, loadedAt: kept.loadedAt ?? null },
  tossups: kept.tossups, bonuses: kept.bonuses,
});

// A word: a whole number from 0. The end-of-question slot is checked where the text is known ('word' below; the pane
// offers no other).
export const isWord = word => Number.isInteger(word) && word >= 0;
export function checkWord(match, word) {
  if (matchPacket(match) === null) throw new RefusedError('no-packet', 'a buzz word needs a packet');
  if (!isWord(word)) throw new RefusedError('bad-action', 'a buzz word is a whole number from 0');
}
export const isTossupNumber = number => Number.isInteger(number) && number >= 1 && number <= 999;

// A buzz's word counts only for the tossup it was marked on (`wordTossup`, stored with `word`): the cycle must read that
// tossup now (a throw-out, a cycle deleted or inserted earlier, or a typed number can change what it reads) and the word
// must lie within that question's end slot (`read` is one of tossupNumbers' cycles, or null/undefined for none). A word
// with no `wordTossup` (a hand-edited file) does not count. With no packet text (`end` null) only the tossup is checked.
export function wordState(buzz, read) {
  if (!isWord(buzz?.word)) return 'none';
  if (!read || buzz.wordTossup !== read.read) return 'stale';
  return read.end !== null && buzz.word > read.end ? 'stale' : 'ok';
}
export const countedWord = (buzz, read) => (wordState(buzz, read) === 'ok' ? buzz.word : null);

// The words of tossup `number` (from 1) of the match's packet, or null when the packet has no such tossup.
const questionCache = new WeakMap();
export function tossupText(match, number) {
  const packet = matchPacket(match);
  const tossup = packet?.tossups[number - 1];
  if (!tossup) return null;
  let cache = questionCache.get(packet);
  if (!cache) questionCache.set(packet, (cache = new Map()));
  if (!cache.has(number)) cache.set(number, readQuestion(tossup.question));
  return cache.get(number);
}

// The tossup each cycle reads: the lowest number not yet read, or its typed number; each tossup thrown out of a cycle is
// used up and the next lowest is read in its place (MODAQ's rule: thrown out at question 6, question 6 reads tossup 7 and
// question 7 tossup 8). `cycles[i]` is { read, thrown, end } for cycle i (`end` the read tossup's end-of-question slot, null
// when the packet has none or the match no packet), or null for a cycle derive() flags after the end; `next` is the
// tossup a new cycle would read. With no typed numbers this is the sequential rule qbj.js wrote before 1.14.0.
export function tossupNumbers(match, d = derive(match)) {
  const used = new Set();
  const lowest = () => { let n = 1; while (used.has(n)) n += 1; return n; };
  const cycles = match.cycles.map((cycle, index) => {
    if (d.cycles[index]?.flags.includes('after-end')) return null;
    const typed = isTossupNumber(cycle.tossupNumberOverride) ? cycle.tossupNumberOverride : null;
    const numbers = [typed ?? lowest()];
    used.add(numbers[0]);
    const thrown = (cycle.thrownOut ?? []).filter(t => t.part === 'tossup').length;
    for (let k = 0; k < thrown; k++) { const n = lowest(); numbers.push(n); used.add(n); }
    const read = numbers.at(-1);
    return { read, thrown: numbers.slice(0, -1), end: tossupText(match, read)?.end ?? null };
  });
  return { cycles, next: lowest() };
}

// The tossup being read now: the open cycle's, else the one the next cycle would read.
export function currentTossup(match, d = derive(match)) {
  const numbers = tossupNumbers(match, d);
  const open = d.open.cycleId == null ? -1 : match.cycles.findIndex(c => c.id === d.open.cycleId);
  return open >= 0 && numbers.cycles[open] ? numbers.cycles[open].read : numbers.next;
}

// ---- Actions ----------------------------------------------------------------------------------------------------------

// 'word': { cycleId, buzz, word } puts `word` on buzz `buzz` (its place in the cycle, or 'last') of that cycle, or takes
// the word off when `word` is null. An edit: it works whatever the stage of the match, as an undoable version.
export function markWord(match, { cycleId, buzz, word }, _open, _entry, _phase, _now, derived) {
  const index = cycleIndex(match, cycleId);
  const cycle = match.cycles[index];
  const at = buzz === 'last' ? cycle.buzzes.length - 1 : buzz;
  if (!Number.isInteger(at) || at < 0 || at >= cycle.buzzes.length) throw new RefusedError('bad-action', 'there is no such buzz on this question');
  const entry = cycle.buzzes[at];
  if (word === null) { delete entry.word; delete entry.wordTossup; return; }
  checkWord(match, word);
  const numbers = tossupNumbers(match, derived ?? derive(match)).cycles[index];
  if (!numbers || numbers.end === null) throw new RefusedError('no-tossup-text', 'this packet has no text for that tossup');
  if (word > numbers.end) throw new RefusedError('bad-action', `tossup ${numbers.read} has ${numbers.end} words, so a word runs from 0 to ${numbers.end}`);
  entry.word = word;
  entry.wordTossup = numbers.read;
}

// 'tossupNumber': { number } is the tossup the open question reads, typed (1 to 999); with no question open it opens one,
// as a starter type does. engine.js lists it with the starter actions, so the cycle comes from there.
export function setTossupNumber(match, cycle, { number }) {
  if (matchPacket(match) === null) throw new RefusedError('no-packet', 'a tossup number needs a packet');
  if (!isTossupNumber(number)) throw new RefusedError('bad-action', 'a tossup number is a whole number from 1 to 999');
  cycle.tossupNumberOverride = number;
}

// The buzzes with no word on tossups the packet has text for (the scoresheet's "Buzz points not marked"); 0 with no packet.
export function unmarkedCount(match, d = derive(match)) {
  if (matchPacket(match) === null) return 0;
  const numbers = tossupNumbers(match, d).cycles;
  return match.cycles.reduce((sum, cycle, index) => (numbers[index]?.end == null ? sum
    : sum + cycle.buzzes.filter(b => wordState(b, numbers[index]) !== 'ok').length), 0);
}
