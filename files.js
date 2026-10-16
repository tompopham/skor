// What leaves the page (spec section 8): the CSV, the scoresheet as a standalone page, the result
// line, file names, and offering a file to the person (share sheet, else a download). The first
// four are pure functions of the match record and derive()'s result of it, so they run under Node;
// offerFile reaches for the browser only through `env`, and says so rather than throwing when
// there is none. Teams are always in data order (team 0, then team 1), whichever side of the
// screen they sit on, and stats are shown for people: "–" where there is nothing to divide by,
// bonus conversion as a percentage, points per 20 and points per bonus to two decimals.

import { FORMATS } from './engine.js';

const DASH = '–';
const TYPE_LABELS = { normal: 'Normal', picture: 'Picture', music: 'Music' };
const RESULT_WORDS = { power: 'power', ten: '10', neg: 'neg', wrong: 'wrong' };
// The scoresheet's one- or two-letter marks for a result; a plain 10 has none.
const RESULT_MARKS = { power: 'P', ten: '', neg: 'N', wrong: 'W' };
// What derive()'s flags say in words. 'after-end' is a cycle left after the match ended (spec 6.4);
// the others are entries an edit made impossible.
const FLAG_WORDS = {
  'after-end': 'after the end of the match, not counted',
  jailed: 'check: a player in jail is entered',
  'double-jump-locked': 'check: a team locked out of this Double Jump is entered',
  'not-on-this-set': 'check: a player not on this Split set is entered',
};

const isCorrect = buzz => buzz.result === 'power' || buzz.result === 'ten';
const afterEnd = dc => dc.flags.includes('after-end');
const teamName = (match, team) => String(match.teams[team].name ?? '').trim() || `Team ${'AB'[team]}`;
const seatName = (match, team, seat) => String(match.teams[team].seats[seat] ?? '').trim();
const playerName = (match, team, seat) => seatName(match, team, seat) || `seat ${seat + 1}`;
const capitalise = text => text.charAt(0).toUpperCase() + text.slice(1);
const pad = number => String(number).padStart(2, '0');

const fixed = number => number.toFixed(2);
const percent = ratio => `${(ratio * 100).toFixed(1)}%`;

// ---- What happened in a cycle, in words ------------------------------------------------------

// The type shown for a cycle: the trivia format's label, or Normal, Picture or Music.
const typeLabel = (match, cycle, dc) =>
  (match.rules.trivia ? FORMATS[dc.format] ?? dc.format : TYPE_LABELS[cycle.type] ?? 'Normal');

// What a buzz did, as the room board says it: "10", "neg", "jackpot clue 2 (30)".
function buzzWords(buzz, scored, format) {
  if (format !== 'jackpot') return RESULT_WORDS[buzz.result] ?? buzz.result;
  const clue = `jackpot clue ${(buzz.clue ?? 0) + 1}`;
  return isCorrect(buzz) ? `${clue} (${scored.points})` : `${clue}, ${RESULT_WORDS[buzz.result] ?? buzz.result}`;
}

const streakWords = turn => `streak ${turn.answers}${turn.wrong ? ', wrong' : ` (${turn.points})`}`;

// One team's part of a cycle for the CSV: its buzzes and Streak turn, and "lost turn".
function teamEntries(match, cycle, dc, team) {
  const entries = [];
  cycle.buzzes.forEach((buzz, i) => {
    if (buzz.team === team) entries.push(`${playerName(match, team, buzz.seat)} ${buzzWords(buzz, dc.buzzes[i], dc.format)}`);
  });
  for (const turn of dc.streak) {
    if (turn.team === team) entries.push(`${playerName(match, team, turn.seat)} ${streakWords(turn)}`);
  }
  if (cycle.lostTurn.includes(team)) entries.push('lost turn');
  return entries.join('; ');
}

// The set played for a cycle, "#3: got, missed (bounce got), got", or "" when none was.
function bonusWords(cycle, dc) {
  if (dc.bonusNumber === null) return '';
  const { bonus } = cycle;
  const held = dc.heldKind ? ` (held ${dc.heldKind})` : '';
  const parts = bonus.parts.map(part => {
    const own = part.ctrl ?? 'open';
    return part.other ? `${own} (bounce ${part.other})` : own;
  });
  return `#${dc.bonusNumber}${held}: ${bonus.total != null ? `total ${bonus.total}` : parts.join(', ')}`;
}

// What marks a cycle out: overtime, and the flags derive() raised.
const statusWords = dc => [...(dc.overtime ? ['overtime'] : []), ...dc.flags.map(flag => FLAG_WORDS[flag] ?? flag)];

// ---- Stats columns, shared by the CSV and the scoresheet --------------------------------------
// `group` names the rules a column belongs to: the scoresheet leaves a group out when the rules do
// not use it (the CSV keeps every column so its shape never changes).

const PLAYER_COLUMNS = [
  { header: 'Powers', group: 'power', value: p => p.powers },
  { header: 'Tens', value: p => p.tens },
  { header: 'Negs', value: p => p.negs },
  { header: 'Wrongs', value: p => p.wrongs },
  { header: 'Interrupts without penalty', value: p => p.interruptsNoPenalty },
  { header: 'Tossup points', value: p => p.tossupPoints },
  { header: 'Starters heard', value: p => p.heard },
  { header: 'Points per 20 starters heard', value: p => (p.heard === 0 ? DASH : fixed(p.pp20)) },
];

const TEAM_COLUMNS = [
  { header: 'Score', value: t => t.score },
  { header: 'Tossup points', value: t => t.tossupPoints },
  { header: 'Own bonus points', group: 'bonus', value: t => t.ownBonus },
  { header: 'Bonuses heard', group: 'bonus', value: t => t.bonusesHeard },
  { header: 'Points per bonus', group: 'bonus', value: t => (t.bonusesHeard === 0 ? DASH : fixed(t.ppb)) },
  { header: 'Bonus conversion', group: 'bonus', value: t => (t.partsHeard === 0 ? DASH : percent(t.conversion)) },
  { header: 'Bounce-back points', group: 'bounce', value: t => t.bounce.points },
  { header: 'Bounce-back parts heard', group: 'bounce', value: t => t.bounce.partsHeard },
  { header: 'Bounce-back parts got', group: 'bounce', value: t => t.bounce.partsGot },
  { header: 'Bounce-back conversion', group: 'bounce', value: t => (t.bounce.partsHeard === 0 ? DASH : percent(t.bounce.conversion)) },
  { header: 'Sweep rewards', group: 'reward', value: t => t.rewards },
  { header: 'Powers', group: 'power', value: t => t.powers },
  { header: 'Negs', value: t => t.negs },
  { header: 'Powers per neg', group: 'power', value: t => (t.powersPerNeg === null ? DASH : fixed(t.powersPerNeg)) },
];

// The column groups worth showing for this match: those the rules use, or that have something in them.
function usedGroups(match, d) {
  const { rules } = match;
  const groups = new Set();
  if (!rules.trivia) groups.add('bonus');
  if (rules.bonus.bounce != null || d.cycles.some(c => c.bounce.some(points => points !== 0))) groups.add('bounce');
  if (rules.bonus.reward > 0 || d.cycles.some(c => c.reward.some(points => points !== 0))) groups.add('reward');
  if (rules.tossup.power != null || d.stats.players.flat().some(p => p.powers > 0)) groups.add('power');
  return groups;
}

// Every seat with somebody in it, as [team, seat, stats]; an empty seat gets no stats.
const namedPlayers = (match, d) => [0, 1].flatMap(team =>
  d.stats.players[team].flatMap((stats, seat) => (seatName(match, team, seat) === '' ? [] : [[team, seat, stats]])));

// ---- The result line and the file name --------------------------------------------------------

// The result line as pieces: ['name', text] for a team name and ['text', text] for the rest, so the
// scoresheet can isolate the names (below) while the plain line is just the pieces joined.
function resultPieces(match, d) {
  const questions = d.cycles.filter(dc => !afterEnd(dc)).length;
  const et = d.phase.et ? ' (ET)' : '';
  const count = `${questions} ${questions === 1 ? 'question' : 'questions'}`;
  return [['name', teamName(match, 0)], ['text', ` ${d.scores[0]}, `], ['name', teamName(match, 1)],
    ['text', ` ${d.scores[1]}${et} (${match.rules.name}, ${count})`]];
}

// "Edinburgh A 210, Glasgow 140 (UK quizbowl, 20 questions)"; a result that went to overtime under
// BuzzerQuiz rules is marked "(ET)". Questions are the cycles that count: one left after the end of
// the match is not one.
export function resultLine(match, d) {
  return resultPieces(match, d).map(([, text]) => text).join('');
}

// A team name fit for a file name: no characters a file system refuses, one space at a time, short
// (cut by letters, so an emoji on the cut goes whole rather than leaving half of it).
function nameForFile(name, fallback) {
  const cleaned = Array.from(String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, 40).join('').trim().replace(/^\.+|\.+$/g, '');
  return cleaned || fallback;
}

// "2026-10-10 Edinburgh A v Glasgow.csv": the day the match was started, on this device's clock.
export function fileName(match, ext) {
  const created = new Date(match.createdAt);
  const day = Number.isFinite(created.getTime())
    ? `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ` : '';
  const teams = [0, 1].map(team => nameForFile(match.teams[team].name, `Team ${'AB'[team]}`));
  const extension = String(ext ?? '').replace(/^\.+/, '');
  return `${day}${teams[0]} v ${teams[1]}${extension === '' ? '' : `.${extension}`}`;
}

// ---- CSV ------------------------------------------------------------------------------------

// A spreadsheet runs a cell that starts with one of these as a formula (a team called
// =HYPERLINK(...) would phone home), so text that does is given a leading apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

// One cell. RFC 4180: a cell with a comma, quote or line break is wrapped in quotes, with inner
// quotes doubled. Text drawn from the record (names, labels) is first guarded against the formula
// trap above. Numbers the code writes are not text and are left alone: a score of -5 stays -5, and so
// does a worked-out figure held as a string ("-50.00", "83.3%") when the caller says `figure`.
// Exported so a test can reach the leading tab and carriage return, which team and player names
// never show (they are trimmed before they get here).
export function csvCell(value, { figure = false } = {}) {
  const raw = String(value ?? '');
  const text = !figure && typeof value !== 'number' && FORMULA_START.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
// Every cell is text unless it is a number or comes at or after `figuresFrom`.
const csvRow = (values, figuresFrom = values.length) =>
  values.map((value, i) => csvCell(value, { figure: i >= figuresFrom })).join(',');

// The file starts with a UTF-8 byte-order mark so that older Windows Excel reads accents and the en
// dash as UTF-8 rather than as Windows-1252.
const BYTE_ORDER_MARK = '\uFEFF';

// One row per cycle, then a blank line and a row per named player, then a blank line and a row per
// team. A starter that nobody got says "dead" in the Bonus column. A cycle left after the end of
// the match is listed with what happened and "after the end of the match, not counted" in its Type,
// and its points left empty, since they are in no total.
export function toCSV(match, d) {
  const [a, b] = [0, 1].map(team => teamName(match, team));
  const lines = [csvRow(['Question', 'Type', `${a} buzzes`, `${b} buzzes`, 'Bonus',
    `${a} points`, `${b} points`, `${a} total`, `${b} total`])];
  match.cycles.forEach((cycle, i) => {
    const dc = d.cycles[i];
    const status = statusWords(dc);
    const type = typeLabel(match, cycle, dc);
    const points = afterEnd(dc) ? ['', ''] : dc.total;
    lines.push(csvRow([dc.number, status.length > 0 ? `${type} (${status.join('; ')})` : type,
      teamEntries(match, cycle, dc, 0), teamEntries(match, cycle, dc, 1),
      cycle.dead ? 'dead' : bonusWords(cycle, dc), ...points, ...dc.running]));
  });
  lines.push('', csvRow(['Player', 'Team', 'Seat', ...PLAYER_COLUMNS.map(c => c.header)]));
  for (const [team, seat, stats] of namedPlayers(match, d)) {
    lines.push(csvRow([seatName(match, team, seat), teamName(match, team), seat + 1, ...PLAYER_COLUMNS.map(c => c.value(stats))], 2));
  }
  lines.push('', csvRow(['Team', ...TEAM_COLUMNS.map(c => c.header)]));
  d.stats.teams.forEach((stats, team) => lines.push(csvRow([teamName(match, team), ...TEAM_COLUMNS.map(c => c.value(stats))], 1)));
  return `${BYTE_ORDER_MARK}${lines.join('\n')}\n`;
}

// ---- The scoresheet page ----------------------------------------------------------------------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]);
// A team or player name on the page: escaped, and isolated from the text round it (<bdi>), so a name
// in a right-to-left script cannot pull the score beside it to the wrong side of it.
const nameHTML = value => `<bdi>${esc(value)}</bdi>`;

// Plain, black on white, no colour: it is printed. A4 landscape, a row never split across pages, the
// column headings repeated on each page, and the stats on a page of their own when printed.
const SHEET_CSS = `
@page { size: 297mm 210mm; margin: 10mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 10mm; background: #fff; color: #000; font: 10pt/1.3 system-ui, -apple-system, "Segoe UI", Arial, sans-serif; }
h1 { margin: 0 0 1mm; font-size: 15pt; }
h2 { margin: 6mm 0 1mm; font-size: 11pt; }
p { margin: 1mm 0; }
.details, .key, .foot { font-size: 8.5pt; }
.wide { overflow-x: auto; }
table { width: 100%; margin: 2mm 0; border-collapse: collapse; }
th, td { padding: 0.8mm 1.5mm; border: 1px solid #000; font-size: 8.5pt; text-align: left; vertical-align: top; }
th { background: #e6e6e6; }
.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.seat { text-align: center; white-space: nowrap; }
th.seat { max-width: 20mm; white-space: normal; overflow-wrap: anywhere; }
.stats th { white-space: normal; }
.set, .notes { overflow-wrap: break-word; }
.set { font-size: 7.5pt; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
tr.after-end td { color: #444; font-style: italic; }
tr.marker td { background: #e6e6e6; font-weight: bold; }
@media print {
  body { padding: 0; }
  .wide { overflow: visible; }
  .stats { break-before: page; page-break-before: always; }
}
`;

const DETAIL_LABELS = [['competition', 'Competition'], ['round', 'Round'], ['venue', 'Venue'], ['reader', 'Reader'], ['scorer', 'Scorer']];

function detailsLine(match) {
  const parts = DETAIL_LABELS.map(([key, label]) => [label, String(match.details?.[key] ?? '').trim()])
    .filter(([, text]) => text !== '').map(([label, text]) => `${label}: ${text}`);
  const created = new Date(match.createdAt);
  if (Number.isFinite(created.getTime())) {
    parts.unshift(`Date: ${pad(created.getDate())}/${pad(created.getMonth() + 1)}/${created.getFullYear()}`);
  }
  return parts.join(' · ');
}

const numCell = value => `<td class="num">${esc(value)}</td>`;

// What a seat did in a cycle, in points: "P 15", "10", "N -5", "W 0", "40 (clue 1)", "S 3 (15)".
function seatMarks(cycle, dc, team, seat) {
  const marks = [];
  cycle.buzzes.forEach((buzz, i) => {
    if (buzz.team !== team || buzz.seat !== seat) return;
    const mark = RESULT_MARKS[buzz.result] ?? '';
    const clue = dc.format === 'jackpot' ? ` (clue ${(buzz.clue ?? 0) + 1})` : '';
    marks.push(`${mark === '' ? '' : `${mark} `}${dc.buzzes[i].points}${clue}`);
  });
  for (const turn of dc.streak) {
    if (turn.team === team && turn.seat === seat) marks.push(`S ${turn.answers}${turn.wrong ? ' wrong' : ''} (${turn.points})`);
  }
  return marks.join(' / ');
}

// Where each quarter ends: a row of text to put after the cycle at that index (-1: before the first).
function quarterRows(match, d) {
  const ends = match.markers.filter(marker => marker.type === 'quarter').flatMap(marker => {
    const index = marker.afterCycleId === null ? -1 : match.cycles.findIndex(c => c.id === marker.afterCycleId);
    return marker.afterCycleId !== null && index < 0 ? [] : [index];
  }).sort((x, y) => x - y);
  const rows = new Map();
  ends.forEach((index, k) => {
    const [x, y] = index < 0 ? [0, 0] : d.cycles[index].running;
    rows.set(index, [...(rows.get(index) ?? []), `End of quarter ${k + 1}: ${x} to ${y}`]);
  });
  return rows;
}

function cycleTable(match, d, groups) {
  const { rules } = match;
  const showType = Boolean(rules.trivia) || rules.starterTypes.on || match.cycles.some(c => c.type !== 'normal');
  const extras = [['bonus', 'Bonus'], ['bounce', 'Bounce'], ['reward', 'Reward']].filter(([group]) => groups.has(group));
  const perTeam = 4 + extras.length + 2;
  const leading = 1 + (showType ? 1 : 0) + (groups.has('bonus') ? 1 : 0);
  const columns = leading + 2 * perTeam + 1;

  const head1 = ['<th rowspan="2">Q</th>', showType ? '<th rowspan="2">Type</th>' : '',
    groups.has('bonus') ? '<th rowspan="2">Bonus set</th>' : '',
    ...[0, 1].map(team => `<th colspan="${perTeam}">${nameHTML(teamName(match, team))}</th>`),
    '<th rowspan="2">Notes</th>'].join('');
  const head2 = [0, 1].map(team => [
    ...[0, 1, 2, 3].map(seat => `<th class="seat">${nameHTML(seatName(match, team, seat) || DASH)}</th>`),
    ...extras.map(([, label]) => `<th class="num">${label}</th>`),
    '<th class="num">Total</th>', '<th class="num">Running</th>',
  ].join('')).join('');

  const quarters = quarterRows(match, d);
  const markerRows = index => (quarters.get(index) ?? [])
    .map(text => `<tr class="marker"><td colspan="${columns}">${esc(text)}</td></tr>`);
  const rows = [...markerRows(-1)];
  match.cycles.forEach((cycle, i) => {
    const dc = d.cycles[i];
    const counted = !afterEnd(dc);
    const controller = dc.bonusNumber === null ? null : cycle.buzzes.find(isCorrect)?.team;
    const notes = [cycle.dead ? 'Dead' : null,
      ...cycle.lostTurn.map(team => `${nameHTML(teamName(match, team))} lost its turn`),
      ...[...statusWords(dc).map(capitalise), String(cycle.note ?? '').trim()].filter(Boolean).map(esc)].filter(Boolean);
    const teamCells = team => {
      const points = (value, shown) => numCell(counted && shown ? value : '');
      return [
        ...[0, 1, 2, 3].map(seat => `<td class="seat">${esc(seatMarks(cycle, dc, team, seat))}</td>`),
        ...extras.map(([group]) => {
          if (group === 'bonus') return points(dc.ownBonus[team], controller === team);
          if (group === 'bounce') return points(dc.bounce[team], dc.bounce[team] !== 0);
          return points(dc.reward[team], dc.reward[team] !== 0);
        }),
        points(dc.total[team], true), numCell(dc.running[team]),
      ].join('');
    };
    rows.push(`<tr class="cycle${counted ? '' : ' after-end'}"><td class="num">${dc.number}</td>`
      + (showType ? `<td>${esc(typeLabel(match, cycle, dc))}</td>` : '')
      + (groups.has('bonus') ? `<td class="set">${esc(bonusWords(cycle, dc))}</td>` : '')
      + teamCells(0) + teamCells(1) + `<td class="notes">${notes.join('<br>')}</td></tr>`);
    rows.push(...markerRows(i));
  });
  const body = rows.length > 0 ? rows.join('\n') : `<tr><td colspan="${columns}">No questions yet.</td></tr>`;
  return `<div class="wide"><table class="cycles">\n<thead><tr>${head1}</tr><tr>${head2}</tr></thead>\n<tbody>\n${body}\n</tbody></table></div>`;
}

function statsTables(match, d, groups) {
  const shown = columns => columns.filter(c => c.group === undefined || groups.has(c.group));
  const playerColumns = shown(PLAYER_COLUMNS), teamColumns = shown(TEAM_COLUMNS);
  const players = namedPlayers(match, d).map(([team, seat, stats]) => `<tr><td>${nameHTML(seatName(match, team, seat))}</td>`
    + `<td>${nameHTML(teamName(match, team))}</td>${playerColumns.map(c => numCell(c.value(stats))).join('')}</tr>`);
  const teams = d.stats.teams.map((stats, team) => `<tr><td>${nameHTML(teamName(match, team))}</td>`
    + `${teamColumns.map(c => numCell(c.value(stats))).join('')}</tr>`);
  const heads = columns => columns.map(c => `<th class="num">${esc(c.header)}</th>`).join('');
  return `<section class="stats">
<h2>Players</h2>
<div class="wide"><table>
<thead><tr><th>Player</th><th>Team</th>${heads(playerColumns)}</tr></thead>
<tbody>
${players.join('\n')}
</tbody></table></div>
<h2>Teams</h2>
<div class="wide"><table>
<thead><tr><th>Team</th>${heads(teamColumns)}</tr></thead>
<tbody>
${teams.join('\n')}
</tbody></table></div>
</section>`;
}

// The whole scoresheet as one standalone page: no script, no outside file, so it prints or sends as
// it is. Everything from the match record goes through esc().
export function toScoresheetHTML(match, d) {
  const groups = usedGroups(match, d);
  const title = `${teamName(match, 0)} v ${teamName(match, 1)}`;
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} scoresheet</title>
<style>${SHEET_CSS}</style>
</head>
<body>
<h1>${resultPieces(match, d).map(([kind, text]) => (kind === 'name' ? nameHTML(text) : esc(text))).join('')}</h1>
<p class="details">${esc(detailsLine(match))}</p>
${cycleTable(match, d, groups)}
<p class="key">Each player's cell shows the points from the buzz: P is a power, N a wrong interruption, W a wrong answer after the question ended, S a Streak turn.</p>
${statsTables(match, d, groups)}
<p class="foot">Unofficial scoresheet from Skor.</p>
</body>
</html>
`;
}

// ---- Offering a file --------------------------------------------------------------------------

// Hands a text file to the person: through the share sheet when the browser can share a file (so an
// iPhone can Save to Files, Mail or Messages), otherwise as a download. Browser only: `env` is the
// page's globals and is passed in so Node can stand in for them. Resolves { ok: true, method:
// 'share' | 'download' }; a share sheet the person closed is { ok: false, method: 'share',
// cancelled: true } and offers nothing more; anything else that fails is { ok: false, error }.
export async function offerFile({ name, type, text }, env = globalThis) {
  const { navigator } = env;
  if (typeof env.File === 'function' && typeof navigator?.canShare === 'function' && typeof navigator.share === 'function') {
    try {
      const file = new env.File([text], name, { type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return { ok: true, method: 'share' };
      }
    } catch (error) {
      if (error?.name === 'AbortError') return { ok: false, method: 'share', cancelled: true };
      // Any other refusal falls through to the download.
    }
  }
  try {
    if (!env.document || typeof env.URL?.createObjectURL !== 'function' || typeof env.Blob !== 'function') {
      throw new Error('There is no page here to offer a file from');
    }
    const url = env.URL.createObjectURL(new env.Blob([text], { type }));
    const link = env.document.createElement('a');
    link.href = url;
    link.download = name;
    env.document.body.append(link);
    link.click();
    link.remove();
    env.setTimeout(() => env.URL.revokeObjectURL(url), 10000);
    return { ok: true, method: 'download' };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
