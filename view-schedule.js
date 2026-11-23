// The afternoon link's receive screen (Skor 1.16.0, SPEC-partB 7.5): what an "#s1." link opens, or one pasted on Home.
// "Afternoon schedule for Teapot Trophy 8 (made 13:52)", the rounds and rooms with their teams, and Use this schedule,
// Just look and Cancel. Use puts the link's rounds into the tournament file kept on this device (tournament.js
// keepAfternoon), asking first when the link is older than the one used here or names another tournament; the Round and
// Room pickers in Setup then show real teams. Just look shows the same list with only Close and saves nothing, for a player
// who only wants to see where they play. The link is read and checked in schedule-link.js; names go in as text only.

import { h } from './dom.js';
import { copyText, isIosSafariTab, ensureStyles } from './view-common.js';
import { readScheduleLink, afternoonLines, madeAt, useQuestion } from './schedule-link.js';
import { readSavedTournament, keepAfternoon } from './tournament.js';

const titleOf = afternoon => {
  const made = madeAt(afternoon.made);
  return `Afternoon schedule${afternoon.name ? ` for ${afternoon.name}` : ''}${made ? ` (made ${made})` : ''}`;
};

// The rounds, each a heading and its rooms: "Room 2: Kelpie A v Puffin".
function roundList(afternoon) {
  ensureStyles('schedule-list-css', '.sched-list { display: grid; gap: 6px; } .sched-list h3 { margin: 0; font-size: 1em; }'
    + ' .sched-list ul { margin: 0; padding-left: 18px; } .sched-list li { overflow-wrap: anywhere; }');
  const { rounds } = afternoonLines(afternoon);
  return h('div', { class: 'sched-list', id: 'sched-rounds' },
    rounds.map(round => h('section', {}, h('h3', {}, round.title), h('ul', {}, round.games.map(game => h('li', {}, game))))));
}

// A link opened (or pasted on Home): a damaged one says what to do; a good one shows what it holds.
export async function offerSchedule(link, api) {
  const read = await readScheduleLink(link);
  if (!read.ok) return api.ask({ title: 'This link cannot be opened', body: read.error, buttons: [{ label: 'Close', value: 'cancel', primary: true }] });
  return showSchedule(read.afternoon, read.link, api);
}

// The schedule and the choice. In a Safari tab on an iPhone, which keeps its own copy of the tournament file apart from
// the home-screen Skor, it says how to take the link there. Cancel (or the back gesture) changes nothing.
export async function showSchedule(afternoon, link, api) {
  const { summary } = afternoonLines(afternoon);
  const box = h('textarea', { readonly: '', rows: '3', id: 'sched-box', 'aria-label': 'The link', spellcheck: 'false', hidden: true });
  const status = h('p', { class: 'hint', id: 'sched-msg', role: 'status', hidden: true });
  const copy = async () => {
    box.value = link;
    status.hidden = false;
    status.textContent = await copyText(link, box) ? 'Link copied.' : 'Select the whole link above and copy it.';
  };
  const safari = isIosSafariTab() ? [
    h('p', { class: 'dtext', id: 'sched-safari' }, 'This is Safari, not your home-screen Skor, which keeps its own tournament file. To use it there: Copy link, open Skor from your home screen, Paste backup text.'),
    h('button', { type: 'button', class: 'btn', id: 'sched-copy', onclick: copy }, 'Copy link'), box, status,
  ] : [];
  // The buttons come first: a 40-team afternoon is 140 lines, and Use should not be below them all.
  const choice = await api.ask({
    title: titleOf(afternoon),
    body: [h('p', { class: 'dtext', id: 'sched-summary' }, summary), ...safari, roundList(afternoon)],
    buttons: [{ label: 'Use this schedule', value: 'use', primary: true }, { label: 'Just look', value: 'look' }, { label: 'Cancel', value: 'cancel' }],
    first: true,
  });
  if (choice === 'use') return useSchedule(afternoon, api);
  if (choice === 'look') {
    return api.ask({ title: titleOf(afternoon), body: [h('p', { class: 'dtext' }, summary), roundList(afternoon)], buttons: [{ label: 'Close', value: 'cancel', primary: true }], first: true });
  }
  return undefined;
}

// Use this schedule: asks first when the link is older than the one used here ("You already have the 13:58 schedule"),
// or when the kept file is another tournament's (replacing it keeps team names only); then keeps it and says what next.
export async function useSchedule(afternoon, api) {
  const saved = readSavedTournament();
  const question = useQuestion(saved, afternoon);
  let fresh = false;
  if (question === 'older') {
    const choice = await api.ask({
      title: 'An older schedule',
      body: `You already have the ${madeAt(saved.linkMade)} schedule. Use this older one (made ${madeAt(afternoon.made)})?`,
      buttons: [{ label: 'Keep the newer one', value: 'cancel', primary: true }, { label: 'Use the older one', value: 'use' }],
    });
    if (choice !== 'use') return undefined;
  } else if (question === 'other') {
    const choice = await api.ask({
      title: 'Another tournament',
      body: `This phone's tournament file is ${saved.name}, not ${afternoon.name}. Replace it? Players will be typed.`,
      buttons: [{ label: 'Replace it', value: 'replace', primary: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'replace') return undefined;
    fresh = true;
  }
  const kept = keepAfternoon(afternoon, undefined, fresh);
  if (!kept.ok) return api.ask({ title: 'Not saved', body: kept.error, buttons: [{ label: 'Close', value: 'cancel', primary: true }] });
  api.setUi({});   // Setup, if it is open, draws its pickers again with the afternoon's teams
  return api.ask({
    title: 'Afternoon schedule saved',
    body: ['In Setup, pick the round and your room.', kept.names ? 'The link holds team names only, so type the players.' : null],
    buttons: [{ label: 'OK', value: 'ok', primary: true }],
  });
}
