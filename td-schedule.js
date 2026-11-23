// The TD check page's Add a schedule (Skor 1.16.0, SPEC-partB 7.3), in step 1 beside the tournament file it is saved into.
// The TD pastes the schedule from a spreadsheet; the page says what it read and every fault, line by line, and Save
// tournament file with schedule hands over the loaded file with the schedule in it, the file scorers then load in Setup.
// Every rule and line is in schedule.js; this file only draws them. Names go in as text only.

import { offerFile } from './files.js';
import { readScheduleTable, scheduleTable, withSchedule, scheduleFileName } from './schedule.js';

const $ = id => document.getElementById(id);
const SHOWN_FAULTS = 40;

// The box after another tournament file is loaded (fixed after the stages 1-2 review): while it is empty or still holds
// the table the last file put in (`shown`), it takes the new file's schedule as a table, or empties for a file with none; a
// table the TD has typed or changed stays. { text, shown }.
export function tableAfterLoad(text, shown, schedule) {
  if (String(text ?? '').trim() && text !== shown) return { text, shown };
  const table = schedule ? scheduleTable(schedule) : '';
  return { text: table, shown: table };
}

// `now()` gives { tournament, text, fileName }: the loaded tournament file as read (readTournamentFile) and its text, or
// nulls. Gives `refresh`, which td.js calls when another tournament file is loaded: the names are checked again, and a
// file that has a schedule puts it in the box when the box is empty.
export function initSchedule(now) {
  const open = $('add-schedule');
  const box = $('schedule-box');
  const area = $('schedule-text');
  const status = $('schedule-status');
  const faults = $('schedule-faults');
  const msg = $('schedule-msg');
  let read = null;
  let timer = 0;

  const draw = () => {
    const { tournament } = now();
    read = readScheduleTable(area.value, tournament?.teams ?? []);
    msg.textContent = '';
    if (!read.schedule && !read.faults.length) {
      status.textContent = 'Nothing pasted yet.';
      faults.replaceChildren();
      return;
    }
    const lines = [];
    if (read.schedule) lines.push(`Read: ${read.summary}.`);
    if (!tournament) lines.push('Load the tournament file above to check the names and save.');
    status.textContent = lines.join(' ');
    const shown = read.faults.slice(0, SHOWN_FAULTS).map(line => document.createElement('li'));
    shown.forEach((item, i) => { item.textContent = read.faults[i]; });
    if (read.faults.length > SHOWN_FAULTS) {
      const more = document.createElement('li');
      more.textContent = `and ${read.faults.length - SHOWN_FAULTS} more`;
      shown.push(more);
    }
    const head = document.createElement('li');
    head.className = 'head';
    head.textContent = `${read.faults.length} to fix before saving:`;
    faults.replaceChildren(...(read.faults.length ? [head, ...shown] : []));
  };

  open.addEventListener('click', () => {
    box.hidden = !box.hidden;
    open.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) { draw(); area.focus(); }
  });
  area.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 250); });

  $('save-schedule').addEventListener('click', async () => {
    clearTimeout(timer);
    draw();
    const { tournament, text, fileName } = now();
    if (!tournament) { msg.textContent = 'Load the tournament file first: the saved file holds its teams and players.'; return; }
    if (!read.schedule) { msg.textContent = 'Paste the schedule first: one row a game, Round, Room, Team, Team.'; return; }
    if (read.faults.length) { msg.textContent = `Fix the ${read.faults.length === 1 ? 'line' : `${read.faults.length} lines`} above first: the file is saved only when the table has no faults.`; return; }
    let saved;
    try {
      saved = await offerFile({ name: scheduleFileName(tournament.name ?? fileName?.replace(/\.(qbj|json)$/i, '')), type: 'application/json', text: withSchedule(text, read.schedule) });
    } catch {
      saved = { ok: false, error: 'the file could not be made' };
    }
    if (!saved.ok && !saved.cancelled) msg.textContent = `It could not be saved: ${saved.error}.`;
    else if (saved.ok) status.textContent = `Saved. Post it in Discord for the scorers, who load it in Setup as before. Read: ${read.summary}.`;
  });

  let shown = '';
  return function refresh() {
    const { tournament } = now();
    const after = tableAfterLoad(area.value, shown, tournament?.schedule ?? null);
    area.value = after.text;
    shown = after.shown;
    if (!box.hidden) draw();
  };
}
