// Packet mode's files out (Skor 1.14.0, SPEC-partB 5.5), no screen code: Save packet file (the packet for the buzzpoints.org
// upload, named for its round) and Buzz points (CSV), one row per buzz for clue study. The QBJ file's packet-mode fields
// are in qbj.js. Pure functions of the match record, so the tests run them in Node; the scoresheet hands the text to
// offerFile.

import { formatPieces, sentenceAt } from './packet.js';
import { matchPacket, tossupNumbers, tossupText, countedWord } from './packet-match.js';
import { qbjRound } from './qbj.js';
import { csvCell, fileName } from './files.js';
import { lineupsOf, playerName } from './lineup.js';
import { teamName } from './view-common.js';

// "Round_3.json": buzzpoints.org reads a packet's round from its file name (the first number followed by _, a space, . or
// the end), and must find the game's round there. With no round typed the game is round 0 on the site, so the packet is too.
export const packetFileName = match => `Round_${qbjRound(match) ?? 0}.json`;

// The packet as MODAQ's and packet-parser's JSON: its name, tossups and bonuses, two spaces deep.
export function packetFileText(match) {
  const packet = matchPacket(match);
  if (!packet) throw new Error('This match has no packet.');
  const bonuses = packet.bonuses.map(b => ({
    leadin: b.leadin, parts: b.parts, answers: b.answers, values: b.values,
    ...(Array.isArray(b.difficultyModifiers) ? { difficultyModifiers: b.difficultyModifiers } : {}),
    ...(b.metadata ? { metadata: b.metadata } : {}),
  }));
  const tossups = packet.tossups.map(t => ({ question: t.question, answer: t.answer, ...(t.metadata ? { metadata: t.metadata } : {}) }));
  return `${JSON.stringify({ name: packet.ref?.name ?? 'Packet', tossups, bonuses }, null, 2)}\n`;
}

const plain = html => formatPieces(html).map(p => (p.br ? ' ' : p.text)).join('').replace(/\s+/g, ' ').trim();
const RESULT = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };
const row = values => values.map(value => csvCell(value)).join(',');

// One row per buzz on the questions that count, in order: the question, set, packet, tossup read, its answer line as text,
// player, team, result, points, the word index (from 0, as in the QBJ file), the word and its clue sentence. A buzz with no
// word leaves the last three blank. With a UTF-8 marker and the formula guard, as the scoresheet's CSV.
export function buzzPointsCsv(match, d) {
  const packet = matchPacket(match);
  const ref = packet?.ref ?? {};
  const numbers = tossupNumbers(match, d).cycles;
  const lineups = lineupsOf(match);
  const lines = [row(['Question', 'Set', 'Packet', 'Tossup', 'Answer line', 'Player', 'Team', 'Result', 'Points', 'Word index', 'Word', 'Clue sentence'])];
  match.cycles.forEach((cycle, index) => {
    const read = numbers[index];
    if (!read) return;
    const question = tossupText(match, read.read);
    const answer = packet?.tossups[read.read - 1]?.answer;
    cycle.buzzes.forEach((b, k) => {
      const player = playerName(match, b.team, lineups[index][b.team][b.seat]) || `${teamName(match, b.team)} seat ${b.seat + 1}`;
      const counted = countedWord(b, read);
      const marked = counted !== null;
      let word = '', sentence = '';
      if (marked && question) {
        if (counted >= question.end) word = '(end of question)';
        else {
          word = question.words[counted];
          const { start, end } = sentenceAt(question.words, counted);
          sentence = question.words.slice(start, end + 1).join(' ');
        }
      }
      lines.push(row([d.cycles[index].number, ref.setName ?? '', ref.name ?? '', read.read, answer ? plain(answer) : '', player, teamName(match, b.team),
        RESULT[b.result] ?? b.result, d.cycles[index].buzzes[k].points, marked ? counted : '', word, sentence]));
    });
  });
  return `﻿${lines.join('\n')}\n`;
}

export const buzzPointsFileName = match => fileName(match, 'csv').replace(/\.csv$/, ' buzz points.csv');
