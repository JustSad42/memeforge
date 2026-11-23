//! Where popular memes come from: Imgflip and memegen.link (no key), GIPHY (free API key)
//! and Reddit (free app client id, official OAuth API). Plus the background refresh.
use crate::library::{self, agent, Candidate};
use crate::settings::{self, write_atomic};
use once_cell::sync::Lazy;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

const REDDIT_UA: &str = concat!("windows:memeforge:", env!("CARGO_PKG_VERSION"), " (desktop meme maker)");

fn get_json(url: &str) -> Result<Value, String> {
    let mut r = agent(45).get(url).call().map_err(|e| match e {
        ureq::Error::StatusCode(429) => "too many requests, try again later".to_string(),
        ureq::Error::StatusCode(c) => format!("the site answered with an error (HTTP {c})"),
        ureq::Error::Timeout(_) => "didn't answer in time (the site may be down)".to_string(),
        e if e.to_string().contains("dns") || e.to_string().contains("connect") => "couldn't connect (offline?)".to_string(),
        e => e.to_string(),
    })?;
    r.body_mut().with_config().limit(20 * 1024 * 1024).read_json().map_err(|e| e.to_string())
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2)
        .map(|w| w.to_lowercase())
        .collect()
}

// ---------- Imgflip ----------

pub fn imgflip() -> Result<Vec<Candidate>, String> {
    let v = get_json("https://api.imgflip.com/get_memes")?;
    let arr = v["data"]["memes"].as_array().ok_or("unexpected Imgflip reply")?;
    Ok(arr
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            Some(Candidate {
                source: "imgflip".into(),
                source_id: m["id"].as_str()?.into(),
                title: m["name"].as_str()?.into(),
                url: m["url"].as_str()?.into(),
                preview: m["url"].as_str()?.into(),
                tags: words(m["name"].as_str().unwrap_or("")),
                boxes: m["box_count"].as_u64().unwrap_or(2) as u32,
                rank: i as u32 + 1,
                animated: false,
                w: m["width"].as_u64().unwrap_or(0) as u32,
                h: m["height"].as_u64().unwrap_or(0) as u32,
            })
        })
        .collect())
}

// ---------- memegen.link ----------

pub fn memegen() -> Result<Vec<Candidate>, String> {
    let v = get_json("https://api.memegen.link/templates/")?;
    let arr = v.as_array().ok_or("unexpected memegen reply")?;
    Ok(arr
        .iter()
        .enumerate()
        .filter_map(|(i, m)| {
            let name = m["name"].as_str()?;
            let mut tags = words(name);
            for k in m["keywords"].as_array().into_iter().flatten() {
                tags.extend(words(k.as_str().unwrap_or("")));
            }
            Some(Candidate {
                source: "memegen".into(),
                source_id: m["id"].as_str()?.into(),
                title: name.into(),
                url: m["blank"].as_str()?.into(),
                preview: m["blank"].as_str()?.into(),
                tags,
                boxes: m["lines"].as_u64().unwrap_or(2).clamp(1, 6) as u32,
                rank: 100 + i as u32,
                ..Default::default()
            })
        })
        .collect())
}

// ---------- GIPHY ----------

fn giphy_list(v: &Value, offset: u32) -> Vec<Candidate> {
    v["data"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, g)| {
            let im = &g["images"];
            // ~5 MB GIF that still looks good; the original can be 20+ MB
            let pick = ["downsized_medium", "downsized", "original"]
                .iter()
                .map(|k| &im[*k])
                .find(|x| x["url"].as_str().is_some())?;
            let title = g["title"].as_str().unwrap_or("GIF");
            let title = title.split(" GIF").next().unwrap_or(title).trim();
            let mut tags = words(title);
            tags.extend(words(g["slug"].as_str().unwrap_or("")));
            tags.dedup();
            Some(Candidate {
                source: "giphy".into(),
                source_id: g["id"].as_str()?.into(),
                title: if title.is_empty() { "GIF".into() } else { title.into() },
                url: pick["url"].as_str()?.into(),
                preview: im["fixed_width"]["webp"]
                    .as_str()
                    .or(im["fixed_width"]["url"].as_str())
                    .unwrap_or(pick["url"].as_str()?)
                    .into(),
                tags,
                boxes: 1,
                rank: offset + i as u32 + 1,
                animated: true,
                w: pick["width"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
                h: pick["height"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
            })
        })
        .collect()
}

pub fn giphy_trending(key: &str, total: u32) -> Result<Vec<Candidate>, String> {
    let mut out = Vec::new();
    let mut off = 0;
    while off < total {
        let url = format!("https://api.giphy.com/v1/gifs/trending?api_key={}&limit=50&offset={off}&rating=pg-13&bundle=messaging_non_clips", urlencoding::encode(key));
        let v = get_json(&url).map_err(|e| if e.contains("401") || e.contains("403") { "GIPHY rejected the API key".into() } else { e })?;
        let page = giphy_list(&v, off);
        if page.is_empty() {
            break;
        }
        out.extend(page);
        off += 50;
    }
    Ok(out)
}

pub fn giphy_search(key: &str, q: &str, offset: u32) -> Result<Vec<Candidate>, String> {
    let url = format!(
        "https://api.giphy.com/v1/gifs/search?api_key={}&q={}&limit=40&offset={offset}&rating=pg-13&bundle=messaging_non_clips",
        urlencoding::encode(key),
        urlencoding::encode(q)
    );
    Ok(giphy_list(&get_json(&url)?, offset))
}

// ---------- Reddit (official API, application-only OAuth) ----------

static REDDIT_TOKEN: Lazy<Mutex<Option<(String, i64)>>> = Lazy::new(|| Mutex::new(None));

fn reddit_token(client_id: &str) -> Result<String, String> {
    if let Some((t, exp)) = REDDIT_TOKEN.lock().unwrap().clone() {
        if exp > library::now() + 60 {
            return Ok(t);
        }
    }
    use std::io::Write;
    let mut basic = Vec::new();
    write!(basic, "{client_id}:").ok();
    let auth = format!("Basic {}", b64(&basic));
    let mut r = agent(30)
        .post("https://www.reddit.com/api/v1/access_token")
        .header("Authorization", &auth)
        .header("User-Agent", REDDIT_UA)
        .send_form([("grant_type", "https://oauth.reddit.com/grants/installed_client"), ("device_id", "DO_NOT_TRACK_THIS_DEVICE")])
        .map_err(|e| match e {
            ureq::Error::StatusCode(401) => "Reddit rejected the client ID (it must be an \"installed app\")".to_string(),
            e => format!("Reddit sign-in failed: {e}"),
        })?;
    let v: Value = r.body_mut().read_json().map_err(|e| e.to_string())?;
    let t = v["access_token"].as_str().ok_or("Reddit didn't return a token (check the client ID)")?.to_string();
    let exp = library::now() + v["expires_in"].as_i64().unwrap_or(3600);
    *REDDIT_TOKEN.lock().unwrap() = Some((t.clone(), exp));
    Ok(t)
}

fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

fn reddit_get(client_id: &str, path: &str) -> Result<Value, String> {
    let tok = reddit_token(client_id)?;
    let mut r = agent(30)
        .get(&format!("https://oauth.reddit.com{path}"))
        .header("Authorization", &format!("Bearer {tok}"))
        .header("User-Agent", REDDIT_UA)
        .call()
        .map_err(|e| format!("Reddit: {e}"))?;
    r.body_mut().with_config().limit(20 * 1024 * 1024).read_json().map_err(|e| e.to_string())
}

fn clean_reddit_title(t: &str) -> String {
    let mut s = t.to_string();
    for pat in ["[template]", "[Template]", "(template)", "Template:", "template", "Template", "[request]", "[Request]"] {
        s = s.replace(pat, "");
    }
    let s = s.trim().trim_matches(|c: char| c == '-' || c == ':' || c == '|').trim();
    s.chars().take(90).collect()
}

fn reddit_posts(v: &Value, rank0: u32) -> Vec<Candidate> {
    v["data"]["children"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, c)| {
            let d = &c["data"];
            if d["over_18"].as_bool() == Some(true) || d["is_video"].as_bool() == Some(true) {
                return None;
            }
            let url = d["url_overridden_by_dest"].as_str().or(d["url"].as_str())?.replace("&amp;", "&");
            let low = url.to_lowercase();
            let img = [".jpg", ".jpeg", ".png", ".gif", ".webp"].iter().any(|e| low.split('?').next().unwrap_or("").ends_with(e));
            if !img || !(low.contains("i.redd.it") || low.contains("i.imgur.com")) {
                return None;
            }
            let title = clean_reddit_title(d["title"].as_str().unwrap_or(""));
            let preview = d["preview"]["images"][0]["resolutions"]
                .as_array()
                .and_then(|r| r.iter().find(|x| x["width"].as_u64().unwrap_or(0) >= 300).or(r.last()))
                .and_then(|x| x["url"].as_str())
                .map(|s| s.replace("&amp;", "&"))
                .unwrap_or_else(|| url.clone());
            Some(Candidate {
                source: "reddit".into(),
                source_id: d["id"].as_str()?.into(),
                tags: words(&title),
                title: if title.is_empty() { "Reddit template".into() } else { title },
                animated: low.contains(".gif"),
                url,
                preview,
                boxes: 2,
                rank: rank0 + i as u32 + 1,
                ..Default::default()
            })
        })
        .collect()
}

pub fn reddit_top(client_id: &str, subs: &[String], per_sub: u32) -> Result<Vec<Candidate>, String> {
    let mut out = Vec::new();
    let mut err = None;
    for (si, sub) in subs.iter().enumerate() {
        let sub = sub.trim().trim_start_matches("r/");
        let mut after = String::new();
        let mut got = 0;
        for t in ["month", "year"] {
            while got < per_sub {
                let path = format!("/r/{sub}/top?t={t}&limit=100&raw_json=1{after}");
                match reddit_get(client_id, &path) {
                    Ok(v) => {
                        let page = reddit_posts(&v, si as u32 * 1000 + got);
                        got += page.len() as u32;
                        out.extend(page);
                        match v["data"]["after"].as_str() {
                            Some(a) => after = format!("&after={a}"),
                            None => break,
                        }
                    }
                    Err(e) => {
                        err = Some(e);
                        break;
                    }
                }
            }
            after.clear();
        }
    }
    if out.is_empty() {
        if let Some(e) = err {
            return Err(e);
        }
    }
    out.sort_by(|a, b| a.source_id.cmp(&b.source_id));
    out.dedup_by(|a, b| a.source_id == b.source_id);
    Ok(out)
}

pub fn reddit_search(client_id: &str, subs: &[String], q: &str) -> Result<Vec<Candidate>, String> {
    let multi = subs.iter().map(|s| s.trim().trim_start_matches("r/")).collect::<Vec<_>>().join("+");
    let path = format!("/r/{multi}/search?q={}&restrict_sr=1&sort=relevance&limit=60&raw_json=1", urlencoding::encode(q));
    Ok(reddit_posts(&reddit_get(client_id, &path)?, 0))
}

// ---------- refresh job ----------

pub static RUNNING: AtomicBool = AtomicBool::new(false);
pub static STATUS: Lazy<Mutex<Value>> = Lazy::new(|| Mutex::new(json!({"running": false})));

fn state_file() -> std::path::PathBuf {
    settings::library_dir().join("refresh.json")
}
pub fn last_refresh() -> Value {
    std::fs::read_to_string(state_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
}

pub fn due() -> bool {
    let s = settings::load();
    if s.refresh_days == 0 {
        return library::list().is_empty();
    }
    let last = last_refresh()["at"].as_i64().unwrap_or(0);
    library::now() - last > s.refresh_days as i64 * 86400
}

/// Fetch every enabled source and download what's new. `progress` gets status updates.
pub fn refresh(progress: &(dyn Fn(Value) + Sync)) -> Value {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return json!({"error": "A refresh is already running."});
    }
    let s = settings::load();
    let mut errors: Vec<String> = Vec::new();
    let mut cands: Vec<Candidate> = Vec::new();
    let set = |v: Value| {
        *STATUS.lock().unwrap() = v.clone();
        progress(v);
    };
    set(json!({"running": true, "phase": "Checking sources...", "done": 0, "total": 0}));
    if s.src_imgflip {
        match imgflip() {
            Ok(v) => cands.extend(v),
            Err(e) => errors.push(format!("Imgflip: {e}")),
        }
    }
    if s.src_memegen {
        match memegen() {
            Ok(v) => cands.extend(v),
            Err(e) => errors.push(format!("memegen.link: {e}")),
        }
    }
    if s.src_giphy && !s.giphy_key.trim().is_empty() {
        match giphy_trending(s.giphy_key.trim(), 200) {
            Ok(v) => cands.extend(v),
            Err(e) => errors.push(format!("GIPHY: {e}")),
        }
    }
    if s.src_reddit && !s.reddit_client_id.trim().is_empty() {
        let per = (300 / s.reddit_subs.len().max(1)) as u32;
        match reddit_top(s.reddit_client_id.trim(), &s.reddit_subs, per.max(50)) {
            Ok(v) => cands.extend(v),
            Err(e) => errors.push(format!("Reddit: {e}")),
        }
    }
    // already have it? just mark it as still popular
    let mut todo = Vec::new();
    for c in &cands {
        let id = library::id_for(&c.source, &c.source_id);
        if library::has(&id) {
            library::touch(&id, c);
        } else {
            todo.push(c.clone());
        }
    }
    library::flush();
    let total = todo.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let failed = std::sync::atomic::AtomicUsize::new(0);
    set(json!({"running": true, "phase": "Downloading", "done": 0, "total": total}));
    use rayon::prelude::*;
    let pool = rayon::ThreadPoolBuilder::new().num_threads(6).build().unwrap();
    pool.install(|| {
        todo.par_iter().for_each(|c| {
            if library::add_candidate(c).is_err() {
                failed.fetch_add(1, Ordering::Relaxed);
            }
            let d = done.fetch_add(1, Ordering::Relaxed) + 1;
            if d.is_multiple_of(5) || d == total {
                set(json!({"running": true, "phase": "Downloading", "done": d, "total": total, "title": c.title}));
            }
        })
    });
    let pruned = library::prune(45);
    let res = json!({
        "at": library::now(), "found": cands.len(), "added": total - failed.load(Ordering::Relaxed),
        "failed": failed.load(Ordering::Relaxed), "pruned": pruned, "errors": errors,
    });
    let _ = write_atomic(&state_file(), res.to_string().as_bytes());
    RUNNING.store(false, Ordering::SeqCst);
    let mut fin = res.clone();
    fin["running"] = json!(false);
    fin["phase"] = json!("Done");
    set(fin);
    res
}

/// Search online (GIPHY / Reddit) for things that aren't in the library yet.
pub fn search_online(source: &str, q: &str, offset: u32) -> Result<Vec<Candidate>, String> {
    let s = settings::load();
    match source {
        "giphy" => {
            if s.giphy_key.trim().is_empty() {
                return Err("Add a GIPHY API key in Settings to search GIFs.".into());
            }
            giphy_search(s.giphy_key.trim(), q, offset)
        }
        "reddit" => {
            if s.reddit_client_id.trim().is_empty() {
                return Err("Add a Reddit client ID in Settings to search Reddit.".into());
            }
            reddit_search(s.reddit_client_id.trim(), &s.reddit_subs, q)
        }
        _ => Err("unknown source".into()),
    }
}

/// Quick key check for the Settings page.
pub fn test_source(source: &str) -> Result<String, String> {
    let s = settings::load();
    match source {
        "giphy" => giphy_search(s.giphy_key.trim(), "cat", 0).map(|v| format!("GIPHY works ({} results for \"cat\").", v.len())),
        "reddit" => {
            *REDDIT_TOKEN.lock().unwrap() = None;
            reddit_top(s.reddit_client_id.trim(), &s.reddit_subs[..1.min(s.reddit_subs.len())], 10)
                .map(|v| format!("Reddit works ({} templates found).", v.len()))
        }
        _ => Err("unknown source".into()),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn b64() {
        assert_eq!(super::b64(b"abc:"), "YWJjOg==");
        assert_eq!(super::b64(b"ab"), "YWI=");
    }
    #[test]
    fn titles() {
        assert_eq!(super::clean_reddit_title("[Template] Guy looking at sky"), "Guy looking at sky");
    }
}
