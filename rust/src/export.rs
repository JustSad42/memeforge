//! Turning rendered frames into files: PNG (static), GIF and MP4 (animated).
//! The page renders every frame itself (so the result matches the editor exactly) and
//! streams raw RGBA frames here; this side quantizes and encodes.
use crate::settings;
use once_cell::sync::Lazy;
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

pub struct Job {
    pub w: u32,
    pub h: u32,
    pub frames: Vec<(Vec<u8>, u32)>,
}

pub static JOBS: Lazy<Mutex<HashMap<u64, Job>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT: Lazy<Mutex<u64>> = Lazy::new(|| Mutex::new(1));

pub fn begin(w: u32, h: u32) -> u64 {
    let mut n = NEXT.lock().unwrap();
    *n += 1;
    JOBS.lock().unwrap().insert(*n, Job { w, h, frames: Vec::new() });
    *n
}

pub fn add_frame(id: u64, rgba: Vec<u8>, delay_ms: u32) -> Result<usize, String> {
    let mut jobs = JOBS.lock().unwrap();
    let j = jobs.get_mut(&id).ok_or("export job not found")?;
    if rgba.len() != (j.w * j.h * 4) as usize {
        return Err(format!("frame is {} bytes, expected {}", rgba.len(), j.w * j.h * 4));
    }
    j.frames.push((rgba, delay_ms));
    Ok(j.frames.len())
}

pub fn cancel(id: u64) {
    JOBS.lock().unwrap().remove(&id);
}

// ---------- GIF ----------

const TRANSPARENT: u8 = 255;

/// One palette for all frames (NeuQuant over a sample of every frame) and a
/// 6-bit-per-channel lookup table into it. Returns (palette, lut, has_alpha).
fn quantizer(frames: &[(Vec<u8>, u32)]) -> (Vec<u8>, Vec<u8>, bool) {
    let px_per_frame = frames.first().map(|f| f.0.len() / 4).unwrap_or(0);
    let total_px = px_per_frame * frames.len();
    let step = (total_px / 1_500_000).max(1);
    let mut sample = Vec::with_capacity(total_px / step * 4 + 4);
    let mut has_alpha = false;
    let mut k = 0usize;
    for (f, _) in frames {
        for px in f.as_chunks::<4>().0 {
            if px[3] < 128 {
                has_alpha = true;
            } else if k.is_multiple_of(step) {
                sample.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            k += 1;
        }
    }
    if sample.is_empty() {
        sample.extend_from_slice(&[0, 0, 0, 255]);
    }
    let nq = color_quant::NeuQuant::new(10, 255, &sample);
    let pal = nq.color_map_rgb();
    let mut palette = vec![0u8; 256 * 3];
    let n = pal.len().min(255 * 3);
    palette[..n].copy_from_slice(&pal[..n]);
    // exact nearest colour (NeuQuant's own index_of is only approximate and visibly off on gradients)
    let cols: Vec<[i32; 3]> = palette[..n].chunks(3).map(|c| [c[0] as i32, c[1] as i32, c[2] as i32]).collect();
    let lut: Vec<u8> = (0..262_144u32)
        .into_par_iter()
        .map(|i| {
            let e = |c: u32| ((c << 2) | (c >> 4)) as i32;
            let (r, g, b) = (e((i >> 12) & 63), e((i >> 6) & 63), e(i & 63));
            let mut best = (i32::MAX, 0usize);
            for (k, c) in cols.iter().enumerate() {
                // weighted distance: the eye is most sensitive to green
                let d = 2 * (c[0] - r).pow(2) + 4 * (c[1] - g).pow(2) + 3 * (c[2] - b).pow(2);
                if d < best.0 {
                    best = (d, k);
                }
            }
            best.1 as u8
        })
        .collect();
    (palette, lut, has_alpha)
}

/// RGBA -> palette indexes, with light ordered dithering to keep gradients smooth.
fn map_frame(f: &[u8], w: usize, h: usize, lut: &[u8], dither: bool) -> Vec<u8> {
    const BAYER: [[i16; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let p = &f[i * 4..i * 4 + 4];
            if p[3] < 128 {
                out[i] = TRANSPARENT;
                continue;
            }
            let d = if dither { (BAYER[y & 3][x & 3] - 8) / 4 } else { 0 };
            let c = |v: u8| ((v as i16 + d).clamp(0, 255) as u32) >> 2;
            out[i] = lut[((c(p[0]) << 12) | (c(p[1]) << 6) | c(p[2])) as usize];
        }
    }
    out
}

/// One palette for the whole animation (no colour flicker between frames) + unchanged
/// pixels left transparent so each frame only stores what moved.
pub fn encode_gif(job: &Job) -> Result<Vec<u8>, String> {
    let (w, h) = (job.w as usize, job.h as usize);
    if w > 65535 || h > 65535 || job.frames.is_empty() {
        return Err("nothing to encode".into());
    }
    let (palette, lut, has_alpha) = quantizer(&job.frames);
    let indexed: Vec<Vec<u8>> = job.frames.par_iter().map(|(f, _)| map_frame(f, w, h, &lut, true)).collect();

    let mut buf = Vec::new();
    {
        let mut enc = gif::Encoder::new(&mut buf, w as u16, h as u16, &palette).map_err(|e| e.to_string())?;
        if job.frames.len() > 1 {
            enc.set_repeat(gif::Repeat::Infinite).map_err(|e| e.to_string())?;
        }
        let mut prev: Option<&Vec<u8>> = None;
        for (fi, idx) in indexed.iter().enumerate() {
            let delay = job.frames[fi].1;
            let mut frame = gif::Frame::default();
            frame.width = w as u16;
            frame.height = h as u16;
            frame.delay = ((delay + 5) / 10).max(2) as u16;
            frame.transparent = Some(TRANSPARENT);
            match (prev, has_alpha) {
                (Some(p), false) => {
                    // only the pixels that changed, cropped to the box around them
                    let (mut x0, mut y0, mut x1, mut y1) = (w, h, 0usize, 0usize);
                    for y in 0..h {
                        for x in 0..w {
                            if idx[y * w + x] != p[y * w + x] {
                                x0 = x0.min(x);
                                y0 = y0.min(y);
                                x1 = x1.max(x);
                                y1 = y1.max(y);
                            }
                        }
                    }
                    if x1 < x0 {
                        (x0, y0, x1, y1) = (0, 0, 0, 0);
                    }
                    let (fw, fh) = (x1 - x0 + 1, y1 - y0 + 1);
                    let mut data = Vec::with_capacity(fw * fh);
                    for y in y0..=y1 {
                        for x in x0..=x1 {
                            let v = idx[y * w + x];
                            data.push(if v == p[y * w + x] { TRANSPARENT } else { v });
                        }
                    }
                    frame.left = x0 as u16;
                    frame.top = y0 as u16;
                    frame.width = fw as u16;
                    frame.height = fh as u16;
                    frame.dispose = gif::DisposalMethod::Keep;
                    frame.buffer = data.into();
                }
                _ => {
                    frame.dispose = if has_alpha { gif::DisposalMethod::Background } else { gif::DisposalMethod::Keep };
                    frame.buffer = idx.clone().into();
                }
            }
            enc.write_frame(&frame).map_err(|e| e.to_string())?;
            prev = Some(idx);
        }
    }
    Ok(buf)
}

// ---------- MP4 (FFmpeg) ----------

pub fn ffmpeg_path() -> Option<PathBuf> {
    let local = settings::app_file("ffmpeg.exe");
    if local.exists() {
        return Some(local);
    }
    if let Ok(p) = std::env::var("PATH") {
        for d in std::env::split_paths(&p) {
            let f = d.join("ffmpeg.exe");
            if f.exists() {
                return Some(f);
            }
        }
    }
    // winget installs it here without always updating PATH for running apps
    let pk = std::env::var("LOCALAPPDATA").ok().map(|l| PathBuf::from(l).join("Microsoft\\WinGet\\Packages"))?;
    for e in std::fs::read_dir(pk).ok()?.flatten() {
        if e.file_name().to_string_lossy().to_lowercase().contains("ffmpeg") {
            for sub in std::fs::read_dir(e.path()).ok()?.flatten() {
                let f = sub.path().join("bin").join("ffmpeg.exe");
                if f.exists() {
                    return Some(f);
                }
            }
        }
    }
    None
}

pub fn encode_mp4(job: &Job, out: &Path) -> Result<(), String> {
    let ff = ffmpeg_path().ok_or("FFmpeg isn't installed, so MP4 can't be made. Install it from Settings.")?;
    // constant 30 fps timeline from the variable GIF delays; loop short clips to ~3 s
    let total: u32 = job.frames.iter().map(|f| f.1.max(10)).sum::<u32>().max(10);
    let loops = (3000 / total).clamp(1, 10);
    let fps = 30u32;
    let n_out = (total * loops * fps / 1000).max(1);
    let (w, h) = (job.w, job.h);
    let mut child = Command::new(&ff)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba"])
        .args(["-s", &format!("{w}x{h}"), "-r", &fps.to_string(), "-i", "-"])
        .args(["-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p"])
        .args(["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart"])
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .creation_flags_hidden()
        .spawn()
        .map_err(|e| format!("Couldn't start FFmpeg: {e}"))?;
    {
        let stdin = child.stdin.as_mut().ok_or("no stdin")?;
        let mut white = vec![0u8; (w * h * 4) as usize];
        for i in 0..n_out {
            let t = (i as u64 * 1000 / fps as u64) as u32 % total;
            let mut acc = 0;
            let mut fi = 0;
            for (k, f) in job.frames.iter().enumerate() {
                acc += f.1.max(10);
                if t < acc {
                    fi = k;
                    break;
                }
            }
            // MP4 has no transparency: put see-through pixels on white
            let f = &job.frames[fi].0;
            for (o, p) in white.as_chunks_mut::<4>().0.iter_mut().zip(f.chunks_exact(4)) {
                let a = p[3] as u32;
                for c in 0..3 {
                    o[c] = ((p[c] as u32 * a + 255 * (255 - a)) / 255) as u8;
                }
                o[3] = 255;
            }
            if stdin.write_all(&white).is_err() {
                break;
            }
        }
    }
    drop(child.stdin.take());
    let o = child.wait_with_output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("FFmpeg failed: {}", String::from_utf8_lossy(&o.stderr).trim()));
    }
    Ok(())
}

trait Hidden {
    fn creation_flags_hidden(&mut self) -> &mut Self;
}
impl Hidden for Command {
    fn creation_flags_hidden(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x0800_0000)
    }
}

// ---------- where results go ----------

fn safe_name(s: &str) -> String {
    let n: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { ' ' })
        .collect();
    let n = n.split_whitespace().collect::<Vec<_>>().join(" ");
    let n: String = n.chars().take(60).collect();
    if n.is_empty() { "meme".into() } else { n }
}

/// A new file path for an export: the memes folder when auto-save is on, else a temp folder.
pub fn out_path(name: &str, ext: &str) -> PathBuf {
    let s = settings::load();
    let dir = if s.auto_save && !s.save_folder.trim().is_empty() {
        PathBuf::from(s.save_folder.trim())
    } else {
        std::env::temp_dir().join("MemeForge")
    };
    let _ = std::fs::create_dir_all(&dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d %H.%M.%S");
    let base = format!("{} {stamp}", safe_name(name));
    let mut p = dir.join(format!("{base}.{ext}"));
    let mut i = 2;
    while p.exists() {
        p = dir.join(format!("{base} ({i}).{ext}"));
        i += 1;
    }
    p
}

/// Finish an animated export. Returns {path, mp4, bytes}.
pub fn finish(id: u64, name: &str, want_gif: bool, want_mp4: bool) -> Result<Value, String> {
    let job = JOBS.lock().unwrap().remove(&id).ok_or("export job not found")?;
    let mut res = json!({});
    if want_gif {
        let data = encode_gif(&job)?;
        let p = out_path(name, "gif");
        std::fs::write(&p, &data).map_err(|e| e.to_string())?;
        res["path"] = json!(p.to_string_lossy());
        res["bytes"] = json!(data.len());
    }
    if want_mp4 {
        let p = out_path(name, "mp4");
        match encode_mp4(&job, &p) {
            Ok(()) => {
                res["mp4"] = json!(p.to_string_lossy());
                if !want_gif {
                    res["path"] = json!(p.to_string_lossy());
                    res["bytes"] = json!(std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0));
                }
            }
            Err(e) if want_gif => res["mp4_error"] = json!(e),
            Err(e) => return Err(e),
        }
    }
    Ok(res)
}

pub fn save_still(bytes: &[u8], name: &str, ext: &str) -> Result<Value, String> {
    let p = out_path(name, ext);
    std::fs::write(&p, bytes).map_err(|e| e.to_string())?;
    Ok(json!({"path": p.to_string_lossy(), "bytes": bytes.len()}))
}

// ---------- clipboard ----------

/// Put a finished meme on the clipboard. Stills go on as a picture (and PNG, and the file);
/// GIF/MP4 go on as the file, so apps like Discord paste the animation.
pub fn to_clipboard(path: &Path) -> Result<(), String> {
    use clipboard_win::{formats, Clipboard, Setter};
    let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let still = matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp" | "bmp");
    let mut bmp = None;
    let mut png = None;
    if still {
        let img = image::open(path).map_err(|e| e.to_string())?;
        let rgba = img.to_rgba8();
        // a top-down 32-bit DIB with the alpha channel; pasting apps that ignore alpha see the colours
        let mut b = Vec::new();
        image::DynamicImage::ImageRgb8(image::DynamicImage::ImageRgba8(rgba.clone()).to_rgb8())
            .write_to(&mut std::io::Cursor::new(&mut b), image::ImageFormat::Bmp)
            .map_err(|e| e.to_string())?;
        bmp = Some(b);
        let mut p = Vec::new();
        image::DynamicImage::ImageRgba8(rgba)
            .write_to(&mut std::io::Cursor::new(&mut p), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        png = Some(p);
    }
    let _clip = Clipboard::new_attempts(20).map_err(|e| format!("Clipboard busy: {e}"))?;
    clipboard_win::raw::empty().map_err(|e| e.to_string())?;
    let file = path.to_string_lossy().to_string();
    formats::FileList.write_clipboard(&[file.as_str()]).map_err(|e| e.to_string())?;
    if let Some(b) = bmp {
        formats::Bitmap.write_clipboard(&b).map_err(|e| e.to_string())?;
    }
    if let Some(p) = png {
        if let Some(fmt) = clipboard_win::register_format("PNG") {
            // set_without_clear: the plain setter would wipe the formats written above
            clipboard_win::raw::set_without_clear(fmt.get(), &p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gif_roundtrip() {
        let (w, h) = (40u32, 30u32);
        let mut frames = Vec::new();
        for k in 0..4u8 {
            let mut f = vec![0u8; (w * h * 4) as usize];
            for (i, p) in f.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                p.copy_from_slice(&[(i % 255) as u8, k * 60, 128, 255]);
            }
            frames.push((f, 80));
        }
        let data = encode_gif(&Job { w, h, frames }).unwrap();
        use image::AnimationDecoder;
        let dec = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(&data)).unwrap();
        let fr: Vec<_> = dec.into_frames().collect::<Result<_, _>>().unwrap();
        assert_eq!(fr.len(), 4);
        let px = fr[3].buffer().get_pixel(5, 5);
        assert!((px[1] as i32 - 180).abs() < 24, "green {}", px[1]);
    }
    #[test]
    fn gif_gradient_colours() {
        // white bar on top, blue gradient below, a moving yellow dot: colours must survive
        let (w, h) = (200u32, 160u32);
        let mut frames = Vec::new();
        for k in 0..6u32 {
            let mut f = vec![0u8; (w * h * 4) as usize];
            for y in 0..h {
                for x in 0..w {
                    let i = ((y * w + x) * 4) as usize;
                    let c = if y < 40 { [255, 255, 255] } else { [(30 + y / 3) as u8, 120, (200 - y / 3) as u8] };
                    let dot = (x as i32 - (20 + k as i32 * 25)).pow(2) + (y as i32 - 100).pow(2) < 225;
                    let c = if dot { [255, 200, 0] } else { c };
                    f[i..i + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
                }
            }
            frames.push((f, 60));
        }
        let data = encode_gif(&Job { w, h, frames }).unwrap();
        use image::AnimationDecoder;
        let dec = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(&data)).unwrap();
        let fr: Vec<_> = dec.into_frames().collect::<Result<_, _>>().unwrap();
        for (n, f) in fr.iter().enumerate() {
            let p = f.buffer().get_pixel(150, 130);
            let want = [30 + 130 / 3, 120, 200 - 130 / 3];
            for c in 0..3 {
                assert!((p[c] as i32 - want[c]).abs() < 20, "frame {n} pixel {:?} want {:?}", p, want);
            }
        }
    }
    /// MF_FRAME=<png> cargo test real_frame -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_frame() {
        let p = std::env::var("MF_FRAME").unwrap();
        let img = image::open(&p).unwrap().to_rgba8();
        let (w, h) = img.dimensions();
        let frames: Vec<_> = (0..24).map(|_| (img.as_raw().clone(), 60)).collect();
        let data = encode_gif(&Job { w, h, frames }).unwrap();
        std::fs::write(format!("{p}.gif"), &data).unwrap();
        use image::AnimationDecoder;
        let dec = image::codecs::gif::GifDecoder::new(std::io::Cursor::new(&data)).unwrap();
        let f = dec.into_frames().next().unwrap().unwrap();
        for (x, y) in [(300u32, 200u32), (20, 300), (200, 100)] {
            println!("({x},{y}) src {:?} gif {:?}", img.get_pixel(x, y), f.buffer().get_pixel(x, y));
        }
        let fr = vec![(img.as_raw().clone(), 60u32)];
        let (pal, lut, _) = quantizer(&fr);
        for dither in [false, true] {
            let idx = map_frame(img.as_raw(), w as usize, h as usize, &lut, dither);
            let mut err = 0f64;
            for (i, p) in img.pixels().enumerate() {
                let k = idx[i] as usize;
                err += (0..3).map(|c| (pal[k * 3 + c] as f64 - p[c] as f64).abs()).sum::<f64>();
            }
            println!("lut dither={dither}: mean err {:.2}", err / (w * h) as f64 / 3.0);
        }
        for sf in [1, 10, 30] {
            let nq = color_quant::NeuQuant::new(sf, 255, img.as_raw());
            let pal = nq.color_map_rgb();
            let mut err = 0f64;
            for p in img.pixels() {
                let i = nq.index_of(&p.0);
                err += (0..3).map(|c| (pal[i * 3 + c] as f64 - p[c] as f64).abs()).sum::<f64>();
            }
            let uniq: std::collections::HashSet<_> = pal.chunks(3).collect();
            println!("samplefac {sf}: mean err {:.2}, unique colours {}", err / (w * h) as f64 / 3.0, uniq.len());
        }
    }
    #[test]
    fn names() {
        assert_eq!(safe_name("Drake: yes/no?"), "Drake yes no");
        assert_eq!(safe_name("///"), "meme");
    }
}
