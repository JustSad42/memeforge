// The window: library, "My memes" history, settings, and switching between them and the editor.
import { icon } from "./icons.js";
import { $, $$, h, esc, call, listen, win, toast, menu, modal, fmtBytes, ago, matches, score, addBlobs, rangeFill } from "./api.js";
import { libUrl } from "./render.js";
import { initEditor, openItem, openScene, setSettings, isOpen } from "./editor.js";

const st = {
  items: [],
  settings: {},
  view: "library",
  filter: "all",
  source: "",
  sort: "popular",
  q: "",
  online: { q: "", giphy: [], reddit: [], busy: false },
  refresh: { running: false },
};

// ---------- boot ----------

async function boot() {
  $$(".tab").forEach((t) => {
    const v = t.dataset.view;
    t.innerHTML = { library: `${icon("library-big", 16)}Library`, editor: `${icon("pencil", 16)}Editor`, history: `${icon("history", 16)}My memes` }[v];
    t.onclick = () => go(v);
  });
  $("#btnSettings").innerHTML = icon("settings");
  $("#btnSettings").onclick = openSettings;
  $("#wMin").innerHTML = icon("minus", 16);
  $("#wMax").innerHTML = icon("square", 13);
  $("#wClose").innerHTML = icon("x", 17);
  $("#wMin").onclick = () => win().minimize();
  $("#wMax").onclick = () => win().toggleMaximize();
  $("#wClose").onclick = () => win().close();
  $(".titlebar").addEventListener("dblclick", (e) => { if (e.target.closest("[data-tauri-drag-region]") === e.target) win().toggleMaximize(); });

  st.settings = await call("settings_get");
  setSettings(st.settings);
  updateHotkeyHint();
  buildLibrary();
  buildHistory();
  initEditor({
    getItems: () => st.items,
    reloadLibrary: loadItems,
    onExported: () => { if (st.view === "history") loadHistory(); },
  });
  await loadItems();
  const stats = await call("lib_stats");
  if (stats.refresh?.running) onRefresh(stats.refresh);
  updateRefreshCard(stats);

  listen("refresh", onRefresh);
  listen("library-changed", loadItems);
  const openFromQuick = async (p) => {
    if (!p) return;
    if (p.scene) { go("editor", true); openScene(p.scene, { title: p.scene.title }); return; }
    const it = st.items.find((i) => i.id === p.id) || (await loadItems(), st.items.find((i) => i.id === p.id));
    if (it) { go("editor", true); openItem(it, { caption: p.caption }); }
  };
  listen("open-editor", openFromQuick);
  call("take_pending").then(openFromQuick);
  listen("update-progress", (m) => toast(m, { ico: "download" }));
  addEventListener("keydown", (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === "f") || (e.key === "/" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName))) {
      if (st.view !== "library") go("library");
      e.preventDefault();
      $("#q").focus();
      $("#q").select();
    }
    if (e.ctrlKey && e.key === ",") { e.preventDefault(); openSettings(); }
  });
  // paste an image anywhere in the library = add it and start a meme with it
  addEventListener("paste", async (e) => {
    if (st.view !== "library" || /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const items = await addBlobs(files, "user");
    await loadItems();
    if (items[0]) { go("editor", true); openItem(items[0]); }
  });
  requestAnimationFrame(() => {
    $("#app").classList.add("ready");
    win().show();
    win().setFocus();
  });
  if (!st.items.length && !st.refresh.running) {
    call("refresh_start");
  }
  // quietly check for an update
  if (st.settings.check_updates) {
    setTimeout(async () => {
      const u = await call("update_check", { force: false }).catch(() => null);
      if (u?.available) toast(`MemeForge ${u.latest} is available.`, { ico: "sparkles", action: u.can_install ? "Update" : "View", onAction: () => (u.can_install ? installUpdate() : call("open_path", { path: u.page })), ms: 10000 });
    }, 4000);
  }
}

function go(v, quiet = false) {
  st.view = v;
  $$(".tab").forEach((t) => t.classList.toggle("on", t.dataset.view === v));
  $$(".view").forEach((s) => s.classList.toggle("on", s.id === "view-" + v));
  if (v === "history") loadHistory();
  if (v === "editor" && !isOpen() && !quiet) {
    toast("Pick a template from the library to start a meme.", { ico: "sparkles" });
  }
}

async function loadItems() {
  st.items = await call("lib_list");
  renderSidebar();
  renderGrid();
}

function updateHotkeyHint() {
  const s = st.settings;
  $("#hkHint").innerHTML = s.hotkey_enabled && s.hotkey ? `Quick meme ${s.hotkey.split("+").map((k) => `<kbd>${esc(k)}</kbd>`).join("")}` : "";
}

// ---------- library ----------

const FILTERS = [
  ["all", "All memes", "sparkles"],
  ["still", "Templates", "image"],
  ["gif", "GIFs", "film"],
  ["fav", "Favorites", "star"],
  ["recent", "Recently used", "clock"],
  ["user", "My uploads", "upload"],
  ["sticker", "Stickers", "sticker"],
];
const SOURCES = [["imgflip", "Imgflip", "#f59e0b"], ["memegen", "memegen.link", "#22d3ee"], ["reddit", "Reddit", "#ff4500"], ["giphy", "GIPHY", "#a855f7"]];

function buildLibrary() {
  $("#view-library").innerHTML = `
    <aside class="sidebar">
      <div id="sideFilters"></div>
      <div class="side-h">Sources</div>
      <div id="sideSources"></div>
      <div class="side-foot"><div class="refresh-card" id="refreshCard"></div></div>
    </aside>
    <div class="lib-main">
      <div class="lib-top">
        <div class="search">${icon("search")}<input class="input" id="q" placeholder="Search memes, GIFs, reactions…" autocomplete="off"><kbd>Ctrl F</kbd></div>
        <select class="input" id="sort" style="width:160px">
          <option value="popular">Most popular</option><option value="used">Most used</option><option value="new">Newest</option><option value="az">A – Z</option>
        </select>
        <span class="grow"></span>
        <button class="btn" id="btnAdd">${icon("upload", 16)}Add images</button>
        <button class="btn primary" id="btnBlank">${icon("plus", 16)}New meme</button>
      </div>
      <div class="lib-scroll" id="libScroll">
        <div id="onlineBox"></div>
        <div class="lib-head"><h2 id="libTitle">All memes</h2><span class="muted" id="libCount"></span></div>
        <div class="grid" id="grid"></div>
        <div id="more"></div>
      </div>
    </div>`;
  let timer;
  $("#q").addEventListener("input", (e) => {
    st.q = e.target.value.trim();
    renderGrid();
    clearTimeout(timer);
    timer = setTimeout(searchOnline, 650);
  });
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { clearTimeout(timer); searchOnline(); const first = $("#grid .card"); if (first && e.ctrlKey) first.click(); }
    if (e.key === "Escape") { e.target.value = ""; st.q = ""; renderGrid(); renderOnline(); }
  });
  $("#sort").onchange = (e) => { st.sort = e.target.value; renderGrid(); };
  $("#btnAdd").onclick = async () => {
    const r = await call("lib_add_dialog", { source: "user" });
    if (r.errors?.length) toast(r.errors.join("\n"), { kind: "err" });
    if (r.added?.length) { toast(`Added ${r.added.length} image${r.added.length > 1 ? "s" : ""}.`, { kind: "ok" }); await loadItems(); }
  };
  $("#btnBlank").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 220, r.bottom + 6, [
      { label: "Blank square", icon: "square", run: () => { go("editor", true); $("#bNew").click(); } },
      { label: "From an image file…", icon: "upload", run: async () => { const r2 = await call("lib_add_dialog", { source: "user" }); await loadItems(); if (r2.added?.[0]) { go("editor", true); openItem(r2.added[0]); } } },
      { label: "Paste image (Ctrl+V)", icon: "clipboard", run: () => toast("Copy an image, then press Ctrl+V here.", {}) },
    ]);
  };
  // drop files on the library = add them
  const scroll = $("#libScroll");
  scroll.addEventListener("dragover", (e) => e.preventDefault());
  scroll.addEventListener("drop", async (e) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    const items = await addBlobs(files, "user");
    await loadItems();
    toast(`Added ${items.length} image${items.length === 1 ? "" : "s"} to My uploads.`, { kind: "ok" });
  });
}

function counts() {
  const c = { all: 0, still: 0, gif: 0, fav: 0, recent: 0, user: 0, sticker: 0 };
  for (const i of st.items) {
    if (i.source !== "sticker") c.all++;
    if (!i.animated && !["user", "sticker"].includes(i.source)) c.still++;
    if (i.animated && i.source !== "sticker") c.gif++;
    if (i.fav) c.fav++;
    if (i.used) c.recent++;
    if (i.source === "user") c.user++;
    if (i.source === "sticker") c.sticker++;
  }
  return c;
}

function renderSidebar() {
  const c = counts();
  $("#sideFilters").innerHTML = FILTERS.map(([k, n, ic]) => `<button class="side-item ${st.filter === k ? "on" : ""}" data-f="${k}">${icon(ic, 17)}<span>${n}</span><span class="n">${c[k] || ""}</span></button>`).join("");
  $$("#sideFilters .side-item").forEach((b) => (b.onclick = () => { st.filter = b.dataset.f; renderSidebar(); renderGrid(); }));
  const bySrc = {};
  st.items.forEach((i) => (bySrc[i.source] = (bySrc[i.source] || 0) + 1));
  $("#sideSources").innerHTML = SOURCES.map(([k, n, col]) => `<button class="side-item ${st.source === k ? "on" : ""}" data-s="${k}"><span class="dot" style="background:${col}"></span><span>${n}</span><span class="n">${bySrc[k] || ""}</span></button>`).join("");
  $$("#sideSources .side-item").forEach((b) => (b.onclick = () => { st.source = st.source === b.dataset.s ? "" : b.dataset.s; renderSidebar(); renderGrid(); }));
}

function filtered() {
  let list = st.items.filter((i) => {
    switch (st.filter) {
      case "still": return !i.animated && !["user", "sticker"].includes(i.source);
      case "gif": return i.animated && i.source !== "sticker";
      case "fav": return i.fav;
      case "recent": return i.used > 0;
      case "user": return i.source === "user";
      case "sticker": return i.source === "sticker";
      default: return i.source !== "sticker";
    }
  });
  if (st.source) list = list.filter((i) => i.source === st.source);
  if (st.q) list = list.filter((i) => matches(i, st.q));
  const by = {
    popular: (a, b) => score(a) - score(b),
    used: (a, b) => b.used - a.used || b.last_used - a.last_used,
    new: (a, b) => b.added - a.added,
    az: (a, b) => a.title.localeCompare(b.title),
  }[st.filter === "recent" ? "recent" : st.sort] || ((a, b) => b.last_used - a.last_used);
  return list.sort(by);
}

let shown = 0;
const PAGE = 120;

function renderGrid() {
  const list = filtered();
  const grid = $("#grid");
  const label = FILTERS.find((f) => f[0] === st.filter)[1];
  $("#libTitle").textContent = st.q ? `Results for “${st.q}”` : st.source ? `${label} · ${SOURCES.find((s) => s[0] === st.source)[1]}` : label;
  $("#libCount").textContent = `${list.length} item${list.length === 1 ? "" : "s"}`;
  grid.innerHTML = "";
  shown = 0;
  if (!list.length) {
    grid.innerHTML = emptyState();
    wireEmpty();
    $("#more").innerHTML = "";
    return;
  }
  appendCards(list);
}

function emptyState() {
  if (st.refresh.running && !st.items.length) {
    return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("loader-circle", 34, "spin")}</div><h3>Building your meme library…</h3><div>Downloading the most popular templates. This takes a minute the first time.</div></div>`;
  }
  if (st.q) return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("search", 30)}</div><h3>Nothing in your library for “${esc(st.q)}”</h3><div>Results from GIPHY and Reddit show above when those are set up in Settings.</div></div>`;
  if (st.filter === "fav") return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("star", 30)}</div><h3>No favorites yet</h3><div>Hover a meme and click the star to keep it here.</div></div>`;
  if (st.filter === "user" || st.filter === "sticker") return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("upload", 30)}</div><h3>Drop images here</h3><div>Or paste one with Ctrl+V, or use “Add images”.</div></div>`;
  if (st.filter === "gif" && !st.settings.giphy_key) return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("film", 30)}</div><h3>Add GIPHY to get trending GIFs</h3><div>It's free and takes two minutes.</div><button class="btn primary" data-open-settings>${icon("settings", 16)}Set up GIPHY</button></div>`;
  return `<div class="empty" style="column-span:all"><div class="big-ico">${icon("sparkles", 30)}</div><h3>Nothing here yet</h3><button class="btn primary" data-refresh>${icon("refresh-cw", 16)}Refresh library</button></div>`;
}
function wireEmpty() {
  $("[data-open-settings]")?.addEventListener("click", () => openSettings("sources"));
  $("[data-refresh]")?.addEventListener("click", () => call("refresh_start"));
}

function appendCards(list) {
  const grid = $("#grid");
  const frag = document.createDocumentFragment();
  const end = Math.min(list.length, shown + PAGE);
  for (let i = shown; i < end; i++) frag.append(card(list[i], i - shown));
  grid.append(frag);
  shown = end;
  const more = $("#more");
  more.innerHTML = shown < list.length ? `<div style="text-align:center;padding:10px"><button class="btn">Show more (${list.length - shown})</button></div>` : "";
  more.querySelector("button")?.addEventListener("click", () => appendCards(list));
}

function card(it, i) {
  const ratio = it.h && it.w ? `aspect-ratio:${it.w}/${it.h}` : "";
  const el = h(`<div class="card" draggable="true" style="animation-delay:${Math.min(i, 30) * 12}ms">
    <img loading="lazy" decoding="async" src="${libUrl(it.thumb)}" style="${ratio}" alt="">
    <div class="tag">${it.animated ? '<span class="pill gif">GIF</span>' : ""}${it.source === "user" ? '<span class="pill">MINE</span>' : ""}</div>
    <div class="acts">
      <button class="fav ${it.fav ? "on" : ""}" title="Favorite">${icon("star", 15)}</button>
      <button class="more" title="More">${icon("chevron-down", 15)}</button>
    </div>
    <div class="meta">${esc(it.title)}</div></div>`);
  const img = el.querySelector("img");
  if (it.animated) {
    // play the GIF on hover
    el.addEventListener("mouseenter", () => (img.src = libUrl(it.file)));
    el.addEventListener("mouseleave", () => (img.src = libUrl(it.thumb)));
  }
  el.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/x-memeforge-item", it.id));
  el.onclick = (e) => {
    if (e.target.closest(".fav")) return toggleFav(it, e.target.closest(".fav"));
    if (e.target.closest(".more")) return itemMenu(it, e);
    // GIFs start with a caption bar, pictures with text boxes; Shift-click does the other
    startMeme(it, e.shiftKey ? !it.animated : it.animated);
  };
  el.oncontextmenu = (e) => { e.preventDefault(); itemMenu(it, e); };
  return el;
}

function startMeme(it, caption) {
  go("editor", true);
  openItem(it, { caption: caption ?? it.animated });
}

async function toggleFav(it, btn) {
  it.fav = !it.fav;
  btn.classList.toggle("on", it.fav);
  await call("lib_fav", { id: it.id, on: it.fav });
  renderSidebar();
}

function itemMenu(it, e) {
  menu(e.clientX, e.clientY, [
    { label: "Make a meme", icon: "pencil", run: () => startMeme(it, false) },
    { label: "Make a meme with a caption bar", icon: "captions", run: () => startMeme(it, true) },
    { label: it.fav ? "Remove from favorites" : "Add to favorites", icon: "star", run: async () => { it.fav = !it.fav; await call("lib_fav", { id: it.id, on: it.fav }); renderSidebar(); renderGrid(); } },
    { label: "Copy original", icon: "copy", run: async () => { await call("clipboard", { path: st.settings._data_dir + "\\library\\" + it.file.replace("/", "\\") }); toast("Copied.", { kind: "ok" }); } },
    { label: "Rename…", icon: "type", run: async () => { const t = prompt("Name:", it.title); if (t) { await call("lib_rename", { id: it.id, title: t }); loadItems(); } } },
    { label: "Show file", icon: "folder-open", run: () => call("reveal", { path: st.settings._data_dir + "\\library\\" + it.file.replace("/", "\\") }) },
    "-",
    { label: "Remove from library", icon: "trash-2", danger: true, run: async () => { await call("lib_remove", { id: it.id }); st.items = st.items.filter((x) => x.id !== it.id); renderSidebar(); renderGrid(); toast("Removed.", {}); } },
  ]);
}

// online results (GIPHY / Reddit) for the current search
async function searchOnline() {
  const q = st.q;
  const s = st.settings;
  if (!q || q.length < 2) { st.online = { q: "", giphy: [], reddit: [] }; return renderOnline(); }
  if (st.online.q === q) return;
  st.online = { q, giphy: [], reddit: [], busy: true };
  renderOnline();
  const jobs = [];
  if (s.src_giphy && s.giphy_key) jobs.push(call("search_online", { source: "giphy", q }).then((r) => (st.online.giphy = r)).catch(() => {}));
  if (s.src_reddit && s.reddit_client_id) jobs.push(call("search_online", { source: "reddit", q }).then((r) => (st.online.reddit = r)).catch(() => {}));
  await Promise.all(jobs);
  if (st.online.q !== q) return;
  st.online.busy = false;
  renderOnline();
}

function renderOnline() {
  const box = $("#onlineBox");
  const o = st.online;
  const have = new Set(st.items.map((i) => i.source + ":" + i.source_id));
  const strip = (name, list, src) => {
    list = list.filter((c) => !have.has(src + ":" + c.source_id));
    if (!list.length) return "";
    return `<div class="online-strip"><div class="sec-h">${icon(src === "giphy" ? "film" : "globe", 16)}${name}<span class="src">click to add to your library and start a meme</span></div>
      <div class="row-scroll" data-src="${src}">${list.map((c, i) => `<div class="card online" data-i="${i}"><img loading="lazy" src="${esc(c.preview)}" alt=""><div class="tag">${c.animated ? '<span class="pill gif">GIF</span>' : ""}</div><div class="meta">${esc(c.title)}</div></div>`).join("")}</div></div>`;
  };
  if (!o.q) { box.innerHTML = ""; return; }
  box.innerHTML = o.busy ? `<div class="sec-h muted">${icon("loader-circle", 16, "spin")}Searching online…</div>` : strip("From GIPHY", o.giphy, "giphy") + strip("From Reddit", o.reddit, "reddit");
  $$(".row-scroll", box).forEach((row) => {
    const src = row.dataset.src;
    const list = o[src].filter((c) => !have.has(src + ":" + c.source_id));
    $$(".card", row).forEach((c) => (c.onclick = async () => {
      c.style.opacity = 0.5;
      try {
        const it = await call("add_candidate", { cand: list[+c.dataset.i] });
        await loadItems();
        startMeme(it);
      } catch (e) { toast(String(e), { kind: "err" }); c.style.opacity = 1; }
    }));
  });
}

// ---------- refresh ----------

function onRefresh(v) {
  st.refresh = v;
  updateRefreshCard({ refresh: v });
  if (!v.running) {
    loadItems();
    if (v.errors?.length) toast("Some sources failed: " + v.errors.join(" · "), { kind: "err", ms: 9000 });
    else if (v.added) toast(`Library updated: ${v.added} new meme${v.added === 1 ? "" : "s"}.`, { kind: "ok" });
  } else if (!st.items.length) {
    renderGrid();
  } else if (v.done && v.done % 40 === 0) {
    loadItems();
  }
}

async function updateRefreshCard(stats) {
  const card = $("#refreshCard");
  if (!card) return;
  const r = stats.refresh || st.refresh;
  if (r?.running) {
    const p = r.total ? r.done / r.total : 0;
    card.innerHTML = `<div class="row between"><span class="t">${r.phase === "Downloading" ? "Downloading memes" : "Checking sources"}</span>${icon("loader-circle", 15, "spin")}</div>
      <div class="bar ${r.total ? "" : "indet"}"><i style="width:${Math.round(p * 100)}%"></i></div>
      <div class="faint small">${r.total ? `${r.done} of ${r.total}` : "Looking for what's popular…"}</div>`;
    return;
  }
  const s = stats.count != null ? stats : await call("lib_stats");
  card.innerHTML = `<div class="row between"><span class="t">${s.count} in library</span><button class="icon-btn" id="btnRefresh" title="Refresh now">${icon("refresh-cw", 16)}</button></div>
    <div class="faint small">${fmtBytes(s.bytes)} · updated ${ago(s.last_refresh?.at)}</div>`;
  $("#btnRefresh").onclick = () => { call("refresh_start"); onRefresh({ running: true, phase: "Checking sources", done: 0, total: 0 }); };
}

// ---------- My memes ----------

function buildHistory() {
  $("#view-history").innerHTML = `<div class="hist-top"><h2>My memes</h2><span class="muted" id="histCount"></span><span class="grow"></span>
    <button class="btn" id="openFolder">${icon("folder-open", 16)}Open memes folder</button></div><div class="hist-grid" id="histGrid"></div>`;
  $("#openFolder").onclick = () => call("open_path", { path: st.settings.save_folder });
}

async function loadHistory() {
  const list = await call("project_list");
  $("#histCount").textContent = `${list.length} made`;
  const g = $("#histGrid");
  if (!list.length) {
    g.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="big-ico">${icon("history", 30)}</div><h3>Nothing made yet</h3><div>Memes you copy or save show up here, so you can copy them again or keep editing.</div></div>`;
    return;
  }
  g.innerHTML = "";
  list.forEach((p, i) => {
    const el = h(`<div class="hcard" style="animation-delay:${Math.min(i, 20) * 15}ms">
      <div class="im" style="background-image:url('${p.thumb || ""}')">${p.fmt === "gif" || p.fmt === "mp4" ? `<div class="tag" style="position:absolute;left:8px;top:8px"><span class="pill gif">${p.fmt.toUpperCase()}</span></div>` : ""}</div>
      <div class="body"><div class="nm">${esc(p.name || p.title)}</div>
      <div class="faint small">${ago(p.saved)} · ${p.w}×${p.h} · ${fmtBytes(p.bytes)}${p.exists ? "" : " · file deleted"}</div>
      <div class="acts">
        <button class="btn sm primary" data-a="copy" ${p.exists ? "" : "disabled"}>${icon("clipboard", 14)}Copy</button>
        <button class="btn sm" data-a="edit">${icon("pencil", 14)}Edit</button>
        <span class="grow"></span>
        <button class="icon-btn" data-a="show" title="Show in folder" ${p.exists ? "" : "disabled"}>${icon("folder-open", 15)}</button>
        <button class="icon-btn" data-a="del" title="Remove from list">${icon("trash-2", 15)}</button>
      </div></div></div>`);
    el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = async () => {
      const a = b.dataset.a;
      if (a === "copy") { await call("clipboard", { path: p.out }); toast("Copied!", { kind: "ok", ico: "copy-check" }); }
      if (a === "show") call("reveal", { path: p.out });
      if (a === "edit") { const full = await call("project_get", { id: p.id }); go("editor", true); openScene(full.scene, { projectId: p.id, title: full.title }); }
      if (a === "del") { await call("project_delete", { id: p.id }); el.remove(); toast("Removed from the list (the file is kept).", {}); }
    }));
    g.append(el);
  });
}

// ---------- settings ----------

async function openSettings(focus) {
  const s = (st.settings = await call("settings_get"));
  const ff = await call("ffmpeg_status");
  const stats = await call("lib_stats");
  const body = h(`<div style="display:grid;gap:16px">
    <div class="set-sec">
      <h4>${icon("download", 16)}Saving</h4>
      <div class="field"><label>Memes folder</label><div class="row"><input class="input" id="sFolder" value="${esc(s.save_folder)}"><button class="btn" id="sPick">${icon("folder-open", 15)}Browse</button></div></div>
      <div class="set-row"><div class="d"><b>Save every meme automatically</b><small>Copy and Save both keep a file in the memes folder. Off = Save asks where.</small></div><label class="switch"><input type="checkbox" id="sAuto" ${s.auto_save ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div class="d"><b>Also make an MP4 of animated memes</b><small>${ff.path ? "FFmpeg found." : "Needs FFmpeg, which isn't installed."}</small></div>
        <div class="row">${ff.path ? "" : `<button class="btn sm" id="sFF">Install FFmpeg</button>`}<label class="switch"><input type="checkbox" id="sMp4" ${s.also_mp4 ? "checked" : ""}><span></span></label></div></div>
      <div class="set-row"><div class="d"><b>Maximum width for pictures</b><small>“Auto size” shrinks wider pictures to this. 0 = keep size.</small></div><input class="input" id="sMaxW" type="number" min="0" step="10" style="width:100px" value="${s.max_width}"></div>
      <div class="set-row"><div class="d"><b>Most frames in a GIF</b><small>Longer GIFs are thinned out to stay small.</small></div><input class="input" id="sFrames" type="number" min="10" max="1000" style="width:100px" value="${s.gif_max_frames}"></div>
    </div>
    <div class="set-sec">
      <h4>${icon("keyboard", 16)}Quick meme hotkey</h4>
      <div class="set-row"><div class="d"><b>Open the quick meme popup from anywhere</b><small>Search, type, press Enter: the meme is on your clipboard.</small></div><label class="switch"><input type="checkbox" id="sHkOn" ${s.hotkey_enabled ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div class="d"><b>Shortcut</b><small>Click the box and press the keys you want.</small></div><input class="input" id="sHk" style="width:180px;text-align:center;font-weight:600" value="${esc(s.hotkey)}" readonly></div>
      <div class="set-row"><div class="d"><b>Start with Windows</b><small>Runs quietly in the tray so the hotkey always works.</small></div><label class="switch"><input type="checkbox" id="sStart" ${s.start_with_windows ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div class="d"><b>Closing the window keeps MemeForge in the tray</b></div><label class="switch"><input type="checkbox" id="sTray" ${s.close_to_tray ? "checked" : ""}><span></span></label></div>
    </div>
    <div class="set-sec" id="secSources">
      <h4>${icon("globe", 16)}Meme sources</h4>
      <div class="set-row"><div class="d"><b>Imgflip</b><small>The ~100 most captioned templates. No setup.</small></div><label class="switch"><input type="checkbox" id="sImgflip" ${s.src_imgflip ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div class="d"><b>memegen.link</b><small>~200 classic templates with search keywords. No setup.</small></div><label class="switch"><input type="checkbox" id="sMemegen" ${s.src_memegen ? "checked" : ""}><span></span></label></div>
      <div class="set-row"><div class="d"><b>GIPHY</b><small>~200 trending GIFs, plus GIF search.</small></div><label class="switch"><input type="checkbox" id="sGiphy" ${s.src_giphy ? "checked" : ""}><span></span></label></div>
      <div class="row"><input class="input" id="sGiphyKey" placeholder="GIPHY API key" value="${esc(s.giphy_key)}"><button class="btn" data-test="giphy">Test</button></div>
      <div class="help">Free key, about two minutes:<ol><li>Open <a data-url="https://developers.giphy.com/dashboard/">developers.giphy.com/dashboard</a> and sign in (or make an account).</li><li>Click <b>Create an API Key</b>, choose <b>API</b> (not SDK), give it any name.</li><li>Copy the key and paste it above.</li></ol></div>
      <div class="set-row"><div class="d"><b>Reddit</b><small>Top templates from meme-template subreddits, plus search.</small></div><label class="switch"><input type="checkbox" id="sReddit" ${s.src_reddit ? "checked" : ""}><span></span></label></div>
      <div class="row"><input class="input" id="sRedditId" placeholder="Reddit app client ID" value="${esc(s.reddit_client_id)}"><button class="btn" data-test="reddit">Test</button></div>
      <div class="field"><label>Subreddits</label><input class="input" id="sSubs" value="${esc(s.reddit_subs.join(", "))}"></div>
      <div class="help">Reddit only allows apps with their own ID:<ol><li>Open <a data-url="https://www.reddit.com/prefs/apps">reddit.com/prefs/apps</a> while signed in.</li><li>Click <b>create another app…</b>, pick <b>installed app</b>, name it anything, and use <b>http://localhost</b> as the redirect uri.</li><li>Copy the short ID under the app name and paste it above.</li></ol></div>
      <div class="set-row"><div class="d"><b>Refresh the library every</b><small>Picks up newly popular memes in the background.</small></div>
        <select class="input" id="sDays" style="width:140px">${[[1, "Day"], [3, "3 days"], [7, "Week"], [14, "2 weeks"], [30, "Month"], [0, "Only by hand"]].map(([v, n]) => `<option value="${v}" ${s.refresh_days == v ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="faint small">${stats.count} items · ${fmtBytes(stats.bytes)} · last refresh ${ago(stats.last_refresh?.at)}${stats.last_refresh?.errors?.length ? " · " + esc(stats.last_refresh.errors.join("; ")) : ""}</div>
    </div>
    <div class="set-sec">
      <h4>${icon("sparkles", 16)}About</h4>
      <div class="set-row"><div class="d"><b>MemeForge ${esc(s._version)}</b><small id="updMsg">Data folder: ${esc(s._data_dir)}</small></div><div class="row"><button class="btn" id="sUpd">Check for updates</button></div></div>
      <div class="set-row"><div class="d"><b>Check for updates automatically</b></div><label class="switch"><input type="checkbox" id="sUpdAuto" ${s.check_updates ? "checked" : ""}><span></span></label></div>
    </div></div>`);
  const m = modal({ title: "Settings", body });
  const save = async (patch) => {
    const r = await call("settings_set", patch);
    st.settings = await call("settings_get");
    setSettings(st.settings);
    updateHotkeyHint();
    if (r.hotkey_error) toast(r.hotkey_error, { kind: "err" });
  };
  const bind = (id, key, conv = (el) => (el.type === "checkbox" ? el.checked : el.value)) => {
    const el = body.querySelector(id);
    el.addEventListener("change", () => save({ [key]: conv(el) }));
  };
  bind("#sFolder", "save_folder");
  bind("#sAuto", "auto_save");
  bind("#sMp4", "also_mp4");
  bind("#sMaxW", "max_width", (e) => Math.max(0, +e.value || 0));
  bind("#sFrames", "gif_max_frames", (e) => Math.max(10, Math.min(1000, +e.value || 300)));
  bind("#sHkOn", "hotkey_enabled");
  bind("#sStart", "start_with_windows");
  bind("#sTray", "close_to_tray");
  bind("#sImgflip", "src_imgflip");
  bind("#sMemegen", "src_memegen");
  bind("#sGiphy", "src_giphy");
  bind("#sReddit", "src_reddit");
  bind("#sGiphyKey", "giphy_key", (e) => e.value.trim());
  bind("#sRedditId", "reddit_client_id", (e) => e.value.trim());
  bind("#sSubs", "reddit_subs", (e) => e.value.split(/[,\s]+/).map((x) => x.replace(/^r\//, "").trim()).filter(Boolean));
  bind("#sDays", "refresh_days", (e) => +e.value);
  bind("#sUpdAuto", "check_updates");
  body.querySelector("#sPick").onclick = async () => { const f = await call("pick_folder"); if (f) { body.querySelector("#sFolder").value = f; save({ save_folder: f }); } };
  body.querySelector("#sFF")?.addEventListener("click", () => { call("ffmpeg_install"); toast("Installing FFmpeg in a separate window. Reopen Settings when it's done.", { ms: 6000 }); });
  $$("[data-url]", body).forEach((a) => (a.onclick = () => call("open_path", { path: a.dataset.url })));
  $$("[data-test]", body).forEach((b) => (b.onclick = async () => {
    const src = b.dataset.test;
    await save(src === "giphy" ? { giphy_key: body.querySelector("#sGiphyKey").value.trim() } : { reddit_client_id: body.querySelector("#sRedditId").value.trim(), reddit_subs: body.querySelector("#sSubs").value.split(/[,\s]+/).map((x) => x.replace(/^r\//, "").trim()).filter(Boolean) });
    b.innerHTML = icon("loader-circle", 15, "spin");
    try {
      const msg = await call("test_source", { source: src });
      toast(msg + " Refreshing the library…", { kind: "ok" });
      call("refresh_start");
    } catch (e) { toast(String(e), { kind: "err", ms: 8000 }); }
    b.textContent = "Test";
  }));
  // hotkey capture
  const hk = body.querySelector("#sHk");
  hk.addEventListener("keydown", (e) => {
    e.preventDefault();
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Super");
    let k = e.code.replace(/^Key/, "").replace(/^Digit/, "");
    if (!parts.length) return toast("Use at least one of Ctrl, Alt or Shift.", {});
    parts.push(k);
    hk.value = parts.join("+");
    save({ hotkey: hk.value });
  });
  body.querySelector("#sUpd").onclick = async () => {
    const msg = body.querySelector("#updMsg");
    msg.textContent = "Checking…";
    const u = await call("update_check", { force: true });
    if (u.error) msg.textContent = u.error;
    else if (u.available) {
      msg.innerHTML = `Version ${esc(u.latest)} is available.`;
      const b = body.querySelector("#sUpd");
      b.textContent = u.can_install ? "Install update" : "Open download page";
      b.className = "btn primary";
      b.onclick = () => (u.can_install ? installUpdate() : call("open_path", { path: u.page }));
    } else msg.textContent = `You have the newest version (${u.current}).`;
  };
  if (focus === "sources") setTimeout(() => body.querySelector("#secSources").scrollIntoView({ behavior: "smooth" }), 80);
  void m;
  void rangeFill;
}

async function installUpdate() {
  try {
    const v = await call("update_install");
    toast(`Installing ${v}… MemeForge will restart.`, { ico: "download", ms: 10000 });
  } catch (e) { toast(String(e), { kind: "err", ms: 8000 }); }
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="color:#fca5a5;padding:20px;white-space:pre-wrap">MemeForge couldn't start:\n${esc(e.stack || e)}</pre>`;
  win().show();
});
