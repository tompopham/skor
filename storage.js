// Saving on the device (spec section 7): the match records and a small index of them, the match
// in progress, the saved player names and the settings, plus reading a backup file and the two
// checks that stop one copy of a match writing over another. Every function takes the store as
// its last argument (anything with getItem, setItem and removeItem, localStorage by default; a store
// that also has keys() lets the list of matches be rebuilt from the records, v2 2.2) and none of
// them ever throws: a refused write comes back as { ok: false, error } and an unreadable entry as
// null or an empty list, so a full or blocked store can never break the page.

import { derive } from './engine.js';
import { defaultClockRules } from './clock.js';

export const KEYS = {
  index: 'scorer.index',
  current: 'scorer.current',
  roster: 'scorer.roster',
  settings: 'scorer.settings',
};
const MATCH_PREFIX = 'scorer.match.';
export const matchKey = id => `${MATCH_PREFIX}${id}`;

// What stands in when the browser has no localStorage at all, or will not even hand it over (a
// blocked-storage setting can make reading `localStorage` itself throw).
const NO_STORE = {
  getItem() { throw new Error('This browser has no storage for saved matches'); },
  setItem() { throw new Error('This browser has no storage for saved matches'); },
  removeItem() { throw new Error('This browser has no storage for saved matches'); },
};

// The browser's localStorage, with the one thing it lacks: keys(), read from its length and key(i).
// A storage object that cannot be walked that way is handed over without keys().
function browserStore(local) {
  const store = {
    getItem: key => local.getItem(key),
    setItem: (key, value) => local.setItem(key, value),
    removeItem: key => local.removeItem(key),
  };
  if (typeof local.key === 'function' && Number.isInteger(local.length)) {
    store.keys = () => Array.from({ length: local.length }, (_, i) => local.key(i)).filter(key => typeof key === 'string');
  }
  return store;
}
function defaultStore() {
  try {
    const local = globalThis.localStorage;
    return local ? browserStore(local) : NO_STORE;
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

// The index's text as { sound, entries }: the entries in it, minus anything in it that is not an
// entry, and whether the text was a list of nothing but entries. Text that is missing or damaged
// reads as an empty, unsound index (listMatchesReport rebuilds it when the store can list its keys).
function parseIndex(text) {
  let list = null;
  try {
    list = text === null || text === undefined ? null : JSON.parse(text);
  } catch {
    list = null;
  }
  if (!Array.isArray(list)) return { sound: false, entries: [] };
  const entries = list.filter(entry => isObject(entry) && typeof entry.id === 'string');
  return { sound: entries.length === list.length, entries };
}

// The saved index. A store that cannot be read throws rather than reading as empty, so a failed read
// never leads to the index being written over (the callers catch it).
const readIndex = store => parseIndex(store.getItem(KEYS.index)).entries;

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

// The ids of every match record the store holds, or null when the store cannot list its keys (or
// throws doing so).
function recordIds(store) {
  if (typeof store.keys !== 'function') return null;
  try {
    return new Set(store.keys().filter(key => typeof key === 'string' && key.startsWith(MATCH_PREFIX) && key.length > MATCH_PREFIX.length)
      .map(key => key.slice(MATCH_PREFIX.length)));
  } catch {
    return null;
  }
}

const newest = (a, b) => (b.changedAt ?? 0) - (a.changedAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0);

// The index entries, newest change first (the later-created match first when changes tie), and how
// many saved records could not be read. The index is only a list of the records, so it is rebuilt
// from them (v2 2.2) when the store can list its keys and the two disagree: the index is missing or
// damaged, it names a record that is gone (that entry is dropped), or a record is not in it (found,
// and listed if it can be read). The repaired index is saved. A record that cannot be read is
// counted and left exactly where it is; an index entry whose record is there is kept as it is,
// readable or not, for Past matches to show as damaged. A store with no keys() cannot be checked
// against its records, so its index is listed as it stands, and a damaged one reads as empty.
export function listMatchesReport(store = defaultStore()) {
  try {
    const text = store.getItem(KEYS.index);
    const { sound, entries: listed } = parseIndex(text);
    const present = recordIds(store);
    if (present === null) return { entries: listed.sort(newest), unreadable: 0 };
    const kept = listed.filter(entry => present.has(entry.id));
    const known = new Set(kept.map(entry => entry.id));
    const found = [];
    let unreadable = 0;
    for (const id of present) {
      if (known.has(id)) continue;
      const match = loadMatch(id, store);
      if (match) found.push(summaryOf(match));
      else unreadable += 1;
    }
    const entries = [...kept, ...found];
    const unchanged = sound && kept.length === listed.length && found.length === 0;
    const nothingToKeep = (text === null || text === undefined) && entries.length === 0;
    if (!unchanged && !nothingToKeep) attempt(() => store.setItem(KEYS.index, JSON.stringify(entries)));
    return { entries: entries.sort(newest), unreadable };
  } catch {
    return { entries: [], unreadable: 0 };
  }
}

export function listMatches(store = defaultStore()) {
  return listMatchesReport(store).entries;
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

// A record saved before version 2 has no clock list, no times on its cycles and no clock rules, and the
// clock code reads them (v2 1.1). They read as the defaults: the clock never started, nothing stamped, no
// countdown and no limit on timeouts. Fields that are there are left alone.
function fillClockDefaults(match) {
  if (!Array.isArray(match.clock)) match.clock = [];
  match.rules.clock = { ...defaultClockRules(), ...(isObject(match.rules.clock) ? match.rules.clock : {}) };
  for (const cycle of match.cycles) {
    if (cycle.openedAt === undefined) cycle.openedAt = null;
    if (cycle.closedAt === undefined) cycle.closedAt = null;
  }
}

const unreadable = error => ({ ok: false, error });

// Reads a backup file's text, or a saved record: { ok: true, match } or { ok: false, error } with
// a sentence for the person. Checks the pieces a match cannot do without, fills the trivia and clock
// fields an older record lacks, then runs derive() once, so a file that is JSON but not a scorer match is
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
  fillClockDefaults(match);
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
