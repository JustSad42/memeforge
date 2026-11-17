//! Where the app keeps its files (next to the .exe, so it stays portable) and settings.json.
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub static APP_DIR: Lazy<PathBuf> = Lazy::new(|| {
    if let Ok(d) = std::env::var("MEMEFORGE_DATA") {
        let p = PathBuf::from(d);
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
});

pub fn app_file(name: &str) -> PathBuf {
    APP_DIR.join(name)
}
pub fn library_dir() -> PathBuf {
    let d = app_file("library");
    let _ = std::fs::create_dir_all(d.join("media"));
    let _ = std::fs::create_dir_all(d.join("thumbs"));
    d
}
pub fn projects_dir() -> PathBuf {
    let d = app_file("projects");
    let _ = std::fs::create_dir_all(&d);
    d
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    /// finished memes are saved here
    pub save_folder: String,
    pub auto_save: bool,
    /// also write an .mp4 next to every animated meme
    pub also_mp4: bool,
    pub hotkey: String,
    pub hotkey_enabled: bool,
    pub giphy_key: String,
    pub reddit_client_id: String,
    pub reddit_subs: Vec<String>,
    pub src_imgflip: bool,
    pub src_memegen: bool,
    pub src_reddit: bool,
    pub src_giphy: bool,
    /// days between background library refreshes (0 = only by hand)
    pub refresh_days: u32,
    pub start_with_windows: bool,
    pub close_to_tray: bool,
    pub check_updates: bool,
    /// cap on the exported width in px (0 = keep size)
    pub max_width: u32,
    pub gif_max_frames: u32,
    pub accent: String,
    pub first_run_done: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let pics = std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join("Pictures").join("Memes")).unwrap_or_default();
        Settings {
            save_folder: pics.to_string_lossy().into(),
            auto_save: true,
            also_mp4: false,
            hotkey: "Ctrl+Shift+M".into(),
            hotkey_enabled: true,
            giphy_key: String::new(),
            reddit_client_id: String::new(),
            reddit_subs: vec!["MemeTemplatesOfficial".into(), "reactiongifs".into(), "MemeTemplates".into()],
            src_imgflip: true,
            src_memegen: true,
            src_reddit: true,
            src_giphy: true,
            refresh_days: 7,
            start_with_windows: true,
            close_to_tray: true,
            check_updates: true,
            max_width: 0,
            gif_max_frames: 300,
            accent: "violet".into(),
            first_run_done: false,
        }
    }
}

static CACHE: Lazy<Mutex<Option<Settings>>> = Lazy::new(|| Mutex::new(None));

pub fn load() -> Settings {
    if let Some(s) = CACHE.lock().unwrap().clone() {
        return s;
    }
    let s: Settings = std::fs::read_to_string(app_file("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    *CACHE.lock().unwrap() = Some(s.clone());
    s
}

pub fn save(s: &Settings) -> Result<(), String> {
    let t = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    write_atomic(&app_file("settings.json"), t.as_bytes()).map_err(|e| e.to_string())?;
    *CACHE.lock().unwrap() = Some(s.clone());
    Ok(())
}

pub fn write_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = path.with_extension("tmp~");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// Start (in the tray) when Windows starts.
pub fn set_autostart(on: bool) {
    use winreg::enums::*;
    let Ok((key, _)) = winreg::RegKey::predef(HKEY_CURRENT_USER).create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run") else { return };
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.set_value("MemeForge", &format!("\"{}\" --tray", exe.display()));
        }
    } else {
        let _ = key.delete_value("MemeForge");
    }
}
