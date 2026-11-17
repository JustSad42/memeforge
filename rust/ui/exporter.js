// Render a scene to a file through the Rust side (shared by the editor and the quick popup).
import { call, invoke } from "./api.js";
import { layout, timeline, renderFrames, renderStill, thumbnail } from "./render.js";

const probe = () => document.createElement("canvas").getContext("2d");

/** What an export would produce: format, scale, size, frame count. */
export function plan(scene, media, settings, fmt = "auto", size = "auto") {
  const tl = timeline(scene, media, settings.gif_max_frames || 300);
  const anim = !!tl;
  if (fmt === "auto") fmt = anim ? "gif" : "png";
  if (!anim && (fmt === "gif" || fmt === "mp4")) fmt = "png";
  const lay = layout(scene, probe());
  let target;
  if (size === "auto") {
    // GIFs: about 720 px on the long side keeps files shareable
    target = anim ? Math.min(lay.W, Math.round(720 * Math.min(1, lay.W / Math.max(lay.W, lay.H)))) : settings.max_width || lay.W;
  } else target = size === "1" ? lay.W : +size;
  const scale = Math.min(size === "auto" ? 1 : 4, target / lay.W);
  return { fmt, scale, anim, frames: tl ? tl.frames.length : 1, w: Math.max(1, Math.round(lay.W * scale)), h: Math.max(1, Math.round(lay.H * scale)) };
}

/** Make the file. Returns {path, mp4?, bytes, plan}. onProgress(fraction, text); isCancelled() */
export async function exportScene(scene, media, settings, { fmt = "auto", size = "auto", name = "meme", onProgress = () => {}, isCancelled = () => false } = {}) {
  const p = plan(scene, media, settings, fmt, size);
  let res;
  if (!p.anim) {
    const type = p.fmt === "jpg" ? "image/jpeg" : "image/png";
    const blob = await renderStill(scene, media, p.scale, type);
    res = await invoke("save_still", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-name": encodeURIComponent(name), "x-ext": p.fmt } });
  } else {
    const id = await call("export_begin", { w: p.w, h: p.h });
    try {
      await renderFrames(scene, media, { scale: p.scale, maxFrames: settings.gif_max_frames || 300 }, async (data, delay, i, n) => {
        if (isCancelled()) throw new Error("cancelled");
        await invoke("export_frame", new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { headers: { "x-id": String(id), "x-delay": String(delay) } });
        onProgress(((i + 1) / n) * 0.7, `Frame ${i + 1} of ${n}`);
      });
    } catch (e) {
      await call("export_cancel", { id });
      throw e;
    }
    onProgress(0.8, p.fmt === "mp4" ? "Encoding video…" : "Picking colours and compressing…");
    res = await call("export_finish", { id, name, gif: p.fmt === "gif", mp4: p.fmt === "mp4" || !!settings.also_mp4 });
  }
  return { ...res, plan: p };
}

/** Add an export to "My memes". */
export async function remember(scene, media, res, { id = "", name }) {
  const thumb = await thumbnail(scene, media).catch(() => "");
  const p = res.plan;
  const r = await call("project_save", { id, title: scene.title || name, name, scene, out: res.path, mp4: res.mp4 || "", thumb, fmt: p.fmt, w: p.w, h: p.h, bytes: res.bytes || 0 });
  scene.layers.forEach((l) => l.src && call("lib_used", { id: l.src.id }).catch(() => {}));
  return r.id;
}

export function memeName(scene) {
  const words = (s) => (s && /[\p{L}\p{N}]/u.test(s) ? s : "");
  const cap = scene.caption?.on ? words(scene.caption.text) : "";
  const txt = scene.layers.filter((l) => l.type === "text").map((l) => words(l.text)).find(Boolean);
  return (cap || txt || scene.title || "meme").split("\n")[0].slice(0, 50);
}
