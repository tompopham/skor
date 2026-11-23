// Buzzer sessions on the Setup screen (Skor 1.12.0, SPEC-partB 6.4). A choice under the format, Game (4 a side) or Buzzer
// session (up to 10 a side, practice), with Game the default; offered for every format. Consensus and GradWrite were left out
// in 1.12.0, since their Jailbreak and Split rules are written for 4 players, and added in 1.15.0 (Tom, 22 Nov 2026): in a
// session Other is never jailed, a team breaks out when four named players are out (or every named player, a rule on the
// Rules screen), and a Split set takes any number of a team's players (engine.js cycleEntries and checkSplitSeats). In a
// session each team shows 4 name boxes and an Add player button that adds one more, up to 10; Other is never typed (the engine
// always puts it in place 10), and a team may start with no named players. No bench boxes and no round are needed in a session
// (it has no QBJ file). The pure parts here are tested without a screen; view-setup.js draws the boxes.

import { h } from './dom.js';
import { GAME_SEATS, NAMED_PLACES, isOtherName, OTHER_NAME_TEXT } from './session.js';
import { withoutPicked } from './schedule.js';

export const SESSION_PRESETS = ['ukqb', 'acf', 'naqt-college', 'naqt-hs', 'pace', 'uc', 'consensus', 'gradwrite'];
export const GAME_LABEL = 'Game (4 a side)';
export const SESSION_LABEL = 'Buzzer session (up to 10 a side, practice)';
export const START_BOXES = 4;

// Whether a format may be played as a session: any of the eight presets (not one cut in 2026, kept only in old matches).
export const sessionOffered = presetId => SESSION_PRESETS.includes(presetId);

// Whether the draft is a session now: chosen, and the format still allows it (a format change forces Game).
export const sessionOn = draft => draft.session === true && sessionOffered(draft.presetId);

// How many name boxes a team shows: 4 in a game, at least 4 and at most 10 in a session.
export function shownSeats(draft, t) {
  if (!sessionOn(draft)) return GAME_SEATS;
  return Math.min(NAMED_PLACES, Math.max(START_BOXES, draft.teams[t].seats.length));
}

// Adds one name box to a session team. Returns the new box's seat, or null at 10 (or in a game).
export function addSeatBox(draft, t) {
  const shown = shownSeats(draft, t);
  if (!sessionOn(draft) || shown >= NAMED_PLACES) return null;
  const seats = draft.teams[t].seats;
  while (seats.length < shown) seats.push('');
  seats.push('');
  return shown;
}

// The seats a session team starts with: the typed names, trimmed, the empty boxes left out, at most 10. Other is not here.
// A team with nothing typed has no named players (everyone is on Other), never the A1 to A4 a game gets.
export const sessionSeats = team => team.seats.map(name => name.trim()).filter(Boolean).slice(0, NAMED_PLACES);

// The message when a typed name is "Other" (any case): Other is on every team already. null when all is fine.
export const otherNameProblem = draft => (sessionOn(draft) && draft.teams.some(team => sessionSeats(team).some(isOtherName)) ? OTHER_NAME_TEXT : null);

// A tournament roster as a session team's boxes: its first 10 players, and how many boxes that shows (4 at least).
export function sessionRoster(players) {
  const names = (players ?? []).map(name => String(name ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, NAMED_PLACES);
  return { seats: names, shown: Math.max(START_BOXES, names.length) };
}

// The choice under the format: two grey square toggle buttons (the style of the Starter type chips), one pressed at a time,
// drawn only when the format is offered as a session. Game is pressed unless the draft is a session.
export function modeChoice(draft, redraw) {
  if (!sessionOffered(draft.presetId)) return null;
  const option = (value, text) => {
    const on = sessionOn(draft) === (value === 'session');
    return h('button', {
      type: 'button', class: on ? 'chip mode on' : 'chip mode', id: `setup-mode-${value}`, 'data-mode': value, 'aria-pressed': String(on),
      onclick: () => {
        if (on) return;
        draft.session = value === 'session';
        // A session has no round (7.4): a Round and Room the schedule put in go, unless typed since (1.16.0 review fix).
        if (draft.session && draft.details) draft.details = withoutPicked(draft.details, draft.picked ?? null);
        redraw();
        document.getElementById(`setup-mode-${value}`)?.focus();   // the screen is drawn again: keep the keyboard on the choice
      },
    }, text);
  };
  return h('div', { class: 'chips modes', id: 'setup-mode', role: 'group', 'aria-label': 'Kind of match' },
    option('game', GAME_LABEL), option('session', SESSION_LABEL));
}
