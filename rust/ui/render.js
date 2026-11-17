// Scene model + renderer shared by the editor, the quick popup and export.
// Everything is drawn on a canvas in output pixels, so what you see is what gets saved.

export const LIB = "http://lib.localhost/";
export const libUrl = (rel) => LIB + rel.split("/").map(encodeURIComponent).join("/");

// ---------- media (images and animated GIF/WebP) ----------

const mediaCache = new Map();

/** Load an image or animation. Resolves to {w,h,animated,frames:[{bmp,t0,delay}],duration}. */
export function loadMedia(url, maxFrames = 400) {
  if (!mediaCache.has(url)) mediaCache.set(url, decode(url, maxFrames).catch((e) => { mediaCache.delete(url); throw e; }));
  return mediaCache.get(url);
}

async function decode(url, maxFrames) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`couldn't load image (${res.status})`);
  const blob = await res.blob();
  const type = blob.type || "";
  if ((type.includes("gif") || type.includes("webp")) && "ImageDecoder" in window) {
    try {
      const dec = new ImageDecoder({ data: await blob.arrayBuffer(), type });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      await dec.completed.catch(() => {});
      const n = Math.min(track.frameCount || 1, maxFrames);
      if (n > 1) {
        const frames = [];
        let t = 0;
        for (let i = 0; i < n; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          let delay = (image.duration || 100000) / 1000;
          if (delay < 20) delay = 100; // what browsers do with 0/10 ms GIF delays
          const bmp = await createImageBitmap(image);
          image.close();
          frames.push({ bmp, t0: t, delay });
          t += delay;
        }
        dec.close();
        return { w: frames[0].bmp.width, h: frames[0].bmp.height, animated: true, frames, duration: t };
      }
      dec.close();
    } catch (e) {
      console.warn("animated decode failed, using first frame", e);
    }
  }
  const bmp = await createImageBitmap(blob);
  return { w: bmp.width, h: bmp.height, animated: false, frames: [{ bmp, t0: 0, delay: 0 }], duration: 0 };
}

export function frameAt(media, t) {
  if (!media.animated) return media.frames[0].bmp;
  const tt = ((t % media.duration) + media.duration) % media.duration;
  const fr = media.frames;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fr[mid].t0 <= tt) lo = mid; else hi = mid - 1;
  }
  return fr[lo].bmp;
}

// ---------- scene ----------

let uid = 1;
export const newId = () => `L${Date.now().toString(36)}${(uid++).toString(36)}`;

export const FONTS = [
  { name: "Impact", css: "Impact, 'Arial Black', sans-serif" },
  { name: "Arial Black", css: "'Arial Black', Arial, sans-serif" },
  { name: "Bahnschrift", css: "Bahnschrift, 'Segoe UI', sans-serif" },
  { name: "Arial", css: "Arial, Helvetica, sans-serif" },
  { name: "Segoe UI", css: "'Segoe UI', sans-serif" },
  { name: "Segoe UI Black", css: "'Segoe UI Black', 'Segoe UI', sans-serif" },
  { name: "Comic Sans MS", css: "'Comic Sans MS', 'Comic Sans', cursive" },
  { name: "Georgia", css: "Georgia, serif" },
  { name: "Times New Roman", css: "'Times New Roman', serif" },
  { name: "Courier New", css: "'Courier New', monospace" },
  { name: "Segoe Print", css: "'Segoe Print', cursive" },
  { name: "Segoe Script", css: "'Segoe Script', cursive" },
];
const fontCss = (name) => (FONTS.find((f) => f.name === name) || { css: `'${name}', sans-serif` }).css;

export function textLayer(over = {}) {
  return {
    id: newId(), type: "text", text: "", x: 0, y: 0, w: 300, h: 80, rot: 0,
    font: "Impact", size: 64, autoSize: true, color: "#ffffff", stroke: "#000000", strokeW: 0.16,
    align: "center", valign: "middle", caps: true, bold: false, italic: false,
    shadow: 0, lineH: 1.08, letter: 0, bg: "", opacity: 1, ...over,
  };
}

export function imageLayer(item, over = {}) {
  return {
    id: newId(), type: "image", src: item ? srcOf(item) : null, x: 0, y: 0,
    w: item ? item.w : 300, h: item ? item.h : 300, rot: 0,
    fit: "cover", zoom: 1, panX: 0, panY: 0, opacity: 1, flipX: false, radius: 0,
    borderW: 0, borderColor: "#ffffff", ...over,
  };
}

export const srcOf = (item) => ({ id: item.id, url: libUrl(item.file), w: item.w, h: item.h, animated: !!item.animated, title: item.title });

export function newScene(w = 800, h = 600) {
  return {
    v: 1, w, h, bg: "#ffffff",
    pad: { t: 0, r: 0, b: 0, l: 0, color: "#ffffff" },
    caption: { on: false, text: "", font: "Bahnschrift", color: "#000000", bg: "#ffffff", size: 0, align: "center" },
    speed: 1,
    layers: [],
  };
}

// Approximate text-box spots for famous Imgflip templates (fractions of the image).
const PRESETS = {
  "181913649": [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]], // Drake
  "87743020": [[0.05, 0.08, 0.38, 0.14], [0.45, 0.04, 0.38, 0.14], [0.05, 0.78, 0.9, 0.2]], // Two Buttons
  "112126428": [[0.08, 0.55, 0.32, 0.18], [0.45, 0.35, 0.25, 0.18], [0.7, 0.45, 0.28, 0.18]], // Distracted Boyfriend
  "217743513": [[0.08, 0.28, 0.35, 0.2], [0.05, 0.02, 0.9, 0.16]], // UNO Draw 25
  "124822590": [[0.18, 0.08, 0.32, 0.22], [0.5, 0.08, 0.3, 0.22], [0.3, 0.68, 0.45, 0.2]], // Left Exit 12
  "131940431": [[0.06, 0.12, 0.38, 0.32], [0.56, 0.12, 0.38, 0.32], [0.06, 0.6, 0.38, 0.32], [0.56, 0.6, 0.38, 0.32]], // Gru's Plan
  "129242436": [[0.28, 0.6, 0.52, 0.22], [0, 0, 1, 0.2]], // Change My Mind
  "93895088": [[0, 0, 0.5, 0.25], [0, 0.25, 0.5, 0.25], [0, 0.5, 0.5, 0.25], [0, 0.75, 0.5, 0.25]], // Expanding Brain
  "188390779": [[0, 0, 0.5, 0.22], [0.5, 0, 0.5, 0.22]], // Woman Yelling at Cat
  "438680": [[0.02, 0.02, 0.48, 0.2], [0.5, 0.02, 0.48, 0.2]], // Batman Slapping Robin
  "135256802": [[0.05, 0.3, 0.3, 0.2], [0.65, 0.3, 0.3, 0.2], [0.35, 0.1, 0.3, 0.2]], // Epic Handshake
  "131087935": [[0.55, 0.05, 0.4, 0.2], [0.05, 0.4, 0.35, 0.2], [0.05, 0.75, 0.4, 0.2], [0.55, 0.65, 0.4, 0.2], [0.6, 0.85, 0.35, 0.15]], // Running Away Balloon
  "178591752": [[0.5, 0, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]], // Tuxedo Winnie the Pooh
  "100777631": [[0.05, 0.25, 0.4, 0.2], [0.55, 0.15, 0.4, 0.2], [0.05, 0.75, 0.9, 0.22]], // Is This A Pigeon
  "309868304": [[0.05, 0.25, 0.4, 0.2], [0.55, 0.25, 0.4, 0.2]], // Trade Offer
  "247375501": [[0.05, 0.05, 0.45, 0.2], [0.55, 0.05, 0.45, 0.2], [0.05, 0.75, 0.45, 0.2], [0.55, 0.75, 0.45, 0.2]], // Buff Doge vs Cheems
  "222403160": [[0, 0.75, 1, 0.25]], // Bernie Once Again
  "252600902": [[0.05, 0.05, 0.45, 0.25], [0.55, 0.05, 0.45, 0.25]], // Always Has Been
};

/** Starting text boxes for a template: preset spots or stacked top/bottom. */
export function defaultTexts(item, sw, sh) {
  const pid = item.source === "imgflip" && PRESETS[item.source_id] ? item.source_id : null;
  const n = Math.max(1, Math.min(item.boxes || 2, 6));
  const base = Math.max(24, Math.round(Math.min(sw, sh) / 9));
  if (pid) {
    return PRESETS[pid].map(([x, y, w, h], i) => textLayer({ x: x * sw, y: y * sh, w: w * sw, h: h * sh, size: base, ph: `Text ${i + 1}` }));
  }
  const bh = Math.round(sh * (n <= 2 ? 0.22 : Math.min(0.22, 0.9 / n)));
  const m = Math.round(sw * 0.03);
  if (n === 1) return [textLayer({ x: m, y: sh - bh - m, w: sw - 2 * m, h: bh, size: base, ph: "Bottom text" })];
  if (n === 2) {
    return [
      textLayer({ x: m, y: m, w: sw - 2 * m, h: bh, size: base, ph: "Top text" }),
      textLayer({ x: m, y: sh - bh - m, w: sw - 2 * m, h: bh, size: base, ph: "Bottom text" }),
    ];
  }
  const step = (sh - 2 * m - bh) / (n - 1);
  return Array.from({ length: n }, (_, i) => textLayer({ x: m, y: m + i * step, w: sw - 2 * m, h: bh, size: base, ph: `Text ${i + 1}` }));
}

/** A scene from one library item: the item fills the canvas, with its starting text. */
export function sceneFromItem(item, opts = {}) {
  let w = item.w, h = item.h;
  // keep big stills manageable; GIFs keep their size
  const max = item.animated ? 900 : 1400;
  const s = Math.min(1, max / Math.max(w, h));
  w = Math.round(w * s); h = Math.round(h * s);
  const sc = newScene(w, h);
  sc.layers.push(imageLayer(item, { x: 0, y: 0, w, h, base: true }));
  if (opts.caption) {
    sc.caption.on = true;
    sc.caption.text = opts.captionText || "";
  } else {
    sc.layers.push(...defaultTexts(item, w, h));
  }
  sc.title = item.title;
  return sc;
}

// ---------- layout ----------

export function captionLayout(ctx, scene, outW) {
  const c = scene.caption;
  if (!c || !c.on) return { h: 0, lines: [], size: 0 };
  const size = c.size > 0 ? c.size : Math.max(16, Math.round(outW / 13));
  const font = `700 ${size}px ${fontCss(c.font)}`;
  ctx.save();
  ctx.font = font;
  const padX = Math.round(size * 0.7);
  const text = c.text.trim() ? c.text : " ";
  const lines = wrap(ctx, text, outW - padX * 2, 0);
  ctx.restore();
  const lh = size * 1.18;
  const h = Math.round(lines.length * lh + size * 1.1);
  return { h, lines, size, font, lh, padX };
}

/** Output size and where the content area sits in it. */
export function layout(scene, ctx) {
  const p = scene.pad || { t: 0, r: 0, b: 0, l: 0 };
  const W = Math.round(scene.w + p.l + p.r);
  const cap = captionLayout(ctx, scene, W);
  return { W, H: Math.round(cap.h + p.t + scene.h + p.b), ox: p.l, oy: cap.h + p.t, cap };
}

// ---------- text ----------

const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const graphemes = (s) => (seg ? [...seg.segment(s)].map((x) => x.segment) : Array.from(s));

function wrap(ctx, text, maxW, letter) {
  const out = [];
  const measure = (s) => ctx.measureText(s).width + letter * Math.max(0, s.length - 1);
  for (const para of text.split("\n")) {
    const words = para.split(/(\s+)/).filter((w) => w.length);
    let line = "";
    for (const w of words) {
      const test = line + w;
      if (measure(test.trimEnd()) <= maxW || !line.trim()) {
        line = test;
        // a single word wider than the box: break it (between whole characters, never inside an emoji)
        let g = graphemes(line);
        while (measure(line.trimEnd()) > maxW && g.length > 1) {
          let cut = g.length - 1;
          while (cut > 1 && measure(g.slice(0, cut).join("")) > maxW) cut--;
          out.push(g.slice(0, cut).join(""));
          g = g.slice(cut);
          line = g.join("");
        }
      } else {
        out.push(line.trimEnd());
        line = w.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const fontStr = (L, size) => `${L.italic ? "italic " : ""}${L.bold ? "800" : L.font === "Impact" ? "400" : "700"} ${size}px ${fontCss(L.font)}`;

/** Lines and font size for a text layer (auto-size shrinks text to fit its box). */
export function textFit(ctx, L) {
  const txt = (L.caps ? L.text.toUpperCase() : L.text) || "";
  const pad = 4;
  const maxW = Math.max(10, L.w - pad * 2), maxH = Math.max(10, L.h - pad * 2);
  const fits = (size) => {
    ctx.font = fontStr(L, size);
    const lines = wrap(ctx, txt, maxW, L.letter * size);
    const tall = lines.length * size * L.lineH;
    const wide = Math.max(...lines.map((l) => ctx.measureText(l).width + L.letter * size * Math.max(0, l.length - 1)));
    return { lines, ok: tall <= maxH && wide <= maxW + 0.5 };
  };
  ctx.save();
  let size = L.size, res;
  if (L.autoSize) {
    let lo = 6, hi = Math.max(8, Math.min(L.size, maxH));
    res = fits(hi);
    if (!res.ok) {
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        if (fits(mid).ok) lo = mid; else hi = mid;
      }
      size = Math.floor(lo);
      res = fits(size);
    } else size = hi;
  } else res = fits(size);
  ctx.restore();
  return { size, lines: res.lines, txt };
}

function drawText(ctx, L, opts) {
  const show = L.text || (opts.placeholders ? L.ph || "Your text" : "");
  if (!show && !L.bg) return;
  const fit = textFit(ctx, { ...L, text: show });
  const { size, lines } = fit;
  ctx.save();
  ctx.globalAlpha *= L.opacity ?? 1;
  if (L.bg) {
    ctx.fillStyle = L.bg;
    roundRect(ctx, 0, 0, L.w, L.h, Math.min(16, L.h / 4));
    ctx.fill();
  }
  if (!show) { ctx.restore(); return; }
  if (!L.text && opts.placeholders) ctx.globalAlpha *= 0.45;
  ctx.font = fontStr(L, size);
  ctx.letterSpacing = `${L.letter * size}px`;
  ctx.textBaseline = "middle";
  ctx.textAlign = L.align;
  const lh = size * L.lineH;
  const block = lines.length * lh;
  const pad = 4;
  let y0 = L.valign === "top" ? pad + lh / 2 : L.valign === "bottom" ? L.h - pad - block + lh / 2 : (L.h - block) / 2 + lh / 2;
  const x = L.align === "left" ? pad : L.align === "right" ? L.w - pad : L.w / 2;
  if (L.shadow > 0) {
    ctx.shadowColor = "rgba(0,0,0,0.85)";
    ctx.shadowBlur = size * 0.25 * L.shadow;
    ctx.shadowOffsetY = size * 0.06 * L.shadow;
  }
  const sw = L.strokeW > 0 && L.stroke ? size * L.strokeW : 0;
  lines.forEach((line, i) => {
    const y = y0 + i * lh;
    if (sw > 0) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = sw;
      ctx.strokeStyle = L.stroke;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = "transparent";
    }
    ctx.fillStyle = L.color;
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.max(0, r));
  else ctx.rect(x, y, w, h);
}

// ---------- images ----------

/** Where the source image lands inside its frame (cover + zoom + pan). */
export function imagePlacement(L, mw, mh) {
  if (L.fit === "fill") return { dx: 0, dy: 0, dw: L.w, dh: L.h };
  const s = Math.max(L.w / mw, L.h / mh) * (L.zoom || 1);
  const dw = mw * s, dh = mh * s;
  const mx = Math.max(0, (dw - L.w) / 2), my = Math.max(0, (dh - L.h) / 2);
  const px = Math.max(-mx, Math.min(mx, L.panX || 0)), py = Math.max(-my, Math.min(my, L.panY || 0));
  return { dx: (L.w - dw) / 2 + px, dy: (L.h - dh) / 2 + py, dw, dh };
}

function drawImage(ctx, L, media, t, opts) {
  ctx.save();
  ctx.globalAlpha *= L.opacity ?? 1;
  roundRect(ctx, 0, 0, L.w, L.h, L.radius || 0);
  if (!media) {
    if (opts.placeholders) {
      ctx.fillStyle = "rgba(124,58,237,0.10)";
      ctx.fill();
      ctx.setLineDash([10, 8]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(124,58,237,0.6)";
      ctx.stroke();
      ctx.fillStyle = "rgba(90,70,160,0.9)";
      ctx.font = `600 ${Math.max(12, Math.min(L.w, L.h) / 12)}px 'Segoe UI', sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(L.src ? "Loading…" : "Click to add an image", L.w / 2, L.h / 2);
    }
    ctx.restore();
    return;
  }
  ctx.clip();
  const p = imagePlacement(L, media.w, media.h);
  if (L.flipX) {
    ctx.translate(L.w, 0);
    ctx.scale(-1, 1);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(frameAt(media, t), L.flipX ? L.w - p.dx - p.dw : p.dx, p.dy, p.dw, p.dh);
  ctx.restore();
  if (L.borderW > 0) {
    ctx.save();
    roundRect(ctx, L.borderW / 2, L.borderW / 2, L.w - L.borderW, L.h - L.borderW, Math.max(0, (L.radius || 0) - L.borderW / 2));
    ctx.lineWidth = L.borderW;
    ctx.strokeStyle = L.borderColor;
    ctx.stroke();
    ctx.restore();
  }
}

// ---------- the scene ----------

/** Media for every image layer, keyed by url (null while loading). */
export async function loadSceneMedia(scene, maxFrames) {
  const out = new Map();
  await Promise.all(
    scene.layers.filter((l) => l.type === "image" && l.src).map(async (l) => {
      try { out.set(l.src.url, await loadMedia(l.src.url, maxFrames)); } catch (e) { console.warn(e); }
    }),
  );
  return out;
}

/** Draw the whole scene at time t (ms). ctx must already be scaled to output pixels. */
export function renderScene(ctx, scene, media, t = 0, opts = {}) {
  const lay = layout(scene, ctx);
  const { W, H, ox, oy, cap } = lay;
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  // padding colour, then the content background
  if (scene.pad && (scene.pad.t || scene.pad.r || scene.pad.b || scene.pad.l)) {
    ctx.fillStyle = scene.pad.color;
    ctx.fillRect(0, cap.h, W, H - cap.h);
  }
  if (scene.bg && scene.bg !== "transparent") {
    ctx.fillStyle = scene.bg;
    ctx.fillRect(ox, oy, scene.w, scene.h);
  }
  if (cap.h) {
    const c = scene.caption;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, W, cap.h);
    ctx.fillStyle = c.color;
    ctx.font = cap.font;
    ctx.textBaseline = "middle";
    ctx.textAlign = c.align;
    const x = c.align === "left" ? cap.padX : c.align === "right" ? W - cap.padX : W / 2;
    const top = (cap.h - cap.lines.length * cap.lh) / 2 + cap.lh / 2;
    const showCap = c.text.trim() ? cap.lines : opts.placeholders ? ["Type a caption"] : [];
    if (!c.text.trim()) ctx.globalAlpha = 0.35;
    showCap.forEach((l, i) => ctx.fillText(l, x, top + i * cap.lh));
    ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  ctx.rect(ox, oy, scene.w, scene.h);
  ctx.clip();
  const tt = t * (scene.speed || 1);
  for (const L of scene.layers) {
    if (L.hidden) continue;
    ctx.save();
    ctx.translate(ox + L.x + L.w / 2, oy + L.y + L.h / 2);
    if (L.rot) ctx.rotate((L.rot * Math.PI) / 180);
    ctx.translate(-L.w / 2, -L.h / 2);
    if (L.type === "image") drawImage(ctx, L, L.src ? media.get(L.src.url) : null, tt, opts);
    else if (L.type === "text") drawText(ctx, L, opts);
    ctx.restore();
  }
  ctx.restore();
  return lay;
}

/** How long one loop lasts and which moments to render as frames. */
export function timeline(scene, media, maxFrames = 300) {
  const anim = scene.layers
    .filter((l) => l.type === "image" && l.src && !l.hidden)
    .map((l) => media.get(l.src.url))
    .filter((m) => m && m.animated);
  if (!anim.length) return null;
  const speed = scene.speed || 1;
  const dur = Math.max(...anim.map((m) => m.duration));
  let times;
  if (anim.length === 1 || anim.every((m) => m === anim[0])) {
    times = anim[0].frames.map((f) => ({ t: f.t0, delay: f.delay }));
  } else {
    const step = Math.max(20, Math.min(...anim.flatMap((m) => m.frames.map((f) => f.delay))));
    times = [];
    for (let t = 0; t < dur; t += step) times.push({ t, delay: Math.min(step, dur - t) });
  }
  // too many frames: merge neighbours
  while (times.length > maxFrames) {
    const merged = [];
    for (let i = 0; i < times.length; i += 2) merged.push({ t: times[i].t, delay: times[i].delay + (times[i + 1]?.delay || 0) });
    times = merged;
  }
  return { duration: dur / speed, frames: times.map((f) => ({ t: f.t / speed, delay: Math.max(20, f.delay / speed) })) };
}

/** Render every frame and hand them to `sink(rgba, delay, i, n)`. Returns the size used. */
export async function renderFrames(scene, media, { scale = 1, maxFrames = 300 } = {}, sink) {
  const probe = document.createElement("canvas").getContext("2d");
  const { W, H } = layout(scene, probe);
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const cv = new OffscreenCanvas(w, h);
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  const tl = timeline(scene, media, maxFrames);
  const frames = tl ? tl.frames : [{ t: 0, delay: 0 }];
  for (let i = 0; i < frames.length; i++) {
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    renderScene(ctx, scene, media, frames[i].t, {});
    const img = ctx.getImageData(0, 0, w, h);
    await sink(img.data, Math.round(frames[i].delay), i, frames.length);
  }
  return { w, h, animated: !!tl, n: frames.length };
}

/** A still PNG (or JPEG if huge) of the scene. */
export async function renderStill(scene, media, scale = 1, type = "image/png") {
  const probe = document.createElement("canvas").getContext("2d");
  const { W, H } = layout(scene, probe);
  const cv = new OffscreenCanvas(Math.max(1, Math.round(W * scale)), Math.max(1, Math.round(H * scale)));
  const ctx = cv.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
  }
  renderScene(ctx, scene, media, 0, {});
  return cv.convertToBlob({ type, quality: 0.92 });
}

/** A small preview image (data URL) for history. */
export async function thumbnail(scene, media, size = 360) {
  const probe = document.createElement("canvas").getContext("2d");
  const { W, H } = layout(scene, probe);
  const s = Math.min(1, size / Math.max(W, H));
  const blob = await renderStill(scene, media, s, "image/jpeg");
  return new Promise((r) => {
    const fr = new FileReader();
    fr.onload = () => r(fr.result);
    fr.readAsDataURL(blob);
  });
}
