// Save QBJ file (Skor 1.11.0, SPEC-partB 3.2, 3.6 and 3.7), the seventh of the scoresheet's Print or save actions: the
// dialog that names the file, says what it is for and what to watch, and hands the file over inside its own button's tap
// (iPhone Safari's rule), as Send match does. The file itself is made in qbj.js.

import { derive } from './engine.js';
import { offerFile } from './files.js';
import { h } from './dom.js';
import { qbjText, qbjFileName, qbjRound } from './qbj.js';

export const QBJ_USE = 'For YellowFruit (File, QBJ Schema, Import Games Only) and buzzpoints.org.';
export const QBJ_TWICE = 'buzzpoints.org counts every game uploaded, so one uploaded twice counts twice: delete the old upload first.';
export const QBJ_NO_ROUND = 'No round was typed, so the file has none inside. YellowFruit takes it only from the round’s own Import button (Games, the round); buzzpoints.org reads the first number in the file name as the round, so put the round at the start, as R03.';

// The dialog's lines for a match, for the page and the tests: whether it has ended, the file name, and the round note.
export function qbjWords(match, d = derive(match)) {
  return {
    notEnded: d.phase.ended ? null : 'This match has not ended.',
    name: qbjFileName(match),
    noRound: qbjRound(match) === null ? QBJ_NO_ROUND : null,
  };
}

export function qbjDialog(state, api) {
  const words = qbjWords(state.match);
  const status = h('p', { class: 'hint', id: 'qbj-msg', role: 'status' });
  const say = (text, bad = false) => { status.textContent = text; status.className = bad ? 'msg' : 'hint'; };
  // The match is read when the button is pressed, so the file is never older than the screen. A second tap while the
  // share sheet is up does nothing, so one tap never gives a share sheet and a download as well.
  let busy = false;
  const save = async () => {
    if (busy) return;
    busy = true;
    try {
      const { match } = state;
      const file = { name: qbjFileName(match), type: 'application/json', text: qbjText(match, derive(match)) };
      const result = await offerFile(file);
      if (result.ok) say(result.method === 'share' ? `Shared ${file.name}.` : `Saved ${file.name}. Look in your downloads.`);
      else if (result.cancelled) say('');
      else say(`Could not save ${file.name}: ${result.error ?? 'the browser refused.'}`, true);
    } catch (error) {
      say(`Could not make the file: ${error?.message ?? error}. Save a backup instead and send it to Tom.`, true);
    } finally {
      busy = false;
    }
  };
  return api.ask({
    title: 'Save QBJ file',
    body: [
      words.notEnded ? h('p', { class: 'msg', id: 'qbj-not-ended' }, words.notEnded) : null,
      h('p', { class: 'dtext', id: 'qbj-use' }, QBJ_USE),
      h('p', { class: 'dtext qbjname', id: 'qbj-name' }, words.name),
      words.noRound ? h('p', { class: 'hint', id: 'qbj-no-round' }, words.noRound) : null,
      h('p', { class: 'hint', id: 'qbj-twice' }, QBJ_TWICE),
      h('div', { class: 'stack' }, h('button', { type: 'button', class: 'btn primary', id: 'qbj-save', onclick: save }, 'Save QBJ file')),
      status,
    ],
    buttons: [{ label: 'Close', value: 'cancel' }],
  });
}
