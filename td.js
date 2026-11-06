// The TD check page's screen (Skor 1.8.0, SPEC-partB 4.2). Step 1 loads the tournament file, step 2 the game files (a
// folder, chosen files, or a drop), and the report below them is drawn from td-check.js, which holds every rule and
// every line. Files are read one at a time, so 500 of them keep the page responsive; each is judged on its own, so a
// damaged one never stops the rest. The page reads files and writes none (Tom, 5 Nov 2026, T2): nothing is kept and
// nothing leaves the page except by Copy report and Print.

import { h } from './dom.js';
import { copyText } from './view-common.js';
import { VERSION } from './version.js';
import {
  MAX_BYTES, fileKind, tooBig, readGame, readTournament, checkGames, reportText, summaryLines, BYE_LINE, MODAQ_HEAD, NO_TOURNAMENT,
} from './td-check.js';

const $ = id => document.getElementById(id);
// tournament: readTournament()'s result or null. entries: the game files read, or null before any. run and tournamentRun
// count each choice, so a slow read of an earlier choice stops, or is dropped, when a newer one starts.
const state = { tournament: null, entries: null, run: 0, tournamentRun: 0 };
const collator = new Intl.Collator('en-GB', { numeric: true });

// ---- Step 1: the tournament file ------------------------------------------------------------------------------------------

async function loadTournament(file) {
  const run = ++state.tournamentRun;
  const error = $('tournament-error');
  error.textContent = '';
  let read;
  if (file.size > MAX_BYTES) read = { ok: false, error: 'This file is too large to be a tournament file.' };
  else {
    try { read = readTournament(await file.text()); } catch { read = { ok: false, error: 'This file could not be read from the disk. Try again.' }; }
  }
  if (run !== state.tournamentRun) return;   // a file chosen after it is already being read
  if (!read.ok) {
    error.textContent = `${file.name}: ${read.error}${state.tournament ? ' The tournament file loaded before is still in use.' : ''}`;
    return;
  }
  state.tournament = read;
  $('tournament-status').textContent = `Tournament: ${read.name ?? file.name} (${read.teams.length} team${read.teams.length === 1 ? '' : 's'}), from ${file.name}.`;
  drawReport();
}

// ---- Step 2: the game files -------------------------------------------------------------------------------------------------

// A chosen file's path inside the chosen folder ("QBJs/Round 1/x.qbj"); a file chosen on its own has its name only.
const pathOf = file => file.webkitRelativePath || file.name;

// Reads `items` ({ file, path }, or { path, error } for a dropped file the browser would not give) one at a time. A new
// choice replaces the last one. `run` is taken when the choice is made (a drop's folder walk takes time).
async function readFiles(items, run = ++state.run) {
  if (run !== state.run) return;
  const status = $('read-status');
  const ordered = [...items].sort((a, b) => collator.compare(a.path, b.path));
  const kinds = ordered.map(item => (item.file ? fileKind(item.path, item.file.size) : 'unreadable'));
  const total = kinds.filter(kind => kind === 'qbj').length;
  if (!ordered.length) {
    state.entries = null;
    $('report').replaceChildren();
    $('report').hidden = true;
    status.textContent = 'There were no files in what was chosen.';
    return;
  }
  const entries = [];
  let done = 0;
  for (const [i, item] of ordered.entries()) {
    const kind = kinds[i];
    if (kind === 'hidden') continue;
    if (kind === 'unreadable') { entries.push({ path: item.path, kind: 'bad', reason: 'could not be read: the browser would not open it' }); continue; }
    if (kind === 'big') { entries.push(tooBig(item.path, item.file.size)); continue; }
    if (kind !== 'qbj') { entries.push({ path: item.path, kind }); continue; }
    done += 1;
    if (done === 1 || done % 10 === 0 || done === total) status.textContent = `Reading ${done} of ${total}`;   // not 500 announcements
    let text = null;
    try { text = await item.file.text(); } catch { /* listed below */ }
    if (run !== state.run) return;   // a newer choice replaced this one
    let entry;
    try { entry = text === null ? { path: item.path, kind: 'bad', reason: 'could not be read from the disk' } : readGame(item.path, text); } catch {
      entry = { path: item.path, kind: 'bad', reason: 'could not be checked: something in it stopped the page' };
    }
    entries.push(entry);
  }
  state.entries = entries;
  const games = entries.filter(entry => entry.kind === 'game').length;
  status.textContent = games
    ? `Read ${games} game file${games === 1 ? '' : 's'}.`
    : 'No game files found: nothing chosen was a .qbj file that could be read. The files are listed below.';
  drawReport();
}

// A dropped folder is walked with the browser's file entries, which give each file's path inside it. They must be taken
// from the drop at once, before anything waits.
async function droppedItems(transfer) {
  const roots = [...(transfer.items ?? [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!roots.length) return [...transfer.files].map(file => ({ file, path: file.name }));
  const out = [];
  const walk = async entry => {
    const path = entry.fullPath.replace(/^\//, '');
    try {
      if (entry.isFile) out.push({ file: await new Promise((resolve, reject) => entry.file(resolve, reject)), path });
      else if (entry.isDirectory) {
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await walk(child);
        }
      }
    } catch {
      out.push({ path, error: true });
    }
  };
  for (const root of roots) await walk(root);
  return out;
}

// ---- The report -------------------------------------------------------------------------------------------------------------

// A report line: text, with the bold parts bold. Text goes in as text, never as markup.
const lineNode = (tag, item) => h(tag, {}, (Array.isArray(item.line) ? item.line : [item.line]).map(part => (typeof part === 'string' ? part : h('b', {}, part.b))));
const listOf = (items, id) => h('ul', { id }, items.map(item => lineNode('li', item)));
const noneLine = (id, text) => h('p', { class: 'hint', id }, text);

// One cell of the grid: the opponent's row number ("v 7"), "2 games", "no game", or a dash for a round its group did
// not play. A star marks a game filed under another name (section 3).
function cellNode(cell) {
  const opponents = cell.games.map(entry => `v ${entry.opponent}${entry.filedAs ? '*' : ''}`).join(', ');
  const title = cell.games.map(entry => `${entry.path}: v ${entry.opponentName}${entry.filedAs ? ` (filed as "${entry.filedAs}")` : ''}`).join('\n');
  if (cell.state === 'game') return h('td', { class: 'game', title }, opponents);
  if (cell.state === 'double') return h('td', { class: 'double', title }, `${cell.games.length} games`, h('span', { class: 'note' }, opponents));
  if (cell.state === 'gap') return h('td', { class: 'gap' }, 'no game');
  return h('td', { class: 'none' }, '–');
}

function gridTable(report) {
  const { rounds, rows } = report.grid;
  return h('div', { class: 'tablewrap', id: 'grid-wrap', tabindex: '0', role: 'region', 'aria-label': 'Team by round grid; it scrolls sideways' },
    h('table', { class: 'grid', id: 'grid' },
      h('caption', { class: 'hint' }, 'Team by round grid'),
      h('thead', {}, h('tr', {}, h('th', { class: 'team', scope: 'col' }, 'Team'), rounds.map(round => h('th', { scope: 'col' }, `R${round}`)))),
      h('tbody', {}, rows.map(row => h('tr', {},
        h('th', { class: 'team', scope: 'row' }, `${row.n}. ${row.name}${report.tournament && !row.registered ? ' (not in the tournament file)' : ''}`),
        rounds.map(round => cellNode(row.cells[round])))))));
}

function drawReport() {
  const root = $('report');
  if (!state.entries) return;
  let report;
  try { report = checkGames(state.entries, state.tournament); } catch {
    root.replaceChildren(h('p', { class: 'msg', id: 'report-error' }, 'Something in these files stopped the check. Try a smaller folder, one round at a time, to find the file, and send it to Tom.'));
    root.hidden = false;
    return;
  }
  const copyBox = h('textarea', { id: 'copy-box', class: 'noprint', readonly: true, hidden: true, 'aria-label': 'The report as text' });
  const copyMsg = h('p', { class: 'status noprint', id: 'copy-msg', role: 'status', 'aria-live': 'polite' });
  const copy = async () => {
    const text = reportText(report);
    copyBox.value = text;
    const copied = await copyText(text, copyBox);
    copyMsg.textContent = copied ? 'Report copied.' : 'This browser would not copy it: the report is in the box below. Select it and copy.';
    copyBox.hidden = copied;
    if (!copied) copyBox.select();
  };
  const doublesAndGaps = [...report.doubles, ...report.gaps];
  const sections = [
    h('h2', {}, 'Report'),
    h('div', {}, summaryLines(report).map((line, i) => h('p', { class: i === 2 ? 'status' : 'hint', id: `summary-${i}` }, line))),
    h('div', { class: 'acts noprint' },
      h('button', { class: 'btn', type: 'button', id: 'copy-report', onclick: copy }, 'Copy report'),
      h('button', { class: 'btn', type: 'button', id: 'print-report', onclick: () => window.print() }, 'Print')),
    copyMsg, copyBox,
    h('section', { class: 'job', id: 'job-rounds' },
      h('h3', {}, `1. Round does not match (${report.rounds.length})`),
      report.rounds.length ? listOf(report.rounds, 'rounds-list')
        : noneLine('rounds-none', 'None: wherever the folder, the file name and the file give a round, they agree.')),
    h('section', { class: 'job', id: 'job-grid' },
      h('h3', {}, `2. Team by round grid: doubles and gaps (${doublesAndGaps.length})`),
      h('p', { class: 'status', id: 'bye-line' }, BYE_LINE),
      doublesAndGaps.length ? listOf(doublesAndGaps, 'grid-list')
        : noneLine('grid-none', 'None: no team has two games in a round, or none in a round its opponents played.'),
      report.grid.rows.length ? gridTable(report) : null,
      report.grid.rows.length
        ? h('p', { class: 'hint', id: 'grid-key' }, 'v 7: played team 7. *: filed under another name (see 3). no game: the teams it meets, and theirs, played that round. –: none of them played that round.')
        : null),
    h('section', { class: 'job', id: 'job-names' },
      h('h3', {}, `3. Names not in the tournament file${report.names ? ` (${report.names.length})` : ''}`),
      !report.names ? noneLine('names-none', NO_TOURNAMENT)
        : report.names.length ? listOf(report.names, 'names-list') : noneLine('names-none', 'None: every team name is in the tournament file.'),
      report.players ? h('h3', {}, `Players not on their team's roster (${report.players.length})`) : null,
      !report.players ? null
        : report.players.length ? listOf(report.players, 'players-list') : noneLine('players-none', 'None: every player is on their team\'s roster.')),
    report.modaq.length ? h('section', { class: 'job files', id: 'files-modaq' },
      h('h3', {}, `${MODAQ_HEAD} (${report.modaq.length})`), listOf(report.modaq.map(path => ({ line: [path] })), 'modaq-list')) : null,
    report.bad.length ? h('section', { class: 'job files', id: 'files-bad' },
      h('h3', {}, `Could not be read (${report.bad.length})`), listOf(report.bad, 'bad-list')) : null,
    report.other.length ? h('section', { class: 'job files', id: 'files-other' },
      h('h3', {}, `Skipped: not .qbj files (${report.other.length})`), listOf(report.other.map(path => ({ line: [path] })), 'other-list')) : null,
  ];
  root.replaceChildren(...sections.filter(Boolean));
  root.hidden = false;
}

// ---- Start ------------------------------------------------------------------------------------------------------------------

$('version').textContent = `Version ${VERSION}`;
$('load-tournament').addEventListener('click', () => $('tournament-file').click());
$('tournament-file').addEventListener('change', event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (file) loadTournament(file);
});
$('choose-folder').addEventListener('click', () => $('folder-input').click());
$('choose-files').addEventListener('click', () => $('files-input').click());
for (const id of ['folder-input', 'files-input']) {
  $(id).addEventListener('change', event => {
    const files = [...event.target.files];
    event.target.value = '';
    readFiles(files.map(file => ({ file, path: pathOf(file) })));
  });
}
// Dropping files anywhere on the page reads them as step 2; the page is outlined while something is held over it.
const hasFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragover', event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('dropping'); });
document.addEventListener('drop', async event => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  document.body.classList.remove('dropping');
  const run = ++state.run;   // taken now, so a later choice wins even if this folder takes longer to walk
  readFiles(await droppedItems(event.dataTransfer), run);
});

// The same offline copy as the scorer, so the page opens with no signal once either has been opened (sw.js keeps both).
// Registered after the page has loaded, as app.js does. An update waits until every Skor tab is closed: the scorer's own
// "Update ready" line is where an update is applied.
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
