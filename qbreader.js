// Loading packets from outside (Skor 1.14.0, SPEC-partB 5.2), no screen code: qbreader's set list, packet count and packets
// (`/api/packet?setName=&packetNumber=&modaq=true`, the shape MODAQ reads), and a .docx packet read by YAPP, MODAQ's packet
// parser web service (the file itself POSTed, as MODAQ's PacketLoader does; its answer is a packet in MODAQ's shape). These
// are the only network calls Skor makes, all from New match, Packet, and scoring never needs them. Both services answer a
// page on another site (Access-Control-Allow-Origin: *, checked 20 Nov 2026). The fetch is passed in, so the tests run
// in Node. Every failure comes back as { ok: false, message } saying what to do; nothing here throws.

import { readPacket } from './packet.js';
import { loadSetNames, saveSetNames } from './storage.js';

export const QBREADER = 'https://www.qbreader.org/api';
export const YAPP = 'https://www.quizbowlreader.com/yapp/api/parse?modaq=true';
export const NO_SIGNAL = 'qbreader could not be reached. Check the signal and try again; packets loaded here work with no signal.';
const NO_YAPP = 'YAPP could not be reached. Check the signal and try again, or load a packet file.';
const TIMEOUT_MS = 20_000;

const defaultFetch = (...args) => globalThis.fetch(...args);

// A fetch that gives up after 20 seconds, the answer's body included (the timer runs until the body has been read);
// null when it could not be made or read at all, else { ok, status, text }.
async function get(fetchFn, url, init = {}, timeoutMs = TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function jsonOf(response) {
  try {
    return JSON.parse(response.text);
  } catch {
    return undefined;
  }
}
const query = params => new URLSearchParams(params).toString();

// How old a kept set list may get before it is fetched again in the background (Skor 1.18.0).
export const SET_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// True when the kept list ({ sets, fetchedAt }, or null) should be fetched again: none kept, no usable fetch time, more than
// 7 days old, or fetched in the future (the device's clock was changed). Pure: `now` is passed in.
export function setListIsStale(kept, now = Date.now()) {
  if (!kept || typeof kept.fetchedAt !== 'number' || !Number.isFinite(kept.fetchedAt)) return true;
  const age = now - kept.fetchedAt;
  return age < 0 || age > SET_LIST_MAX_AGE_MS;
}

// qbreader's set names for the suggestions: the kept list unless `refresh` (or none is kept), else fetched and kept. A refresh
// that fails keeps the old list, returns it with ok: true and says why in `refreshFailed`; with none kept it returns { ok: false, message }.
export async function setList({ fetchFn = defaultFetch, store, now = Date.now(), refresh = false, timeoutMs } = {}) {
  const kept = loadSetNames(store);
  if (kept && !refresh) return { ok: true, ...kept };
  const response = await get(fetchFn, `${QBREADER}/set-list`, {}, timeoutMs);
  const body = response?.ok ? await jsonOf(response) : undefined;
  const sets = Array.isArray(body?.setList) ? body.setList.filter(name => typeof name === 'string') : null;
  if (!sets) {
    const message = !response ? NO_SIGNAL
      : response.ok ? 'qbreader sent something that is not a set list. Try again later, or load a packet file.'
        : `qbreader answered with an error (${response.status}). Try again later, or load a packet file.`;
    return kept ? { ok: true, ...kept, refreshFailed: message } : { ok: false, message };
  }
  saveSetNames(sets, now, store);
  return { ok: true, sets, fetchedAt: now };
}

const noSet = setName => `qbreader has no set called "${setName}". Pick one from the list.`;

// How many packets a set has, from qbreader.
export async function packetCount(setName, { fetchFn = defaultFetch, timeoutMs } = {}) {
  const name = String(setName ?? '').trim();
  if (!name) return { ok: false, message: 'Type a set name first.' };
  const response = await get(fetchFn, `${QBREADER}/num-packets?${query({ setName: name })}`, {}, timeoutMs);
  if (!response) return { ok: false, message: NO_SIGNAL };
  const body = await jsonOf(response);
  const count = body?.numPackets;
  if (Number.isInteger(count) && count > 0) return { ok: true, count };
  if (response.ok || response.status === 404) return { ok: false, message: noSet(name) };
  return { ok: false, message: `qbreader answered with an error (${response.status}). Try again later, or load a packet file.` };
}

// One packet of a set from qbreader, read and checked as packet.js reads a file: { ok, packet, summary } or { ok: false, message }.
export async function fetchPacket(setName, number, { fetchFn = defaultFetch, timeoutMs } = {}) {
  const name = String(setName ?? '').trim();
  if (!name) return { ok: false, message: 'Type a set name first.' };
  if (!Number.isInteger(number) || number < 1) return { ok: false, message: 'Pick a packet number.' };
  const response = await get(fetchFn, `${QBREADER}/packet?${query({ setName: name, packetNumber: number, modaq: true })}`, {}, timeoutMs);
  if (!response) return { ok: false, message: NO_SIGNAL };
  const body = await jsonOf(response);
  if (response.status === 404 || (response.ok && Array.isArray(body?.tossups) && body.tossups.length === 0)) return { ok: false, message: `qbreader has no packet ${number} in ${name}.` };
  if (!response.ok) return { ok: false, message: `qbreader answered with an error (${response.status}). Try again later, or load a packet file.` };
  if (body === undefined) return { ok: false, message: 'qbreader sent something that is not a packet. Try again later, or load a packet file.' };
  return readPacket(body);
}

// A .docx packet read by YAPP. `bytes` is the file's ArrayBuffer; the packet is named for the file.
export async function parseDocx(bytes, fileName, { fetchFn = defaultFetch, timeoutMs } = {}) {
  const response = await get(fetchFn, YAPP, { method: 'POST', body: bytes, mode: 'cors' }, timeoutMs);
  if (!response) return { ok: false, message: NO_YAPP };
  if (response.status === 400) {
    const body = await jsonOf(response);
    const lines = Array.isArray(body?.errorMessages) ? body.errorMessages.map(String) : [];
    const shown = lines.slice(0, 3).join('; ');
    return { ok: false, message: `YAPP could not read this packet${shown ? `: ${shown}` : ''}${lines.length > 3 ? ` (and ${lines.length - 3} more)` : ''}.` };
  }
  if (!response.ok) return { ok: false, message: `YAPP answered with an error (${response.status}). Try again later, or load a packet file.` };
  const body = await jsonOf(response);
  if (body === undefined) return { ok: false, message: 'YAPP sent something that is not a packet. Try again later, or load a packet file.' };
  return readPacket(body, { fileName });
}
