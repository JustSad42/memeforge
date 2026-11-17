// Talking to the Rust side, plus small UI helpers (toasts, menus, modals) shared by the pages.
import { icon } from "./icons.js";

const T = window.__TAURI__;
export const invoke = T.core.invoke;
export const call = (cmd, args = {}) => invoke("call", { cmd, args });
export const listen = (ev, fn) => T.event.listen(ev, (e) => fn(e.payload));
export const win = () => T.window.getCurrentWindow();

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, { kind = "", ico, action, onAction, ms = 3800 } = {}) {
  const root = $("#toasts");
  const el = h(`<div class="toast ${kind}">${icon(ico || (kind === "ok" ? "circle-check" : kind === "err" ? "triangle-alert" : "info"))}<div class="msg">${esc(msg)}</div>${action ? `<button class="act">${esc(action)}</button>` : ""}</div>`);
  const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  if (action) el.querySelector(".act").onclick = () => { onAction?.(); close(); };
  root.append(el);
  setTimeout(close, ms);
  return close;
}

export function menu(x, y, items) {
  $$(".menu").forEach((m) => m.remove());
  const el = h(`<div class="menu"></div>`);
  for (const it of items) {
    if (it === "-") { el.append(h("<hr>")); continue; }
    const b = h(`<button class="${it.danger ? "danger" : ""}">${icon(it.icon || "check", 15)}<span>${esc(it.label)}</span></button>`);
    b.onclick = () => { el.remove(); it.run(); };
    el.append(b);
  }
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  el.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  setTimeout(() => addEventListener("pointerdown", function off(e) { if (!el.contains(e.target)) { el.remove(); removeEventListener("pointerdown", off, true); } }, true));
  return el;
}

export function modal({ title, body, wide = false, onClose }) {
  const back = h(`<div class="modal-back"><div class="modal ${wide ? "wide" : ""}"><div class="modal-h"><h3>${esc(title)}</h3><button class="icon-btn x">${icon("x")}</button></div><div class="modal-b"></div></div></div>`);
  const b = back.querySelector(".modal-b");
  if (typeof body === "string") b.innerHTML = body; else if (body) b.append(body);
  const close = () => { back.remove(); removeEventListener("keydown", key, true); onClose?.(); };
  const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  addEventListener("keydown", key, true);
  back.querySelector(".x").onclick = close;
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  document.body.append(back);
  return { el: back, body: b, close };
}

export function busy(title) {
  const el = h(`<div class="busy"><div class="box"><b>${esc(title)}</b><div class="bar"><i></i></div><div class="muted small st">Starting…</div><div><button class="btn sm ghost cancel hidden">Cancel</button></div></div></div>`);
  document.body.append(el);
  return {
    set(p, text) { el.querySelector(".bar i").style.width = Math.round(p * 100) + "%"; if (text) el.querySelector(".st").textContent = text; },
    onCancel(fn) { const c = el.querySelector(".cancel"); c.classList.remove("hidden"); c.onclick = fn; },
    close() { el.remove(); },
  };
}

export function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + " " + u[i];
}

export function ago(ts) {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : d + " days ago";
}

export function rangeFill(el) {
  const set = () => el.style.setProperty("--p", ((el.value - el.min) / (el.max - el.min)) * 100 + "%");
  el.addEventListener("input", set);
  set();
}

/** Read clipboard/drag image files as base64 and add them to the library. */
export async function addBlobs(blobs, source = "user") {
  const out = [];
  for (const b of blobs) {
    const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
    try { out.push(await call("lib_add_b64", { data, title: (b.name || "Pasted image").replace(/\.[^.]+$/, ""), source })); }
    catch (e) { toast(String(e), { kind: "err" }); }
  }
  return out;
}

/** Library search: every word must match the title or a tag. */
export function matches(item, q) {
  if (!q) return true;
  const hay = (item.title + " " + (item.tags || []).join(" ")).toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

/** Popular-first score used by default sorting. */
export function score(item) {
  const srcW = { imgflip: 0, memegen: 300, giphy: 150, reddit: 220, user: -50, sticker: 900 }[item.source] ?? 400;
  return (item.fav ? -10000 : 0) - item.used * 40 + (item.rank || 500) + srcW;
}
