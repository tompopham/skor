// Two screens: the scoresheet and stats (spec 6.6) with the files it offers (spec 8), and Past matches
// (spec 6.7). The sheet is the same page the "Save scoresheet" file holds: toScoresheetHTML builds it and
// this screen takes its tables as they are, so what is on the screen, on paper and in the saved file can
// never disagree. Each cycle row opens the cycle editor. Everything leaves the page through offerFile.

import { derive } from './engine.js';
import { toScoresheetHTML, toCSV, resultLine, fileName, offerFile } from './files.js';
import { listMatchesReport, loadMatch, getCurrent } from './storage.js';
import { h } from './dom.js';
import { ensureStyles, refusalText } from './view-common.js';
import { protestControls } from './view-protest.js';

// ---- Style -----------------------------------------------------------------------------------
// The tables come with the class names the saved file uses (.seat, .notes, .num ...). Two of them
// (.seat and .notes) are also used by other screens, so they are put back to plain table cells here.
// How the sheet prints is in index.html.

const CSS = `
.sheetview { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
.sheetview .fmsg { min-height: 38px; }
@media (min-width: 700px) { .sheetview .fmsg { min-height: 20px; } }
.filesgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 6px; }
.sheet { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; }
.sheet .sheet-title { font-size: 18px; margin: 0; }
.sheet .details, .sheet .key, .sheet .foot, .sheet .timeline { color: var(--muted); font-size: 14px; margin: 0; overflow-wrap: anywhere; }
.sheet .wide { overflow-x: auto; max-width: 100%; }
.sheet h2 { margin: 12px 0 0; }
.sheet .num, .sheet .time { text-align: right; }
.sheet td.seat, .sheet th.seat { display: table-cell; appearance: none; min-height: 0; padding: 4px 6px; cursor: inherit; text-align: center; background: var(--bg); }
.sheet th.seat { background: var(--btn); white-space: normal; overflow-wrap: anywhere; min-width: 56px; max-width: 120px; }
.sheet td.notes, .sheet td.set { display: table-cell; max-width: none; margin: 0; white-space: normal; overflow-wrap: break-word; min-width: 120px; }
.sheet tr.cycle { cursor: pointer; }
.sheet tr.cycle:hover td { background: #f4f4f4; }
.sheet tr.after-end td { color: var(--muted); font-style: italic; }
.sheet tr.marker td { background: var(--btn); font-weight: bold; }
.sheet tr.swap .swaptext { margin-right: 8px; overflow-wrap: anywhere; }
.sheet tr.thrown td { display: table-cell; white-space: normal; color: var(--muted); text-decoration: line-through; }
.sheet tr.thrown .tw { display: block; position: sticky; left: 0; max-width: min(100%, calc(100vw - 56px)); overflow-wrap: anywhere; text-decoration: line-through; }
.sheet section.protests { display: grid; gap: 8px; }
.sheet .protest { overflow-wrap: anywhere; }
.sheet .rowbtn { appearance: none; border: 1px solid var(--line); background: var(--btn); border-radius: 0; min-width: 48px; min-height: 48px; padding: 0 8px; font: inherit; cursor: pointer; }
.sheet .cycles tr.cycle td:first-child { position: sticky; left: 0; z-index: 1; background: var(--bg); }
.sheet .cycles thead tr:first-child th:first-child { position: sticky; left: 0; z-index: 1; }
.afternote { border: 1px solid var(--line); padding: 8px; margin: 0; overflow-wrap: anywhere; }
.pastlist { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; max-width: 640px; }
.past { margin: 0; }
.past .pline { overflow-wrap: anywhere; }
.past .row > .btn { min-width: 96px; }
.past.damaged { border-style: dashed; }
.pmsg { min-height: 18px; }
`;

const pad = number => String(number).padStart(2, '0');
function dateOf(ms, withTime = false) {
  if (typeof ms !== 'number') return '';               // no date saved: not 1 January 1970
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

const noMatch = (root, api) => root.append(h('div', { class: 'unbuilt' }, h('h1', { tabindex: '-1' }, 'No match open'),
  h('p', { class: 'hint' }, 'Open a match from Home or from Past matches first.'),
  h('button', { class: 'btn', id: 'sheet-home', onclick: () => api.go('home') }, 'Home')));

// ---- Scoresheet and stats --------------------------------------------------------------------

// The saved file's body as nodes for this page: its title line, details, the two tables and the notes.
// toScoresheetHTML escapes everything it writes, and a parsed page runs no script.
function sheetNodes(match, d) {
  const page = new DOMParser().parseFromString(toScoresheetHTML(match, d), 'text/html');
  return [...page.body.children].map(node => document.importNode(node, true));
}

// Turns each cycle row into a way into the cycle editor: the whole row responds to a tap, and the
// question number in it is a button for the keyboard. The rows are in the order of match.cycles.
function openableRows(sheet, match, d, api) {
  const rows = [...sheet.querySelectorAll('table.cycles tbody tr.cycle')];
  if (rows.length !== match.cycles.length) return;
  rows.forEach((row, i) => {
    const cell = row.firstElementChild;
    cell.replaceChildren(h('button', { type: 'button', class: 'rowbtn', 'aria-label': `Open question ${d.cycles[i].number} to edit it` }, cell.textContent));
    row.addEventListener('click', () => api.editCycle(match.cycles[i].id, 'sheet'));
  });
}

// Gives each swap line of the sheet a Delete (the saved file has the line and no button). Delete asks first,
// and the swap goes from the record: every player's starters heard are worked out again from what is left.
function deletableSwaps(sheet, api) {
  for (const row of sheet.querySelectorAll('tr.swap')) {
    const index = Number(row.dataset.marker);
    const line = row.querySelector('.swaptext')?.textContent ?? '';
    const onDelete = async () => {
      const choice = await api.ask({
        title: 'Delete this swap?', body: line,
        buttons: [{ label: 'Delete', value: 'delete' }, { label: 'Cancel', value: 'cancel' }],
      });
      if (choice !== 'delete') return;
      const result = api.dispatch({ type: 'deleteSub', index }, { fmsg: null });   // a delete that goes through clears an earlier refusal's message
      if (result.ok) return;
      // Refused (a later swap depends on this one): nothing is removed, and the reason is said under the buttons at the top, brought into view.
      api.setUi({ fmsg: { text: refusalText(result.error), bad: true } });
      document.getElementById('files-msg')?.scrollIntoView?.({ block: 'nearest' });
    };
    row.firstElementChild.append(h('button', { type: 'button', class: 'rowbtn noprint', 'aria-label': `Delete the swap: ${line}`, onclick: onDelete }, 'Delete'));
  }
}

// Gives each protest line of the sheet its status select and Copy for Discord (the saved file has the line and no controls). A
// refusal is said under the buttons at the top, brought into view, as a swap's Delete does.
function controlledProtests(sheet, state, api, d) {
  for (const row of sheet.querySelectorAll('.protest')) {
    row.append(protestControls({
      api, getMatch: () => state.match, d, cycleId: row.dataset.cycle, index: Number(row.dataset.index), patch: { fmsg: null },
      onRefused: text => {
        api.setUi({ fmsg: { text, bad: true } });
        document.getElementById('files-msg')?.scrollIntoView?.({ block: 'nearest' });
      },
    }));
  }
}

// What a file action did, said under the buttons. A share sheet the person closed says nothing.
function reporter(note, api) {
  return (text, bad = false) => {
    note.textContent = text;
    note.className = bad ? 'msg fmsg' : 'hint fmsg';
    api.setUi({ fmsg: { text, bad } }, false);
  };
}

function filesCard(c) {
  const { api, state } = c;
  const note = h('p', { class: state.ui.fmsg?.bad ? 'msg fmsg' : 'hint fmsg', id: 'files-msg', role: 'status' }, state.ui.fmsg?.text ?? '');
  const say = reporter(note, api);

  const report = (file, result) => {
    if (result.ok) say(result.method === 'share' ? `Shared ${file.name}.` : `Saved ${file.name}. Look in your downloads.`);
    else if (result.cancelled) say('');
    else say(`Could not save ${file.name}: ${result.error ?? 'the browser refused.'}`, true);
  };
  // The match is read when the button is pressed, so a file is never older than the screen.
  const save = (ext, type, make) => async () => {
    const { match } = state;
    const file = { name: fileName(match, ext), type, text: make(match, derive(match)) };
    report(file, await offerFile(file));
  };
  const saveBackup = async () => {
    const name = fileName(state.match, 'json');
    report({ name }, await api.offerBackup());
  };
  const print = () => {
    try {
      window.print();
    } catch {
      say('This browser could not open printing. Save the scoresheet and print that file.', true);
    }
  };
  const copyLine = async () => {
    const line = resultLine(state.match, derive(state.match));
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('This browser has no clipboard');
      await navigator.clipboard.writeText(line);
      say(`Copied: ${line}`);
    } catch {
      say('');
      const box = h('textarea', { readonly: '', rows: '3', id: 'copy-line', 'aria-label': 'Result line', spellcheck: 'false' });
      box.value = line;
      const done = api.ask({
        title: 'Copy the result line',
        body: ['This browser would not copy it for you. Select the line below and copy it.', box],
        buttons: [{ label: 'Done', value: 'cancel', primary: true }],
      });
      box.focus();
      box.setSelectionRange(0, line.length);
      await done;
    }
  };

  const button = (id, label, onclick) => h('button', { type: 'button', class: 'btn', id, onclick }, label);
  return h('div', { class: 'card noprint', id: 'files-card' },
    h('b', { tabindex: '-1', id: 'files-head' }, 'Print and save'),
    h('div', { class: 'filesgrid' },
      button('file-print', 'Print', print),
      button('file-sheet', 'Save scoresheet', save('html', 'text/html;charset=utf-8', toScoresheetHTML)),
      button('file-csv', 'Save CSV', save('csv', 'text/csv;charset=utf-8', toCSV)),
      button('file-backup', 'Save backup', saveBackup),
      button('file-copy', 'Copy result line', copyLine)),
    note);
}

export function renderSheet(root, state, api) {
  ensureStyles('sheet-style', CSS);
  const { match } = state;
  if (!match) { noMatch(root, api); return; }
  const d = derive(match);

  const [title, ...rest] = sheetNodes(match, d);
  const heading = h('h2', { class: 'sheet-title' }, ...title.childNodes);
  const sheet = h('div', { class: 'sheet', id: 'sheet' }, heading, ...rest);
  openableRows(sheet, match, d, api);
  deletableSwaps(sheet, api);
  controlledProtests(sheet, state, api, d);

  // A cycle left after the end of the match is listed and marked, and is in no score or statistic.
  const late = d.cycles.filter(dc => dc.flags.includes('after-end')).map(dc => `Q${dc.number}`);
  const note = late.length === 0 ? null : h('p', { class: 'afternote noprint', id: 'after-note' },
    `${late.join(', ')} ${late.length === 1 ? 'comes' : 'come'} after the end of the match. ${late.length === 1 ? 'It is' : 'They are'} listed and marked on the sheet, and not counted in the scores or the statistics.`);

  root.append(h('div', { class: 'sheetview' },
    h('div', { class: 'top noprint' }, h('h1', { tabindex: '-1' }, 'Scoresheet and stats'),
      h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn small', id: 'sheet-back', onclick: () => api.back() }, 'Back'))),
    h('p', { class: 'hint noprint' }, 'Tap a question to look at it or change it.'),
    note,
    filesCard({ state, api }),
    sheet));

  // The menu's Print and Save files come here with an action to carry out once the screen is drawn.
  const { action } = state.ui;
  if (action) {
    api.setUi({ action: null }, false);
    if (action === 'print') setTimeout(() => document.getElementById('file-print')?.click(), 60);
    else if (action === 'files') document.getElementById('files-head')?.scrollIntoView?.({ block: 'start' });
  }
}

// ---- Past matches ----------------------------------------------------------------------------

// A saved match as the list shows it: the result line, the dates, and what it can do. A match the
// index names but whose record cannot be read comes back as { damaged: true } with what the index says.
function describe(entry) {
  const match = loadMatch(entry.id);
  if (match) {
    return { id: entry.id, damaged: false, line: resultLine(match, derive(match)), started: dateOf(match.createdAt), changed: dateOf(match.changedAt, true) };
  }
  const names = (Array.isArray(entry.teams) ? entry.teams : []).map(name => String(name ?? '').trim());
  return {
    id: entry.id, damaged: true, started: dateOf(entry.createdAt), changed: dateOf(entry.changedAt, true),
    line: names.some(Boolean) ? `${names[0] || 'Team A'} v ${names[1] || 'Team B'}` : 'A saved match',
  };
}

export function renderPast(root, state, api) {
  ensureStyles('sheet-style', CSS);
  const current = getCurrent();
  // A refusal is red (.msg); "Deleted." and "Removed from the list." are quiet (.hint). The line keeps its
  // height either way, so nothing below it moves.
  const message = h('p', { class: state.ui.good ? 'hint pmsg' : 'msg pmsg', id: 'past-msg', role: 'status' }, state.ui.msg ?? '');
  const say = text => { message.textContent = text; message.className = 'msg pmsg'; api.setUi({ msg: text, good: false }, false); };

  async function remove(item) {
    const body = item.damaged
      ? [item.line, 'This match cannot be read, so it cannot be opened. Removing it takes its line off this list.']
      : [item.line, 'This takes the match off this device. It cannot be brought back unless you saved a backup file.'];
    const choice = await api.ask({
      title: item.damaged ? 'Remove this entry?' : 'Delete this match?', body,
      buttons: [{ label: item.damaged ? 'Remove' : 'Delete match', value: 'delete' }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'delete') return;
    const result = api.deleteSaved(item.id);
    if (result.ok) api.setUi({ msg: item.damaged ? 'Removed from the list.' : 'Deleted.', good: true });
    else say(`Could not delete it: ${result.error}`);
  }
  const open = (action, item) => {
    const result = action(item.id);
    if (!result.ok) say(result.error);
  };

  const { entries, unreadable } = listMatchesReport();
  const items = entries.map(describe);
  const list = items.length === 0
    ? h('p', { class: 'hint', id: 'past-empty' }, 'No matches are saved on this device yet.')
    : h('div', { class: 'pastlist', id: 'past-list' }, items.map(item => h('div', { class: item.damaged ? 'card past damaged' : 'card past', 'data-id': item.id },
      h('b', { class: 'pline' }, item.line),
      h('span', { class: 'hint' }, [item.started ? `Started ${item.started}` : '', item.changed ? `last changed ${item.changed}` : '',
        item.id === current ? 'match in progress' : ''].filter(Boolean).join(' · ')),
      item.damaged ? h('span', { class: 'msg' }, 'This saved match is damaged and cannot be opened.') : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', 'data-act': 'view', disabled: item.damaged, onclick: () => open(api.viewMatch, item) }, 'View'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'resume', disabled: item.damaged, onclick: () => open(api.resumeSaved, item) }, 'Resume'),
        h('button', { type: 'button', class: 'btn', 'data-act': 'delete', onclick: () => remove(item) }, item.damaged ? 'Remove' : 'Delete')))));

  root.append(
    h('div', { class: 'top' }, h('h1', { tabindex: '-1' }, 'Past matches'),
      h('div', { class: 'acts' }, h('button', { type: 'button', class: 'btn small', id: 'past-back', onclick: () => api.back() }, 'Back'))),
    h('p', { class: 'hint' }, 'Kept on this device only, newest first. View opens the scoresheet, where a question can be changed. Resume carries on scoring.'),
    message, ...(unreadable > 0 ? [unreadableNote(unreadable)] : []), list);
}

// Saved records that are neither listed nor deleted because they cannot be read (v2 2.2).
const unreadableNote = count => h('p', { class: 'msg', id: 'past-unreadable' },
  `${count} saved ${count === 1 ? 'match' : 'matches'} could not be read`);
