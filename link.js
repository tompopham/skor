// Send match (SPEC-partB section 1): a whole match carried in a link, with no server. The link is the address the scorer
// runs from, then "#m1.", then the saved record as JSON (UTF-8), squeezed with raw deflate (CompressionStream
// 'deflate-raw', iOS 16.4) and written in base64url (RFC 4648 section 5) with no padding. "m1" is the link format's version.
// Everything after the # stays on the phone: a browser never sends it to a server (RFC 3986, RFC 9110). Reading a link
// ends in parseBackup, as reading a backup file does, so a link can never hold more or less than a backup file can.
// No screen code here.

import { parseBackup } from './storage.js';

const FORMAT = 1;
const LINK = /#m(\d+)\.([A-Za-z0-9_-]*)([\s\S]*)$/;
const AROUND = /[^\s(<[{'"]*#m\d+\.[A-Za-z0-9_-]*/;   // the link itself, inside pasted text (not a bracket or quote before it)
const MAX_TEXT = 5_000_000;   // a match is about 10 to 15 thousand characters; a link that opens into more is not one

export const LINK_DAMAGED = 'This link is cut short or damaged, so the match cannot be read. Ask the sender for the file instead.';
export const LINK_NEWER = 'This match was sent from a newer Skor. Reload Skor to update it, then open the link again.';
export const LINK_UNSUPPORTED = 'This browser cannot read or make match links. Update it, or send and open the backup file instead.';

// Whether this browser can make and read links (iOS and Safari 16.4, Chrome 103, Firefox 113).
export const canLink = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

// Whether some text (an address, its # part, or a pasted message) holds a match link.
export const isMatchLink = text => typeof text === 'string' && /#m\d+\./.test(text);

// The address a link opens: the page the scorer is running from, without index.html or anything after it.
export const linkBase = ({ origin, pathname }) => `${origin}${pathname.replace(/index\.html$/, '')}`;

// The record a link carries: the saved record, less a packet's text (packet mode, section 5), which would make it ten times
// longer, and less the mark Past matches gives a copy a sent match replaced here, which says nothing on another device.
export function sentRecord(match) {
  const { packet, keptCopy, ...record } = match;
  return record;
}

function toBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// The bytes, or null when the text cannot be base64url (a length of 4k + 1 never can).
function fromBase64Url(text) {
  if (text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

// Runs bytes through a compression or decompression stream and joins what comes out, stopping past `limit` bytes.
async function pipe(bytes, stream, limit = Infinity) {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { reader.cancel().catch(() => {}); throw new Error('too long'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

// The link for a match. `base` is linkBase(location).
export async function matchLink(match, base) {
  const json = new TextEncoder().encode(JSON.stringify(sentRecord(match)));
  return `${base}#m${FORMAT}.${toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))}`;
}

// Reads the match in a link (or in pasted text holding one): { ok: true, match, link } as parseBackup gives it, with the
// link itself out of the text, or { ok: false, error } with a sentence saying what to do. A link may be followed by a space
// or by the end of a sentence (".", ")" and the like), as in a pasted message. Anything that cannot be undone back to JSON, however it went wrong, is a link
// cut short or damaged; JSON that is not a match gets parseBackup's own sentence.
export async function readLink(text) {
  const found = typeof text === 'string' ? LINK.exec(text) : null;
  if (!found) return { ok: false, error: LINK_DAMAGED };
  const [, format, payload, after] = found;
  if (format !== String(FORMAT)) return { ok: false, error: Number(format) > FORMAT ? LINK_NEWER : LINK_DAMAGED };
  if (!canLink()) return { ok: false, error: LINK_UNSUPPORTED };
  const bytes = payload === '' || !/^([.,;:!?)\]}>'"]*)(\s|$)/.test(after) ? null : fromBase64Url(payload);   // the link must end where its letters do
  if (!bytes) return { ok: false, error: LINK_DAMAGED };
  let json;
  try {
    json = new TextDecoder('utf-8', { fatal: true }).decode(await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_TEXT));
    JSON.parse(json);
  } catch {
    return { ok: false, error: LINK_DAMAGED };
  }
  const read = parseBackup(json);
  return read.ok ? { ...read, link: AROUND.exec(text)[0] } : { ok: false, error: read.error };
}
