// Saving on the device (spec section 7): the match records and a small index of them, the match
// in progress, the saved player names and the settings, plus reading a backup file and the two
// checks that stop one copy of a match writing over another. Every function takes the store as
// its last argument (anything with getItem, setItem and removeItem, localStorage by default) and
// none of them ever throws: a refused write comes back as { ok: false, error } and an unreadable
// entry as null or an empty list, so a full or blocked store can never break the page.

import { derive } from './engine.js';

export const KEYS = {
  index: 'scorer.index',
  current: 'scorer.current',
  roster: 'scorer.roster',
  settings: 'scorer.settings',
};
export const matchKey = id => `scorer.match.${id}`;

// What stands in when the browser has no localStorage at all, or will not even hand it over (a
// blocked-storage setting can make reading `localStorage` itself throw).
const NO_STORE = {
  getItem() { throw new Error('This browser has no storage for saved matches'); },
  setItem() { throw new Error('This browser has no storage for saved matches'); },
  removeItem() { throw new Error('This browser has no storage for saved matches'); },
};
function defaultStore() {
  try {
    return globalThis.localStorage ?? NO_STORE;
  } catch {
    return NO_STORE;
  }
}

const messageOf = error => String(error?.message ?? error);

// Runs a job that writes to the store; { ok: true }, or { ok: false, error } if anything threw.
function attempt(job) {
  try {
    job();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

// The JSON stored under a key, or `fallback` when there is none, it is not JSON, or the store throws.
function readJSON(store, key, fallback) {
  try {
    const text = store.getItem(key);
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---- Matches and the index ------------------------------------------------------------------

// What the Past matches list needs to show a match without opening it.
const summaryOf = match => ({
  id: match.id, createdAt: match.createdAt, changedAt: match.changedAt,
  teams: [match.teams[0].name, match.teams[1].name],
  scores: derive(match).scores,
  preset: match.rules.name,
});

// The entries in the index's text, minus anything in it that is not an entry. Text that is missing
// or damaged reads as an empty index: the store cannot list its keys, so the matches a damaged
// index named cannot be found again (they are still there).
function entriesIn(text) {
  let list = [];
  try {
    list = text === null || text === undefined ? [] : JSON.parse(text);
  } catch {
    list = [];
  }
  return Array.isArray(list) ? list.filter(entry => isObject(entry) && typeof entry.id === 'string') : [];
}

// The saved index. A store that cannot be read throws rather than reading as empty, so a failed read
// never leads to the index being written over (the callers catch it).
const readIndex = store => entriesIn(store.getItem(KEYS.index));

// Saves the whole record and updates its line in the index. The record goes first: if only the
// index write fails the match is kept but this reports the failure, and the next save repairs the index.
export function saveMatch(match, store = defaultStore()) {
  return attempt(() => {
    if (typeof match?.id !== 'string' || match.id === '') throw new Error('The match has no id');
    const summary = summaryOf(match);
    store.setItem(matchKey(match.id), JSON.stringify(match));
    const index = readIndex(store).filter(entry => entry.id !== match.id);
    index.push(summary);
    store.setItem(KEYS.index, JSON.stringify(index));
  });
}

// The saved match, ready for the engine, or null if there is none or it cannot be read.
export function loadMatch(id, store = defaultStore()) {
  try {
    const text = store.getItem(matchKey(id));
    if (text === null || text === undefined) return null;
    const read = parseBackup(text);
    return read.ok ? read.match : null;
  } catch {
    return null;
  }
}

// The index entries, newest change first (the later-created match first when changes tie).
export function listMatches(store = defaultStore()) {
  const newest = (a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0);
  try {
    return readIndex(store).sort(newest);
  } catch {
    return [];
  }
}

// Removes the match, its index entry and, if it was the match in progress, that pointer too. The
// index goes first, so a failure part-way leaves a stray record rather than a listed match that
// cannot be opened.
export function deleteMatch(id, store = defaultStore()) {
  return attempt(() => {
    store.setItem(KEYS.index, JSON.stringify(readIndex(store).filter(entry => entry.id !== id)));
    store.removeItem(matchKey(id));
    if (getCurrent(store) === id) store.removeItem(KEYS.current);
  });
}

// ---- The match in progress, saved names and settings ----------------------------------------

export function setCurrent(id, store = defaultStore()) {
  return attempt(() => {
    if (id === null || id === undefined) store.removeItem(KEYS.current);
    else store.setItem(KEYS.current, String(id));
  });
}

export function getCurrent(store = defaultStore()) {
  try {
    return store.getItem(KEYS.current) ?? null;
  } catch {
    return null;
  }
}

export function loadRoster(store = defaultStore()) {
  const names = readJSON(store, KEYS.roster, []);
  return Array.isArray(names) ? names.filter(name => typeof name === 'string') : [];
}

// Keeps each name once, trimmed, and drops anything that is not a name.
export function saveRoster(names, store = defaultStore()) {
  return attempt(() => {
    const kept = [];
    for (const name of Array.isArray(names) ? names : []) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (trimmed !== '' && !kept.includes(trimmed)) kept.push(trimmed);
    }
    store.setItem(KEYS.roster, JSON.stringify(kept));
  });
}

export function loadSettings(store = defaultStore()) {
  const settings = readJSON(store, KEYS.settings, {});
  return isObject(settings) ? settings : {};
}

export function saveSettings(settings, store = defaultStore()) {
  return attempt(() => store.setItem(KEYS.settings, JSON.stringify(isObject(settings) ? settings : {})));
}

// ---- Backup files ---------------------------------------------------------------------------

// A record saved before the trivia formats has none of these on its cycles, and derive() reads
// them (R28). Fields that are there are left alone.
function fillTriviaDefaults(cycle) {
  if (typeof cycle.format !== 'string') cycle.format = 'normal';
  if (typeof cycle.clue !== 'number') cycle.clue = 0;
  if (!Array.isArray(cycle.streak)) cycle.streak = [];
  if (cycle.eligible === undefined) cycle.eligible = null;
}

const unreadable = error => ({ ok: false, error });

// Reads a backup file's text, or a saved record: { ok: true, match } or { ok: false, error } with
// a sentence for the person. Checks the pieces a match cannot do without, fills the trivia fields
// an older record lacks, then runs derive() once, so a file that is JSON but not a scorer match is
// refused here and cannot crash a screen later.
export function parseBackup(text) {
  if (typeof text !== 'string' || text.trim() === '') return unreadable('There is nothing to read: the text is empty, so it is not valid JSON.');
  let match;
  try {
    match = JSON.parse(text);
  } catch {
    return unreadable('That is not a scorer backup: it is not valid JSON.');
  }
  if (!isObject(match)) return unreadable('That is not a scorer backup: it is not a match.');
  if (typeof match.id !== 'string' || match.id === '') return unreadable('That backup has no match id.');
  if (!isObject(match.rules)) return unreadable('That backup has no rules.');
  if (!Array.isArray(match.teams) || match.teams.length !== 2 || !match.teams.every(isObject)) {
    return unreadable('That backup does not have two teams.');
  }
  if (!Array.isArray(match.cycles) || !match.cycles.every(isObject)) return unreadable('That backup has no list of cycles.');
  match.cycles.forEach(fillTriviaDefaults);
  try {
    derive(match);
  } catch (error) {
    return unreadable(`That backup could not be read as a match (${messageOf(error)}).`);
  }
  return { ok: true, match };
}

// What to do with a loaded copy of a match, given the copy already saved: 'new' (none saved),
// 'same', 'incomingNewer' or 'existingNewer'. The higher rev is newer; with equal revs the later
// changedAt is, since undo hands back an older record whose rev can repeat (R27). 'same' needs both
// to match.
export function mergeDecision(existing, incoming) {
  if (!isObject(existing)) return 'new';
  const rev = match => Number(match?.rev) || 0;
  const changed = match => Number(match?.changedAt) || 0;
  if (rev(incoming) !== rev(existing)) return rev(incoming) > rev(existing) ? 'incomingNewer' : 'existingNewer';
  if (changed(incoming) === changed(existing)) return 'same';
  return changed(incoming) > changed(existing) ? 'incomingNewer' : 'existingNewer';
}

// Whether the saved copy is ahead of the one this tab last saved, meaning another tab has been
// saving the same match. Either side missing means there is nothing to compare.
export function detectForeignChange(lastSavedRev, storedMatch) {
  const stored = storedMatch?.rev;
  return Number.isFinite(stored) && Number.isFinite(lastSavedRev) && stored > lastSavedRev;
}
