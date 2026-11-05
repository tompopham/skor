// Two screens: the scoresheet and stats (spec 6.6) with the files it offers (spec 8), and Past matches
// (spec 6.7). The sheet is the same page the "Save scoresheet" file holds: toScoresheetHTML builds it and
// this screen takes its tables as they are, so what is on the screen, on paper and in the saved file can
// never disagree. Each cycle row opens the cycle editor. Everything leaves the page through offerFile.
// From version 1.6.0 (review 19/10/2026, changes 6 and 7): the sheet comes first, with the file actions behind one
// Print or save button; where the question grid is wider than the window it shows as a list built from the same match
// (files.js sheetRows), while print and the saved file keep the grid; and after the editor the edited row is brought back.

import { derive } from './engine.js';
import { toScoresheetHTML, toCSV, resultLine, fileName, offerFile, sheetRows } from './files.js';
import { listMatchesReport, loadMatch, getCurrent } from './storage.js';
import { h } from './dom.js';
import { ensureStyles, refusalText, isLive, fmt } from './view-common.js';
import { protestControls } from './view-protest.js';

// ---- Style -----------------------------------------------------------------------------------
// The tables come with the class names the saved file uses (.seat, .notes, .num ...). Two of them
// (.seat and .notes) are also used by other screens, so they are put back to plain table cells here.
// How the sheet prints is in index.html.

const CSS = `
.sheetview { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; min-width: 0; }
.sheetview .fmsg { min-height: 20px; margin: 0; }
.sheetview > .top { margin-bottom: 0; }
.sheetview > .top .acts .btn { white-space: nowrap; }
.sheet { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; }
.sheet .sheet-title { font-size: 18px; margin: 0; }
.sheet .details, .sheet .key, .sheet .foot, .sheet .timeline { color: var(--muted); font-size: 14px; margin: 0; overflow-wrap: anywhere; }
.sheet .wide { overflow-x: auto; max-width: 100%; }
.sheet h2 { margin: 12px 0 0; }
.sheet .num, .sheet .time { text-align: right; }
.sheet td.seat, .sheet th.seat { display: table-cell; appearance: none; min-height: 0; padding: 4px 6px; cursor: inherit; text-align: center; background: var(--bg); }
.sheet th.seat { background: var(--btn); white-space: normal; overflow-wrap: break-word; min-width: 56px; max-width: 120px; }
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
/* With a mouse a question row is 35 px (a 28 px button, 3 px padding); on a touch screen it stays 47 (review change 6). */
/* Screen only: paper keeps 1.5.0's rows and headings (index.html's print rules). */
@media screen and (hover: hover) and (pointer: fine) {
  .sheet .cycles tr.cycle .rowbtn { min-width: 28px; min-height: 28px; padding: 0 6px; }
  .sheet .cycles tbody td { padding-block: 3px; }
}
/* When the grid fits the window, its two heading rows stay at the top of the window as it scrolls (review change 7); the Q
   heading stays over the Q cells that scroll under it. */
@media screen {
  .sheet:not(.listmode) .cyclewrap { overflow: visible; }
  .sheet:not(.listmode) .cycles thead th { position: sticky; top: 0; z-index: 2; }
  .sheet:not(.listmode) .cycles thead tr + tr th { top: var(--head1, 0px); }
  .sheet:not(.listmode) .cycles thead tr:first-child th:first-child { z-index: 3; }
}
.sheet.listmode .cyclewrap, .sheet.listmode > .key { display: none; }
.sheet:not(.listmode) .qlist { display: none; }
/* The list (review change 7): Q, what happened (and a note under it), and the two running scores, a row a question. */
.qlist { display: grid; gap: 0; border: 1px solid var(--line); min-width: 0; }
.qlist .lhead, .qlist .lrow { display: grid; grid-template-columns: 36px minmax(0, 1fr) 64px 64px; column-gap: 6px; align-items: center; padding: 0 6px; }
@media (min-width: 640px) { .qlist .lhead, .qlist .lrow { grid-template-columns: 44px minmax(0, 1fr) 76px 76px; } }
.qlist .lhead { background: var(--btn); font-size: 14px; font-weight: bold; min-height: 32px; border-bottom: 1px solid var(--line); }
.qlist .lhead span { overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; line-height: 16px; padding-block: 4px; }
.qlist .lhead span:nth-child(n+3), .qlist .lnum { text-align: right; font-variant-numeric: tabular-nums; }
.qlist .lrow { appearance: none; width: 100%; border: 0; border-top: 1px solid var(--line); border-radius: 0; background: var(--bg); text-align: left; min-height: 48px; padding-block: 4px; font: inherit; font-size: 14px; line-height: 18px; cursor: pointer; }
.qlist .lhead + .lrow { border-top: 0; }
@media (hover: hover) and (pointer: fine) { .qlist .lrow { min-height: 40px; } }
.qlist .lrow:hover { background: #f4f4f4; }
.qlist .lq { font-weight: bold; }
.qlist .lwhat { min-width: 0; overflow-wrap: anywhere; }
.qlist .lnote { display: block; color: var(--muted); font-size: 13px; line-height: 16px; }
.qlist .lrow.after-end { color: var(--muted); font-style: italic; }
.qlist .lmark { border-top: 1px solid var(--line); background: var(--btn); padding: 6px; font-size: 14px; font-weight: bold; overflow-wrap: anywhere; }
.qlist .lmark.thrown { font-weight: normal; color: var(--muted); text-decoration: line-through; background: var(--bg); }
/* The Players and Teams headings wrap at 78 px, and the first column (the name) stays put as the table scrolls (change 7). */
@media screen {
  .sheet .stats th { white-space: normal; max-width: 78px; overflow-wrap: break-word; vertical-align: bottom; }
  .sheet .stats tbody td:first-child, .sheet .stats thead th:first-child { position: sticky; left: 0; z-index: 1; background: var(--bg); }
  .sheet .stats thead th:first-child { background: var(--btn); }
}
.afternote { border: 1px solid var(--line); padding: 8px; margin: 0; overflow-wrap: anywhere; }
.pastlist { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; max-width: 640px; }
.past { margin: 0; }
.past .pline { overflow-wrap: anywhere; }
.past .ptop { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; min-width: 0; }
.past .ptop .tag { margin-left: 0; }
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
  for (const row of sheet.querySelectorAll('tr.swap, .lmark.swap')) {
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
    (row.matches('tr') ? row.firstElementChild : row).append(h('button', { type: 'button', class: 'rowbtn noprint', 'aria-label': `Delete the swap: ${line}`, onclick: onDelete }, 'Delete'));
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

// The list for a window too narrow for the grid (review change 7): built from the match, not from the grid's cells. A
// question's row opens the editor, like the grid's.
function questionList(match, d, api) {
  const { teams, rows } = sheetRows(match, d);
  return h('div', { class: 'qlist noprint', id: 'qlist' },
    h('div', { class: 'lhead', 'aria-hidden': 'true' }, h('span', {}, 'Q'), h('span', {}, 'What happened'), ...teams.map(name => h('span', { title: name }, name))),
    rows.map(row => {
      if (row.kind !== 'cycle') {
        return h('div', { class: `lmark${row.kind === 'swap' ? ' swap' : row.kind === 'thrown' ? ' thrown' : ''}`, 'data-marker': row.kind === 'swap' ? row.index : null },
          row.kind === 'swap' ? h('span', { class: 'swaptext' }, row.text) : row.text);
      }
      return h('button', {
        type: 'button', class: row.counted ? 'lrow' : 'lrow after-end', 'data-index': row.index,
        'aria-label': `Question ${row.number}: ${row.what}${row.note ? `. ${row.note}` : ''}. ${teams[0]} ${fmt(row.running[0])}, ${teams[1]} ${fmt(row.running[1])}. Open it to edit it.`,
        onclick: () => api.editCycle(match.cycles[row.index].id, 'sheet'),
      },
      h('span', { class: 'lq' }, String(row.number)),
      h('span', { class: 'lwhat' }, row.what, row.note ? h('span', { class: 'lnote' }, row.note) : null),
      ...row.running.map(points => h('span', { class: 'lnum' }, fmt(points))));
    }));
}

// The grid where it fits the window, else the list; again whenever the window changes size. When the grid shows, its second
// heading row is held under the first.
function chooseView() {
  const sheet = document.getElementById('sheet');
  const table = sheet?.querySelector('table.cycles');
  if (!table) return;
  const wrap = table.parentElement;
  wrap.classList.add('cyclewrap');
  sheet.classList.remove('listmode');
  const fits = table.offsetWidth <= wrap.clientWidth + 1;
  sheet.classList.toggle('listmode', !fits);
  if (fits) table.style.setProperty('--head1', `${table.tHead.rows[0].getBoundingClientRect().height}px`);
}
// Only a change of width can change whether the grid fits: iPhone Safari also fires resize when its toolbar folds away as the
// page scrolls, and that is left alone. Where the page was scrolled to is kept across the check.
let resizing = false;
let watching = false;
let lastWidth = 0;
function watchSize() {
  lastWidth = window.innerWidth;
  if (watching) return;
  watching = true;
  window.addEventListener('resize', () => {
    if (resizing || window.innerWidth === lastWidth) return;
    resizing = true;
    requestAnimationFrame(() => {
      resizing = false;
      lastWidth = window.innerWidth;
      const y = window.scrollY;
      chooseView();
      window.scrollTo(window.scrollX, y);
    });
  });
}

// The question row at `index` (as many down as the match has questions), in whichever view shows.
function rowAt(index) {
  const sheet = document.getElementById('sheet');
  if (!sheet) return null;
  if (sheet.classList.contains('listmode')) {
    const rows = sheet.querySelectorAll('#qlist .lrow');
    return rows[Math.min(index, rows.length - 1)] ?? null;
  }
  const rows = sheet.querySelectorAll('table.cycles tbody tr.cycle');
  return rows[Math.min(index, rows.length - 1)]?.querySelector('.rowbtn') ?? null;
}

// The five file actions, behind Print or save (review change 6). Each runs inside its own button's click, so iPhone Safari
// still lets it share, download or copy; the dialog closes first. What happened is said in the line under the heading.
function fileActions(state, api, say) {
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
  return [
    ['print', 'Print', print],
    ['sheet', 'Save scoresheet', save('html', 'text/html;charset=utf-8', toScoresheetHTML)],
    ['csv', 'Save CSV', save('csv', 'text/csv;charset=utf-8', toCSV)],
    ['backup', 'Save backup', saveBackup],
    ['copy', 'Copy result line', copyLine],
  ];
}

function filesDialog(actions, api) {
  return api.ask({
    title: 'Print or save',
    body: finish => h('div', { class: 'stack', id: 'files-choices' }, actions.map(([value, label, act]) => h('button', {
      type: 'button', class: 'btn', id: `file-${value}`, 'data-value': value, onclick: () => { finish(value); act(); },
    }, label))),
    buttons: [{ label: 'Close', value: 'cancel' }],
  });
}

const HINT = 'Tap a question to open it';

export function renderSheet(root, state, api) {
  ensureStyles('sheet-style', CSS);
  const { match } = state;
  if (!match) { noMatch(root, api); return; }
  const d = derive(match);

  const [title, ...rest] = sheetNodes(match, d);
  const heading = h('h2', { class: 'sheet-title' }, ...title.childNodes);
  const sheet = h('div', { class: 'sheet', id: 'sheet' }, heading, ...rest);
  openableRows(sheet, match, d, api);
  sheet.querySelector('table.cycles')?.parentElement.after(questionList(match, d, api));
  deletableSwaps(sheet, api);
  controlledProtests(sheet, state, api, d);

  // A cycle left after the end of the match is listed and marked, and is in no score or statistic.
  const late = d.cycles.filter(dc => dc.flags.includes('after-end')).map(dc => `Q${dc.number}`);
  const note = late.length === 0 ? null : h('p', { class: 'afternote noprint', id: 'after-note' },
    `${late.join(', ')} ${late.length === 1 ? 'comes' : 'come'} after the end of the match. ${late.length === 1 ? 'It is' : 'They are'} listed and marked on the sheet, and not counted in the scores or the statistics.`);

  // One reserved line under the heading: the hint, or what a file action, a swap's Delete or a protest last said.
  const message = h('p', { class: state.ui.fmsg?.bad ? 'msg fmsg noprint' : 'hint fmsg noprint', id: 'files-msg', role: 'status' }, state.ui.fmsg?.text || HINT);
  const say = (text, bad = false) => {
    message.textContent = text || HINT;
    message.className = bad ? 'msg fmsg noprint' : 'hint fmsg noprint';
    api.setUi({ fmsg: text ? { text, bad } : null }, false);
  };
  const actions = fileActions(state, api, say);

  root.append(h('div', { class: 'sheetview' },
    h('div', { class: 'top noprint' }, h('h1', { tabindex: '-1' }, 'Scoresheet and stats'),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'btn small', id: 'sheet-files', onclick: () => filesDialog(actions, api) }, 'Print or save'),
        h('button', { type: 'button', class: 'btn small', id: 'sheet-back', onclick: () => api.back() }, 'Back'))),
    message,
    note,
    sheet));
  chooseView();
  watchSize();

  // The menu's Print and Save files come here with an action to carry out once the screen is drawn; the editor comes back
  // with the row it edited, which is brought to the middle of the window and given focus (after the page's own scroll to
  // the top, which follows the drawing).
  const { action, focusRow } = state.ui;
  if (action) {
    api.setUi({ action: null }, false);
    if (action === 'print') setTimeout(actions[0][2], 60);
    else if (action === 'files') setTimeout(() => filesDialog(actions, api), 0);
  }
  if (Number.isInteger(focusRow) && focusRow >= 0) {
    api.setUi({ focusRow: null }, false);
    queueMicrotask(() => {
      const row = rowAt(focusRow);
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    });
  }
}

// ---- Past matches ----------------------------------------------------------------------------

// A saved match as the list shows it: the result line, the dates, and what it can do. A match the
// index names but whose record cannot be read comes back as { damaged: true } with what the index says.
function describe(entry) {
  const match = loadMatch(entry.id);
  if (match) {
    return { id: entry.id, damaged: false, live: isLive(match), line: resultLine(match, derive(match)), started: dateOf(match.createdAt), changed: dateOf(match.changedAt, true) };
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
      // Tagged In progress only while it is the match in progress and has not ended (review change 10).
      h('div', { class: 'ptop' }, h('b', { class: 'pline' }, item.line), item.id === current && item.live ? h('span', { class: 'tag' }, 'In progress') : null),
      h('span', { class: 'hint' }, [item.started ? `Started ${item.started}` : '', item.changed ? `last changed ${item.changed}` : ''].filter(Boolean).join(' · ')),
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
