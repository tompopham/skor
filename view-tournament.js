// The tournament file on Setup (Skor 1.11.0, SPEC-partB 3.4): its line under the format summary, its Load and Remove
// buttons in Match details, and each team card's picker, which offers the registered teams by name and fills the seats
// and bench from the one picked. The file is read and kept in tournament.js; view-setup.js calls these.

import { readSavedTournament, saveTournamentFile, tournamentLine, findTeam, rosterSeats, fillPlan, NOT_IN_TOURNAMENT } from './tournament.js';
import { removeTournamentText } from './storage.js';
import { h } from './dom.js';

// A tournament file is about 20 KB; anything far bigger is not one, and is not read.
const MAX_BYTES = 5 * 1024 * 1024;
export const TEAM_LIST_ID = 'tournament-teams';

// The saved file as Setup uses it: { tournament, error }, either or both null.
export function tournamentNow() {
  const read = readSavedTournament();
  return { tournament: read?.ok ? read : null, error: read && !read.ok ? read.error : null };
}

// The line under the format summary ("Tournament: Deep Bench 2026 (24 teams)"), or the damaged file's message, or nothing.
export function tournamentStatus({ tournament, error }) {
  if (tournament) return h('p', { class: 'hint', id: 'tournament-line' }, tournamentLine(tournament));
  if (error) return h('p', { class: 'msg', id: 'tournament-line' }, error);
  return null;
}

// The datalist the team name boxes use while a file is loaded: every registered team, in the file's order.
export const teamList = ({ tournament }) => (tournament
  ? h('datalist', { id: TEAM_LIST_ID }, tournament.teams.map(team => h('option', { value: team.name })))
  : null);

// Match details' Tournament file row: Load (or Load another) and, with a file, Remove, which asks first. The file
// picker opens inside the Load button's own click (iPhone Safari's rule). `redraw` draws Setup again once it changes.
export function tournamentRow(now, api, redraw) {
  const note = h('p', { class: 'hint', id: 'tournament-msg', role: 'status' });
  const say = (text, bad = false) => { note.textContent = text; note.className = bad ? 'msg' : 'hint'; };
  const load = h('button', { type: 'button', class: 'btn', id: 'tournament-load', onclick: () => pickFile(say, redraw) },
    now.tournament || now.error ? 'Load another tournament file' : 'Load tournament file');
  const remove = now.tournament || now.error ? h('button', {
    type: 'button', class: 'btn', id: 'tournament-remove',
    onclick: async () => {
      const sure = await api.ask({
        title: 'Remove the tournament file?',
        body: ['Team names stop being offered from it on this device until it is loaded again. Your matches are not touched.'],
        buttons: [{ label: 'Remove', value: 'yes', primary: true }, { label: 'Cancel', value: 'cancel' }],
      });
      if (sure !== 'yes') return;
      const done = removeTournamentText();
      if (done.ok) redraw();
      else say(`It could not be removed: ${done.error}`, true);
    },
  }, 'Remove') : null;
  return h('div', { class: 'group', id: 'tournament-row' },
    h('p', { class: 'hint' }, now.tournament ? tournamentLine(now.tournament) : 'Tournament file (.qbj): the TD’s list of teams and players, from YellowFruit or quizbowlreader.com/createTournamentFile.html.'),
    h('div', { class: remove ? 'grid2' : 'stack' }, load, remove), note);
}

function pickFile(say, redraw) {
  const input = h('input', { type: 'file', accept: '.qbj,.json,application/json', hidden: true, id: 'tournament-file' });
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_BYTES) { say(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB, too large to be a tournament file.`, true); return; }
    let text;
    try {
      text = await file.text();
    } catch {
      say(`${file.name} could not be read. If it is in iCloud, open it in Files once so it downloads, then load it again.`, true);
      return;
    }
    const saved = saveTournamentFile(text);
    if (!saved.ok) { say(`${file.name}: ${saved.error}`, true); return; }
    redraw();
  });
  document.body.append(input);
  input.click();
}

// A team card's part: the line under the team name, which says "not in the tournament file" for a name the file does not
// have, or offers the registered team's players when the boxes hold names typed by hand. `fill(seats, bench)` puts a
// roster into the card; `boxes()` gives what the card's boxes hold now ({ seats, bench }). The draft remembers which
// registered team filled the card (`fromTournament`), so typing on past a shorter name refills and never asks.
export function teamPicker(now, draftTeam, fill, boxes) {
  const line = h('p', { class: 'hint tline' });
  if (!now.tournament) return { line: null, onName() {}, listId: null };
  const offer = h('button', { type: 'button', class: 'btn small' });
  const show = (text, registered = null) => {
    const count = registered ? rosterSeats(registered).seats.filter(Boolean).length + rosterSeats(registered).bench.length : 0;
    line.replaceChildren(registered && count === 0 ? 'In the tournament file, with no players listed.' : text);
    if (registered && count > 0) {
      offer.textContent = `Use its ${count} player${count === 1 ? '' : 's'}`;
      offer.onclick = () => use(registered);
      line.append(' ', offer);
    }
  };
  // The card still holds exactly the roster the picker put in (`team`'s), not names typed since.
  const holdsRoster = team => {
    const roster = rosterSeats(team);
    const now = boxes();
    const bench = now.bench.map(name => String(name ?? '').trim()).filter(Boolean);
    return now.seats.every((name, i) => String(name ?? '').trim() === roster.seats[i]) && bench.join('\n') === roster.bench.join('\n');
  };
  const use = registered => {
    const roster = rosterSeats(registered);
    draftTeam.fromTournament = registered.name;
    fill(roster.seats, roster.bench);
    show('');
  };
  const onName = value => {
    const registered = findTeam(now.tournament, value);
    if (!registered) {
      // Typing on past a registered name ("Oxford B" to "Oxford Brookes") takes out the roster it put in, so no one
      // else's players are left in the seats; names typed by hand stay.
      const filled = findTeam(now.tournament, draftTeam.fromTournament ?? '');
      if (filled && filled.name === draftTeam.fromTournament && holdsRoster(filled)) fill(['', '', '', ''], []);
      draftTeam.fromTournament = null;
      show(String(value ?? '').trim() ? NOT_IN_TOURNAMENT : '');
      return;
    }
    const previous = findTeam(now.tournament, draftTeam.fromTournament ?? '');
    const plan = fillPlan(boxes(), registered, previous && previous.name === draftTeam.fromTournament ? previous : null);
    if (plan === 'fill') use(registered);
    else if (plan === 'ask') show('In the tournament file.', registered);
    else show('');
  };
  // Drawn again (a file loaded or removed, back from Rules): the name already typed is decided as if typed now, so empty
  // boxes fill, typed ones get the offer, and an unknown name its mark.
  queueMicrotask(() => { if (line.isConnected) onName(draftTeam.name); });
  return { line, onName, listId: TEAM_LIST_ID };
}
