// Small helpers every screen shares (R29): build an element, and make an id. Browser only.

// Builds an element. `on...` attributes become listeners; false, null and undefined are skipped, so
// a condition can sit in the attributes or the children. Text goes in as text, never as markup.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return el;
}

// A fresh match id: a UUID where the browser has one (a secure page), otherwise time plus random.
export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
