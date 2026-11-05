// Send match (SPEC-partB section 1), its screens: the Send dialog (Menu, More, and the scoresheet's Print or save), the "A
// match was sent to you" dialog a link opens, the choice when the match is already saved here, and the offer to save a match
// that Just look opened before it can be changed. The link itself is made and read in link.js. sentWords, clashWords and
// keptCopy are pure, for the tests.

import { derive } from './engine.js';
import { resultLine, fileName } from './files.js';
import { saveMatch, loadMatch, mergeDecision } from './storage.js';
import { h, newId } from './dom.js';
import { teamName, leftRight, copyText, isIosSafariTab } from './view-common.js';
import { matchLink, readLink, linkBase, canLink, LINK_UNSUPPORTED } from './link.js';

// ---- Words ------------------------------------------------------------------------------------------

const pad = number => String(number).padStart(2, '0');
function playedOn(match) {
  const date = new Date(typeof match.createdAt === 'number' ? match.createdAt : NaN);
  return Number.isFinite(date.getTime()) ? `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}` : '';
}

// The number of the last question finished in the match (one after its end is not counted), or 0 for none.
const reached = d => d.cycles.filter(dc => dc.closed && !dc.flags.includes('after-end')).at(-1)?.number ?? 0;

// What the receive screen says of a match: the result line (teams left first, the score, the format) and its state.
export function sentWords(match) {
  const d = derive(match);
  const last = reached(d);
  const state = d.phase.ended ? 'Ended' : last > 0 ? `In progress after Q${last}` : 'No question played yet';
  const date = playedOn(match);
  return { line: resultLine(match, d), state: `${date ? `Played ${date}. ` : ''}${state}.` };
}

// The title and question for a sent match already saved here, by mergeDecision's answer ('same', 'incomingNewer' or
// 'existingNewer'), with how far each copy got.
export function clashWords(decision, existing, incoming) {
  if (decision === 'same') return { title: 'You already have this match', body: 'This device has the same copy, with the same changes.' };
  const sent = reached(derive(incoming));
  const mine = reached(derive(existing));
  if (decision === 'incomingNewer') {
    const how = sent === mine ? `both stop at Q${mine}; it was changed later` : `Q${sent}, yours stops at Q${mine}`;
    return { title: 'This copy is newer', body: `This copy is newer (${how}). Replace yours?` };
  }
  const how = sent === mine ? `both stop at Q${mine}; yours was changed later` : `Q${mine}, this copy stops at Q${sent}`;
  return { title: 'Your copy is newer', body: `Your copy is newer (${how}). Keep yours?` };
}

// The copy a sent match replaces, kept under a new id and marked, so Past matches lists it as the Older copy, or the Newer
// copy when the person chose to replace a newer copy with the one sent.
export const keptCopy = (match, id, at, newer = false) => ({ ...match, id, keptCopy: { of: match.id, at, newer } });
export const keptTag = match => (match.keptCopy ? (match.keptCopy.newer ? 'Newer copy' : 'Older copy') : null);

// ---- Sending ----------------------------------------------------------------------------------------

// A box holding the link, shown only when the browser will not copy it: then it is selected for copying by hand.
const linkBox = id => h('textarea', { readonly: '', rows: '3', id, 'aria-label': 'The link', spellcheck: 'false', hidden: true });

// The Send dialog. The link is made as the dialog opens, so each button hands it to the share sheet or the clipboard inside
// its own tap, as iPhone Safari requires. What happened is said in the line under the buttons; the dialog stays until Close.
export function sendDialog(match, api) {
  const [left, right] = leftRight(match).map(team => teamName(match, team));
  let link = null;
  const ready = canLink() ? matchLink(match, linkBase(location)).then(made => { link = made; return made; }, () => null) : Promise.resolve(null);
  const status = h('p', { class: 'hint', id: 'send-msg', role: 'status' });
  const say = (text, bad = false) => { status.textContent = text; status.className = bad ? 'msg' : 'hint'; };
  const box = linkBox('send-box');
  const withLink = act => async () => {
    const url = link ?? await ready;   // ready almost at once; no wait at all once it is
    if (url) return act(url);
    return say(LINK_UNSUPPORTED, true);
  };
  const copy = async url => {
    box.value = url;
    if (await copyText(url, box)) say(`Link copied (${url.length.toLocaleString('en-GB')} characters). Paste it into WhatsApp or Messages.`);
    else say('This browser would not copy it. Select the whole link above and copy it.', true);
  };
  // The share sheet where there is one; where there is none, or it refuses (Chrome takes no link over 16,384 characters),
  // the link is copied instead.
  const share = async url => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return say('Link sent.');
      } catch (error) {
        if (error?.name === 'AbortError') return say('');
      }
    }
    return copy(url);
  };
  const sendFile = async () => {
    const name = fileName(match, 'json');
    const result = await api.offerBackup();
    if (result.ok) say(result.method === 'share' ? `Shared ${name}.` : `Saved ${name}. Look in your downloads.`);
    else if (result.cancelled) say('');
    else say(`Could not save ${name}: ${result.error ?? 'the browser refused.'}`, true);
  };
  return api.ask({
    title: `Send ${left} v ${right}`,
    body: [
      'The link holds the whole match: names, scores and notes. Anyone who has it can read them.',
      match.packet ? 'The link leaves the packet out. Send the file to include it.' : null,
      h('div', { class: 'stack', id: 'send-choices' },
        h('button', { type: 'button', class: 'btn', id: 'send-link', onclick: withLink(share) }, 'Send link'),
        h('button', { type: 'button', class: 'btn', id: 'send-copy', onclick: withLink(copy) }, 'Copy link'),
        h('button', { type: 'button', class: 'btn', id: 'send-file', onclick: sendFile }, 'Send file')),
      box, status,
    ],
    buttons: [{ label: 'Close', value: 'cancel' }],
  });
}

// ---- Receiving --------------------------------------------------------------------------------------

// A link opened (or pasted on Home): a damaged one says what to do; a good one shows what it holds.
export async function offerLink(link, api) {
  const read = await readLink(link);
  if (!read.ok) return api.ask({ title: 'This link cannot be opened', body: read.error, buttons: [{ label: 'Close', value: 'cancel', primary: true }] });
  return showSent(read.match, read.link, api);
}

// "A match was sent to you", and the choice. In a Safari tab on an iPhone, which keeps its saved matches apart from the
// home-screen Skor and clears them after 7 days unused, it says how to move the match there. Cancel (or the back gesture)
// leaves it unsaved.
export async function showSent(match, link, api) {
  const { line, state } = sentWords(match);
  const box = linkBox('sent-box');
  const status = h('p', { class: 'hint', id: 'sent-msg', role: 'status', hidden: true });   // no empty line until there is something to say
  const copy = async () => {
    box.value = link;
    status.hidden = false;
    status.textContent = await copyText(link, box) ? 'Link copied.' : 'Select the whole link above and copy it.';
  };
  const safari = isIosSafariTab() ? [
    h('p', { class: 'dtext', id: 'sent-safari' }, 'This is Safari, not your home-screen Skor. Safari clears saved matches after 7 days unused. To keep it: Copy link, open Skor from your home screen, Paste backup text.'),
    h('button', { type: 'button', class: 'btn', id: 'sent-copy', onclick: copy }, 'Copy link'), box, status,
  ] : [];
  const choice = await api.ask({
    title: 'A match was sent to you',
    // One paragraph for the two lines, so the iPhone Safari screen, the tallest, still fits a 470 px window.
    body: [h('p', { class: 'dtext' }, h('span', { id: 'sent-line' }, line), h('br'), h('span', { id: 'sent-state' }, state)), ...safari],
    buttons: [{ label: 'Save to my matches', value: 'save', primary: true }, { label: 'Just look', value: 'look' }, { label: 'Cancel', value: 'cancel' }],
  });
  if (choice === 'save') return saveSent(match, api);
  if (choice === 'look') return api.lookAt(match);
  return undefined;
}

// Save to my matches: a match not saved here is saved and its scoresheet opened. One already saved here follows
// mergeDecision, as Load backup file does: nothing is written over until the person chooses, and a copy replaced is kept.
export async function saveSent(match, api) {
  const existing = loadMatch(match.id);
  const decision = mergeDecision(existing, match);
  if (decision === 'new') return keep(match, api);
  const { title, body } = clashWords(decision, existing, match);
  const buttons = {
    same: [{ label: 'Open it', value: 'mine', primary: true }, { label: 'Close', value: 'cancel' }],
    incomingNewer: [{ label: 'Replace yours', value: 'replace', primary: true }, { label: 'Keep yours', value: 'mine' }, { label: 'Cancel', value: 'cancel' }],
    existingNewer: [{ label: 'Keep yours', value: 'mine', primary: true }, { label: 'Replace with this copy', value: 'replace' }, { label: 'Cancel', value: 'cancel' }],
  }[decision];
  const note = decision === 'same' ? null : `Replacing keeps yours in Past matches, marked ${decision === 'existingNewer' ? 'Newer' : 'Older'} copy.`;
  const choice = await api.ask({ title, body: [body, note], buttons });
  if (choice === 'mine') return api.viewMatch(existing.id);
  // The copy kept is the one saved at the tap (another tab may have saved it since the question was drawn).
  if (choice === 'replace') return keep(match, api, keptCopy(loadMatch(match.id) ?? existing, newId(), api.now(), decision === 'existingNewer'));
  return undefined;
}

// Saves the match (after the copy it replaces, kept under its new id: if that cannot be saved, nothing is replaced), then
// opens its scoresheet. A device that will not save offers Just look.
async function keep(match, api, older = null) {
  api.askForPersistentStorage();   // as a match started or loaded from a file does: asks the browser not to clear it
  const first = older ? saveMatch(older) : { ok: true };
  const result = first.ok ? saveMatch(match) : first;
  if (result.ok) return api.viewMatch(match.id);
  const choice = await api.ask({
    title: 'Not saved', body: [`This device would not save the match: ${result.error}`, 'Just look shows it without saving it.'],
    buttons: [{ label: 'Just look', value: 'look', primary: true }, { label: 'Close', value: 'cancel' }],
  });
  return choice === 'look' ? api.lookAt(match) : undefined;
}

// A change tried on a match Just look opened: it is not saved here, so saving it is offered first.
export async function askToSave(match, api) {
  const choice = await api.ask({
    title: 'Not saved on this device',
    body: 'This match was sent to you, and Just look shows it without saving it. Save it to your matches to change it.',
    buttons: [{ label: 'Save to my matches', value: 'save', primary: true }, { label: 'Cancel', value: 'cancel' }],
  });
  return choice === 'save' ? saveSent(match, api) : undefined;
}
