// The scoring screen's menu in two levels (review 19/10/2026, change 2; Tom's decision 2). Menu holds the eleven
// buttons used mid-match, in three groups; More holds the other nine. Each panel has a fixed header with its title and
// Close (and, on More, a Menu button back). A greyed button keeps its label and says why on a second line, and a
// Timeout names its team in full on its second line, so two long names never read the same. The two settings in More
// switch in place and show their state, without closing the panel. menuModel() is pure, for the tests; showMenu()
// draws a panel with app.js's ask() and resolves with the value chosen, or 'cancel'.

import { clockRunning } from './clock.js';
import { h } from './dom.js';
import { teamName, leftRight } from './view-common.js';

const group = (title, ...items) => ({ title, items });

// What each panel holds. `opts`: { keysOn, namesHidden, updateReady }. An item is { value, label } plus, where it
// applies, `sub` (the second line), `disabled`, `full` (the whole row on a phone), and `toggle` with `pressed`.
export function menuModel(match, d, { keysOn, namesHidden, updateReady }) {
  const { phase } = d;
  const timeDone = match.markers.some(m => m.type === 'timeCalled');
  const threeStarters = phase.overtime?.mode === 'threeStarters';
  const firstDone = d.cycles.some(x => x.closed);
  const halftimeOk = phase.halftimeAfterCycleId !== null || (!phase.ended && !phase.regulationOver && firstDone);
  const swapReady = d.open.cycleId === null;   // a swap is made between questions (the engine refuses it while one is open)
  const aim = d.open.cycleId ?? d.cycles.at(-1)?.id ?? null;   // Protest and Throw out act on the open question, else the last
  const over = phase.ended ? 'match over' : null;
  const why = (disabled, reason) => (disabled ? { disabled: true, sub: reason } : { disabled: false });
  const timeWhy = over ?? (timeDone ? 'already called' : phase.regulationOver ? 'regulation over' : null);
  const halftimeWhy = halftimeOk ? null : over ?? (phase.regulationOver ? 'regulation over' : 'after the first question');
  const endWhy = over ?? (threeStarters ? 'not before the third overtime starter' : null);
  const timeout = team => ({ value: `timeout${team}`, label: 'Timeout', sub: teamName(match, team), disabled: phase.ended });

  const menu = [
    group('Clock and time',
      { value: 'clock', label: clockRunning(match) ? 'Pause clock' : 'Start clock', ...why(phase.ended, over) },
      { value: 'time', label: 'Time called', ...why(timeWhy !== null, timeWhy) },
      ...leftRight(match).map(timeout),
      { value: 'halftime', label: 'Halftime (score check)', full: true, ...why(!halftimeOk, halftimeWhy) }),
    group('Players and questions',
      { value: 'subs', label: 'Swap players', full: true, ...why(!swapReady, 'between questions only') },
      { value: 'protest', label: 'Protest', ...why(!aim, 'no question yet') },
      { value: 'throwout', label: 'Throw out', ...why(!aim, 'no question yet') }),
    group('Match',
      { value: 'sheet', label: 'Scoresheet and stats' },
      { value: 'more', label: 'More…', ...(updateReady ? { sub: 'Update ready' } : {}) },
      { value: 'end', label: 'End match', full: true, ...why(endWhy !== null, endWhy) }),
  ];
  const more = [
    group('Screen and keys',
      { value: 'swap', label: 'Swap sides' },
      { value: 'reverse', label: 'Reverse seat order' },
      { value: 'keys', label: 'Single-key shortcuts', full: true, toggle: true, pressed: keysOn, sub: keysOn ? 'on' : 'off' }),
    group('Room board',
      { value: 'board', label: 'Open room board', full: true },
      { value: 'boardnames', label: 'Player names on board', full: true, toggle: true, pressed: !namesHidden, sub: namesHidden ? 'hidden' : 'shown' }),
    group('Rules, files, leaving',
      { value: 'rules', label: 'Edit rules' },
      { value: 'print', label: 'Print' },
      { value: 'files', label: 'Save files' },
      { value: 'home', label: 'Home' }),
  ];
  return { menu, more };
}

// One button of a panel. A toggle sets its state on the button itself, so the panel stays open.
function itemButton(item, finish, onToggle) {
  const subLine = text => h('span', { class: 'sub' }, text);
  const button = h('button', {
    type: 'button', class: ['btn', item.full ? 'full' : '', item.sub ? 'two' : ''].filter(Boolean).join(' '),
    disabled: item.disabled === true, 'data-value': item.value, 'aria-pressed': item.toggle ? String(item.pressed) : null,
  }, item.sub ? [h('span', {}, item.label), subLine(item.sub)] : item.label);
  button.addEventListener('click', () => {
    if (!item.toggle) { finish(item.value); return; }
    const next = onToggle(item.value);   // the item as it is now
    button.setAttribute('aria-pressed', String(next.pressed));
    button.querySelector('.sub').textContent = next.sub;
  });
  return button;
}

const panelBody = (groups, finish, onToggle) => h('div', { class: 'mgroups' }, groups.map(entry =>
  h('section', { class: 'mgroup' }, h('h3', {}, entry.title),
    h('div', { class: 'mbtns' }, entry.items.map(item => itemButton(item, finish, onToggle))))));

// Shows Menu, and More when it is chosen, until a button that acts (or Close) is pressed. `model()` gives the panels
// as they are now; `onToggle(value)` switches a setting and returns nothing. The More panel carries the update line.
export async function showMenu(api, model, onToggle) {
  let panel = 'menu';
  for (;;) {
    const groups = model()[panel];
    const toggled = value => { onToggle(value); return model()[panel].flatMap(entry => entry.items).find(item => item.value === value); };
    const update = panel === 'more' && api.updateReady()
      ? h('div', { class: 'updateline', id: 'menu-update' },
        h('span', {}, 'Update ready: reload when the match is over'),
        h('button', { type: 'button', class: 'btn', id: 'menu-update-reload', onclick: () => api.applyUpdate() }, 'Reload'))
      : null;
    const choice = await api.ask({
      title: panel === 'menu' ? 'Menu' : 'More', head: true, menu: true,
      back: panel === 'more' ? { label: 'Menu', value: 'back' } : null,
      body: finish => [update, panelBody(groups, finish, toggled)],
    });
    if (choice === 'more') panel = 'more';
    else if (choice === 'back') panel = 'menu';
    else return choice;
  }
}
