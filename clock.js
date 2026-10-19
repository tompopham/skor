// Time (v2 3.1, 3.2): what the match record says about the clock, worked out with no page timer.
// The record holds only facts: `match.clock`, a list of { type: 'start' | 'stop', at } (milliseconds
// since 1 January 1970, UTC), the `openedAt` and `closedAt` of each cycle, and the timeout markers.
// Everything here is a pure function of the record and the `now` it is given, so a reload, a locked
// phone or a second tab always reads the same time (v2 1.3, 1.8). This file never imports engine.js
// (engine.js imports it), and none of it changes a score (v2 1.4).

// The clock rules of a record that has none (anything saved before version 2): no countdown, a 30 s
// timeout, no limit on timeouts and no rulebook clause. Always a new object, so no caller can change the next one.
export function defaultClockRules() {
  return { countdown: null, timeoutSeconds: 30, timeoutsPerTeam: null, source: '' };
}

const clockRules = match => ({ ...defaultClockRules(), ...match.rules?.clock });
const isTime = value => Number.isFinite(value);

// The stretches the clock ran, oldest first: { from, to }, with `to` null while it is running.
// A start while it runs and a stop while it is stopped are ignored (the engine never records either).
function runsOf(match) {
  const runs = [];
  for (const event of match.clock ?? []) {
    if (event.type === 'start' && (runs.length === 0 || runs.at(-1).to !== null)) runs.push({ from: event.at, to: null });
    else if (event.type === 'stop' && runs.length > 0 && runs.at(-1).to === null) runs.at(-1).to = event.at;
  }
  return runs;
}

// How long the clock ran between `from` and `now`.
function runTime(runs, from, now) {
  return runs.reduce((sum, run) => {
    const start = Math.max(run.from, from);
    const end = Math.min(run.to ?? now, now);
    return sum + Math.max(0, end - start);
  }, 0);
}

export function clockRunning(match) {
  return runsOf(match).at(-1)?.to === null;
}

// Wall time since the clock first started, pauses included; null before it has started. Whatever has
// happened since (a pause, the end of the match), it goes on counting: the page decides what to show.
export function elapsed(match, now) {
  const first = runsOf(match)[0];
  return first ? now - first.from : null;
}

// Time played: how long the clock has run, pauses (and halftime) left out, so it stands still while the clock is
// stopped; null before it has started. What the top bar shows when the rules have no countdown (Tom, 19/10/2026).
export function played(match, now) {
  const runs = runsOf(match);
  return runs.length > 0 ? runTime(runs, -Infinity, now) : null;
}

export function timeoutsUsed(match, team) {
  return match.markers.filter(marker => marker.type === 'timeout' && marker.team === team).length;
}

// The close of the halftime cycle: the cycle the 'halftime' marker names, or else the cycle at the
// rules' halftimeAfter position. Null until that cycle has a recorded close.
function halftimeClose(match) {
  const marker = match.markers.find(m => m.type === 'halftime');
  const after = match.rules?.regulation?.halftimeAfter;
  const cycle = marker ? match.cycles.find(c => c.id === marker.afterCycleId)
    : (Number.isInteger(after) && after >= 1 ? match.cycles[after - 1] : undefined);
  return isTime(cycle?.closedAt) ? cycle.closedAt : null;
}

// The run that begins the second half: the first start after the first stop at or after the halftime
// cycle's close, in list order. The stop is the one halftime brings (the close itself under a derived
// halftime, the Halftime tap otherwise), so a start before it, such as the entry that closed the
// halftime cycle with the clock paused, is still the first half. Null until the clock is started again.
function restartAfter(runs, closedAt) {
  const index = runs.findIndex(run => run.to !== null && run.to >= closedAt);
  return index < 0 ? null : runs[index + 1] ?? null;
}

// Where the timeouts stop the clock: each timeout in the period (at or after `from`) takes the stretch
// from its start to its start plus the rules' timeout length, and stretches that overlap are one.
function timeoutWindows(markers, from, lengthMs) {
  const spans = markers.filter(m => m.type === 'timeout' && m.at >= from).map(m => [m.at, m.at + lengthMs]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of spans) {
    if (merged.length > 0 && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// The countdown at `now`, or null when the rules have none: the period (1, or 2 for the second half
// under a per-half countdown), the time left in ms (negative once over), and whether the clock runs.
// Time used is the time the clock has run in the period, less the run time that falls inside any
// timeout's window (a timeout's start to its start plus the rules' timeout length; overlapping windows
// count once). In effect the clock stops for each timeout: the time left stands still for its length
// if the clock runs on, a pause inside it is not counted twice, and the time left never goes up.
// Until the second half's first start, the full length is left and the clock is not running.
export function countdownState(match, now) {
  const { countdown, timeoutSeconds } = clockRules(match);
  if (!countdown) return null;
  const perHalf = countdown.per === 'half';
  const length = countdown.length * 1000;
  const runs = runsOf(match);
  let period = 1, windowStart = -Infinity;
  const closedAt = perHalf ? halftimeClose(match) : null;
  if (closedAt !== null) {
    period = 2;
    const restart = restartAfter(runs, closedAt);
    if (!restart) return { period, left: length, running: false, perHalf };
    windowStart = restart.from;
  }
  const inTimeouts = timeoutWindows(match.markers, windowStart, timeoutSeconds * 1000)
    .reduce((sum, [from, to]) => sum + runTime(runs, from, Math.min(to, now)), 0);
  return { period, left: length - (runTime(runs, windowStart, now) - inTimeouts), running: clockRunning(match), perHalf };
}

// The lengths the scoresheet shows, from the record and derive()'s result for it. Each is a number in ms,
// or null where it cannot be worked out (an old record, a cycle inserted by an edit):
// - game: from the clock's first start to the close of the last question closed;
// - halves: null while no halftime has been reached; else [first start to the halftime cycle's close,
//   the first start after halftime (or, if the clock never stopped, the halftime cycle's close) to the
//   last close], the second null until a question after halftime has closed;
// - average: the game over the questions closed;
// - closedAt: each cycle's close, in ms from the first start;
// - timeouts: in marker order, the team and the number of the question each follows (0 for none).
export function timeSummary(match, derived) {
  const runs = runsOf(match);
  const first = runs[0]?.from ?? null;
  const since = time => (first !== null && isTime(time) ? time - first : null);
  const counted = derived.cycles.map((cycle, index) => (cycle.closed && !cycle.flags.includes('after-end') ? index : -1)).filter(index => index >= 0);
  const lastIndex = counted.at(-1) ?? -1;
  const lastClose = lastIndex >= 0 ? match.cycles[lastIndex].closedAt : null;
  const game = since(lastClose);
  return {
    game,
    played: first !== null && isTime(lastClose) ? runTime(runs, -Infinity, lastClose) : null,   // to the last close, pauses left out
    halves: halvesOf(match, derived, runs, since, lastIndex, lastClose),
    average: game !== null && counted.length > 0 ? game / counted.length : null,
    closedAt: match.cycles.map(cycle => since(cycle.closedAt)),
    timeouts: match.markers.filter(m => m.type === 'timeout').map(m => ({
      team: m.team,
      afterNumber: derived.cycles.find(c => c.id === m.afterCycleId)?.number ?? 0,
    })),
  };
}

function halvesOf(match, derived, runs, since, lastIndex, lastClose) {
  const index = match.cycles.findIndex(c => c.id === derived.phase.halftimeAfterCycleId);
  if (index < 0) return null;
  const closedAt = match.cycles[index].closedAt;
  if (!isTime(closedAt)) return [null, null];
  let restart = restartAfter(runs, closedAt)?.from ?? null;
  // The clock never stopped at halftime: no event since the halftime cycle closed, and it is running.
  if (restart === null && clockRunning(match) && match.clock.every(event => event.at < closedAt)) restart = closedAt;
  const second = restart !== null && lastIndex > index && isTime(lastClose) ? lastClose - restart : null;
  return [since(closedAt), second];
}

// A length as m:ss ('12:34'); null is 'not recorded'; a negative length (a countdown run past zero)
// has a plus sign ('+0:12'). Minutes go past 59 rather than turning into hours.
export function formatLength(ms) {
  if (!isTime(ms)) return 'not recorded';
  const seconds = Math.round(Math.abs(ms) / 1000);
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return ms < 0 && seconds > 0 ? `+${text}` : text;
}
