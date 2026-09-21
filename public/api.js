// Tiny helpers + API client. No framework, no build step, no external requests.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat(4)) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ID_KEY = 'kotoba.learner';
let cachedId = '';
let storageOk = true;

/** Device-local learner id. Cookies are the primary mechanism server-side, but a
 *  sandboxed iframe or a browser blocking third-party cookies would silently create a
 *  new learner on every request — which would look like losing all progress. So we also
 *  keep an explicit id and send it as a header. */
export function learnerId() {
  if (cachedId) return cachedId;
  try {
    cachedId = localStorage.getItem(ID_KEY) || sessionStorage.getItem(ID_KEY) || '';
  } catch { storageOk = false; }
  if (!/^L[0-9a-f]{16,32}$/.test(cachedId)) {
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    cachedId = 'L' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(ID_KEY, cachedId); } catch { try { sessionStorage.setItem(ID_KEY, cachedId); } catch { storageOk = false; } }
  }
  return cachedId;
}
export const storageAvailable = () => storageOk;

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', 'x-kotoba-learner': learnerId(), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

export function modal(content) {
  const wrap = $('#modal');
  const card = $('#modalCard');
  const restoreTo = document.activeElement;
  card.replaceChildren();
  if (typeof content === 'string') card.innerHTML = content;
  else card.append(content);

  wrap.classList.remove('hidden');
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  document.body.style.overflow = 'hidden';

  const close = () => {
    wrap.classList.add('hidden');
    wrap.removeAttribute('role');
    wrap.removeAttribute('aria-modal');
    document.body.style.overflow = '';
    wrap.onclick = null;
    document.removeEventListener('keydown', onKey, true);
    if (restoreTo instanceof HTMLElement && document.contains(restoreTo)) restoreTo.focus();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    // keep focus inside: a modal you can tab out of is a modal you can get lost in
    const focusable = [...card.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  document.addEventListener('keydown', onKey, true);
  const focusTarget = card.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  (focusTarget ?? card).focus?.();
  return close;
}

// ---------------------------------------------------------------- Japanese text

/** Wrap Japanese runs so they can be tapped for a gloss. Keeps punctuation intact. */
export function tokenize(text) {
  const parts = String(text).split(/([\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]+)/g);
  return parts.map((p) => ({ text: p, jp: /[\u3000-\u30ff\u3400-\u9fff]/.test(p) }));
}

export function passageNode(text, { newWords = [], onTap }) {
  const frag = document.createDocumentFragment();
  for (const part of tokenize(text)) {
    if (!part.jp) { frag.append(document.createTextNode(part.text)); continue; }
    // Split Japanese runs into 1–3 char chunks: rough but effective for tap-to-look-up.
    const chars = [...part.text];
    let i = 0;
    while (i < chars.length) {
      const len = Math.min(chars.length - i, /[\u4e00-\u9fff]/.test(chars[i]) ? 2 : 1);
      const chunk = chars.slice(i, i + len).join('');
      const span = el('span', {
        class: 'tok' + (newWords.some((w) => chunk.includes(w) || w.includes(chunk)) ? ' new' : ''),
        onclick: (e) => onTap?.(chunk, e),
      }, chunk);
      frag.append(span);
      i += len;
    }
  }
  return frag;
}

export function ruby(ja, reading) {
  if (!reading || reading === ja) return el('span', { class: 'jp', text: ja });
  return el('ruby', { class: 'jp' }, ja, el('rt', {}, reading));
}

export const levelChip = (lvl) => el('span', { class: 'tag ai', text: lvl || '—' });

export function fmtMin(m) {
  if (m < 60) return `${Math.round(m)} min`;
  return `${Math.floor(m / 60)} h ${Math.round(m % 60)}`;
}

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

// ---------------------------------------------------------------- IndexedDB (voice archive)

const DB = 'kotoba-media';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('clips', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveClip(clip) {
  try {
    const db = await idb();
    await new Promise((res, rej) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put(clip);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* recordings are a nice-to-have, never block the lesson */ }
}
export async function listClips(limit = 30) {
  try {
    const db = await idb();
    const all = await new Promise((res, rej) => {
      const tx = db.transaction('clips', 'readonly');
      const r = tx.objectStore('clips').getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
    return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
  } catch { return []; }
}
