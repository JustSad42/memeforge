// The editor: a canvas stage with draggable/resizable/rotatable layers, side panels, export.
import { icon } from "./icons.js";
import { $, $$, h, esc, call, toast, menu, modal, busy, fmtBytes, rangeFill, addBlobs, matches, score } from "./api.js";
import {
  FONTS, newScene, textLayer, imageLayer, srcOf, sceneFromItem, loadMedia, renderScene, layout, timeline,
  imagePlacement, libUrl,
} from "./render.js";
import { plan, exportScene, remember, memeName } from "./exporter.js";

const S = {
  scene: newScene(800, 600),
  media: new Map(),
  sel: null,
  hover: null,
  undo: [],
  redo: [],
  view: { s: 1, zoom: 0 }, // zoom 0 = fit
  playing: true,
  t: 0,
  t0: performance.now(),
  mode: null, // null | "crop" | "adjust"
  crop: null,
  tab: "text",
  projectId: "",
  dirty: false,
  settings: {},
  hasScene: false,
};
let ctx, cv, stage, wrap, overlay, env;

const sel = () => S.scene.layers.find((l) => l.id === S.sel) || null;
const clone = (o) => JSON.parse(JSON.stringify(o));
const isAnimated = () => S.scene.layers.some((l) => l.type === "image" && l.src && S.media.get(l.src.url)?.animated);

// ---------- setup ----------

export function initEditor(e) {
  env = e; // { getItems(), settings(), go(view), reloadLibrary() }
  const root = $("#view-editor");
  root.innerHTML = `
    <div class="panel ed-left">
      <div class="ptabs">
        <button class="ptab on" data-tab="text">${icon("type")}Text</button>
        <button class="ptab" data-tab="images">${icon("image-plus")}Images</button>
        <button class="ptab" data-tab="canvas">${icon("frame")}Canvas</button>
      </div>
      <div class="pbody" id="leftBody"></div>
    </div>
    <div class="ed-center">
      <div class="ed-bar">
        <button class="icon-btn" id="bUndo" title="Undo (Ctrl+Z)">${icon("undo-2")}</button>
        <button class="icon-btn" id="bRedo" title="Redo (Ctrl+Y)">${icon("redo-2")}</button>
        <div class="sep"></div>
        <button class="icon-btn" id="bAddText" title="Add text (T)">${icon("type")}</button>
        <button class="icon-btn" id="bAddImg" title="Add image or sticker">${icon("image-plus")}</button>
        <button class="icon-btn" id="bCrop" title="Crop">${icon("crop")}</button>
        <div class="title" id="edTitle">Untitled meme</div>
        <button class="btn sm ghost" id="bNew">${icon("plus", 15)}New</button>
      </div>
      <div class="stage-wrap" id="stageWrap">
        <div class="stage" id="stage"><canvas id="cv"></canvas><div id="overlay"></div></div>
        <div class="drop-hint" id="dropHint">Drop to add as a sticker</div>
      </div>
      <div class="ed-foot">
        <button class="icon-btn hidden" id="bPlay" title="Play / pause (Space)">${icon("pause")}</button>
        <input type="range" class="scrub hidden" id="scrub" min="0" max="1000" value="0">
        <span class="tc hidden" id="tc"></span>
        <span class="grow muted" id="sizeInfo"></span>
        <div class="zoom-ctl">
          <button class="icon-btn" id="zOut" title="Zoom out">${icon("zoom-out", 16)}</button>
          <span id="zVal">Fit</span>
          <button class="icon-btn" id="zIn" title="Zoom in">${icon("zoom-in", 16)}</button>
          <button class="icon-btn" id="zFit" title="Fit (Ctrl+0)">${icon("maximize", 16)}</button>
        </div>
      </div>
    </div>
    <div class="panel ed-right">
      <div class="export-card">
        <div class="twin">
          <button class="btn primary big" id="bCopy" title="Copy to clipboard (Ctrl+Shift+C)">${icon("clipboard", 17)}Copy</button>
          <button class="btn big" id="bSave" title="Save (Ctrl+S)">${icon("download", 17)}Save</button>
        </div>
        <div class="twin">
          <select class="input" id="fmt" title="Format">
            <option value="auto">Auto format</option><option value="png">PNG</option><option value="jpg">JPG</option>
            <option value="gif">GIF</option><option value="mp4">MP4</option>
          </select>
          <select class="input" id="osize" title="Output size">
            <option value="auto">Auto size</option><option value="1">Original</option>
            <option value="1080">1080 px wide</option><option value="720">720 px wide</option>
            <option value="480">480 px wide</option><option value="320">320 px wide</option>
          </select>
        </div>
        <div class="info"><span id="outInfo"></span><button class="btn sm ghost" id="bSaveAs" style="height:22px;padding:0 6px">Save as…</button></div>
      </div>
      <div class="pbody" id="insp"></div>
    </div>`;
  cv = $("#cv");
  ctx = cv.getContext("2d");
  stage = $("#stage");
  wrap = $("#stageWrap");
  overlay = $("#overlay");

  $$(".ptab", root).forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; $$(".ptab", root).forEach((x) => x.classList.toggle("on", x === b)); renderLeft(); }));
  $("#bUndo").onclick = undo;
  $("#bRedo").onclick = redo;
  $("#bAddText").onclick = () => addText();
  $("#bAddImg").onclick = () => pickImage("sticker");
  $("#bCrop").onclick = () => (S.mode === "crop" ? endCrop(false) : startCrop());
  $("#bNew").onclick = (e) => newMenu(e);
  $("#bCopy").onclick = () => doExport("copy");
  $("#bSave").onclick = () => doExport("save");
  $("#bSaveAs").onclick = () => doExport("saveas");
  $("#fmt").onchange = updateInfo;
  $("#osize").onchange = updateInfo;
  $("#zIn").onclick = () => setZoom((S.view.zoom || S.view.s) * 1.25);
  $("#zOut").onclick = () => setZoom((S.view.zoom || S.view.s) / 1.25);
  $("#zFit").onclick = () => setZoom(0);
  $("#bPlay").onclick = togglePlay;
  const scrub = $("#scrub");
  scrub.oninput = () => {
    const tl = timeline(S.scene, S.media);
    if (!tl) return;
    S.playing = false;
    S.t = (scrub.value / 1000) * tl.duration;
    $("#bPlay").innerHTML = icon("play");
    draw();
  };

  new ResizeObserver(() => fit()).observe(wrap);
  overlay.addEventListener("pointerdown", onDown);
  overlay.addEventListener("pointermove", onHover);
  overlay.addEventListener("pointerleave", () => { S.hover = null; drawOverlay(); });
  overlay.addEventListener("dblclick", onDbl);
  wrap.addEventListener("wheel", onWheel, { passive: false });
  setupDrop();
  addEventListener("keydown", onKey);
  addEventListener("paste", onPaste);
  document.addEventListener("visibilitychange", kick);
  kick();
  renderLeft();
  renderInspector();
}

export function isOpen() { return S.hasScene; }

// ---------- opening things ----------

export async function openScene(scene, { projectId = "", title } = {}) {
  S.scene = scene;
  S.sel = null;
  S.mode = null;
  S.undo = [];
  S.redo = [];
  S.projectId = projectId;
  S.hasScene = true;
  S.t = 0;
  S.t0 = performance.now();
  S.playing = true;
  $("#fmt").value = "auto";
  $("#edTitle").textContent = title || scene.title || "Untitled meme";
  await loadAllMedia();
  S.view.zoom = 0;
  fit();
  renderLeft();
  renderInspector();
  commit(true);
  // put the cursor in the first empty text box
  const first = S.scene.layers.find((l) => l.type === "text");
  if (S.scene.caption.on) setTimeout(() => $("#capText")?.focus(), 60);
  else if (first) setTimeout(() => focusText(first.id), 60);
}

export async function openItem(item, opts = {}) {
  call("lib_used", { id: item.id }).catch(() => {});
  const caption = opts.caption ?? false;
  const sc = sceneFromItem(item, { caption });
  await openScene(sc, { title: item.title });
}

async function loadAllMedia() {
  const max = S.settings.gif_max_frames || 300;
  await Promise.all(
    S.scene.layers.filter((l) => l.type === "image" && l.src && !S.media.has(l.src.url)).map(async (l) => {
      try { S.media.set(l.src.url, await loadMedia(l.src.url, max)); }
      catch (e) { toast(`Couldn't load "${l.src.title || "image"}": ${e.message || e}`, { kind: "err" }); }
    }),
  );
  draw();
  updateFoot();
}

export function setSettings(s) { S.settings = s; updateInfo(); }

// ---------- history ----------

let commitTimer = 0;
function commit(reset = false) {
  clearTimeout(commitTimer);
  const snap = JSON.stringify(S.scene);
  if (reset) { S.undo = [snap]; S.redo = []; }
  else if (S.undo[S.undo.length - 1] !== snap) {
    S.undo.push(snap);
    if (S.undo.length > 120) S.undo.shift();
    S.redo = [];
    S.dirty = true;
  }
  updateUndo();
}
const commitSoon = () => { clearTimeout(commitTimer); commitTimer = setTimeout(() => commit(), 450); };
function updateUndo() {
  $("#bUndo").disabled = S.undo.length < 2;
  $("#bRedo").disabled = !S.redo.length;
}
async function restore(snap) {
  S.scene = JSON.parse(snap);
  if (!S.scene.layers.find((l) => l.id === S.sel)) S.sel = null;
  await loadAllMedia();
  fit();
  renderLeft();
  renderInspector();
}
function undo() {
  commit();
  if (S.undo.length < 2) return;
  S.redo.push(S.undo.pop());
  restore(S.undo[S.undo.length - 1]);
  updateUndo();
}
function redo() {
  if (!S.redo.length) return;
  const s = S.redo.pop();
  S.undo.push(s);
  restore(s);
  updateUndo();
}

/** Something changed: redraw now, remember it shortly. */
function changed({ panels = false, refit = false } = {}) {
  if (refit) fit(); else draw();
  if (panels) { renderLeft(); renderInspector(); }
  commitSoon();
  updateInfo();
}

// ---------- drawing ----------

function fit() {
  if (!wrap) return;
  const lay = layout(S.scene, ctx);
  const ww = wrap.clientWidth, wh = wrap.clientHeight;
  const fitS = Math.min((ww - 64) / lay.W, (wh - 64) / lay.H, 3);
  const s = S.view.zoom || Math.max(0.05, fitS);
  S.view.s = s;
  S.lay = lay;
  const dw = Math.round(lay.W * s), dh = Math.round(lay.H * s);
  stage.style.width = dw + "px";
  stage.style.height = dh + "px";
  stage.style.left = Math.round((ww - dw) / 2) + "px";
  stage.style.top = Math.round((wh - dh) / 2) + "px";
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(dw * dpr));
  cv.height = Math.max(1, Math.round(dh * dpr));
  $("#zVal").textContent = S.view.zoom ? Math.round(s * 100) + "%" : "Fit";
  draw();
}

function setZoom(z) {
  S.view.zoom = z ? Math.max(0.1, Math.min(8, z)) : 0;
  fit();
}

function draw() {
  if (!ctx) return;
  const dpr = devicePixelRatio || 1;
  ctx.setTransform(S.view.s * dpr, 0, 0, S.view.s * dpr, 0, 0);
  S.lay = renderScene(ctx, S.scene, S.media, S.t, { placeholders: true });
  drawOverlay();
  kick();
}

// The playback loop runs only while a GIF/video is actually playing on screen; otherwise it stops,
// and kick() (called from draw(), play, crop end and visibility changes) starts it again.
let raf = 0;
const wantsFrames = () => S.playing && isAnimated() && S.mode !== "crop" && !document.hidden;
function kick() { if (!raf && wantsFrames()) raf = requestAnimationFrame(loop); }

function loop(now) {
  raf = 0;
  if (!wantsFrames()) return;
  raf = requestAnimationFrame(loop); // book the next frame first so draw()'s kick() doesn't double it
  const tl = timeline(S.scene, S.media);
  if (tl) {
    S.t = (now - S.t0) % tl.duration;
    draw();
    const sc = $("#scrub");
    if (sc) sc.value = Math.round((S.t / tl.duration) * 1000);
    $("#tc").textContent = `${(S.t / 1000).toFixed(2)} / ${(tl.duration / 1000).toFixed(2)} s`;
  }
}

function togglePlay() {
  S.playing = !S.playing;
  if (S.playing) { S.t0 = performance.now() - S.t; kick(); }
  $("#bPlay").innerHTML = icon(S.playing ? "pause" : "play");
}

function updateFoot() {
  const anim = isAnimated();
  ["#bPlay", "#scrub", "#tc"].forEach((s) => $(s).classList.toggle("hidden", !anim));
  updateInfo();
}

// ---------- overlay: selection box, handles, guides ----------

const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
const CURSORS = ["nwse", "ns", "nesw", "ew", "nwse", "ns", "nesw", "ew"];

function boxEl(L, cls) {
  const s = S.view.s, { ox, oy } = S.lay;
  const el = h(`<div class="sel ${cls}"></div>`);
  Object.assign(el.style, {
    left: (ox + L.x) * s + "px", top: (oy + L.y) * s + "px", width: L.w * s + "px", height: L.h * s + "px",
    transform: `rotate(${L.rot || 0}deg)`,
  });
  return el;
}

function drawOverlay() {
  if (!overlay) return;
  overlay.innerHTML = "";
  if (S.mode === "crop") return drawCrop();
  const hv = S.scene.layers.find((l) => l.id === S.hover);
  if (hv && hv.id !== S.sel) overlay.append(boxEl(hv, "hover"));
  const L = sel();
  if (!L || L.hidden) return;
  const el = boxEl(L, "");
  if (S.mode === "adjust") {
    el.style.borderColor = "#f472b6";
    overlay.append(el);
    return;
  }
  if (!L.locked) {
    HANDLES.forEach(([hx, hy], i) => {
      const k = h(`<div class="h" data-h="${i}"></div>`);
      k.style.left = ((hx + 1) / 2) * 100 + "%";
      k.style.top = ((hy + 1) / 2) * 100 + "%";
      // pick the cursor that matches the rotated direction
      const rot = (((L.rot || 0) % 180) + 180) % 180;
      const shift = Math.round(rot / 45);
      k.style.cursor = CURSORS[(i + shift * 1) % 8] + "-resize";
      el.append(k);
    });
    const r = h(`<div class="h rot" data-h="rot" title="Rotate"></div>`);
    r.style.left = "50%";
    r.style.top = "-26px";
    el.append(r);
  }
  overlay.append(el);
  for (const g of S.guides || []) {
    const ge = h(`<div class="guide ${g.v ? "v" : "h"}"></div>`);
    if (g.v) ge.style.left = g.v * S.view.s + "px"; else ge.style.top = g.h * S.view.s + "px";
    overlay.append(ge);
  }
}

/** Screen point -> content coordinates. */
function toContent(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left) / S.view.s - S.lay.ox, y: (e.clientY - r.top) / S.view.s - S.lay.oy };
}
const rotate = (x, y, deg) => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return { x: x * c - y * s, y: x * s + y * c };
};
function hit(L, p) {
  const cx = L.x + L.w / 2, cy = L.y + L.h / 2;
  const q = rotate(p.x - cx, p.y - cy, -(L.rot || 0));
  return Math.abs(q.x) <= L.w / 2 && Math.abs(q.y) <= L.h / 2;
}
function layerAt(p, includeBase = false) {
  for (let i = S.scene.layers.length - 1; i >= 0; i--) {
    const L = S.scene.layers[i];
    if (L.hidden) continue;
    if (L.base && !includeBase) continue;
    if (hit(L, p)) return L;
  }
  return null;
}

function onHover(e) {
  if (e.buttons || S.mode) return;
  const L = layerAt(toContent(e));
  const id = L ? L.id : null;
  overlay.style.cursor = L && !L.locked ? "move" : "default";
  if (id !== S.hover) { S.hover = id; drawOverlay(); }
}

function select(id, { focus = false } = {}) {
  if (S.mode === "adjust" && id !== S.sel) S.mode = null;
  S.sel = id;
  drawOverlay();
  renderInspector();
  $$(".tbox").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  $$(".layer-row").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
  if (focus) focusText(id);
}

function focusText(id) {
  const L = S.scene.layers.find((l) => l.id === id);
  if (!L || L.type !== "text") return;
  if (S.tab !== "text") { S.tab = "text"; $$(".ptab").forEach((x) => x.classList.toggle("on", x.dataset.tab === "text")); renderLeft(); }
  const ta = $(`.tbox[data-id="${id}"] textarea`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); ta.closest(".tbox").scrollIntoView({ block: "nearest", behavior: "smooth" }); }
  if (S.sel !== id) select(id);
}

function onDbl(e) {
  const p = toContent(e);
  const L = layerAt(p) || layerAt(p, true);
  if (!L) return;
  if (L.type === "text") focusText(L.id);
  else if (L.type === "image" && L.src) { select(L.id); startAdjust(); }
  else if (L.type === "image") fillSlot(L);
}

function onDown(e) {
  if (e.button !== 0) return;
  if (S.mode === "crop") return cropDown(e);
  const p = toContent(e);
  const hEl = e.target.closest?.(".h");
  let L = sel();
  if (S.mode === "adjust") {
    if (L && hit(L, p)) return dragPan(e, L, p);
    endAdjust();
  }
  if (hEl && L) return hEl.dataset.h === "rot" ? dragRotate(e, L) : dragResize(e, L, HANDLES[+hEl.dataset.h], p);
  L = layerAt(p);
  if (!L) {
    // empty spot: an empty panel slot under the base? else deselect
    const b = layerAt(p, true);
    if (b && b.type === "image" && !b.src) { select(b.id); return fillSlot(b); }
    select(null);
    return;
  }
  select(L.id);
  if (L.type === "image" && !L.src) return fillSlot(L);
  if (!L.locked) dragMove(e, L, p);
}

function track(e, move, up) {
  try { overlay.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => move(ev);
  const end = (ev) => {
    overlay.removeEventListener("pointermove", mv);
    overlay.removeEventListener("pointerup", end);
    overlay.removeEventListener("pointercancel", end);
    S.guides = [];
    up?.(ev);
    drawOverlay();
    commit();
    renderInspector();
  };
  overlay.addEventListener("pointermove", mv);
  overlay.addEventListener("pointerup", end);
  overlay.addEventListener("pointercancel", end);
}

function dragMove(e, L, p0) {
  const x0 = L.x, y0 = L.y;
  const { w: W, h: H } = S.scene;
  const tol = 6 / S.view.s;
  track(e, (ev) => {
    const p = toContent(ev);
    let x = x0 + p.x - p0.x, y = y0 + p.y - p0.y;
    S.guides = [];
    if (!ev.altKey) {
      // snap centre/edges to the canvas centre and edges
      const cx = x + L.w / 2, cy = y + L.h / 2;
      const snapsX = [[W / 2, cx, 0], [0, x, 0], [W, x + L.w, 0]];
      for (const [t, v] of snapsX) if (Math.abs(t - v) < tol) { x += t - v; S.guides.push({ v: S.lay.ox + t }); break; }
      const snapsY = [[H / 2, cy], [0, y], [H, y + L.h]];
      for (const [t, v] of snapsY) if (Math.abs(t - v) < tol) { y += t - v; S.guides.push({ h: S.lay.oy + t }); break; }
    }
    L.x = Math.round(x);
    L.y = Math.round(y);
    draw();
  });
}

function dragResize(e, L, [hx, hy], p0) {
  e.stopPropagation();
  const o = { x: L.x, y: L.y, w: L.w, h: L.h };
  const c0 = { x: o.x + o.w / 2, y: o.y + o.h / 2 };
  const corner = hx !== 0 && hy !== 0;
  const keep = L.type === "image";
  track(e, (ev) => {
    const p = toContent(ev);
    const d = rotate(p.x - p0.x, p.y - p0.y, -(L.rot || 0));
    let w = Math.max(12, o.w + hx * d.x * (ev.ctrlKey ? 2 : 1));
    let hh = Math.max(12, o.h + hy * d.y * (ev.ctrlKey ? 2 : 1));
    if (!hx) w = o.w;
    if (!hy) hh = o.h;
    if (corner && (keep !== ev.shiftKey)) {
      const k = Math.max(w / o.w, hh / o.h);
      w = o.w * k;
      hh = o.h * k;
    }
    let cx, cy;
    if (ev.ctrlKey) { cx = c0.x; cy = c0.y; }
    else {
      // keep the opposite edge/corner where it was
      const a = rotate((-hx * o.w) / 2, (-hy * o.h) / 2, L.rot || 0);
      const b = rotate((-hx * w) / 2, (-hy * hh) / 2, L.rot || 0);
      cx = c0.x + a.x - b.x;
      cy = c0.y + a.y - b.y;
    }
    L.w = Math.round(w);
    L.h = Math.round(hh);
    L.x = Math.round(cx - w / 2);
    L.y = Math.round(cy - hh / 2);
    draw();
  });
}

function dragRotate(e, L) {
  e.stopPropagation();
  const c = { x: L.x + L.w / 2, y: L.y + L.h / 2 };
  track(e, (ev) => {
    const p = toContent(ev);
    let a = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
    if (ev.shiftKey) a = Math.round(a / 15) * 15;
    else { const n = Math.round(a / 45) * 45; if (Math.abs(n - a) < 4) a = n; }
    a = ((a + 540) % 360) - 180;
    L.rot = Math.round(a * 10) / 10;
    draw();
  });
}

// "adjust" mode: drag pans the picture inside its frame, wheel zooms it
function startAdjust() {
  const L = sel();
  if (!L || L.type !== "image" || !L.src) return;
  S.mode = "adjust";
  drawOverlay();
  toast("Drag to move the picture inside its frame, scroll to zoom. Press Enter when done.", { ico: "hand", ms: 3000 });
}
function endAdjust() { S.mode = null; drawOverlay(); commit(); renderInspector(); }
function dragPan(e, L, p0) {
  const m = S.media.get(L.src.url);
  if (!m) return;
  const px = L.panX || 0, py = L.panY || 0;
  track(e, (ev) => {
    const p = toContent(ev);
    const d = rotate(p.x - p0.x, p.y - p0.y, -(L.rot || 0));
    const pl = imagePlacement({ ...L, panX: 0, panY: 0 }, m.w, m.h);
    const mx = Math.max(0, (pl.dw - L.w) / 2), my = Math.max(0, (pl.dh - L.h) / 2);
    L.panX = Math.max(-mx, Math.min(mx, px + d.x * (L.flipX ? -1 : 1)));
    L.panY = Math.max(-my, Math.min(my, py + d.y));
    draw();
  });
}

function onWheel(e) {
  const L = sel();
  if (S.mode === "adjust" && L) {
    e.preventDefault();
    L.zoom = Math.max(1, Math.min(8, (L.zoom || 1) * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    draw();
    commitSoon();
    return;
  }
  if (e.ctrlKey) {
    e.preventDefault();
    setZoom(S.view.s * (e.deltaY < 0 ? 1.12 : 1 / 1.12));
  }
}

// ---------- crop ----------

function startCrop() {
  endAdjust();
  S.mode = "crop";
  S.crop = { x: 0, y: 0, w: S.scene.w, h: S.scene.h, ratio: 0 };
  select(null);
  $("#bCrop").classList.add("on");
  drawOverlay();
}
function endCrop(apply) {
  const c = S.crop;
  S.mode = null;
  kick();
  $("#bCrop").classList.remove("on");
  $(".crop-bar")?.remove();
  if (apply && c && (c.x || c.y || c.w !== S.scene.w || c.h !== S.scene.h)) {
    for (const L of S.scene.layers) { L.x -= c.x; L.y -= c.y; }
    S.scene.w = Math.round(c.w);
    S.scene.h = Math.round(c.h);
    changed({ refit: true, panels: true });
  }
  drawOverlay();
}
function drawCrop() {
  const c = S.crop, s = S.view.s, { ox, oy } = S.lay;
  const box = h(`<div class="crop-box"></div>`);
  Object.assign(box.style, { left: (ox + c.x) * s + "px", top: (oy + c.y) * s + "px", width: c.w * s + "px", height: c.h * s + "px" });
  HANDLES.forEach(([hx, hy], i) => {
    const k = h(`<div class="h" data-h="${i}"></div>`);
    k.style.left = ((hx + 1) / 2) * 100 + "%";
    k.style.top = ((hy + 1) / 2) * 100 + "%";
    k.style.cursor = CURSORS[i] + "-resize";
    box.append(k);
  });
  overlay.append(box);
  if (!$(".crop-bar")) {
    const bar = h(`<div class="crop-bar">
      <div class="seg" style="width:260px">${[["Free", 0], ["1:1", 1], ["4:5", 0.8], ["16:9", 16 / 9], ["9:16", 9 / 16]].map(([n, r]) => `<button data-r="${r}" class="${c.ratio == r ? "on" : ""}">${n}</button>`).join("")}</div>
      <button class="btn sm ghost" data-a="cancel">Cancel</button><button class="btn sm primary" data-a="ok">${icon("check", 15)}Crop</button></div>`);
    bar.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => {
      const r = +b.dataset.r;
      c.ratio = r;
      bar.querySelectorAll("[data-r]").forEach((x) => x.classList.toggle("on", x === b));
      if (r) {
        let w = S.scene.w, hh = w / r;
        if (hh > S.scene.h) { hh = S.scene.h; w = hh * r; }
        Object.assign(c, { w, h: hh, x: (S.scene.w - w) / 2, y: (S.scene.h - hh) / 2 });
      }
      drawOverlay();
    }));
    bar.querySelector('[data-a="cancel"]').onclick = () => endCrop(false);
    bar.querySelector('[data-a="ok"]').onclick = () => endCrop(true);
    wrap.append(bar);
  }
}
function cropDown(e) {
  const c = S.crop, p = toContent(e), o = { ...c };
  const hEl = e.target.closest?.(".h");
  const W = S.scene.w, H = S.scene.h;
  try { overlay.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => {
    const q = toContent(ev), dx = q.x - p.x, dy = q.y - p.y;
    if (hEl) {
      const [hx, hy] = HANDLES[+hEl.dataset.h];
      let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
      if (hx < 0) x0 = Math.min(x1 - 10, Math.max(0, o.x + dx));
      if (hx > 0) x1 = Math.max(x0 + 10, Math.min(W, x1 + dx));
      if (hy < 0) y0 = Math.min(y1 - 10, Math.max(0, o.y + dy));
      if (hy > 0) y1 = Math.max(y0 + 10, Math.min(H, y1 + dy));
      if (c.ratio) {
        const w = x1 - x0;
        const hh = w / c.ratio;
        if (hy < 0) y0 = y1 - hh; else y1 = y0 + hh;
        if (y0 < 0 || y1 > H) return;
      }
      Object.assign(c, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    } else {
      c.x = Math.max(0, Math.min(W - c.w, o.x + dx));
      c.y = Math.max(0, Math.min(H - c.h, o.y + dy));
    }
    drawOverlay();
  };
  const up = () => { overlay.removeEventListener("pointermove", mv); overlay.removeEventListener("pointerup", up); };
  overlay.addEventListener("pointermove", mv);
  overlay.addEventListener("pointerup", up);
}

// ---------- adding things ----------

function addText(over = {}) {
  const { w: W, h: H } = S.scene;
  const n = S.scene.layers.filter((l) => l.type === "text").length;
  const L = textLayer({
    x: Math.round(W * 0.1), y: Math.round(H * 0.4 + ((n * 37) % (H * 0.3)) - H * 0.15), w: Math.round(W * 0.8), h: Math.round(Math.max(40, H * 0.18)),
    size: Math.max(24, Math.round(Math.min(W, H) / 9)), ph: "Your text", ...over,
  });
  S.scene.layers.push(L);
  S.sel = L.id;
  changed({ panels: true });
  setTimeout(() => focusText(L.id), 30);
  return L;
}

/** Put a library item on the canvas as a movable image (sticker). */
async function addSticker(item) {
  const { w: W, h: H } = S.scene;
  const k = Math.min((W * 0.4) / item.w, (H * 0.4) / item.h, 1.5);
  const L = imageLayer(item, { w: Math.round(item.w * k), h: Math.round(item.h * k) });
  L.x = Math.round((W - L.w) / 2);
  L.y = Math.round((H - L.h) / 2);
  S.scene.layers.push(L);
  S.sel = L.id;
  await loadAllMedia();
  changed({ panels: true });
}

async function fillSlot(L) {
  const item = await pickImage("pick");
  if (!item) return;
  L.src = srcOf(item);
  L.zoom = 1; L.panX = 0; L.panY = 0;
  await loadAllMedia();
  changed({ panels: true });
}

async function replaceImage(L) {
  const item = await pickImage("pick");
  if (!item) return;
  L.src = srcOf(item);
  L.zoom = 1; L.panX = 0; L.panY = 0;
  if (L.base) {
    // the canvas follows a replaced background's shape
    const k = S.scene.w / item.w;
    L.h = Math.round(item.h * k);
    S.scene.h = L.h;
    S.scene.title = item.title;
  }
  await loadAllMedia();
  changed({ panels: true, refit: true });
}

/** Choose an image from the library (or a file). mode "sticker" adds it, "pick" returns it. */
function pickImage(mode) {
  return new Promise((resolve) => {
    let tab = mode === "sticker" ? "sticker" : "all", q = "";
    const body = h(`<div style="display:grid;gap:14px;min-height:0">
      <div class="row"><div class="search grow">${icon("search")}<input class="input" placeholder="Search your library…"></div>
      <button class="btn" data-a="file">${icon("upload", 16)}From file</button></div>
      <div class="chips"></div><div class="grid" style="columns:150px"></div></div>`);
    const m = modal({ title: mode === "sticker" ? "Add an image or sticker" : "Choose an image", body, wide: true, onClose: () => resolve(null) });
    // resolve before closing: closing resolves with null
    const done = (item) => { resolve(item); m.close(); if (mode === "sticker" && item) addSticker(item); };
    const tabs = [["all", "All"], ["sticker", "Stickers"], ["user", "My uploads"], ["still", "Templates"], ["gif", "GIFs"], ["fav", "Favorites"]];
    const chips = body.querySelector(".chips");
    const grid = body.querySelector(".grid");
    const paint = () => {
      chips.innerHTML = tabs.map(([k, n]) => `<button class="chip ${tab === k ? "on" : ""}" data-k="${k}">${n}</button>`).join("");
      chips.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { tab = c.dataset.k; paint(); }));
      let items = env.getItems().filter((i) => matches(i, q));
      items = items.filter((i) => tab === "all" ? true : tab === "sticker" ? i.source === "sticker" : tab === "user" ? i.source === "user" : tab === "still" ? !i.animated && !["sticker", "user"].includes(i.source) : tab === "gif" ? i.animated : i.fav);
      items.sort((a, b) => score(a) - score(b));
      grid.innerHTML = items.length ? "" : `<div class="empty" style="column-span:all"><div>Nothing here yet.${tab === "sticker" ? " Add a PNG with a see-through background using “From file”, or paste one with Ctrl+V." : ""}</div></div>`;
      for (const it of items.slice(0, 300)) {
        const c = h(`<div class="card"><img loading="lazy" src="${libUrl(it.thumb)}" alt=""><div class="tag">${it.animated ? '<span class="pill gif">GIF</span>' : ""}</div><div class="meta">${esc(it.title)}</div></div>`);
        c.onclick = () => done(it);
        grid.append(c);
      }
    };
    body.querySelector("input").oninput = (e) => { q = e.target.value; paint(); };
    body.querySelector('[data-a="file"]').onclick = async () => {
      const r = await call("lib_add_dialog", { source: mode === "sticker" ? "sticker" : "user" });
      if (r.errors?.length) toast(r.errors.join("\n"), { kind: "err" });
      await env.reloadLibrary();
      if (r.added?.length) done(r.added[0]);
    };
    paint();
    setTimeout(() => body.querySelector("input").focus(), 50);
  });
}

// ---------- panel layouts ----------

const LAYOUTS = {
  single: [[0, 0, 1, 1]],
  rows2: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
  cols2: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  grid4: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  rows3: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 1 / 3], [0, 2 / 3, 1, 1 / 3]],
  rows4: [[0, 0, 1, 0.25], [0, 0.25, 1, 0.25], [0, 0.5, 1, 0.25], [0, 0.75, 1, 0.25]],
  big2: [[0, 0, 1, 0.6], [0, 0.6, 0.5, 0.4], [0.5, 0.6, 0.5, 0.4]],
  cols3: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
  side: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
};
const LAYOUT_SIZE = { single: [1, 1], rows2: [1, 2], cols2: [2, 1], grid4: [2, 2], rows3: [1, 3], rows4: [1, 4], big2: [2, 2.5], cols3: [3, 1], side: [2, 2] };

function layoutIcon(k) {
  return `<svg class="lay" viewBox="0 0 40 40">${LAYOUTS[k].map(([x, y, w, hh]) => `<rect x="${2 + x * 36 + 1}" y="${2 + y * 36 + 1}" width="${w * 36 - 2}" height="${hh * 36 - 2}" rx="2"/>`).join("")}</svg>`;
}

function applyLayout(k, gap = 8) {
  const imgs = S.scene.layers.filter((l) => l.type === "image" && (l.base || l.slot));
  const firstSrc = imgs.find((l) => l.src)?.src;
  const cellAspect = firstSrc ? firstSrc.w / firstSrc.h : 4 / 3;
  const [cx, cy] = LAYOUT_SIZE[k];
  const W = Math.round(Math.max(600, Math.min(1000, S.scene.w)));
  const cellW = (W - gap * (cx - 1)) / cx;
  const H = Math.round((cellW / cellAspect) * cy + gap * (Math.ceil(cy) - 1));
  const keep = S.scene.layers.filter((l) => !(l.type === "image" && (l.base || l.slot)));
  // keep text roughly in place relative to the new size
  const sx = W / S.scene.w, sy = H / S.scene.h;
  keep.forEach((l) => { l.x *= sx; l.y *= sy; l.w *= sx; l.h *= sy; if (l.type === "text") l.size *= Math.min(sx, sy); });
  const slots = LAYOUTS[k].map(([x, y, w, hh], i) => {
    const gx = x > 0 ? gap / 2 : 0, gy = y > 0 ? gap / 2 : 0;
    const gw = (x > 0 ? gap / 2 : 0) + (x + w < 0.999 ? gap / 2 : 0);
    const gh = (y > 0 ? gap / 2 : 0) + (y + hh < 0.999 ? gap / 2 : 0);
    return imageLayer(null, {
      slot: true, base: k === "single", src: imgs[i]?.src || null,
      x: Math.round(x * W + gx), y: Math.round(y * H + gy), w: Math.round(w * W - gw), h: Math.round(hh * H - gh),
    });
  });
  S.scene.w = W;
  S.scene.h = H;
  S.scene.layers = [...slots, ...keep];
  S.scene.layout = k;
  loadAllMedia();
  changed({ refit: true, panels: true });
}

// ---------- left panel ----------

const PRESETS = {
  classic: { font: "Impact", color: "#ffffff", stroke: "#000000", strokeW: 0.16, caps: true, shadow: 0, bg: "", bold: false },
  modern: { font: "Arial Black", color: "#ffffff", stroke: "#000000", strokeW: 0.1, caps: false, shadow: 0.8, bg: "", bold: false },
  plain: { font: "Arial", color: "#000000", stroke: "", strokeW: 0, caps: false, shadow: 0, bg: "", bold: true },
  label: { font: "Arial", color: "#000000", stroke: "", strokeW: 0, caps: false, shadow: 0, bg: "#ffffff", bold: true },
  subtitle: { font: "Arial", color: "#ffee00", stroke: "#000000", strokeW: 0.12, caps: false, shadow: 0.5, bg: "", bold: true },
  neon: { font: "Segoe UI Black", color: "#ffffff", stroke: "#ec4899", strokeW: 0.14, caps: true, shadow: 1, bg: "", bold: false },
};
const EMOJI = "😂🤣😭💀🔥👀🙏😎🥲😤🤡👍👎❤️💯✨😱🤔🫠😳🙃😏🥺😈🗿🤌🧠💩🎉⚡👑🚀".match(/\p{Extended_Pictographic}️?/gu);

function renderLeft() {
  const b = $("#leftBody");
  if (!b) return;
  if (S.tab === "text") {
    const texts = S.scene.layers.filter((l) => l.type === "text" && !/^\p{Extended_Pictographic}/u.test(l.text));
    const c = S.scene.caption;
    b.innerHTML = `
      <div class="pgroup">
        <div class="row between"><span class="lbl">Caption bar</span><label class="switch"><input type="checkbox" id="capOn" ${c.on ? "checked" : ""}><span></span></label></div>
        ${c.on ? `<textarea class="input" id="capText" rows="2" placeholder="Caption above the image…">${esc(c.text)}</textarea>
        <div class="row"><select class="input grow" id="capFont">${FONTS.map((f) => `<option ${f.name === c.font ? "selected" : ""}>${f.name}</option>`).join("")}</select>
        <div class="color" title="Text colour"><i style="background:${c.color}"></i><input type="color" id="capColor" value="${c.color}"></div>
        <div class="color" title="Bar colour"><i style="background:${c.bg}"></i><input type="color" id="capBg" value="${c.bg}"></div></div>` : `<div class="faint small">A white bar with black text above the picture — the classic way to caption a GIF.</div>`}
      </div>
      <div class="pgroup">
        <div class="row between"><span class="lbl">Text boxes</span><span class="faint small">${texts.length}</span></div>
        <div id="tboxes" style="display:grid;gap:8px"></div>
        <button class="btn block" id="addT">${icon("plus", 16)}Add text box</button>
      </div>
      <div class="pgroup">
        <span class="lbl">Style${sel()?.type === "text" ? " (selected)" : " (all text)"}</span>
        <div class="tiles" style="grid-template-columns:repeat(3,1fr)">
          ${Object.keys(PRESETS).map((k) => { const p = PRESETS[k]; return `<button class="tile" data-p="${k}" style="aspect-ratio:auto;height:52px;padding:4px;background:${p.bg || (p.color === "#000000" ? "#d9d9e0" : "var(--surface)")}"><span style="font:${p.bold ? 800 : 400} 17px '${p.font}';color:${p.color};-webkit-text-stroke:${p.strokeW ? "1px " + p.stroke : "0"};text-shadow:${p.shadow ? "0 2px 6px #000" : "none"}">${p.caps ? "MEME" : "Meme"}</span></button>`; }).join("")}
        </div>
      </div>`;
    const list = $("#tboxes");
    texts.forEach((L, i) => {
      const el = h(`<div class="tbox ${L.id === S.sel ? "on" : ""}" data-id="${L.id}">
        <div class="row"><span class="num">${i + 1}</span><span class="grow"></span>
        <button class="icon-btn" style="width:22px;height:22px" title="Delete" data-a="del">${icon("x", 13)}</button></div>
        <textarea rows="2" class="input" placeholder="${esc(L.ph || "Your text")}">${esc(L.text)}</textarea></div>`);
      const ta = el.querySelector("textarea");
      ta.oninput = () => { L.text = ta.value; changed(); };
      ta.onfocus = () => { if (S.sel !== L.id) select(L.id); };
      ta.onkeydown = (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const all = $$("#tboxes textarea");
          const nx = all[(all.indexOf(ta) + (e.shiftKey ? -1 : 1) + all.length) % all.length];
          nx?.focus();
        }
      };
      el.querySelector('[data-a="del"]').onclick = () => removeLayer(L.id);
      el.onclick = (e) => { if (e.target === el) ta.focus(); };
      list.append(el);
    });
    $("#addT").onclick = () => addText();
    $("#capOn").onchange = (e) => { c.on = e.target.checked; changed({ refit: true, panels: true }); if (c.on) setTimeout(() => $("#capText")?.focus(), 30); };
    if (c.on) {
      $("#capText").oninput = (e) => { c.text = e.target.value; changed({ refit: true }); };
      $("#capFont").onchange = (e) => { c.font = e.target.value; changed({ refit: true }); };
      $("#capColor").oninput = (e) => { c.color = e.target.value; e.target.previousElementSibling.style.background = c.color; changed(); };
      $("#capBg").oninput = (e) => { c.bg = e.target.value; e.target.previousElementSibling.style.background = c.bg; changed(); };
    }
    $$("[data-p]", b).forEach((t) => (t.onclick = () => {
      const p = PRESETS[t.dataset.p];
      const targets = sel()?.type === "text" ? [sel()] : S.scene.layers.filter((l) => l.type === "text");
      targets.forEach((L) => Object.assign(L, p));
      changed();
      renderInspector();
    }));
  } else if (S.tab === "images") {
    const stickers = env.getItems().filter((i) => i.source === "sticker").sort((a, b) => b.last_used - a.last_used || b.added - a.added).slice(0, 12);
    b.innerHTML = `
      <div class="pgroup">
        <span class="lbl">Add</span>
        <button class="btn block" id="pLib">${icon("library-big", 16)}From library</button>
        <div class="twin" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <button class="btn" id="pFile">${icon("upload", 16)}File</button>
          <button class="btn" id="pPaste" title="Or press Ctrl+V">${icon("clipboard", 16)}Paste</button>
        </div>
        <div class="faint small">Tip: drop images on the canvas, or press Ctrl+V to paste one.</div>
      </div>
      <div class="pgroup">
        <span class="lbl">Panels</span>
        <div class="tiles">${Object.keys(LAYOUTS).map((k) => `<button class="tile" data-l="${k}" title="${k}">${layoutIcon(k)}</button>`).join("")}</div>
        <div class="faint small">Click an empty panel to fill it. Double-click a picture to move it inside its panel.</div>
      </div>
      <div class="pgroup">
        <div class="row between"><span class="lbl">Stickers</span><button class="btn sm ghost" id="pStk">${icon("plus", 14)}Add</button></div>
        <div class="stickers">${stickers.map((s) => `<button data-id="${s.id}" title="${esc(s.title)}"><img src="${libUrl(s.file)}" alt=""></button>`).join("") || '<span class="faint small" style="grid-column:1/-1">PNG stickers you add show up here.</span>'}</div>
      </div>
      <div class="pgroup">
        <span class="lbl">Emoji</span>
        <div class="emoji-grid">${EMOJI.map((e) => `<button>${e}</button>`).join("")}</div>
      </div>`;
    $("#pLib").onclick = () => pickImage("sticker");
    $("#pFile").onclick = async () => {
      const r = await call("lib_add_dialog", { source: "sticker" });
      await env.reloadLibrary();
      for (const it of r.added || []) await addSticker(it);
    };
    $("#pPaste").onclick = pasteFromClipboard;
    $("#pStk").onclick = async () => { const r = await call("lib_add_dialog", { source: "sticker" }); await env.reloadLibrary(); renderLeft(); for (const it of r.added || []) await addSticker(it); };
    $$("[data-l]", b).forEach((t) => (t.onclick = () => applyLayout(t.dataset.l)));
    $$(".stickers [data-id]", b).forEach((t) => (t.onclick = () => { const it = env.getItems().find((i) => i.id === t.dataset.id); if (it) addSticker(it); }));
    $$(".emoji-grid button", b).forEach((t) => (t.onclick = () => {
      const sz = Math.round(Math.min(S.scene.w, S.scene.h) / 5);
      const bw = Math.round(sz * 1.6);
      addText({ text: t.textContent, font: "Segoe UI Emoji", caps: false, strokeW: 0, autoSize: true, size: sz * 1.3, w: bw, h: bw, x: Math.round((S.scene.w - bw) / 2), y: Math.round((S.scene.h - bw) / 2) });
      S.tab = "images";
      renderLeft();
    }));
  } else {
    const sc = S.scene, p = sc.pad;
    const anim = isAnimated();
    b.innerHTML = `
      <div class="pgroup">
        <span class="lbl">Size</span>
        <div class="row"><input class="input" id="cw" type="number" min="16" max="8000" value="${sc.w}"><span class="faint">×</span><input class="input" id="ch" type="number" min="16" max="8000" value="${sc.h}"></div>
        <div class="row"><button class="btn grow" id="cCrop">${icon("crop", 16)}Crop</button><button class="btn grow" id="cScale" title="Scale everything to the new width">${icon("expand", 16)}Scale to width</button></div>
        <div class="faint small">Changing the numbers resizes the canvas (adds space or cuts edges). “Scale to width” resizes everything.</div>
      </div>
      <div class="pgroup">
        <span class="lbl">Padding</span>
        <div class="kv"><span>Sides</span><span class="v" id="vpx">${p.l}px</span></div>
        <input type="range" id="padX" min="0" max="300" value="${p.l}">
        <div class="kv"><span>Top & bottom</span><span class="v" id="vpy">${p.t}px</span></div>
        <input type="range" id="padY" min="0" max="300" value="${p.t}">
        <div class="row"><span class="grow">Padding colour</span><div class="color"><i style="background:${p.color}"></i><input type="color" id="padC" value="${p.color}"></div></div>
      </div>
      <div class="pgroup">
        <div class="row"><span class="grow">Background</span><div class="color"><i style="background:${sc.bg === "transparent" ? "transparent" : sc.bg}"></i><input type="color" id="bgC" value="${sc.bg === "transparent" ? "#ffffff" : sc.bg}"></div></div>
        <div class="row between"><span>See-through background</span><label class="switch"><input type="checkbox" id="bgT" ${sc.bg === "transparent" ? "checked" : ""}><span></span></label></div>
      </div>
      ${anim ? `<div class="pgroup">
        <span class="lbl">Animation</span>
        <div class="kv"><span>Speed</span><span class="v" id="vsp">${sc.speed}×</span></div>
        <input type="range" id="speed" min="0.25" max="3" step="0.05" value="${sc.speed}">
      </div>` : ""}`;
    const num = (id, fn) => ($(id).onchange = (e) => { fn(Math.max(16, Math.min(8000, +e.target.value || 16))); changed({ refit: true }); });
    num("#cw", (v) => (sc.w = v));
    num("#ch", (v) => (sc.h = v));
    $("#cCrop").onclick = startCrop;
    $("#cScale").onclick = () => {
      const nw = +prompt("New width in pixels:", sc.w);
      if (!nw || nw < 16) return;
      const k = nw / sc.w;
      sc.w = Math.round(sc.w * k); sc.h = Math.round(sc.h * k);
      for (const L of sc.layers) { L.x *= k; L.y *= k; L.w *= k; L.h *= k; if (L.size) L.size *= k; L.panX = (L.panX || 0) * k; L.panY = (L.panY || 0) * k; }
      for (const s of ["t", "r", "b", "l"]) p[s] = Math.round(p[s] * k);
      changed({ refit: true, panels: true });
    };
    const rng = (id, out, fn) => { const r = $(id); rangeFill(r); r.oninput = () => { fn(+r.value); $(out).textContent = r.value + (id === "#speed" ? "×" : "px"); changed({ refit: true }); }; };
    rng("#padX", "#vpx", (v) => (p.l = p.r = v));
    rng("#padY", "#vpy", (v) => (p.t = p.b = v));
    if (anim) rng("#speed", "#vsp", (v) => (sc.speed = v));
    $("#padC").oninput = (e) => { p.color = e.target.value; e.target.previousElementSibling.style.background = p.color; changed(); };
    $("#bgC").oninput = (e) => { sc.bg = e.target.value; e.target.previousElementSibling.style.background = sc.bg; $("#bgT").checked = false; changed(); };
    $("#bgT").onchange = (e) => { sc.bg = e.target.checked ? "transparent" : $("#bgC").value; changed(); };
  }
}

// ---------- inspector (right panel) ----------

const SWATCH = ["#ffffff", "#000000", "#ffee00", "#ff3b30", "#ff9500", "#34c759", "#0a84ff", "#bf5af2", "#ff2d92", "#8e8e93"];

function renderInspector() {
  const b = $("#insp");
  if (!b) return;
  const L = sel();
  const layers = [...S.scene.layers].reverse();
  const layerList = `<div class="pgroup"><span class="lbl">Layers</span><div class="layer-list">${layers.map((l) => {
    const name = l.type === "text" ? (l.text || l.ph || "Text").split("\n")[0] : l.base ? "Background" : l.slot ? (l.src ? `Panel: ${l.src.title || "image"}` : "Empty panel") : l.src?.title || "Image";
    const th = l.type === "text" ? `<span class="thumb">T</span>` : l.src ? `<img class="thumb" src="${l.src.url}">` : `<span class="thumb">${icon("square-dashed", 13)}</span>`;
    return `<div class="layer-row ${l.id === S.sel ? "on" : ""}" data-id="${l.id}">${th}<span class="nm">${esc(name)}</span>
      <button class="icon-btn" data-a="vis" title="Show/hide">${icon(l.hidden ? "eye-off" : "eye", 14)}</button>
      <button class="icon-btn" data-a="lock" title="Lock">${icon(l.locked ? "lock" : "lock-open", 14)}</button></div>`;
  }).join("")}</div></div>`;

  if (!L) {
    b.innerHTML = `<div class="insp-empty"><div class="big-ico">${icon("mouse-pointer-2", 24)}</div><div>Click something on the canvas to change it.</div>
      <div class="small">Double-click text to type · Double-click a picture to move it inside its frame</div></div>${layerList}`;
  } else if (L.type === "text") {
    b.innerHTML = `
      <div class="pgroup">
        <span class="lbl">Font</span>
        <div class="font-pick">${FONTS.concat(L.font === "Segoe UI Emoji" ? [{ name: "Segoe UI Emoji" }] : []).map((f) => `<button data-font="${f.name}" class="${f.name === L.font ? "on" : ""}" style="font-family:'${f.name}'">${f.name}</button>`).join("")}</div>
        <div class="row between"><span>Fit text to box</span><label class="switch"><input type="checkbox" data-k="autoSize" ${L.autoSize ? "checked" : ""}><span></span></label></div>
        <div class="kv"><span>${L.autoSize ? "Max size" : "Size"}</span><span class="v">${Math.round(L.size)}px</span></div>
        <input type="range" data-k="size" min="8" max="${Math.max(200, Math.round(L.size))}" value="${Math.round(L.size)}">
        <div class="seg">
          ${["left", "center", "right"].map((a) => `<button data-align="${a}" class="${L.align === a ? "on" : ""}">${icon("align-" + a, 15)}</button>`).join("")}
          <button data-tog="caps" class="${L.caps ? "on" : ""}" title="All caps">${icon("case-upper", 16)}</button>
          <button data-tog="bold" class="${L.bold ? "on" : ""}" title="Bold">${icon("bold", 15)}</button>
          <button data-tog="italic" class="${L.italic ? "on" : ""}" title="Italic">${icon("italic", 15)}</button>
        </div>
        <div class="seg">${["top", "middle", "bottom"].map((a) => `<button data-valign="${a}" class="${L.valign === a ? "on" : ""}">${a[0].toUpperCase() + a.slice(1)}</button>`).join("")}</div>
      </div>
      <div class="pgroup">
        <span class="lbl">Colour</span>
        <div class="row"><div class="color"><i style="background:${L.color}"></i><input type="color" data-c="color" value="${L.color}"></div>
        <div class="swatches grow">${SWATCH.map((c) => `<button style="background:${c}" data-sw="color" data-v="${c}"></button>`).join("")}</div></div>
        <div class="kv"><span>Outline</span><span class="v">${Math.round(L.strokeW * 100)}</span></div>
        <div class="row"><div class="color"><i style="background:${L.stroke || "transparent"}"></i><input type="color" data-c="stroke" value="${L.stroke || "#000000"}"></div>
        <input type="range" class="grow" data-k="strokeW" min="0" max="0.4" step="0.01" value="${L.strokeW}"></div>
        <div class="kv"><span>Shadow</span><span class="v">${Math.round(L.shadow * 100)}%</span></div>
        <input type="range" data-k="shadow" min="0" max="1" step="0.05" value="${L.shadow}">
        <div class="row between"><span>Background box</span><div class="row"><label class="switch"><input type="checkbox" id="bgOn" ${L.bg ? "checked" : ""}><span></span></label>
        <div class="color ${L.bg ? "" : "hidden"}"><i style="background:${L.bg}"></i><input type="color" data-c="bg" value="${L.bg || "#ffffff"}"></div></div></div>
      </div>
      <div class="pgroup">
        <span class="lbl">Spacing</span>
        <div class="kv"><span>Line height</span><span class="v">${L.lineH.toFixed(2)}</span></div>
        <input type="range" data-k="lineH" min="0.7" max="2" step="0.02" value="${L.lineH}">
        <div class="kv"><span>Letter spacing</span><span class="v">${L.letter.toFixed(2)}</span></div>
        <input type="range" data-k="letter" min="-0.1" max="0.5" step="0.01" value="${L.letter}">
      </div>
      ${commonProps(L)}${layerList}`;
  } else {
    const m = L.src && S.media.get(L.src.url);
    b.innerHTML = `
      <div class="pgroup">
        <span class="lbl">${L.base ? "Background image" : L.slot ? "Panel" : "Image"}</span>
        ${L.src ? `<div class="row"><img src="${L.src.url}" style="width:56px;height:56px;object-fit:cover;border-radius:9px;background:var(--surface)">
          <div class="grow small"><div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(L.src.title || "Image")}</div>
          <div class="faint">${L.src.w} × ${L.src.h}${m?.animated ? ` · ${m.frames.length} frames` : ""}</div></div></div>` : ""}
        <div class="row"><button class="btn grow" data-a="replace">${icon("images", 15)}${L.src ? "Replace" : "Choose"}</button>
        ${L.src ? `<button class="btn grow" data-a="adjust">${icon("hand", 15)}Reposition</button>` : ""}</div>
        ${L.src ? `<div class="kv"><span>Zoom</span><span class="v">${Math.round((L.zoom || 1) * 100)}%</span></div>
        <input type="range" data-k="zoom" min="1" max="5" step="0.01" value="${L.zoom || 1}">
        <div class="seg"><button data-fit="cover" class="${L.fit !== "fill" ? "on" : ""}">Crop to frame</button><button data-fit="fill" class="${L.fit === "fill" ? "on" : ""}">Stretch</button></div>
        <button class="btn" data-a="flip">${icon("flip-horizontal-2", 15)}Flip horizontally</button>` : ""}
      </div>
      <div class="pgroup">
        <span class="lbl">Frame</span>
        <div class="kv"><span>Rounded corners</span><span class="v">${L.radius || 0}px</span></div>
        <input type="range" data-k="radius" min="0" max="${Math.round(Math.min(L.w, L.h) / 2)}" value="${L.radius || 0}">
        <div class="kv"><span>Border</span><span class="v">${L.borderW || 0}px</span></div>
        <div class="row"><div class="color"><i style="background:${L.borderColor}"></i><input type="color" data-c="borderColor" value="${L.borderColor}"></div>
        <input type="range" class="grow" data-k="borderW" min="0" max="40" value="${L.borderW || 0}"></div>
      </div>
      ${commonProps(L)}${layerList}`;
  }
  wireInspector(b, L);
}

function commonProps(L) {
  return `<div class="pgroup">
    <span class="lbl">Layer</span>
    <div class="kv"><span>Opacity</span><span class="v">${Math.round((L.opacity ?? 1) * 100)}%</span></div>
    <input type="range" data-k="opacity" min="0.05" max="1" step="0.01" value="${L.opacity ?? 1}">
    <div class="kv"><span>Rotation</span><span class="v">${Math.round(L.rot || 0)}°</span></div>
    <input type="range" data-k="rot" min="-180" max="180" step="1" value="${L.rot || 0}">
    <div class="row">
      <button class="icon-btn" data-a="front" title="Bring to front">${icon("bring-to-front", 17)}</button>
      <button class="icon-btn" data-a="up" title="Forward">${icon("arrow-up", 17)}</button>
      <button class="icon-btn" data-a="down" title="Backward">${icon("arrow-down", 17)}</button>
      <button class="icon-btn" data-a="back" title="Send to back">${icon("send-to-back", 17)}</button>
      <span class="grow"></span>
      <button class="icon-btn" data-a="dup" title="Duplicate (Ctrl+D)">${icon("copy-plus", 17)}</button>
      <button class="icon-btn" data-a="center" title="Centre on canvas">${icon("align-center", 17)}</button>
      <button class="icon-btn" data-a="del" title="Delete (Del)">${icon("trash-2", 17)}</button>
    </div></div>`;
}

function wireInspector(b, L) {
  $$(".layer-row", b).forEach((r) => (r.onclick = (e) => {
    const l = S.scene.layers.find((x) => x.id === r.dataset.id);
    const a = e.target.closest("[data-a]")?.dataset.a;
    if (a === "vis") { l.hidden = !l.hidden; changed({ panels: true }); return; }
    if (a === "lock") { l.locked = !l.locked; changed({ panels: true }); return; }
    select(l.id);
    if (l.type === "text") focusText(l.id);
  }));
  if (!L) return;
  $$("input[type=range][data-k]", b).forEach((r) => {
    rangeFill(r);
    r.oninput = () => {
      L[r.dataset.k] = +r.value;
      const v = r.closest(".pgroup").querySelectorAll(".kv .v");
      const kv = r.previousElementSibling?.classList?.contains("kv") ? r.previousElementSibling : r.parentElement.previousElementSibling;
      const out = kv?.querySelector?.(".v");
      if (out) {
        const k = r.dataset.k;
        out.textContent = k === "opacity" || k === "shadow" ? Math.round(r.value * 100) + "%" : k === "zoom" ? Math.round(r.value * 100) + "%" : k === "rot" ? Math.round(r.value) + "°" : k === "strokeW" ? Math.round(r.value * 100) : k === "lineH" || k === "letter" ? (+r.value).toFixed(2) : Math.round(r.value) + "px";
      }
      void v;
      draw();
      commitSoon();
    };
  });
  $$("input[type=checkbox][data-k]", b).forEach((c) => (c.onchange = () => { L[c.dataset.k] = c.checked; changed({ panels: true }); }));
  $$("input[type=color][data-c]", b).forEach((c) => (c.oninput = () => { L[c.dataset.c] = c.value; c.previousElementSibling.style.background = c.value; draw(); commitSoon(); }));
  $$("[data-sw]", b).forEach((s) => (s.onclick = () => { L[s.dataset.sw] = s.dataset.v; changed({ panels: true }); }));
  $$("[data-font]", b).forEach((f) => (f.onclick = () => { L.font = f.dataset.font; $$("[data-font]", b).forEach((x) => x.classList.toggle("on", x === f)); changed(); }));
  $$("[data-align]", b).forEach((x) => (x.onclick = () => { L.align = x.dataset.align; changed({ panels: true }); }));
  $$("[data-valign]", b).forEach((x) => (x.onclick = () => { L.valign = x.dataset.valign; changed({ panels: true }); }));
  $$("[data-tog]", b).forEach((x) => (x.onclick = () => { L[x.dataset.tog] = !L[x.dataset.tog]; changed({ panels: true }); }));
  $$("[data-fit]", b).forEach((x) => (x.onclick = () => { L.fit = x.dataset.fit; changed({ panels: true }); }));
  const bgOn = $("#bgOn", b);
  if (bgOn) bgOn.onchange = () => { L.bg = bgOn.checked ? "#ffffff" : ""; if (bgOn.checked && L.color === "#ffffff") { L.color = "#000000"; L.strokeW = 0; } changed({ panels: true }); };
  $$("[data-a]", b).forEach((x) => {
    if (x.closest(".layer-row")) return;
    x.onclick = () => {
      const a = x.dataset.a, arr = S.scene.layers, i = arr.indexOf(L);
      if (a === "del") return removeLayer(L.id);
      if (a === "dup") return duplicate();
      if (a === "replace") return replaceImage(L);
      if (a === "adjust") return startAdjust();
      if (a === "flip") { L.flipX = !L.flipX; return changed(); }
      if (a === "center") { L.x = Math.round((S.scene.w - L.w) / 2); L.y = Math.round((S.scene.h - L.h) / 2); return changed(); }
      arr.splice(i, 1);
      const j = a === "front" ? arr.length : a === "back" ? 0 : a === "up" ? Math.min(arr.length, i + 1) : Math.max(0, i - 1);
      arr.splice(j, 0, L);
      changed({ panels: true });
    };
  });
}

function removeLayer(id) {
  S.scene.layers = S.scene.layers.filter((l) => l.id !== id);
  if (S.sel === id) S.sel = null;
  changed({ panels: true });
}

function duplicate() {
  const L = sel();
  if (!L) return;
  const c = clone(L);
  c.id = "L" + Math.random().toString(36).slice(2, 9);
  c.x += 20; c.y += 20;
  delete c.base; delete c.slot;
  S.scene.layers.splice(S.scene.layers.indexOf(L) + 1, 0, c);
  S.sel = c.id;
  changed({ panels: true });
}

// ---------- keyboard, paste, drop ----------

function onKey(e) {
  if (!$("#view-editor").classList.contains("on") || $(".modal-back")) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) && document.activeElement.type !== "range" && document.activeElement.type !== "checkbox";
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  if (mod && k === "s") { e.preventDefault(); return doExport(e.shiftKey ? "saveas" : "save"); }
  if (mod && e.shiftKey && k === "c") { e.preventDefault(); return doExport("copy"); }
  if (mod && k === "enter") { e.preventDefault(); return doExport("copy"); }
  if (typing) { if (e.key === "Escape") document.activeElement.blur(); return; }
  if (mod && k === "z") { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (mod && k === "y") { e.preventDefault(); return redo(); }
  if (mod && k === "d") { e.preventDefault(); return duplicate(); }
  if (mod && k === "0") { e.preventDefault(); return setZoom(0); }
  if (mod && k === "c" && !window.getSelection()?.toString()) { e.preventDefault(); return doExport("copy"); }
  if (e.key === "Enter" && S.mode === "adjust") return endAdjust();
  if (e.key === "Enter" && S.mode === "crop") return endCrop(true);
  if (e.key === "Escape") { if (S.mode === "crop") return endCrop(false); if (S.mode === "adjust") return endAdjust(); return select(null); }
  if (e.key === " ") { e.preventDefault(); return togglePlay(); }
  if (k === "t" && !mod) { e.preventDefault(); return addText(); }
  const L = sel();
  if (!L) return;
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); return removeLayer(L.id); }
  if (e.key === "Enter" && L.type === "text") { e.preventDefault(); return focusText(L.id); }
  const st = e.shiftKey ? 10 : 1;
  const mv = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
  if (mv && !L.locked) { e.preventDefault(); L.x += mv[0]; L.y += mv[1]; draw(); commitSoon(); }
}

async function onPaste(e) {
  if (!$("#view-editor").classList.contains("on") || $(".modal-back")) return;
  if (/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
  if (!files.length) return;
  e.preventDefault();
  const items = await addBlobs(files, "sticker");
  await env.reloadLibrary();
  for (const it of items) await addSticker(it);
}

async function pasteFromClipboard() {
  try {
    const list = await navigator.clipboard.read();
    const blobs = [];
    for (const it of list) for (const t of it.types) if (t.startsWith("image/")) blobs.push(await it.getType(t));
    if (!blobs.length) return toast("There's no image on the clipboard.", { kind: "err" });
    const items = await addBlobs(blobs, "sticker");
    await env.reloadLibrary();
    for (const it of items) await addSticker(it);
  } catch {
    toast("Press Ctrl+V on the canvas to paste an image.", {});
  }
}

function setupDrop() {
  const hint = $("#dropHint");
  let n = 0;
  wrap.addEventListener("dragenter", (e) => { e.preventDefault(); n++; hint.classList.add("on"); });
  wrap.addEventListener("dragleave", () => { if (--n <= 0) { n = 0; hint.classList.remove("on"); } });
  wrap.addEventListener("dragover", (e) => e.preventDefault());
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    n = 0;
    hint.classList.remove("on");
    const libId = e.dataTransfer.getData("text/x-memeforge-item");
    if (libId) { const it = env.getItems().find((i) => i.id === libId); if (it) addSticker(it); return; }
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const items = await addBlobs(files, "sticker");
    await env.reloadLibrary();
    for (const it of items) await addSticker(it);
  });
}

// ---------- export ----------

const exportPlan = () => plan(S.scene, S.media, S.settings, $("#fmt").value, $("#osize").value);

function updateInfo() {
  if (!ctx) return;
  const p = exportPlan();
  $("#outInfo").textContent = `${p.w} × ${p.h} · ${p.fmt.toUpperCase()}${p.anim ? ` · ${p.frames} frames` : ""}`;
  $("#sizeInfo").textContent = `${S.scene.w} × ${S.scene.h}${S.scene.caption.on ? " + caption" : ""}`;
  $("#fmt").querySelectorAll("option").forEach((o) => { if (o.value === "gif" || o.value === "mp4") o.disabled = !p.anim; });
}

let exporting = false;
async function doExport(action) {
  if (!S.hasScene) return toast("Pick a template from the library first.", {});
  if (exporting) return;
  if (S.mode === "crop") endCrop(true);
  if (S.mode === "adjust") endAdjust();
  exporting = true;
  const p0 = exportPlan();
  const name = memeName(S.scene);
  let b;
  try {
    let cancelled = false;
    if (p0.anim) {
      b = busy(p0.fmt === "mp4" ? "Making your MP4" : "Making your GIF");
      b.onCancel(() => (cancelled = true));
    }
    const res = await exportScene(S.scene, S.media, S.settings, {
      fmt: $("#fmt").value, size: $("#osize").value, name,
      onProgress: (f, t) => b?.set(f, t), isCancelled: () => cancelled,
    });
    b?.close();
    b = null;
    const plan = res.plan;
    if (res.mp4_error) toast("GIF saved, but the MP4 failed: " + res.mp4_error, { kind: "err", ms: 7000 });
    // remember it in "My memes"
    S.projectId = await remember(S.scene, S.media, res, { id: S.projectId, name });
    const reveal = () => call("reveal", { path: res.path });
    if (action === "copy") {
      await call("clipboard", { path: res.path });
      toast(`Copied${plan.anim ? " (as a file — paste it in Discord, etc.)" : ""}! ${fmtBytes(res.bytes)}`, { kind: "ok", ico: "copy-check", action: S.settings.auto_save ? "Show" : "", onAction: reveal });
    } else if (action === "saveas" || !S.settings.auto_save) {
      const r = await call("save_as", { path: res.path });
      if (r) toast("Saved.", { kind: "ok", action: "Show", onAction: () => call("reveal", { path: r.path }) });
    } else {
      toast(`Saved to your memes folder · ${fmtBytes(res.bytes)}`, { kind: "ok", action: "Show in folder", onAction: reveal });
    }
    env.onExported?.();
  } catch (e) {
    b?.close();
    if (String(e.message || e) !== "cancelled") toast("Export failed: " + (e.message || e), { kind: "err", ms: 7000 });
  } finally {
    exporting = false;
  }
}

/** "New" menu: blank canvas sizes. */
function newMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  const blank = (w, hh, bg = "#ffffff") => { const sc = newScene(w, hh); sc.bg = bg; sc.title = "Blank meme"; openScene(sc); };
  menu(r.left, r.bottom + 6, [
    { label: "Blank square (1080×1080)", icon: "square", run: () => blank(1080, 1080) },
    { label: "Blank wide (1280×720)", icon: "rectangle-horizontal", run: () => blank(1280, 720) },
    { label: "Blank tall (1080×1350)", icon: "panel-top", run: () => blank(1080, 1350) },
    { label: "Black canvas (1080×1080)", icon: "square", run: () => blank(1080, 1080, "#000000") },
    "-",
    { label: "From an image file…", icon: "upload", run: async () => {
      const r2 = await call("lib_add_dialog", { source: "user" });
      await env.reloadLibrary();
      if (r2.added?.[0]) openItem(r2.added[0]);
    } },
    { label: "Panels (2×2)", icon: "grid-2x2", run: async () => { await openScene(Object.assign(newScene(800, 800), { title: "Panel meme" })); applyLayout("grid4"); } },
  ]);
}
