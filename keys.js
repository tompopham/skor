// The keyboard and the double-tap guard, as pure functions (spec 6.3, "Keyboard"). The screens
// build the key event and the key state, act on the Command that comes back, and own everything
// else: preventDefault, the chosen seat, the dialogs. Nothing here changes a match, and nothing
// touches the page. Version 1 gives keys to starters and bonuses only: trivia formats, Next clue,
// Streak turns, Split and End quarter are by tap.

const STARTER_TYPES = ['normal', 'picture', 'music'];
const RESULT_KEYS = { p: 'power', c: 'ten', n: 'neg', w: 'wrong' };
const PART_KEYS = { j: 0, k: 1, l: 2 };

const action = body => ({ action: body });
const leftTeam = match => (match.display?.leftTeam === 1 ? 1 : 0);
const hasName = (match, team, seat) => (match.teams[team].seats[seat] ?? '').trim() !== '';

// Keys 1 to 4 are the left team's seats in screen order, 5 to 8 the right team's. The screen's
// order is the display settings': which team is on the left, and whether seats run 1 to 4 or 4 to 1.
function seatOfKey(key, match) {
  if (!/^[1-8]$/.test(key)) return null;
  const slot = Number(key) - 1;
  const team = slot < 4 ? leftTeam(match) : 1 - leftTeam(match);
  return { team, seat: match.display?.seatOrder === 'desc' ? 3 - (slot % 4) : slot % 4 };
}

// Whether a seat can answer the starter now: someone is in it, its team still has a turn, and
// the trivia format lets it in (not in jail, on the Split's list, and not a Streak, which is
// scored by turns). Keys for any other seat do nothing, as its button is grey.
function canAnswer(d, match, { team, seat }) {
  const { open } = d;
  if (open.stage !== 'starter' || open.format === 'streak') return false;
  if (!open.liveTeams[team] || open.jailed?.[team]?.[seat]) return false;
  if (open.format === 'split' && !open.eligible?.[team]?.includes(seat)) return false;
  return hasName(match, team, seat);
}

// P, C, N and W after a seat is chosen. P also needs powers in the rules.
function resultKey(result, chosen, d, match) {
  if (!chosen || !canAnswer(d, match, chosen)) return null;
  if (result === 'power' && !(d.open.canPower && match.rules.tossup.power != null)) return null;
  return action({ type: 'buzz', team: chosen.team, seat: chosen.seat, result });
}

// J, K and L, for part 1, 2 or 3. A part not yet offered to the other team is marked got for the
// controlling team; pressing again clears it. Once the part has been offered, the key is the
// other team's got instead (again, a second press clears it), and the controlling team's result
// can then be changed only by tap.
function partKey(index, d) {
  const part = d.open.stage === 'bonus' ? d.open.bonus?.parts[index] : null;
  if (!part) return null;
  const side = part.offered ? 'other' : 'ctrl';
  return action({ type: 'part', index, side, result: part[side] === 'got' ? null : 'got' });
}

// [ and ]: the team on that side of the screen loses its turn, if it still has one.
function lostTurnKey(side, d, match) {
  const team = side === 'left' ? leftTeam(match) : 1 - leftTeam(match);
  return d.open.stage === 'starter' && d.open.liveTeams[team] ? action({ type: 'lostTurn', team }) : null;
}

// T: the open starter's type, one on from its present one (a new starter is normal).
function starterTypeKey(d, match) {
  if (!match.rules.starterTypes?.on || d.open.stage !== 'starter') return null;
  const now = match.cycles.find(c => c.id === d.open.cycleId)?.type ?? 'normal';
  const next = STARTER_TYPES[(STARTER_TYPES.indexOf(now) + 1) % STARTER_TYPES.length];
  return action({ type: 'starterType', kind: next });
}

// G: time called, which the screen intercepts to ask about a buzz already in (Task 10). Not once
// time has been called, regulation is over or the match has ended: the engine would refuse it.
function timeCalledKey(d, match) {
  const over = d.phase.ended || d.phase.regulationOver || match.markers.some(m => m.type === 'timeCalled');
  return over ? null : action({ type: 'timeCalled' });
}

// ev = { key, shiftKey, metaKey, ctrlKey, repeat, inTextField }
// ui = { selected: null | { team, seat }, keysOn }
// Returns { select: { team, seat } }, { action: <engine action> }, { ui: 'undo' | 'redo' | 'cancel' },
// or null for a key that does nothing. Nothing is done while typing in a text box (the page's own
// Cmd+Z must undo the typing) or for a held-down repeat. With the single-key shortcuts switched
// off, every single key does nothing, but Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z still undo and redo:
// they are chords, not single keys (spec 6.3).
export function keyToCommand(ev, ui, d, match) {
  if (ev.repeat || ev.inTextField || typeof ev.key !== 'string') return null;
  if (ev.metaKey || ev.ctrlKey) {
    return ev.key.toLowerCase() === 'z' ? { ui: ev.shiftKey ? 'redo' : 'undo' } : null;
  }
  if (!ui.keysOn) return null;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  const seat = seatOfKey(key, match);
  if (seat) return canAnswer(d, match, seat) ? { select: seat } : null;
  if (Object.hasOwn(RESULT_KEYS, key)) return resultKey(RESULT_KEYS[key], ui.selected, d, match);
  if (Object.hasOwn(PART_KEYS, key)) return partKey(PART_KEYS[key], d);
  const stage = d.open.stage;
  switch (key) {
    case ' ': return stage === 'starter' ? action({ type: 'dead' }) : null;
    case '[': return lostTurnKey('left', d, match);
    case ']': return lostTurnKey('right', d, match);
    case 'a': return stage === 'bonus' ? action({ type: 'allGot' }) : null;
    case 'Enter': return stage === 'bonus' ? action({ type: 'closeBonus' }) : null;
    case 't': return starterTypeKey(d, match);
    case 'g': return timeCalledKey(d, match);
    case 'Escape': case 'Esc': return { ui: 'cancel' };
    default: return null;
  }
}

// Whether to ignore a tap: true within `ms` of the screen last changing stage, so a quick double
// tap on "10" cannot land its second tap on the bonus panel that has just replaced the action
// bar. A clock that has gone back (now before the change) never locks taps out.
export function tapGuard(now, lastStageChangeAt, ms = 350) {
  if (lastStageChangeAt == null) return false;
  const since = now - lastStageChangeAt;
  return since >= 0 && since < ms;
}
