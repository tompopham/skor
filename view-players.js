// The Players screen of a buzzer session (Skor 1.12.0, SPEC-partB 6.5), from the scoring screen's Menu and built the way the
// swap screen is (view-swap.js): a card that stays open, so several changes can be made one after another, closed by Close,
// Cancel or the back button with nothing more recorded. It lists each team's named players in the order the grid shows them.
// Tap a player for "Move to <other team>" or "Take off"; "Add player" under each team asks for a name. Every change is one
// engine action and so one undoable version; the engine alone decides, and a refusal is shown in plain words in the card
// (refusalText), e.g. "Nick already has 10 named players. Take one off first." Only between questions (the Menu greys the
// entry while one is open, and the engine refuses it anyway). Other is never listed: it cannot move, leave or be added.
// playerColumns and personChoices are pure, for the tests.

import { h } from './dom.js';
import { derive } from './engine.js';
import { playerName } from './lineup.js';
import { sittingNow } from './keys.js';
import { teamName, leftRight, refusalText } from './view-common.js';
import { screenPlaces, OTHER_PLACE } from './session.js';

const CANCEL = { label: 'Cancel', value: 'cancel' };

// The first card's two columns, left team first: each team's named players sitting now, in screen order (the place is
// left out when nobody sits there), then its Add player button. `seats` is who sits where now (keys.js sittingNow).
export function playerColumns(match, seats) {
  return leftRight(match).map(team => ({
    team, name: teamName(match, team),
    players: screenPlaces(match, team).filter(seat => seat !== OTHER_PLACE && seats[team][seat] !== null)
      .map(seat => ({ seat, value: `who:${team}:${seat}`, label: playerName(match, team, seats[team][seat]) })),
    add: { value: `add:${team}`, label: 'Add player' },
  }));
}

// The second card for one player: its title and its two actions.
export function personChoices(match, team, seat, seats) {
  return {
    title: playerName(match, team, seats[team][seat]),
    choices: [
      { value: 'move', label: `Move to ${teamName(match, 1 - team)}` },
      { value: 'off', label: 'Take off' },
    ],
  };
}

const choiceButton = (finish, { label, value, disabled = false }) => h('button', {
  type: 'button', class: 'btn', 'data-value': value, disabled, onclick: () => finish(value),
}, label);

// The name of a late arrival, asked again until there is one. undefined if cancelled.
async function askName(api, team, match) {
  const input = h('input', {
    type: 'text', maxlength: 40, autocomplete: 'off', autocapitalize: 'words', autocorrect: 'off', spellcheck: 'false', 'aria-label': "New player's name",
  });
  const note = h('p', { class: 'msg' });
  for (;;) {
    const choice = await api.ask({
      title: `Add player to ${teamName(match, team)}`, body: ['The player is heard from the next question.', input, note],
      buttons: [{ label: 'Add', value: 'ok', primary: true }, CANCEL],
    });
    if (choice !== 'ok') return undefined;
    const name = input.value.trim();
    if (name !== '') return name;
    note.textContent = 'Type a name.';
  }
}

// `c` is the scoring screen's context (as for swapFlow): its state, the page's api and c.say. The card is drawn again after
// each change from the match as it is then; `message` carries a refusal into it.
export async function playersFlow(c) {
  const { api } = c;
  let message = '';
  for (;;) {
    const match = c.state.match;
    const seats = sittingNow(match, derive(match));
    const picked = await api.ask({
      title: 'Players',
      body: finish => [
        h('div', { class: 'cols2', id: 'players-cols' }, playerColumns(match, seats).map(column => h('div', { class: 'col', 'data-team': column.team },
          h('h3', { title: column.name }, column.name),
          column.players.length === 0 ? h('p', { class: 'dtext' }, 'Nobody named: everyone is on Other.') : null,
          column.players.map(player => choiceButton(finish, player)),
          choiceButton(finish, column.add)))),
        h('p', { class: 'msg', id: 'players-msg', role: 'status' }, message),
      ],
      buttons: [{ label: 'Close', value: 'cancel' }],
    });
    message = '';
    const who = /^who:([01]):([0-9])$/.exec(picked ?? '');
    const add = /^add:([01])$/.exec(picked ?? '');
    let action = null;
    if (who) {
      const [team, seat] = [Number(who[1]), Number(who[2])];
      const { title, choices } = personChoices(match, team, seat, seats);
      const what = await api.ask({ title, body: finish => h('div', { class: 'stack' }, choices.map(choice => choiceButton(finish, choice))), buttons: [CANCEL] });
      if (what === 'move') action = { type: 'move', team, seat };
      else if (what === 'off') action = { type: 'sub', team, seat, player: null };
    } else if (add) {
      const team = Number(add[1]);
      const name = await askName(api, team, match);
      if (name !== undefined) action = { type: 'addPlayer', team, name };
    } else return;
    if (action === null) continue;
    const result = api.dispatchAll([action], { selected: null, streakN: 0 });
    if (!result.ok) message = refusalText(result.error);
  }
}
