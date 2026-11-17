//! The meme library: downloaded templates/GIFs and the user's own images, with thumbnails.
//! Files live in library/media, thumbnails in library/thumbs, the list in library/index.json.
use crate::settings::{self, write_atomic};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Item {
    pub id: String,
    /// imgflip | memegen | reddit | giphy | user | sticker
    pub source: String,
    /// the id the source uses (Imgflip template id, GIPHY id, ...)
    pub source_id: String,
    pub title: String,
    /// relative to library/
    pub file: String,
    pub thumb: String,
    pub w: u32,
    pub h: u32,
    pub animated: bool,
    pub frames: u32,
    /// how many text boxes the template is made for
    pub boxes: u32,
    pub tags: Vec<String>,
    /// popularity position at the source (lower = more popular)
    pub rank: u32,
    pub added: i64,
    /// last time a refresh still listed it
    pub seen: i64,
    pub used: u32,
    pub last_used: i64,
    pub fav: bool,
    pub origin: String,
    pub bytes: u64,
}

/// Something a source offers, before it is downloaded.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Candidate {
    pub source: String,
    pub source_id: String,
    pub title: String,
    pub url: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub boxes: u32,
    pub rank: u32,
    pub animated: bool,
    pub w: u32,
    pub h: u32,
}

static ITEMS: Lazy<Mutex<HashMap<String, Item>>> = Lazy::new(|| {
    let m: HashMap<String, Item> = std::fs::read_to_string(index_file())
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<Item>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .map(|i| (i.id.clone(), i))
        .collect();
    Mutex::new(m)
});

fn index_file() -> PathBuf {
    settings::library_dir().join("index.json")
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn save_locked(m: &HashMap<String, Item>) {
    let mut v: Vec<&Item> = m.values().collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    if let Ok(t) = serde_json::to_string(&v) {
        let _ = write_atomic(&index_file(), t.as_bytes());
    }
}

pub fn list() -> Vec<Item> {
    ITEMS.lock().unwrap().values().cloned().collect()
}

pub fn get(id: &str) -> Option<Item> {
    ITEMS.lock().unwrap().get(id).cloned()
}

pub fn id_for(source: &str, key: &str) -> String {
    let h = Sha256::digest(format!("{source}:{key}").as_bytes());
    h.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

pub fn has(id: &str) -> bool {
    ITEMS.lock().unwrap().contains_key(id)
}

/// Mark an existing item as still listed by its source (and refresh its rank/title).
pub fn touch(id: &str, c: &Candidate) {
    let mut m = ITEMS.lock().unwrap();
    if let Some(i) = m.get_mut(id) {
        i.seen = now();
        i.rank = c.rank;
        if i.boxes == 0 {
            i.boxes = c.boxes;
        }
        for t in &c.tags {
            if !i.tags.contains(t) {
                i.tags.push(t.clone());
            }
        }
    }
}

pub fn flush() {
    save_locked(&ITEMS.lock().unwrap());
}

pub fn agent(secs: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(secs)))
        .user_agent(concat!("MemeForge/", env!("CARGO_PKG_VERSION")))
        .build()
        .into()
}

pub fn download(url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut r = agent(90).get(url).call().map_err(|e| format!("download failed: {e}"))?;
    r.body_mut().with_config().limit(limit).read_to_vec().map_err(|e| format!("download failed: {e}"))
}

struct Probe {
    w: u32,
    h: u32,
    frames: u32,
    ext: &'static str,
    first: image::DynamicImage,
}

/// Work out what the bytes are: size, frame count and a first frame for the thumbnail.
fn probe(bytes: &[u8]) -> Result<Probe, String> {
    use image::AnimationDecoder;
    let fmt = image::guess_format(bytes).map_err(|_| "not an image".to_string())?;
    match fmt {
        image::ImageFormat::Gif => {
            let dec = image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
            let mut frames = dec.into_frames();
            let first = frames.next().ok_or("empty GIF")?.map_err(|e| e.to_string())?;
            let n = 1 + frames.take(5000).count() as u32;
            let img = image::DynamicImage::ImageRgba8(first.into_buffer());
            Ok(Probe { w: img.width(), h: img.height(), frames: n, ext: "gif", first: img })
        }
        image::ImageFormat::WebP => {
            let dec = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
            if dec.has_animation() {
                let mut frames = dec.into_frames();
                let first = frames.next().ok_or("empty WebP")?.map_err(|e| e.to_string())?;
                let n = 1 + frames.take(5000).count() as u32;
                let img = image::DynamicImage::ImageRgba8(first.into_buffer());
                Ok(Probe { w: img.width(), h: img.height(), frames: n, ext: "webp", first: img })
            } else {
                let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
                Ok(Probe { w: img.width(), h: img.height(), frames: 1, ext: "webp", first: img })
            }
        }
        image::ImageFormat::Png | image::ImageFormat::Jpeg | image::ImageFormat::Bmp => {
            let img = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
            let ext = match fmt {
                image::ImageFormat::Png => "png",
                image::ImageFormat::Jpeg => "jpg",
                _ => "bmp",
            };
            Ok(Probe { w: img.width(), h: img.height(), frames: 1, ext, first: img })
        }
        _ => Err("unsupported image type".into()),
    }
}

fn write_thumb(img: &image::DynamicImage, path: &Path) -> Result<(), String> {
    let t = if img.width() > 420 || img.height() > 420 { img.thumbnail(420, 420) } else { img.clone() };
    // flatten transparency onto a dark grey so it reads on the grid
    let rgba = t.to_rgba8();
    let mut rgb = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, p) in rgba.enumerate_pixels() {
        let a = p[3] as u32;
        let bg = 38u32;
        rgb.put_pixel(x, y, image::Rgb([0, 1, 2].map(|c| ((p[c] as u32 * a + bg * (255 - a)) / 255) as u8)));
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 84)
        .encode_image(&rgb)
        .map_err(|e| e.to_string())?;
    write_atomic(path, &out).map_err(|e| e.to_string())
}

/// Store bytes as a library item. Returns the item (existing one if the id is taken).
pub fn add_bytes(id: &str, bytes: &[u8], meta: Item) -> Result<Item, String> {
    if let Some(i) = get(id) {
        return Ok(i);
    }
    let p = probe(bytes)?;
    let dir = settings::library_dir();
    let file = format!("media/{id}.{}", p.ext);
    let thumb = format!("thumbs/{id}.jpg");
    write_atomic(&dir.join(&file), bytes).map_err(|e| e.to_string())?;
    write_thumb(&p.first, &dir.join(&thumb))?;
    let t = now();
    let item = Item {
        id: id.to_string(),
        file,
        thumb,
        w: p.w,
        h: p.h,
        animated: p.frames > 1,
        frames: p.frames,
        added: t,
        seen: t,
        bytes: bytes.len() as u64,
        ..meta
    };
    let mut m = ITEMS.lock().unwrap();
    m.insert(id.to_string(), item.clone());
    save_locked(&m);
    Ok(item)
}

/// Download a candidate into the library (no-op if it's already there).
pub fn add_candidate(c: &Candidate) -> Result<Item, String> {
    let id = id_for(&c.source, &c.source_id);
    if let Some(i) = get(&id) {
        touch(&id, c);
        return Ok(i);
    }
    let bytes = download(&c.url, 40 * 1024 * 1024)?;
    add_bytes(
        &id,
        &bytes,
        Item {
            source: c.source.clone(),
            source_id: c.source_id.clone(),
            title: c.title.clone(),
            boxes: c.boxes,
            tags: c.tags.clone(),
            rank: c.rank,
            origin: c.url.clone(),
            ..Default::default()
        },
    )
}

/// Add an image file from disk (the user's own, or a sticker).
pub fn add_file(path: &Path, source: &str) -> Result<Item, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let title = path.file_stem().map(|s| s.to_string_lossy().replace(['_', '-'], " ")).unwrap_or_default();
    add_named(&bytes, &title, source)
}

pub fn add_named(bytes: &[u8], title: &str, source: &str) -> Result<Item, String> {
    let h: String = Sha256::digest(bytes).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let id = id_for(source, &h);
    add_bytes(
        &id,
        bytes,
        Item { source: source.into(), title: title.trim().to_string(), rank: 0, ..Default::default() },
    )
}

pub fn update<F: FnOnce(&mut Item)>(id: &str, f: F) -> Option<Item> {
    let mut m = ITEMS.lock().unwrap();
    let out = m.get_mut(id).map(|i| {
        f(i);
        i.clone()
    });
    save_locked(&m);
    out
}

pub fn remove(id: &str) -> bool {
    let mut m = ITEMS.lock().unwrap();
    let Some(i) = m.remove(id) else { return false };
    let dir = settings::library_dir();
    let _ = std::fs::remove_file(dir.join(&i.file));
    let _ = std::fs::remove_file(dir.join(&i.thumb));
    save_locked(&m);
    true
}

/// Drop downloaded items a source hasn't listed for a long time, unless the user cares about them.
pub fn prune(older_than_days: i64) -> usize {
    let cut = now() - older_than_days * 86400;
    let ids: Vec<String> = ITEMS
        .lock()
        .unwrap()
        .values()
        .filter(|i| matches!(i.source.as_str(), "giphy" | "reddit") && !i.fav && i.used == 0 && i.seen < cut)
        .map(|i| i.id.clone())
        .collect();
    for id in &ids {
        remove(id);
    }
    ids.len()
}

pub fn stats() -> serde_json::Value {
    let m = ITEMS.lock().unwrap();
    let mut by: HashMap<String, usize> = HashMap::new();
    let mut bytes = 0u64;
    for i in m.values() {
        *by.entry(i.source.clone()).or_default() += 1;
        bytes += i.bytes;
    }
    serde_json::json!({"count": m.len(), "bytes": bytes, "by_source": by})
}
