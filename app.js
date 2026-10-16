// The page. Owns the app state, moves between screens, applies each action to the match, saves it,
// and draws the Home screen. The other screens are views in their own files, each given
// (root, state, api). Nothing here is exported.

import { applyAction, derive, RefusedError } from './engine.js';
import { createHistory } from './history.js';
import {
  saveMatch, loadMatch, deleteMatch, setCurrent, getCurrent, parseBackup, mergeDecision, matchKey, detectForeignChange,
} from './storage.js';
import { offerFile, resultLine, fileName } from './files.js';
import { h, newId } from './dom.js';
import { renderSetup } from './view-setup.js';
import { renderScore } from './view-score.js';
import { renderSheet, renderPast } from './view-sheet.js';
import { renderBoard, stopBoard, CHANNEL_NAME } from './view-board.js';
import { VERSION } from './version.js';

// state.screen: which screen is showing. state.match: the match being scored, or null.
// state.history: its undo/redo versions. state.ui: what the current screen is showing (a form
// draft, a selected seat, a message); `go` clears it except for the keys in KEEP_UI.
// state.enteredAt: when the screen was last entered (performance.now()), which the scoring screen
// uses to ignore taps just after it opens. state.foreign: another tab has saved this match.
// state.viewOnly: the match is open only to look at in Past matches (R34), so the room board is not told
// about it unless it is also the match in progress. START is the page's first screen: the room board when
// the address ends in #board (the scorer's Room board menu item opens a window like that), otherwise Home.
const START = location.hash === '#board' ? 'board' : 'home';
const state = { screen: START, match: null, history: null, ui: {}, enteredAt: 0, foreign: false, viewOnly: false };
const KEEP_UI = ['setup'];

// How saving is going (spec 7). `safeAt` is the number of cycles that are safely stored: on this
// device or in a backup file the person has taken.
const save = { ok: true, error: null, safeAt: 0, backupError: null };
const BACKUP_EVERY = 5;

// ---- Screens and the router ----------------------------------------------------------------

const VIEWS = { home: renderHome, setup: renderSetup, score: renderScore, sheet: renderSheet, past: renderPast, board: renderBoard };

const api = {
  go, back, dispatch, dispatchAll, startMatch, setUi, closeSub, ask, undo, redo, setDisplay, editCycle,
  keepAwake, wakeStatus, offerBackup, viewMatch, resumeSaved, deleteSaved, updateReady, applyUpdate,
};

// Moves to a screen, as a history entry (see the back gesture below). `ui` is what the screen starts
// with (the cycle editor opens with its cycle).
function go(screen, ui = {}) {
  if (state.screen === 'board' && screen !== 'board') leaveBoardAddress();
  recordScreen(state.screen, screen);
  show(screen, ui);
}

// Draws a screen, without touching the history.
function show(screen, ui = {}) {
  if (screen !== 'board') stopBoard();
  state.screen = screen;
  state.enteredAt = performance.now();
  state.ui = { ...Object.fromEntries(KEEP_UI.filter(key => state.ui[key]).map(key => [key, state.ui[key]])), ...ui };
  render();
  window.scrollTo(0, 0);
  document.querySelector('#app h1')?.focus({ preventScroll: true });
}

// The Back button on a screen: the screen before this one in the trail (Home if there is none), as the
// phone's back gesture would go.
function back() {
  go(trail.screens.length > 1 ? trail.screens.at(-2) : 'home');
}

// Closes the cycle editor or Edit rules without saving: the scoring screen, or the screen the editor
// was opened from (the scoresheet) when it names one.
function closeSub() {
  const sub = state.ui.sub;
  if (!sub) return;
  if (sub.returnTo) go(sub.returnTo);
  else setUi({ sub: null, msg: '' });
}

// Changes what the current screen shows; redraws unless the caller has already updated the page.
function setUi(patch, redraw = true) {
  Object.assign(state.ui, patch);
  if (redraw) render();
}

function render() {
  renderStatus();
  const root = document.getElementById('app');
  root.replaceChildren();
  root.dataset.screen = state.screen;   // lets index.html give the scoresheet more width
  const view = VIEWS[state.screen] ?? renderHome;
  try {
    view(root, state, api);
  } catch (error) {
    console.error(error);
    root.replaceChildren(h('div', { class: 'unbuilt' }, h('h1', { tabindex: '-1' }, 'Something went wrong'),
      h('p', { class: 'msg' }, String(error?.message ?? error)),
      h('button', { class: 'btn', onclick: () => go('home') }, 'Home')));
  }
  renderForeign();
}

// ---- The match: opening, changing, saving --------------------------------------------------

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The one place a match that came from outside (Resume, a backup file) is given the fields every
// screen reads. A record from an older version may lack `display` or `details` (Task 8 carry), and
// `rev` and `nextCycleNo` are read by the engine's next action.
function withDefaults(match) {
  const cycleNumbers = match.cycles.map(cycle => Number(String(cycle.id).replace(/^c/, ''))).filter(Number.isInteger);
  match.details = { competition: '', venue: '', round: '', reader: '', scorer: '', ...(isObject(match.details) ? match.details : {}) };
  match.display = { leftTeam: 0, seatOrder: 'asc', ...(isObject(match.display) ? match.display : {}) };
  match.teams.forEach(team => {
    team.seats = [0, 1, 2, 3].map(seat => team.seats?.[seat] ?? '');
    team.captain ??= null;
  });
  if (!Number.isInteger(match.rev)) match.rev = 0;
  if (!Number.isInteger(match.nextCycleNo)) match.nextCycleNo = Math.max(match.cycles.length, ...cycleNumbers) + 1;
  return match;
}

// Makes `match` the one on screen, with no earlier versions to undo to. The room board is told unless
// the match is only being looked at (`announce` false: Past matches > View).
function openMatch(match, announce = true) {
  state.match = withDefaults(match);
  state.history = createHistory(state.match);
  state.viewOnly = !announce;
  state.foreign = false;
  save.safeAt = state.match.cycles.length;
  save.backupError = null;
  if (announce) broadcast();
}

// Records how a save went: every result must be ok for the match to count as stored.
function recordSave(results, match) {
  const failed = results.find(result => !result.ok);
  save.ok = !failed;
  save.error = failed ? failed.error : null;
  if (!failed) save.safeAt = match.cycles.length;
}

let persistAsked = false;
function askForPersistentStorage() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    Promise.resolve(navigator.storage?.persist?.()).catch(() => {});
  } catch {
    // The browser has no say to give; the match is still saved as usual.
  }
}

// The screen wake lock (spec 6.2). `refusals` counts requests the browser has turned down since the
// last one it granted. The scoring screen asks again on each scoring tap while the lock is not held.
const wake = { sentinel: null, refusals: 0, pending: false };
async function keepAwake() {
  if (wake.sentinel || wake.pending || !('wakeLock' in navigator)) return;
  wake.pending = true;
  try {
    const sentinel = await navigator.wakeLock.request('screen');
    wake.sentinel = sentinel;
    wake.refusals = 0;
    sentinel.addEventListener('release', () => { if (wake.sentinel === sentinel) wake.sentinel = null; redrawScoring(); });
  } catch {
    wake.refusals += 1;
  }
  wake.pending = false;
  redrawScoring();
}

// 'on' (held), 'pending' (asking), 'lost' (released or refused once: offer a tap to ask again) or
// 'hint' (refused twice, or this browser has no wake lock: suggest a longer Auto-Lock).
function wakeStatus() {
  if (wake.sentinel) return 'on';
  if (!('wakeLock' in navigator) || wake.refusals >= 2) return 'hint';
  return wake.pending ? 'pending' : 'lost';
}

// Redraws the scoring screen when the wake lock changes, unless a sub-screen (the cycle or rules
// editor) is open, whose draft and focus a redraw would disturb.
function redrawScoring() {
  if (state.screen === 'score' && !state.ui.sub) render();
}

// ---- The room board's side of the conversation (spec 6.5) -----------------------------------------
// The board (a screen of this same page, in another tab or window, or in this one) says { kind: 'hello' }
// when it opens, and gets { kind: 'state', match } back, and again after every change. The board never
// writes anything to the match, so nothing here waits for it.

let channel = null;
try {
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = event => { if (event.data?.kind === 'hello') answerHello(); };
} catch {
  // No BroadcastChannel here, so there is no room board to tell.
}

function sendToBoard(match) {
  try {
    channel?.postMessage({ kind: 'state', match });
  } catch {
    // The board is not told this time; it hears the next change.
  }
}

// The board follows the match in progress and nothing else (R34): a match opened only to look at in Past
// matches is not sent, unless it is also the match in progress.
const boardFollows = () => state.match !== null && (!state.viewOnly || state.match.id === getCurrent());

function broadcast() {
  if (boardFollows()) sendToBoard(state.match);
}

// A board has opened. A tab scoring the match in progress answers with it. A tab only looking at an old
// match still knows which match is in progress, and answers with its saved copy. A tab with no match open
// says nothing, so a board with no scorer behind it shows "Waiting for the scorer".
function answerHello() {
  if (boardFollows()) {
    sendToBoard(state.match);
  } else if (state.viewOnly) {
    const id = getCurrent();
    const saved = id ? loadMatch(id) : null;
    if (saved) sendToBoard(saved);
  }
}

// Setup's Start, and a backup file not yet saved here: the match is saved and made the one in
// progress, then scoring begins.
function startMatch(match) {
  askForPersistentStorage();
  openMatch(match);
  recordSave([saveMatch(state.match), setCurrent(state.match.id)], state.match);
  keepAwake();
  go('score');
}

// Resume, and a backup file that is already saved here: the stored copy becomes the match in progress.
function resumeMatch(match) {
  openMatch(match);
  recordSave([setCurrent(state.match.id)], state.match);
  keepAwake();
  go('score');
}

// Every change to the match comes through here: it becomes the match on screen, is saved, the
// screen is redrawn and the room board told. Undo and redo end here too, after giving the restored
// record a fresh rev and changedAt (R27).
function commit(match) {
  state.match = match;
  recordSave([saveMatch(match)], match);
  render();
  broadcast();
}

// Applies actions to the match, in order, as one change (one undo): { ok: true }, or { ok: false,
// error } when the engine refuses one (a RefusedError whose message the screen can show). A refused
// list changes nothing. On success `uiPatch` is merged into state.ui before the redraw, and any
// message is cleared. Nothing is applied while another tab holds a newer copy of the match.
function dispatchAll(actions, uiPatch = {}) {
  if (!state.match) return { ok: false, error: new Error('There is no match open') };
  if (state.foreign) return { ok: false, error: new Error('This match changed in another tab. Reload it before scoring.') };
  let next = state.match;
  try {
    for (const action of actions) next = applyAction(next, action, Date.now());
  } catch (error) {
    if (error instanceof RefusedError) return { ok: false, error };
    throw error;
  }
  state.history.push(next);
  Object.assign(state.ui, { msg: '' }, uiPatch);
  commit(next);
  return { ok: true };
}

function dispatch(action, uiPatch) {
  return dispatchAll([action], uiPatch);
}

// Undo and redo hand back an earlier record, which is saved as a new change: its rev is one past the
// last one saved here, so a rev never repeats with different content (R27). The display settings
// are not part of the history, so they stay as they are now.
function stepHistory(step) {
  if (!state.match || state.foreign) return false;
  const restored = step();
  if (!restored) return false;
  Object.assign(state.ui, { msg: '', selected: null, streakN: 0 });
  commit({ ...restored, display: state.match.display, rev: state.match.rev + 1, changedAt: Date.now() });
  return true;
}
function undo() {
  return stepHistory(() => state.history.undo());
}
function redo() {
  return stepHistory(() => state.history.redo());
}

// Swap sides and Reverse seat order. Display settings never change the scores, so they are saved
// as a change but are not a version to undo.
function setDisplay(patch) {
  if (!state.match || state.foreign) return;
  commit({ ...state.match, display: { ...state.match.display, ...patch }, rev: state.match.rev + 1, changedAt: Date.now() });
}

// Opens the cycle editor (spec 6.4) on one cycle. The scoresheet passes the screen to come back to
// when the editor is left ('sheet'); with none, it returns to scoring.
function editCycle(cycleId, returnTo = null) {
  go('score', { sub: { kind: 'cycle', cycleId, returnTo } });
}

// ---- Past matches (spec 6.7) ---------------------------------------------------------------

// View: the saved match opens on its scoresheet, without becoming the match in progress. Resume: the
// saved copy becomes the match in progress and scoring carries on. Both come back { ok: true }, or
// { ok: false, error } with a sentence for the person when the record cannot be read.
const UNREADABLE = 'That match cannot be read. It may be damaged; Delete or Remove takes it off the list.';
function viewMatch(id) {
  const match = loadMatch(id);
  if (!match) return { ok: false, error: UNREADABLE };
  openMatch(match, false);
  go('sheet');
  return { ok: true };
}
function resumeSaved(id) {
  const match = loadMatch(id);
  if (!match) return { ok: false, error: UNREADABLE };
  resumeMatch(match);
  return { ok: true };
}
// Takes the match off this device (and its line off the list). If it is the one open in memory, that
// copy goes too, so nothing saves it back.
function deleteSaved(id) {
  const result = deleteMatch(id);
  if (result.ok && state.match?.id === id) {
    state.match = null;
    state.history = null;
  }
  return result;
}

// ---- Another tab (spec: Review Focus 5) -----------------------------------------------------

// A saved copy of this match with a higher rev than the one last saved here means another tab has
// been saving it. That tab and this one would write over each other, so this one stops. Only the
// screens that show the match are stopped: Resume on Home always opens the saved copy afresh.
function checkForeign() {
  if (!state.match || state.foreign || !MATCH_SCREENS.includes(state.screen)) return;
  const stored = loadMatch(state.match.id);
  if (!stored) return;
  const newer = detectForeignChange(state.match.rev, stored)
    || (stored.rev === state.match.rev && stored.changedAt !== state.match.changedAt);
  if (!newer) return;
  state.foreign = true;
  render();
}

// Takes up the copy another tab saved: the saved match is opened afresh, on the scoring screen.
function reloadFromStorage() {
  const fresh = state.match ? loadMatch(state.match.id) : null;
  if (fresh) resumeMatch(fresh);
  else { state.foreign = false; go('home'); }
}

const MATCH_SCREENS = ['score', 'sheet'];
function renderForeign() {
  document.getElementById('foreign')?.remove();
  if (!state.foreign || !MATCH_SCREENS.includes(state.screen)) return;
  document.body.append(h('div', { class: 'dialog', id: 'foreign', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'This match changed in another tab' },
    h('div', { class: 'card' },
      h('b', {}, 'This match changed in another tab'),
      h('p', { class: 'dtext' }, 'Another tab has saved changes to this match, so scoring here has stopped. Reload to carry on from the saved copy. Anything done here since the other tab saved is not kept.'),
      h('button', { type: 'button', class: 'btn primary', id: 'foreign-reload', onclick: reloadFromStorage }, 'Reload'))));
}

window.addEventListener('storage', event => { if (state.match && event.key === matchKey(state.match.id)) checkForeign(); });
window.addEventListener('focus', checkForeign);
window.addEventListener('pageshow', checkForeign);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (state.screen === 'score' || state.screen === 'board') keepAwake();
  checkForeign();
  worker.registration?.update().catch(() => {});   // a home-screen app is resumed, not reloaded: look for a new version now
});

// ---- The phone's back gesture (R32) ---------------------------------------------------------
// Every screen change through go() is a history entry, so the back gesture goes to the screen before
// instead of leaving the page. `screens` is the trail, and screens[0] is Home, the entry the page opened
// on. Going to a screen that is already in the trail goes back to its entry (Home always is), so the
// trail never piles up and back from Home leaves the page as usual. A dialog, the cycle editor and Edit
// rules are not entries: back closes them and the entry is put back. Each entry carries this page
// load's `session`, so entries left by an earlier load of the page (after a reload) are skipped. The
// address is left alone, except that going from the room board to another screen drops a #board from it
// (leaveBoardAddress), so a reload there does not open the board again. A page opened at #board starts
// with the board as its first entry, where Home is otherwise.

const trail = {
  session: newId(),
  screens: [START],
  waiting: 0,    // popstate events caused by our own history.go(), which are not the person's back
  queue: [],     // history writes held back until those events have come, so they land on the right entry
  timer: null,
  layer: false,  // an entry is pushed above Home while a dialog is open on it (see raiseLayer)
};

const entry = screen => ({ scorer: true, session: trail.session, screen, depth: trail.screens.length - 1 });

function writeHistory(method, value) {
  const write = () => {
    try {
      history[method](value, '');
    } catch {
      // No history to write to; the screens still work, the back gesture just leaves the page.
    }
  };
  if (trail.waiting > 0) trail.queue.push(write);
  else write();
}

function settle() {
  clearTimeout(trail.timer);
  trail.waiting = 0;
  for (const write of trail.queue.splice(0)) write();
}

// Moves through history by `delta` entries, and ignores the popstate events that causes.
function traverse(delta) {
  trail.waiting += 1;
  clearTimeout(trail.timer);
  trail.timer = setTimeout(settle, 400);
  try {
    history.go(delta);
  } catch {
    settle();
  }
}

// Called by go() before the screen changes.
function recordScreen(from, to) {
  const top = trail.screens.length - 1;
  if (to === from) {
    writeHistory('replaceState', entry(to));
    return;
  }
  const below = top > 0 ? trail.screens.lastIndexOf(to, top - 1) : -1;
  if (below >= 0) {
    trail.screens.length = below + 1;
    traverse(below - top);
    return;
  }
  trail.screens.push(to);
  writeHistory('pushState', entry(to));
}

// Home is the page's first entry, so with a dialog open on it (the paste box) back would leave the page:
// there is no entry below it to pop. While a dialog is open there, an entry marked `layer` is pushed on
// top, so back pops that instead and closes the dialog; the dialog closing any other way pops it again.
function raiseLayer() {
  if (trail.screens.length !== 1 || trail.layer) return;
  trail.layer = true;
  writeHistory('pushState', { ...entry(state.screen), layer: true });
}

// A dialog has closed. `popped`: the back gesture did it, and has already removed the layer entry.
function settleLayer(popped) {
  if (!trail.layer) return;
  if (openAsks.length > 0) {
    if (popped) writeHistory('pushState', { ...entry(state.screen), layer: true });   // another dialog is still open
  } else {
    trail.layer = false;
    if (!popped) traverse(-1);
  }
}

// A back that must not change screen: the entry we were on is put back, so the next back asks again.
function holdEntry(was, to) {
  if (was - to === 1) writeHistory('pushState', entry(state.screen));
  else traverse(was - to);
}

async function leaveMatch() {
  const body = save.ok
    ? 'The match is saved on this device. Resume on the Home screen brings it back.'
    : 'This match is not saved on this device (see the notice at the top). Take a backup file first, or Resume will not find it.';
  const choice = await ask({
    title: 'Leave the match?', body,
    buttons: [{ label: 'Stay', value: 'cancel', primary: true }, { label: 'Go to Home', value: 'home' }],
  });
  if (choice === 'home') go('home');
}

function onBack(event) {
  if (trail.waiting > 0) {
    trail.waiting -= 1;
    if (trail.waiting === 0) settle();
    return;
  }
  const target = event.state;
  if (!target?.scorer) return;                     // not one of our entries (a hash link, say)
  if (target.session !== trail.session) {          // left by an earlier load of the page: skip it
    history.back();
    return;
  }
  const was = trail.screens.length - 1;
  const to = target.depth;
  if (trail.layer && !target.layer && to === was && openAsks.length > 0) {   // the layer above Home: close the dialog
    openAsks.at(-1)('cancel', true);
    return;
  }
  if (to >= was) {                                 // forward: the app never goes forward, so undo it
    if (to > was) traverse(was - to);
    return;
  }
  if (openAsks.length > 0 || document.getElementById('foreign')) {
    openAsks.at(-1)?.('cancel');                   // a dialog is open: back closes it (the modal for another tab's change stays)
    holdEntry(was, to);
  } else if (state.screen === 'score' && state.ui.sub) {
    holdEntry(was, to);                            // the editor: back discards it, as Cancel does
    closeSub();
  } else if (state.screen === 'score') {
    holdEntry(was, to);                            // the match: ask before leaving it
    leaveMatch();
  } else {
    trail.screens.length = to + 1;
    show(trail.screens[to]);
  }
}

window.addEventListener('popstate', onBack);
try {
  history.replaceState(entry(START), '');          // the page's first entry: not pushed, so back from Home leaves
} catch {
  // As above.
}

// The address changed to end in #board in a page that is already open: a board window reused by the menu's
// Room board after Back took it Home, or the address typed. A change of only the #fragment loads nothing, so the
// page loads itself again, and a page that opens at #board opens on the board. (Leaving the board drops the
// #board from its entry, so going back through history never lands on an address that would do this.)
window.addEventListener('hashchange', () => { if (location.hash === '#board' && state.screen !== 'board') location.reload(); });

// Leaving the room board for another screen: the address loses its #board, on the entry it is in.
function leaveBoardAddress() {
  if (location.hash !== '#board' || trail.waiting > 0) return;
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  } catch {
    // The address stays as it is.
  }
}

// ---- Dialogs: the only way to ask "are you sure?" ----------------------------------------------

// Shows an in-page dialog and resolves with the value of the button chosen. `body` is a string, a
// node or a list of either (a string becomes a paragraph). `buttons` are { label, value, primary,
// disabled } or plain strings. Escape resolves 'cancel'. The first field in the body is focused, or
// else the button whose value is 'cancel', so Enter cannot confirm something destructive by accident.
const FIELDS = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';
const openAsks = [];   // the dialogs showing, newest last: each is the function that closes it with a value
function ask({ title, body = [], buttons = [] }) {
  return new Promise(resolve => {
    const specs = buttons.map(button => (typeof button === 'string' ? { label: button, value: button } : button));
    const finish = (value, popped = false) => {
      document.removeEventListener('keydown', onKey, true);
      openAsks.splice(openAsks.indexOf(finish), 1);
      dialog.remove();
      settleLayer(popped);
      resolve(value);
    };
    const choices = specs.map(spec => h('button', {
      type: 'button', class: spec.primary ? 'btn primary' : 'btn', disabled: spec.disabled === true, 'data-value': spec.value,
      onclick: () => finish(spec.value),
    }, spec.label));
    const content = [body].flat().map(part => (typeof part === 'string' ? h('p', { class: 'dtext' }, part) : part));
    const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'card' }, h('b', {}, title), content, h('div', { class: 'stack' }, choices)));
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish('cancel');
      } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.type !== 'checkbox') {
        event.preventDefault();
        event.stopPropagation();
        (choices.find(button => button.classList.contains('primary') && !button.disabled) ?? choices.find(button => !button.disabled))?.click();
      } else if (event.key === 'Tab') {
        const items = [...dialog.querySelectorAll(FIELDS)];
        if (items.length === 0) return;
        const at = items.indexOf(document.activeElement);
        const next = items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length];
        event.preventDefault();
        next.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    openAsks.push(finish);
    raiseLayer();
    document.body.append(dialog);
    (dialog.querySelector('input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? choices.find(button => button.dataset.value === 'cancel') ?? choices[0])?.focus();
  });
}

// ---- Save status: the strip above every screen ---------------------------------------------

const backupDue = () => !save.ok && state.match !== null && state.match.cycles.length - save.safeAt >= BACKUP_EVERY;

async function offerBackup() {
  const match = state.match;
  const result = await offerFile({ name: fileName(match, 'json'), type: 'application/json', text: JSON.stringify(match, null, 2) });
  if (result.ok) {
    save.safeAt = match.cycles.length;
    save.backupError = null;
  } else if (!result.cancelled) {
    save.backupError = result.error ?? 'The backup file could not be offered.';
  }
  renderStatus();
  return result;
}

function renderStatus() {
  const box = document.getElementById('status');
  box.replaceChildren();
  if (!save.ok) {
    const notice = h('div', { class: 'notice' },
      h('b', {}, 'Not saved on this device'),
      h('span', {}, 'This match is only on the screen. Keep this page open, and save a backup file every few questions.'));
    if (backupDue()) {
      notice.append(h('button', { class: 'btn', id: 'backup-offer', onclick: offerBackup }, 'Save a backup file now'));
    }
    if (save.backupError) notice.append(h('span', {}, save.backupError));
    box.append(notice);
  }
  if (worker.waiting && state.screen !== 'board' && state.screen !== 'score') {
    box.append(h('div', { class: 'update', id: 'update-ready' },
      h('b', {}, 'Update ready: reload when the match is over'),
      h('button', { class: 'btn', id: 'update-reload', onclick: applyUpdate }, 'Reload')));
  }
}

// ---- Offline copy and updates (spec 3.1) ---------------------------------------------------------
// sw.js keeps every site file, so the scorer opens with no signal. A new version installs beside the old and
// waits; when it is ready this page says so, and only the Reload button (never the page itself) lets it take
// over. A match is saved after every change, so a reload loses nothing. The notice sits above Home, Past
// matches, Setup and the scoresheet; it is never drawn on the scoring screen (R36), because it would push the
// buttons down just as the scorer taps, and there it is one line in the menu (view-score.js, api.updateReady).

const worker = { waiting: null, reloading: false, registration: null };

function updateReady() {
  return worker.waiting !== null;
}

function offerUpdate(waiting) {
  worker.waiting = waiting;
  renderStatus();
}

function watchRegistration(registration) {
  worker.registration = registration;
  const hasOldWorker = () => navigator.serviceWorker.controller !== null;   // false on the very first visit: nothing to update
  if (registration.waiting && hasOldWorker()) offerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && hasOldWorker()) offerUpdate(installing);
    });
  });
}

function applyUpdate() {
  worker.reloading = true;
  worker.waiting?.postMessage({ type: 'skipWaiting' });
  setTimeout(() => location.reload(), 3000);   // if the new worker never takes over, reload anyway rather than leave a dead button
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (worker.reloading) location.reload(); });
  Promise.resolve()
    .then(() => navigator.serviceWorker.register('sw.js'))
    .then(watchRegistration)
    .catch(() => {});   // an insecure address, or a browser with workers off: the page works, just not offline
}
if (document.readyState === 'complete') registerWorker();
else window.addEventListener('load', registerWorker);

// ---- Home (spec 6.1) -----------------------------------------------------------------------

function isStandalone() {
  return navigator.standalone === true || globalThis.matchMedia?.('(display-mode: standalone)').matches === true;
}

// A browser tab on an iPhone or iPad running Safari, not a scorer already added to the home screen.
function isIosSafariTab() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) && !isStandalone();
}

const pad = n => String(n).padStart(2, '0');
function dateAndTime(ms) {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// A backup file's text becomes the match in progress. A match with the same id already saved here
// is compared by mergeDecision (spec 7): nothing is overwritten until the person chooses.
function openBackupText(text) {
  const read = parseBackup(text);
  if (!read.ok) return setUi({ loadError: read.error, clash: null });
  const incoming = read.match;
  const existing = loadMatch(incoming.id);
  const decision = mergeDecision(existing, incoming);
  if (decision === 'same') return resumeMatch(existing);
  if (decision === 'new') return startMatch(incoming);
  return setUi({ loadError: null, clash: { incoming, existing, decision } });
}

async function openBackupFile(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    return setUi({ loadError: 'That file could not be read.', clash: null });
  }
  openBackupText(text);
}

// Load backup, pasted: the backup's text goes in a box in a dialog (so the phone's back gesture closes
// it). Text that is not a backup is explained in the dialog, which stays open with the text still in it;
// text that is one carries on exactly as a file does, including the replace or keep both choice.
async function pasteBackup() {
  let text = '';
  let error = '';
  for (;;) {
    const box = h('textarea', {
      id: 'paste-box', rows: '8', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
      placeholder: 'Paste the whole text of a backup file here', 'aria-label': 'Backup text',
    });
    box.value = text;
    const choice = await ask({
      title: 'Paste backup text',
      body: ['Open the backup file in any app that shows text, copy all of it, and paste it here.',
        error ? h('p', { class: 'msg', id: 'paste-error' }, error) : null, box].filter(Boolean),
      buttons: [{ label: 'Load this backup', value: 'load', primary: true }, { label: 'Cancel', value: 'cancel' }],
    });
    if (choice !== 'load') return;
    text = box.value;
    const read = parseBackup(text);
    if (read.ok) {
      setUi({ loadError: null }, false);
      return openBackupText(text);
    }
    error = read.error;
  }
}

const summary = match => resultLine(match, derive(match));

function clashCard({ incoming, existing, decision }) {
  return h('div', { class: 'card', id: 'clash' },
    h('b', {}, 'This match is already saved on this device'),
    h('p', { class: 'hint' }, `Saved here: ${summary(existing)}.`),
    h('p', { class: 'hint' }, `In the file: ${summary(incoming)}.`),
    h('p', { class: 'hint' }, decision === 'incomingNewer' ? 'The file has the newer copy.' : 'The saved copy is the newer one.'),
    h('button', { class: 'btn', id: 'clash-replace', onclick: () => startMatch(incoming) }, 'Replace the saved copy with the file'),
    h('button', { class: 'btn', id: 'clash-both', onclick: () => startMatch({ ...incoming, id: newId() }) }, 'Keep both (the file gets a new id)'),
    h('button', { class: 'btn', onclick: () => setUi({ clash: null }) }, 'Cancel'));
}

function renderHome(root, state) {
  const current = getCurrent();
  const inProgress = current ? loadMatch(current) : null;
  const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'backup-file' });
  picker.addEventListener('change', () => { const [file] = picker.files; picker.value = ''; openBackupFile(file); });

  const menu = h('div', { class: 'menu' },
    h('button', { class: 'btn primary', id: 'new-match', onclick: () => go('setup') }, 'New match'),
    inProgress ? h('div', { class: 'card', id: 'resume-card' },
      h('b', {}, 'Match in progress'),
      h('span', { class: 'resume-line' }, summary(inProgress)),
      h('span', { class: 'hint' }, `Last changed ${dateAndTime(inProgress.changedAt)}`),
      h('button', { class: 'btn primary', id: 'resume', onclick: () => resumeMatch(inProgress) }, 'Resume')) : null,
    h('button', { class: 'btn', id: 'past-matches', onclick: () => go('past') }, 'Past matches'),
    h('button', { class: 'btn', id: 'room-board', onclick: () => go('board') }, 'Room board'),
    h('button', { class: 'btn', id: 'load-backup', onclick: () => picker.click() }, 'Load backup file'),
    h('button', { class: 'btn', id: 'paste-backup', onclick: pasteBackup }, 'Paste backup text'),
    picker,
    state.ui.loadError ? h('p', { class: 'msg', id: 'load-error' }, state.ui.loadError) : null,
    state.ui.clash ? clashCard(state.ui.clash) : null);

  root.append(
    h('div', { class: 'top' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Skor'), h('p', { class: 'tagline' }, 'Match scorer'))),
    menu,
    h('div', { class: 'notes' },
      h('p', { class: 'hint', id: 'device-note' }, 'Matches are kept on this device only. Nothing is sent anywhere. Save a backup file at halftime and at the end.'),
      isIosSafariTab()
        ? h('p', { class: 'hint', id: 'ios-hint' }, 'On an iPhone, Safari can clear a website\'s saved data after seven days unused. Tap Share, then Add to Home Screen, and open the scorer from there to keep your matches.')
        : null,
      h('p', { class: 'hint', id: 'version' }, `Version ${VERSION}`)));   // so a phone can show which version it runs
}

render();
