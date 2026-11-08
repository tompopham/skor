// Swap players (v2 4.4), from the scoring screen's menu: moved out of view-score.js for version 1.9.0, which made it two cards
// instead of three (review 19/10/2026, change 18; Tom's decision 14, SPEC-v2 11). The first card asks who goes out, with both
// teams' seats as two columns in the order the scoring screen shows them; the second asks who comes in (a bench player or a
// starter who is not sitting, the seat left empty, or a new name typed in, which joins the bench). Cancel or the back button on
// any card ends it with nothing recorded. A new name is added to the bench and swapped in as one version, so one Undo takes both
// back. The engine alone decides: a swap outside the rules' windows comes back refused with the rules' words, the page asks, and
// Record sends it again as confirmed. outColumns and inChoices are pure, for the tests.

import { h } from './dom.js';
import { playersOf, playerName } from './lineup.js';
import { teamName, leftRight, refusalText } from './view-common.js';

const WINDOW_WORDS = { halftime: 'at halftime', beforeOvertime: 'before overtime', timeout: 'after a timeout', quarter: 'between quarters' };
const CANCEL = { label: 'Cancel', value: 'cancel' };

// The first card's two columns, left team first, each with its seats in screen order (Reverse seat order runs them 4 to 1).
// `seats` is who sits where now (keys.js sittingNow): [team A's four ids, team B's], null for an empty seat.
export function outColumns(match, seats) {
  const order = match.display?.seatOrder === 'desc' ? [3, 2, 1, 0] : [0, 1, 2, 3];
  return leftRight(match).map(team => ({
    team, name: teamName(match, team),
    seats: order.map(seat => ({ seat, value: `out:${team}:${seat}`, label: `Seat ${seat + 1}: ${playerName(match, team, seats[team][seat]) || 'empty'}` })),
  }));
}

// The second card: its title, and its choices in order. Everyone the team has who is not in a seat now (the bench, and
// starters who have gone off), a name used twice saying which is which; then the seat left empty (greyed when it is empty
// already) and someone new.
export function inChoices(match, team, seat, seats) {
  const here = playerName(match, team, seats[team][seat]);
  const candidates = playersOf(match, team).filter(p => !seats[team].includes(p.id));
  const label = p => (candidates.filter(other => other.name === p.name).length > 1
    ? `${p.name} (${p.seat === null ? 'bench' : `started in seat ${p.seat + 1}`})` : p.name);
  return {
    title: `Seat ${seat + 1} (${here || 'empty'}): who comes in?`,
    choices: [
      ...candidates.map(p => ({ label: label(p), value: `player:${p.id}` })),
      { label: 'Leave the seat empty', value: 'empty', disabled: here === '' },
      { label: 'Someone new', value: 'new' },
    ],
  };
}

// "UK quizbowl allows swaps only at halftime or before overtime (ACF C.12). Record it anyway?" The bracket is left
// out when the rules cite no clause, and rules with no window at all say so.
function outsideWindowText(match, { windows, source }) {
  const name = match.rules.name || 'These rules';
  const clause = source ? ` (${source})` : '';
  const words = (windows ?? []).map(kind => WINDOW_WORDS[kind] ?? kind);
  if (words.length === 0) return `${name} has no swap window${clause}. Record it anyway?`;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`;
  return `${name} allows swaps only ${list}${clause}. Record it anyway?`;
}

// The name of a player who is not on the bench yet, typed in a box; asks again until there is one. undefined if cancelled.
async function askNewName(api) {
  const input = h('input', {
    type: 'text', maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false', 'aria-label': "New player's name",
  });
  const note = h('p', { class: 'msg' });
  for (;;) {
    const choice = await api.ask({
      title: 'New player', body: ['The new player joins the bench and takes the seat.', input, note],
      buttons: [{ label: 'Swap in', value: 'ok', primary: true }, CANCEL],
    });
    if (choice !== 'ok') return undefined;
    const name = input.value.trim();
    if (name !== '') return name;
    note.textContent = 'Type a name.';
  }
}

// A choice drawn in a card's body (the two columns), which closes the dialog with its value as a button under it would.
const choiceButton = (finish, { label, value, disabled = false }) => h('button', {
  type: 'button', class: 'btn', 'data-value': value, disabled, onclick: () => finish(value),
}, label);

// `c` is the scoring screen's context: the match, the page's api, who sits where now (c.seats) and c.say for a refusal.
export async function swapFlow(c) {
  const { match, api } = c;
  const out = await api.ask({
    title: 'Swap players: who goes out?',
    body: finish => h('div', { class: 'cols2', id: 'swap-out' }, outColumns(match, c.seats).map(column => h('div', { class: 'col', 'data-team': column.team },
      h('h3', { title: column.name }, column.name), column.seats.map(seat => choiceButton(finish, seat))))),
    buttons: [CANCEL],
  });
  const picked = /^out:([01]):([0-3])$/.exec(out ?? '');
  if (!picked) return;
  const [team, seat] = [Number(picked[1]), Number(picked[2])];

  const { title, choices } = inChoices(match, team, seat, c.seats);
  const people = choices.filter(choice => choice.value.startsWith('player:'));
  const who = await api.ask({
    title,
    body: finish => [
      people.length > 0 ? h('div', { class: 'cols2', id: 'swap-in' }, people.map(choice => choiceButton(finish, choice))) : null,
      h('div', { class: 'cols2' }, choices.filter(choice => !people.includes(choice)).map(choice => choiceButton(finish, choice))),
    ],
    buttons: [CANCEL],
  });
  let player = null;
  let name;
  if (who === 'new') {
    name = await askNewName(api);
    if (name === undefined) return;
    player = `b${(match.teams[team].bench ?? []).length}`;
  } else if (typeof who === 'string' && who.startsWith('player:')) player = who.slice('player:'.length);
  else if (who !== 'empty') return;

  const swap = { type: 'sub', team, seat, player };
  const actions = name === undefined ? [swap] : [{ type: 'addBench', team, name }, swap];
  const patch = { selected: null, streakN: 0 };
  let result = api.dispatchAll(actions, patch);
  if (!result.ok && result.error.code === 'outside-window') {
    const choice = await api.ask({
      title: 'Swap outside the window?', body: outsideWindowText(match, result.error),
      buttons: [{ label: 'Record', value: 'record' }, CANCEL],
    });
    if (choice !== 'record') return;
    result = api.dispatchAll(actions.map(action => (action.type === 'sub' ? { ...action, confirmed: true } : action)), patch);
  }
  if (!result.ok) c.say(refusalText(result.error));
}
