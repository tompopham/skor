// New match, Packet (Skor 1.14.0, SPEC-partB 5.2): choose the packet a match reads, from the packets ready on this device,
// or load one from qbreader, a packet file or a .docx through YAPP. Shown only in a window at least 1024 px wide and for
// the quizbowl formats (packet-match.js). Loading keeps the packet on the device (storage.js) and chooses it; Start copies
// the chosen packet into the match (view-setup.js). The only network calls Skor makes are here (qbreader.js).

import { h } from './dom.js';
import { readPacket } from './packet.js';
import { packetAllowed } from './packet-match.js';
import { listPackets, removePacket, savePacket, loadSetNames, NEARLY_FULL_TEXT } from './storage.js';
import { setList, setListIsStale, packetCount, fetchPacket, parseDocx } from './qbreader.js';

export const PACKET_WIDTH = 1024;
export const NARROW_TEXT = `Packet mode needs a laptop window at least ${PACKET_WIDTH} px wide.`;
export const YAPP_WARNING = "This sends the packet to YAPP's server to be read. Use it only for a packet that has been released or that the TD has cleared.";
const MAX_BYTES = 5 * 1024 * 1024;
const SETS_ID = 'qb-sets';

export const packetWindow = () => globalThis.matchMedia?.(`(min-width: ${PACKET_WIDTH}px)`).matches ?? false;
// The Packet button and fold are drawn for a quizbowl format in a wide window.
export const packetOffered = draft => packetWindow() && packetAllowed(draft.rules);

const counts = p => `${p.tossups} tossup${p.tossups === 1 ? '' : 's'}, ${p.bonuses} bonus${p.bonuses === 1 ? '' : 'es'}`;
const day = at => (Number.isFinite(at) ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const SOURCE = { qbreader: 'qbreader', file: 'file', docx: '.docx via YAPP' };

// The chosen packet's line under the format summary, or nothing. A chosen packet no longer kept is forgotten.
export function packetStatus(draft) {
  if (!draft.packetId || !packetAllowed(draft.rules)) return null;
  const chosen = listPackets().find(p => p.id === draft.packetId);
  if (!chosen) { draft.packetId = null; return null; }
  return h('p', { class: 'hint', id: 'packet-line' }, `Packet: ${chosen.name} (${counts(chosen)})`);
}

// The fold's content. `redraw` draws New match again; a message for the person is kept in the draft so it survives it.
export function packetContent(draft, api, redraw) {
  const note = h('p', { class: draft.packetMsg?.bad ? 'msg' : 'hint', id: 'packet-msg', role: 'status' }, draft.packetMsg?.text ?? '');
  const say = (text, bad = false) => { draft.packetMsg = { text, bad }; note.textContent = text; note.className = bad ? 'msg' : 'hint'; };
  const keep = (read, source, fileName = null) => {
    if (!read.ok) { say(read.message, true); return; }
    const saved = savePacket(read.packet, { source, fileName });
    if (!saved.ok) { say(saved.error, true); return; }
    draft.packetId = saved.id;
    draft.packetMsg = { text: `${read.summary}. Ready on this device, and chosen for this match.${saved.nearlyFull ? ` ${NEARLY_FULL_TEXT}` : ''}`, bad: saved.nearlyFull };
    redraw();
  };

  const ready = listPackets();
  const chosen = ready.find(p => p.id === draft.packetId) ?? null;
  const choice = h('div', { class: 'group', id: 'packet-choice' },
    h('p', {}, chosen ? `This match reads ${chosen.name} (${counts(chosen)}).` : 'No packet: the match is scored without packet text.'),
    chosen ? h('button', { type: 'button', class: 'btn small', id: 'packet-none', onclick: () => { draft.packetId = null; draft.packetMsg = null; redraw(); } }, 'No packet') : null);

  const rows = ready.map(p => h('li', { class: 'packetrow' },
    h('span', { class: 'pname' }, p.name),
    h('span', { class: 'hint' }, `${counts(p)}${p.source ? `, ${SOURCE[p.source] ?? p.source}` : ''}${p.loadedAt ? `, ${day(p.loadedAt)}` : ''}`),
    p.id === draft.packetId
      ? h('button', { type: 'button', class: 'btn small', disabled: true, 'aria-pressed': 'true' }, 'Chosen')
      : h('button', { type: 'button', class: 'btn small', onclick: () => { draft.packetId = p.id; draft.packetMsg = null; redraw(); } }, 'Use'),
    h('button', {
      type: 'button', class: 'btn small',
      onclick: async () => {
        const sure = await api.ask({
          title: `Remove ${p.name}?`, body: ['It goes from this device. A match that read it keeps its own copy.'],
          buttons: [{ label: 'Remove', value: 'yes', primary: true }, { label: 'Cancel', value: 'cancel' }],
        });
        if (sure !== 'yes') return;
        const done = removePacket(p.id);
        if (!done.ok) { say(`It could not be removed: ${done.error}`, true); return; }
        if (draft.packetId === p.id) draft.packetId = null;
        draft.packetMsg = null;
        redraw();
      },
    }, 'Remove')));
  const list = h('div', { class: 'group', id: 'packets-ready' }, h('h3', {}, 'Packets ready on this device'),
    rows.length ? h('ul', { class: 'packetlist' }, rows) : h('p', { class: 'hint' }, 'None yet. Load packets here with signal, and score with none.'));

  // qbreader: a set name (suggested from qbreader's list, kept after the first fetch), a packet number, Load.
  const sets = h('datalist', { id: SETS_ID }, (loadSetNames()?.sets ?? []).map(name => h('option', { value: name })));
  const setBox = h('input', { id: 'qb-set', list: SETS_ID, autocomplete: 'off', spellcheck: 'false', placeholder: 'Set name, e.g. 2026 MRNA' });
  setBox.value = draft.qbSet ?? '';
  const numberBox = h('select', { id: 'qb-number', 'aria-label': 'Packet number' }, h('option', { value: '' }, 'Packet'));
  const fillNumbers = n => { numberBox.replaceChildren(h('option', { value: '' }, 'Packet'), ...Array.from({ length: n }, (_, k) => h('option', { value: String(k + 1) }, `Packet ${k + 1}`))); };
  if (draft.qbCount) { fillNumbers(draft.qbCount); numberBox.value = draft.qbNumber ?? ''; }
  const showSets = names => sets.replaceChildren(...names.map(name => h('option', { value: name })));
  // On the box's first focus in this drawing of the pane: fetch if nothing is kept, or in the background if the kept list is
  // more than 7 days old (Skor 1.18.0). A failed fetch keeps the old options and says nothing: the person may be offline.
  setBox.addEventListener('focus', async () => {
    const stale = setListIsStale(loadSetNames());
    if (sets.children.length > 0 && !stale) return;
    const got = await setList({ refresh: stale });
    if (got.ok && !got.refreshFailed) showSets(got.sets);
    else if (got.ok && sets.children.length === 0) showSets(got.sets);
  }, { once: true });
  setBox.addEventListener('change', async () => {
    if (setBox.value.trim() === draft.qbSet && draft.qbCount) return;   // the same set again (a second change on leaving the box)
    draft.qbSet = setBox.value.trim();
    draft.qbCount = null;
    fillNumbers(0);
    if (!draft.qbSet) return;
    say('Asking qbreader how many packets the set has…');
    const got = await packetCount(draft.qbSet);
    if (!got.ok) { say(got.message, true); return; }
    draft.qbCount = got.count;
    fillNumbers(got.count);
    say(`${draft.qbSet} has ${got.count} packets.`);
  });
  numberBox.addEventListener('change', () => { draft.qbNumber = numberBox.value; });
  const qbLoad = h('button', {
    type: 'button', class: 'btn', id: 'qb-load',
    onclick: async () => {
      draft.qbSet = setBox.value.trim();
      say('Loading from qbreader…');
      qbLoad.disabled = true;
      const got = await fetchPacket(draft.qbSet, Number(numberBox.value));
      qbLoad.disabled = false;
      keep(got, 'qbreader');
    },
  }, 'Load');
  // Refresh list always fetches, and says how it went in the message line; a failed fetch keeps the old list.
  const qbRefresh = h('button', {
    type: 'button', class: 'btn small', id: 'qb-refresh',
    onclick: async () => {
      qbRefresh.disabled = true;
      say('Updating the set list…');
      const got = await setList({ refresh: true });
      qbRefresh.disabled = false;
      if (got.ok && !got.refreshFailed) {
        showSets(got.sets);
        say(`Set list updated: ${got.sets.length.toLocaleString('en-GB')} ${got.sets.length === 1 ? 'set' : 'sets'}.`);
      } else if (got.ok) say(`${got.refreshFailed} The old list is kept.`, true);
      else say(got.message, true);
    },
  }, 'Refresh list');
  const qbRow = h('div', { class: 'group', id: 'qb-row' }, h('h3', {}, 'From qbreader'),
    h('div', { class: 'qbrow' }, setBox, numberBox, qbLoad), h('div', { class: 'qbrefresh' }, qbRefresh), sets);

  const fileRow = h('div', { class: 'group', id: 'packet-files' }, h('h3', {}, 'From a file'),
    h('div', { class: 'grid2' },
      h('button', { type: 'button', class: 'btn', id: 'packet-file', onclick: () => pickFile('.json,application/json', say, async file => { const value = await jsonFile(file, say); if (value !== undefined) keep(readPacket(value, { fileName: file.name }), 'file', file.name); }) }, 'Load packet file (.json)'),
      h('button', {
        type: 'button', class: 'btn', id: 'packet-docx',
        onclick: () => pickFile('.docx', say, async file => {
          const sure = await api.ask({ title: 'Send the packet to YAPP?', body: [YAPP_WARNING], buttons: [{ label: 'Send', value: 'yes', primary: true }, { label: 'Cancel', value: 'cancel' }] });
          if (sure !== 'yes') return;
          say('Sending the packet to YAPP to be read…');
          keep(await parseDocx(await file.arrayBuffer(), file.name), 'docx', file.name);
        }),
      }, 'Load .docx packet (YAPP)')),
    h('p', { class: 'hint' }, YAPP_WARNING));

  return h('div', { class: 'inner', id: 'packet-inner' }, choice, list, qbRow, fileRow, note);
}

async function jsonFile(file, say) {
  try {
    return JSON.parse(await file.text());
  } catch {
    say(`${file.name} is not a packet file: it is not JSON.`, true);
    return undefined;
  }
}

// A file picked inside the button's own click (iPhone Safari's rule), refused when far too big to be a packet.
function pickFile(accept, say, use) {
  const input = h('input', { type: 'file', accept, hidden: true });
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_BYTES) { say(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB, too large to be a packet.`, true); return; }
    try {
      await use(file);
    } catch {
      say(`${file.name} could not be read. If it is in iCloud, open it in Files once so it downloads, then load it again.`, true);
    }
  });
  document.body.append(input);
  input.click();
}
