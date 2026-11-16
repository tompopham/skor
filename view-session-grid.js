// A buzzer session's places on the scoring screen (spec 6.5, layout A): each team's column is a grid two places across, the
// name on the top line and the points under it in smaller text, places left to right and row by row, Other last and the same
// size. An empty place is a blank grey box that does nothing. The places are screenPlaces() (session.js), which is also the
// order of the keys 1 to 9, 0 and - (keys.js), so a key hint on a place is the key that picks it. placeCells() is pure, for the
// tests; sessionTeamGrid() draws one team's grid. A game never comes here: its four seats are drawn by view-score.js.

import { h } from './dom.js';
import { screenPlaces, OTHER_PLACE } from './session.js';
import { sessionKeyLabels } from './keys.js';
import { playerName } from './lineup.js';
import { fmt, teamName } from './view-common.js';

// One team's cells in screen order: { place, id, name, points, key }. `seats` is who sits where now (keys.js sittingNow),
// and `shift` is true for the team the Shift keys pick, whose hint reads "⇧1". The points are the player's own.
export function placeCells(match, d, seats, team, shift) {
  return screenPlaces(match, team).map((place, index) => {
    const id = seats[team][place] ?? null;
    const name = id === null ? '' : playerName(match, team, id);
    const points = d.stats.players[team].find(player => player.id === id)?.tossupPoints ?? 0;
    return { place, id, name, points, key: `${shift ? '⇧' : ''}${sessionKeyLabels[index]}` };
  });
}

// `info(c, team, place)` is the scoring screen's test of whether a place can answer now, passed in so this file need not
// import the screen. `column` is 0 for the team on the left, 1 for the one on the right.
export function sessionTeamGrid(c, team, column, info) {
  const { match, d, ui, api } = c;
  const cells = placeCells(match, d, c.seats, team, column === 1);
  return h('div', { class: 'pgrid', 'data-team': team }, cells.map(cell => {
    const can = info(c, team, cell.place);
    const on = ui.selected?.team === team && ui.selected?.seat === cell.place;
    const filled = cell.name !== '';
    return h('button', {
      type: 'button', class: [on ? 'seat on' : 'seat', 'pl', cell.place === OTHER_PLACE ? 'other' : ''].filter(Boolean).join(' '),
      disabled: !can.on, 'aria-pressed': String(on), 'data-team': team, 'data-seat': cell.place,
      'aria-label': filled ? `${teamName(match, team)}, ${cell.name}, ${cell.points} points` : `${teamName(match, team)}, place ${cell.place + 1}, empty`,
      onclick: c.tap(() => api.setUi({ selected: on ? null : { team, seat: cell.place }, msg: '', streakN: 0, hint: null })),
    },
    h('span', { class: 'nm' }, filled ? [h('span', { class: 'key' }, cell.key), cell.name] : ''),
    h('span', { class: 'pt' }, filled ? fmt(cell.points) : ''));
  }));
}
