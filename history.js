// Undo and redo (spec section 4). Every change to the match makes a new version; this keeps the
// versions in memory, so undo gives back the earlier record exactly. Choosing a seat or any
// half-entered action is not a version, so the screens push only when applyAction has returned.
// The versions are never copied or looked inside: the engine returns a new record every time and
// nothing may change one in place.

// `limit` is how many earlier versions undo can reach; the oldest is dropped beyond that.
export function createHistory(initial, limit = 200) {
  const past = [];       // earlier versions, oldest first
  const future = [];     // versions undone, the next redo last
  let present = initial;
  return {
    current: () => present,
    // A new change: the present becomes the past, and anything that was undone is gone for good.
    push(match) {
      past.push(present);
      while (past.length > limit) past.shift();
      present = match;
      future.length = 0;
    },
    // The earlier version, now the present; null when there is none.
    undo() {
      if (past.length === 0) return null;
      future.push(present);
      present = past.pop();
      return present;
    },
    // The version that was undone, now the present again; null when there is none.
    redo() {
      if (future.length === 0) return null;
      past.push(present);
      present = future.pop();
      return present;
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
  };
}
