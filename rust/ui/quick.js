// The quick-meme popup (global hotkey): find a template, type, Enter = meme on the clipboard.
import { icon } from "./icons.js";
import { $, $$, esc, call, listen, win, toast, matches, score } from "./api.js";
import { libUrl, sceneFromItem, loadSceneMedia, renderScene, layout, timeline } from "./render.js";
import { exportScene, remember, memeName } from "./exporter.js";

const st = { items: [], list: [], idx: 0, mode: "text", scene: null, media: new Map(), settings: {}, texts: [], busy: false, t0: performance.now() };
const cv = $("#cv");
const ctx = cv.getContext("2d");

$("#copy").innerHTML = `${icon("clipboard", 17)}Copy meme`;
$("#edit").innerHTML = icon("pencil", 17);

async function refresh() {
  st.settings = await call("settings_get");
  st.items = (await call("lib_list")).filter((i) => i.source !== "sticker");
  filter();
}

function filter() {
  const q = $("#q").value.trim();
  let list = st.items.filter((i) => matches(i, q));
  // favourites and recently used first when there's no search
  list.sort((a, b) => (q ? score(a) - score(b) : (b.fav - a.fav) || (b.last_used - a.last_used) || score(a) - score(b)));
  st.list = list.slice(0, 80);
  st.idx = 0;
  const g = $("#grid");
  g.innerHTML = st.list.map((it, i) => `<div class="qi ${i === 0 ? "on" : ""}" data-i="${i}" title="${esc(it.title)}"><img loading="lazy" src="${libUrl(it.thumb)}">${it.animated ? '<span class="pill gif">GIF</span>' : ""}</div>`).join("") ||
    `<div class="muted" style="grid-column:1/-1;padding:30px;text-align:center">No match${st.items.length ? "" : " — your library is still empty"}.</div>`;
  $$(".qi", g).forEach((el) => {
    el.onclick = () => pick(+el.dataset.i, true);
    el.ondblclick = () => copy();
  });
  pick(0, false);
}

async function pick(i, focusText) {
  if (!st.list.length) { st.scene = null; $("#title").textContent = "Pick a meme"; ctx.clearRect(0, 0, cv.width, cv.height); return; }
  st.idx = Math.max(0, Math.min(st.list.length - 1, i));
  $$(".qi").forEach((el) => el.classList.toggle("on", +el.dataset.i === st.idx));
  $(`.qi[data-i="${st.idx}"]`)?.scrollIntoView({ block: "nearest" });
  const it = st.list[st.idx];
  st.mode = it.animated ? "caption" : "text";
  setMode(st.mode, false);
  await build(it);
  if (focusText) $("#fields textarea")?.focus();
}

async function build(it) {
  const keep = st.texts;
  st.scene = sceneFromItem(it, { caption: st.mode === "caption" });
  $("#title").textContent = it.title;
  const fields = $("#fields");
  if (st.mode === "caption") {
    fields.innerHTML = `<textarea class="input" rows="2" placeholder="Caption…">${esc(keep[0] || "")}</textarea>`;
  } else {
    const tl = st.scene.layers.filter((l) => l.type === "text");
    fields.innerHTML = tl.map((l, i) => `<textarea class="input" rows="1" placeholder="${esc(l.ph || "Text " + (i + 1))}">${esc(keep[i] || "")}</textarea>`).join("");
  }
  $$("textarea", fields).forEach((ta, i) => {
    ta.oninput = () => { st.texts[i] = ta.value; apply(); };
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); copy(); }
    };
  });
  apply();
  st.media = await loadSceneMedia(st.scene, st.settings.gif_max_frames || 300);
  apply();
}

function apply() {
  if (!st.scene) return;
  const tas = $$("#fields textarea");
  st.texts = tas.map((t) => t.value);
  if (st.mode === "caption") st.scene.caption.text = st.texts[0] || "";
  else st.scene.layers.filter((l) => l.type === "text").forEach((l, i) => (l.text = st.texts[i] || ""));
  draw(0);
  kick(); // media may have just loaded and turned out animated
}

function draw(t) {
  if (!st.scene) return;
  const lay = layout(st.scene, ctx);
  const box = $(".qprev").getBoundingClientRect();
  const s = Math.min(box.width / lay.W, box.height / lay.H, 2);
  const dpr = devicePixelRatio || 1;
  const w = Math.round(lay.W * s), h = Math.round(lay.H * s);
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
  }
  ctx.setTransform(s * dpr, 0, 0, s * dpr, 0, 0);
  renderScene(ctx, st.scene, st.media, t, { placeholders: true });
}

// This window is built hidden at startup and a hidden WebView2 still reports "visible", so animate only
// between __quickShown() and hide(), and only while the picked meme actually moves. kick() restarts it.
let shown = false, raf = 0;
function kick() { if (!raf && shown && st.scene && !document.hidden) raf = requestAnimationFrame(loop); }
function loop(now) {
  raf = 0;
  if (!shown || !st.scene || document.hidden) return;
  const tl = timeline(st.scene, st.media);
  if (!tl) return; // still image: apply() already drew it
  raf = requestAnimationFrame(loop);
  draw((now - st.t0) % tl.duration);
}
document.addEventListener("visibilitychange", kick);

function setMode(m, rebuild = true) {
  st.mode = m;
  $$("[data-m]").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
  if (rebuild && st.list[st.idx]) { st.texts = []; build(st.list[st.idx]); }
}
$$("[data-m]").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));

async function copy() {
  if (!st.scene || st.busy) return;
  st.busy = true;
  const btn = $("#copy");
  btn.innerHTML = `${icon("loader-circle", 17, "spin")}Making…`;
  try {
    apply();
    const name = memeName(st.scene);
    const res = await exportScene(st.scene, st.media, st.settings, {
      name,
      onProgress: (f) => (btn.innerHTML = `${icon("loader-circle", 17, "spin")}${Math.round(f * 100)}%`),
    });
    await call("clipboard", { path: res.path });
    remember(st.scene, st.media, res, { name }).catch(() => {});
    btn.innerHTML = `${icon("copy-check", 17)}Copied!`;
    setTimeout(hide, 450);
  } catch (e) {
    toast("Couldn't make it: " + (e.message || e), { kind: "err" });
    btn.innerHTML = `${icon("clipboard", 17)}Copy meme`;
  } finally {
    st.busy = false;
  }
}

function openEditor() {
  if (!st.scene) return;
  apply();
  shown = false; // Rust hides this window when the editor opens
  call("open_editor", { scene: st.scene });
}

function hide() {
  shown = false;
  $("#qp").classList.remove("on");
  setTimeout(() => call("quick_hide"), 120);
  $("#copy").innerHTML = `${icon("clipboard", 17)}Copy meme`;
}

$("#copy").onclick = copy;
$("#edit").onclick = openEditor;
$("#q").addEventListener("input", () => { st.texts = []; filter(); });

addEventListener("keydown", (e) => {
  const inSearch = document.activeElement === $("#q");
  if (e.key === "Escape") { e.preventDefault(); return hide(); }
  if (e.ctrlKey && e.key.toLowerCase() === "e") { e.preventDefault(); return openEditor(); }
  if (e.ctrlKey && e.key.toLowerCase() === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (inSearch) {
    const cols = 4;
    const mv = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (mv) { e.preventDefault(); return pick(st.idx + mv, false); }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); return $("#fields textarea")?.focus(); }
  }
});

// keep the popup tidy: closes when you click elsewhere
addEventListener("blur", () => { if (!st.busy) setTimeout(() => { if (!document.hasFocus()) hide(); }, 150); });

window.__quickShown = async () => {
  shown = true;
  kick();
  $("#qp").classList.add("on");
  st.texts = [];
  $("#q").value = "";
  await refresh();
  $("#q").focus();
};
window.__quickHidden = () => { shown = false; };
listen("library-changed", refresh);
refresh().then(() => $("#qp").classList.add("on"));
void win;
