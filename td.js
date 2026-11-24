// The TD check page's screen (Skor 1.8.0, SPEC-partB 4.2). Step 1 loads the tournament file, step 2 the game files (a
// folder, chosen files, or a drop), and the report below them is drawn from td-check.js, which holds every rule and
// every line. Files are read one at a time, so 500 of them keep the page responsive; each is judged on its own, so a
// damaged one never stops the rest. The page reads files and writes none (Tom, 5 Nov 2026, T2): nothing is kept and
// nothing leaves the page except by Copy report and Print.

import { h } from './dom.js';
import { copyText } from './view-common.js';
import { VERSION } from './version.js';
import { readTournamentFile } from './schedule.js';
import { initSchedule } from './td-schedule.js';
import { initStandings } from './td-standings.js';
import {
  MAX_BYTES, fileKind, tooBig, readGame, checkGames, reportText, summaryLines, sections, nothingElse, needsFixing, gridKey,
  BYE_LINE, MODAQ_HEAD, NO_TOURNAMENT,
} from './td-check.js';

const $ = id => document.getElementById(id);
// tournament: readTournament()'s result or null. entries: the game files read, or null before any. run and tournamentRun
// count each choice, so a slow read of an earlier choice stops, or is dropped, when a newer one starts.
// tournamentText and tournamentFile: the loaded file's text and name, which Save tournament file with schedule builds on.
const state = { tournament: null, tournamentText: null, tournamentFile: null, entries: null, run: 0, tournamentRun: 0 };
const refreshSchedule = initSchedule(() => ({ tournament: state.tournament, text: state.tournamentText, fileName: state.tournamentFile }));
// The last step, Standings and afternoon brackets (1.16.0, 7.6), drawn after the report whenever either changes.
const refreshStandings = initStandings(() => ({ tournament: state.tournament, text: state.tournamentText, fileName: state.tournamentFile, entries: state.entries }));
const collator = new Intl.Collator('en-GB', { numeric: true });

// ---- Step 1: the tournament file ------------------------------------------------------------------------------------------

async function loadTournament(file) {
  const run = ++state.tournamentRun;
  const error = $('tournament-error');
  error.textContent = '';
  let read;
  let text = null;
  if (file.size > MAX_BYTES) read = { ok: false, error: 'This file is too large to be a tournament file.' };
  else {
    try { text = await file.text(); read = readTournamentFile(text); } catch { read = { ok: false, error: 'This file could not be read from the disk. Try again.' }; }
  }
  if (run !== state.tournamentRun) return;   // a file chosen after it is already being read
  if (!read.ok) {
    error.textContent = `${file.name}: ${read.error}${state.tournament ? ' The tournament file loaded before is still in use.' : ''}`;
    return;
  }
  state.tournament = read;
  state.tournamentText = text;
  state.tournamentFile = file.name;
  const rounds = read.schedule?.rounds.length ?? 0;
  $('tournament-status').textContent = `Tournament: ${read.name ?? file.name} (${read.teams.length} team${read.teams.length === 1 ? '' : 's'}), from ${file.name}.`
    + (rounds ? ` It has a schedule of ${rounds} round${rounds === 1 ? '' : 's'}.` : '');
  refreshSchedule();
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
    refreshStandings();
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

// Each problem in the same shape (td-check.js builds the words): the problem in bold, the fix on its own line, then the
// file and what YellowFruit will do in small print. Text goes in as text, never as markup.
const itemNode = entry => h('li', { class: 'item' },
  h('b', { class: 'what' }, entry.title), h('p', { class: 'fix' }, entry.fix), h('p', { class: 'more' }, entry.detail));
const fileList = (lines, id) => h('ul', { id, class: 'filelist' }, lines.map(line => h('li', {}, line)));

// A long team name is cut in the middle, so both ends stay ("Winter of C…tent quads 2"); the cell's title has it whole.
const short = name => {
  const chars = Array.from(name);
  return chars.length > 24 ? `${chars.slice(0, 12).join('')}…${chars.slice(-10).join('')}` : name;
};

// One cell of the grid: the opponent ("v Puffin Institute"), with "filed as ..." under it when this team's name in that
// game file is not the tournament file's; "2 games" and both opponents; "no game"; "bye?" for a probable bye (an odd pool);
// or a dash for a round none of the teams it plays had a game in.
function cellNode(cell) {
  const title = cell.games.map(entry => `${entry.path}: v ${entry.opponentName}${entry.filedAs ? ` (filed as "${entry.filedAs}")` : ''}`).join('\n');
  const games = cell.games.map(entry => h('span', { class: 'opp' }, `v ${short(entry.opponentName)}`,
    entry.filedAs ? h('span', { class: 'note' }, `filed as "${short(entry.filedAs)}"`) : null));
  if (cell.state === 'game') return h('td', { class: 'game', title }, games);
  if (cell.state === 'double') return h('td', { class: 'double', title }, h('b', {}, `${cell.games.length} games`), games);
  if (cell.state === 'gap') return h('td', { class: 'gap' }, 'no game');
  if (cell.state === 'bye') return h('td', { class: 'bye' }, 'bye?');
  return h('td', { class: 'none' }, '–');
}

function gridTable(report, rows) {
  const { rounds } = report.grid;
  return h('div', { class: 'tablewrap', id: 'grid-wrap', tabindex: '0', role: 'region', 'aria-label': 'Team by round grid; it scrolls sideways' },
    h('table', { class: 'grid', id: 'grid' },
      h('thead', {}, h('tr', {}, h('th', { class: 'team', scope: 'col' }, 'Team'), rounds.map(round => h('th', { scope: 'col' }, `R${round}`)))),
      h('tbody', {}, rows.map(row => h('tr', {},
        h('th', { class: 'team', scope: 'row' }, `${row.name}${report.tournament && !row.registered ? ' (not in the tournament file)' : ''}`),
        rounds.map(round => cellNode(row.cells[round])))))));
}

// The grid shows only the teams with something to fix, unless the TD asks for every team. With nothing to fix it starts
// hidden, behind its button.
function gridSection(report) {
  const all = report.grid.rows;
  const flagged = all.filter(row => needsFixing(row, report));
  const box = h('div', { class: 'gridbox' });
  let full = flagged.length === 0 ? null : false;   // null: hidden; false: flagged rows; true: every row
  const button = h('button', { class: 'btn noprint', type: 'button', id: 'grid-toggle' });
  const draw = () => {
    const rows = full ? all : full === false ? flagged : [];
    const showing = h('p', { class: 'hint', id: 'grid-showing' }, full ? `All ${all.length} teams.`
      : `Only the ${flagged.length === 1 ? 'team' : `${flagged.length} teams`} with something to fix.`);
    // The key explains only the marks in the rows shown; the bye line goes with a "no game" cell.
    const key = gridKey(rows);
    const gap = rows.some(row => Object.values(row.cells).some(cell => cell.state === 'gap'));
    box.replaceChildren(...(rows.length ? [showing, gridTable(report, rows),
      key.length ? h('ul', { class: 'key', id: 'grid-key' }, key.map(line => h('li', {}, line))) : null,
      gap ? h('p', { class: 'hint', id: 'bye-line' }, BYE_LINE) : null].filter(Boolean) : []));
    button.textContent = full ? (flagged.length ? 'Show only teams with something to fix' : 'Hide the grid')
      : full === false ? `Show all ${all.length} teams` : `Show the grid (${all.length} teams)`;
    button.setAttribute('aria-expanded', String(rows.length > 0));
  };
  button.addEventListener('click', () => {
    full = !full ? true : flagged.length ? false : null;
    draw();
  });
  draw();
  return h('section', { class: 'job', id: 'job-grid' }, h('h3', {}, 'Team by round grid'), h('div', { class: 'acts noprint' }, button), box);
}

function drawReport() {
  const root = $('report');
  refreshStandings();
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
  const after = nothingElse(report);
  const view = [
    h('h2', {}, 'Report'),
    h('div', { class: 'sum' }, summaryLines(report).map((line, i) => h('p', { class: i === 2 ? 'count' : 'hint', id: `summary-${i}` }, line))),
    h('div', { class: 'acts noprint' },
      h('button', { class: 'btn', type: 'button', id: 'copy-report', onclick: copy }, 'Copy report'),
      h('button', { class: 'btn', type: 'button', id: 'print-report', onclick: () => window.print() }, 'Print')),
    copyMsg, copyBox,
    sections(report).map(section => h('section', { class: 'job', id: `job-${section.id}` },
      h('h3', {}, section.heading), h('ul', { class: 'items', id: `${section.id}-list` }, section.items.map(itemNode)))),
    after ? h('p', { class: 'status', id: 'nothing-else' }, after) : null,
    report.names ? null : h('p', { class: 'status', id: 'names-none' }, NO_TOURNAMENT),
    report.grid.rows.length ? gridSection(report) : null,
    report.modaq.length ? h('section', { class: 'job files', id: 'files-modaq' },
      h('h3', {}, `${MODAQ_HEAD} (${report.modaq.length})`), fileList(report.modaq, 'modaq-list')) : null,
    report.bad.length ? h('section', { class: 'job files', id: 'files-bad' },
      h('h3', {}, `Could not be read (${report.bad.length})`), fileList(report.bad.map(entry => entry.line[0]), 'bad-list')) : null,
    report.other.length ? h('section', { class: 'job files', id: 'files-other' },
      h('h3', {}, `Skipped: not .qbj files (${report.other.length})`), fileList(report.other, 'other-list')) : null,
  ];
  root.replaceChildren(...view.flat().filter(Boolean));
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
