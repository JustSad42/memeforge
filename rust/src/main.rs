//! MemeForge: a meme and GIF maker for Windows.
//!   MemeForge.exe           open the window
//!   MemeForge.exe --tray    start in the background (tray icon + quick-meme hotkey)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod sleep;
mod export;
mod library;
mod settings;
mod sources;
mod updater;

use once_cell::sync::OnceCell;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

static APP: OnceCell<AppHandle> = OnceCell::new();
static PENDING: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

fn notify(title: &str, body: &str) {
    let _ = notify_rust::Notification::new().summary(title).body(body).appname("MemeForge").show();
}

fn arg_str<'a>(a: &'a Value, k: &str) -> &'a str {
    a[k].as_str().unwrap_or("")
}

/// Hidden windows are asleep (see `sleep`) and refresh themselves when shown.
fn emit(ev: &str, v: Value) {
    if let Some(app) = APP.get() {
        for (label, w) in app.webview_windows() {
            if w.is_visible().unwrap_or(true) {
                let _ = app.emit_to(label, ev, v.clone());
            }
        }
    }
}

fn start_refresh() {
    std::thread::spawn(|| {
        let r = sources::refresh(&|v| emit("refresh", v));
        let added = r["added"].as_u64().unwrap_or(0);
        if added > 0 {
            emit("library-changed", json!({}));
        }
    });
}

fn reveal(path: &str) {
    let _ = std::process::Command::new("explorer").arg(format!("/select,{path}")).spawn();
}

/// Everything the page asks for, by name.
fn handle(cmd: &str, a: Value) -> Result<Value, String> {
    Ok(match cmd {
        "settings_get" => {
            let mut v = serde_json::to_value(settings::load()).unwrap();
            v["_version"] = json!(updater::VERSION);
            v["_data_dir"] = json!(settings::APP_DIR.to_string_lossy());
            v
        }
        "settings_set" => {
            let old = settings::load();
            let mut cur = serde_json::to_value(&old).unwrap();
            if let (Some(c), Some(n)) = (cur.as_object_mut(), a.as_object()) {
                for (k, v) in n {
                    if !k.starts_with('_') {
                        c.insert(k.clone(), v.clone());
                    }
                }
            }
            let s: settings::Settings = serde_json::from_value(cur).map_err(|e| e.to_string())?;
            settings::save(&s)?;
            if s.start_with_windows != old.start_with_windows {
                settings::set_autostart(s.start_with_windows);
            }
            // a new key or a newly enabled source: fetch from it now rather than at the next weekly refresh
            let giphy_on = |x: &settings::Settings| x.src_giphy && !x.giphy_key.trim().is_empty();
            let reddit_on = |x: &settings::Settings| x.src_reddit && !x.reddit_client_id.trim().is_empty();
            let new_source = (giphy_on(&s) && (!giphy_on(&old) || s.giphy_key != old.giphy_key))
                || (reddit_on(&s) && (!reddit_on(&old) || s.reddit_client_id != old.reddit_client_id || s.reddit_subs != old.reddit_subs))
                || (s.src_imgflip && !old.src_imgflip)
                || (s.src_memegen && !old.src_memegen);
            if new_source && !sources::RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                start_refresh();
            }
            if s.hotkey != old.hotkey || s.hotkey_enabled != old.hotkey_enabled {
                if let Some(app) = APP.get() {
                    if let Err(e) = register_hotkey(app) {
                        return Ok(json!({"ok": true, "hotkey_error": e}));
                    }
                }
            }
            json!({"ok": true})
        }
        "lib_list" => json!(library::list()),
        "lib_stats" => {
            let mut v = library::stats();
            v["last_refresh"] = sources::last_refresh();
            v["refresh"] = sources::STATUS.lock().unwrap().clone();
            v
        }
        "lib_fav" => json!(library::update(arg_str(&a, "id"), |i| i.fav = a["on"].as_bool().unwrap_or(true))),
        "lib_rename" => json!(library::update(arg_str(&a, "id"), |i| i.title = arg_str(&a, "title").to_string())),
        "lib_used" => json!(library::update(arg_str(&a, "id"), |i| {
            i.used += 1;
            i.last_used = library::now();
        })),
        "lib_remove" => json!(library::remove(arg_str(&a, "id"))),
        "lib_add_dialog" => {
            let files = rfd::FileDialog::new()
                .add_filter("Images and GIFs", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
                .pick_files()
                .unwrap_or_default();
            add_paths(&files, arg_str(&a, "source"))
        }
        "lib_add_paths" => {
            let files: Vec<PathBuf> = a["paths"].as_array().into_iter().flatten().filter_map(|p| p.as_str()).map(PathBuf::from).collect();
            add_paths(&files, arg_str(&a, "source"))
        }
        "lib_add_b64" => {
            let bytes = b64_decode(arg_str(&a, "data")).ok_or("bad data")?;
            let src = if arg_str(&a, "source").is_empty() { "user" } else { arg_str(&a, "source") };
            json!(library::add_named(&bytes, arg_str(&a, "title"), src)?)
        }
        "lib_add_url" => {
            let bytes = library::download(arg_str(&a, "url"), 40 * 1024 * 1024)?;
            let src = if arg_str(&a, "source").is_empty() { "user" } else { arg_str(&a, "source") };
            json!(library::add_named(&bytes, arg_str(&a, "title"), src)?)
        }
        "refresh_start" => {
            start_refresh();
            json!({"ok": true})
        }
        "search_online" => json!(sources::search_online(arg_str(&a, "source"), arg_str(&a, "q"), a["offset"].as_u64().unwrap_or(0) as u32)?),
        "add_candidate" => {
            let c: library::Candidate = serde_json::from_value(a["cand"].clone()).map_err(|e| e.to_string())?;
            json!(library::add_candidate(&c)?)
        }
        "test_source" => json!(sources::test_source(arg_str(&a, "source"))?),
        "export_begin" => json!(export::begin(a["w"].as_u64().unwrap_or(0) as u32, a["h"].as_u64().unwrap_or(0) as u32)),
        "export_cancel" => {
            export::cancel(a["id"].as_u64().unwrap_or(0));
            json!(true)
        }
        "export_finish" => export::finish(
            a["id"].as_u64().unwrap_or(0),
            arg_str(&a, "name"),
            a["gif"].as_bool().unwrap_or(true),
            a["mp4"].as_bool().unwrap_or(false),
        )?,
        "clipboard" => {
            export::to_clipboard(Path::new(arg_str(&a, "path")))?;
            json!(true)
        }
        "reveal" => {
            reveal(arg_str(&a, "path"));
            json!(true)
        }
        "open_path" => {
            let _ = open::that(arg_str(&a, "path"));
            json!(true)
        }
        "save_as" => {
            let src = PathBuf::from(arg_str(&a, "path"));
            let ext = src.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
            let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            match rfd::FileDialog::new().set_file_name(&name).add_filter(ext.to_uppercase(), &[&ext]).save_file() {
                Some(dst) => {
                    std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
                    json!({"path": dst.to_string_lossy()})
                }
                None => json!(null),
            }
        }
        "pick_folder" => json!(rfd::FileDialog::new().pick_folder().map(|p| p.to_string_lossy().to_string())),
        "project_save" => {
            let id = if arg_str(&a, "id").is_empty() { format!("{}", chrono::Utc::now().timestamp_millis()) } else { arg_str(&a, "id").into() };
            let mut v = a.clone();
            v["id"] = json!(id);
            v["saved"] = json!(library::now());
            let p = settings::projects_dir().join(format!("{id}.json"));
            settings::write_atomic(&p, v.to_string().as_bytes()).map_err(|e| e.to_string())?;
            json!({"id": id})
        }
        "project_list" => {
            let mut out: Vec<Value> = std::fs::read_dir(settings::projects_dir())
                .map_err(|e| e.to_string())?
                .flatten()
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
                .map(|mut v| {
                    v.as_object_mut().map(|o| o.remove("scene"));
                    let exists = v["out"].as_str().map(|p| Path::new(p).exists()).unwrap_or(false);
                    v["exists"] = json!(exists);
                    v
                })
                .collect();
            out.sort_by(|a, b| b["saved"].as_i64().cmp(&a["saved"].as_i64()));
            json!(out)
        }
        "project_get" => {
            let p = settings::projects_dir().join(format!("{}.json", arg_str(&a, "id").replace(['/', '\\', '.'], "")));
            serde_json::from_str(&std::fs::read_to_string(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?
        }
        "project_delete" => {
            let p = settings::projects_dir().join(format!("{}.json", arg_str(&a, "id").replace(['/', '\\', '.'], "")));
            json!(std::fs::remove_file(p).is_ok())
        }
        "ffmpeg_status" => json!({"path": export::ffmpeg_path().map(|p| p.to_string_lossy().to_string())}),
        "ffmpeg_install" => {
            // a visible console so the user sees winget's progress and prompts
            std::process::Command::new("cmd")
                .args(["/c", "start", "Install FFmpeg", "cmd", "/c", "winget install -e --id Gyan.FFmpeg & echo. & echo Done - you can close this window. & pause"])
                .spawn()
                .map_err(|e| e.to_string())?;
            json!(true)
        }
        "update_check" => updater::check(a["force"].as_bool().unwrap_or(false)),
        "update_install" => json!(updater::install(&|m| emit("update-progress", json!(m)))?),
        "quick_hide" => {
            if let Some(w) = APP.get().and_then(|a| a.get_webview_window("quick")) {
                put_away(&w);
            }
            json!(true)
        }
        "open_editor" => {
            if let Some(app) = APP.get() {
                let app2 = app.clone();
                let payload = a.clone();
                let _ = app.run_on_main_thread(move || {
                    if let Some(w) = app2.get_webview_window("quick") {
                        put_away(&w);
                    }
                    if app2.get_webview_window("main").is_some() {
                        open_window(&app2);
                        let _ = app2.emit_to("main", "open-editor", payload);
                    } else {
                        // a new window picks this up once its page has loaded
                        *PENDING.lock().unwrap() = Some(payload);
                        open_window(&app2);
                    }
                });
            }
            json!(true)
        }
        "take_pending" => PENDING.lock().unwrap().take().unwrap_or(Value::Null),
        "open_main" => {
            if let Some(app) = APP.get() {
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || open_window(&app2));
            }
            json!(true)
        }
        _ => return Err(format!("unknown command {cmd}")),
    })
}

fn add_paths(files: &[PathBuf], source: &str) -> Value {
    let src = if source.is_empty() { "user" } else { source };
    let mut added = Vec::new();
    let mut errors = Vec::new();
    for f in files {
        match library::add_file(f, src) {
            Ok(i) => added.push(i),
            Err(e) => errors.push(format!("{}: {e}", f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())),
        }
    }
    json!({"added": added, "errors": errors})
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.split(',').next_back()?;
    let mut map = [255u8; 256];
    for (i, c) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().enumerate() {
        map[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut buf, mut bits) = (0u32, 0);
    for c in s.bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = map[c as usize];
        if v == 255 {
            return None;
        }
        buf = buf << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

#[tauri::command]
async fn call(cmd: String, args: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || handle(&cmd, args.unwrap_or(json!({}))))
        .await
        .map_err(|e| e.to_string())?
}

fn header<'a>(req: &'a tauri::ipc::Request<'_>, k: &str) -> &'a str {
    req.headers().get(k).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// One raw RGBA frame of an animated export (body = bytes; headers: id, delay).
#[tauri::command]
fn export_frame(request: tauri::ipc::Request<'_>) -> Result<usize, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected raw frame bytes".into()) };
    let id: u64 = header(&request, "x-id").parse().map_err(|_| "bad id")?;
    let delay: u32 = header(&request, "x-delay").parse().unwrap_or(100);
    export::add_frame(id, data.clone(), delay)
}

/// A finished still image (PNG/JPEG bytes). Headers: x-name (url-encoded), x-ext.
#[tauri::command]
async fn save_still(request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("expected image bytes".into()) };
    let name = urlencoding::decode(header(&request, "x-name")).map(|s| s.to_string()).unwrap_or_default();
    let ext = match header(&request, "x-ext") {
        "jpg" => "jpg",
        _ => "png",
    };
    export::save_still(data, &name, ext)
}

// ---------- windows ----------

fn geometry_file() -> PathBuf {
    settings::app_file("window_state.json")
}

fn save_geometry(w: &WebviewWindow) {
    let max = w.is_maximized().unwrap_or(false);
    let mut g: Value = std::fs::read_to_string(geometry_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    g["max"] = json!(max);
    if !max && !w.is_minimized().unwrap_or(false) {
        if let (Ok(p), Ok(sz)) = (w.outer_position(), w.inner_size()) {
            g["x"] = json!(p.x);
            g["y"] = json!(p.y);
            g["w"] = json!(sz.width);
            g["h"] = json!(sz.height);
        }
    }
    let _ = settings::write_atomic(&geometry_file(), g.to_string().as_bytes());
}

/// Hides a window and lets its web view sleep.
fn put_away(w: &WebviewWindow) {
    let _ = w.eval("window.__quickHidden && window.__quickHidden()"); // the quick window stops its preview loop
    let _ = w.hide();
    sleep::later(w, std::time::Duration::from_secs(5));
}

pub fn open_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let was_hidden = !w.is_visible().unwrap_or(true);
        sleep::wake(&w);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if was_hidden {
            // It may have missed library changes while asleep.
            let _ = app.emit_to("main", "library-changed", json!({}));
        }
        return;
    }
    let (mut lw, mut lh) = (1440.0_f64, 900.0_f64);
    if let Ok(Some(m)) = app.primary_monitor() {
        let sz = m.size().to_logical::<f64>(m.scale_factor());
        lw = lw.min(sz.width * 0.9);
        lh = lh.min(sz.height * 0.88);
    }
    let Ok(w) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("MemeForge")
        .min_inner_size(980.0, 620.0)
        .inner_size(lw, lh)
        .center()
        .decorations(false)
        .visible(false)
        .disable_drag_drop_handler()
        .background_color(tauri::webview::Color(12, 12, 16, 255))
        .build()
    else {
        return;
    };
    let g: Value = std::fs::read_to_string(geometry_file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    if let (Some(x), Some(y), Some(gw), Some(gh)) = (g["x"].as_i64(), g["y"].as_i64(), g["w"].as_u64(), g["h"].as_u64()) {
        let on_screen = w.available_monitors().unwrap_or_default().iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            let (cx, cy) = (x as i32 + 120, y as i32 + 40);
            cx >= p.x && cy >= p.y && cx < p.x + s.width as i32 && cy < p.y + s.height as i32
        });
        if on_screen && gw >= 600 && gh >= 400 {
            let _ = w.set_size(tauri::PhysicalSize::new(gw as u32, gh as u32));
            let _ = w.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
        }
    }
    if g["max"].as_bool() == Some(true) {
        let _ = w.maximize();
    }
    let w2 = w.clone();
    w.on_window_event(move |ev| {
        if let WindowEvent::Focused(true) = ev {
            sleep::focused(&w2);
        }
        if let WindowEvent::CloseRequested { api, .. } = ev {
            save_geometry(&w2);
            if settings::load().close_to_tray {
                api.prevent_close();
                put_away(&w2);
            }
        }
    });
    // shown by the page once it has painted, to avoid a white flash
}

fn build_quick(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window("quick") {
        return Some(w);
    }
    WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("quick.html".into()))
        .title("Quick meme")
        .inner_size(860.0, 560.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .shadow(true)
        .disable_drag_drop_handler()
        .build()
        .ok()
}

fn toggle_quick(app: &AppHandle) {
    let Some(w) = build_quick(app) else { return };
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        put_away(&w);
        return;
    }
    sleep::wake(&w);
    // centre it on the monitor the mouse is on
    if let Ok(pos) = app.cursor_position() {
        if let Ok(mons) = app.available_monitors() {
            if let Some(m) = mons.iter().find(|m| {
                let (p, s) = (m.position(), m.size());
                pos.x >= p.x as f64 && pos.y >= p.y as f64 && pos.x < (p.x + s.width as i32) as f64 && pos.y < (p.y + s.height as i32) as f64
            }) {
                let sz = w.outer_size().unwrap_or(tauri::PhysicalSize::new(860, 560));
                let x = m.position().x + (m.size().width as i32 - sz.width as i32) / 2;
                let y = m.position().y + (m.size().height as i32 - sz.height as i32) * 2 / 5;
                let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    }
    let _ = w.show();
    let _ = w.set_focus();
    let _ = w.eval("window.__quickShown && window.__quickShown()");
}

fn register_hotkey(app: &AppHandle) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let s = settings::load();
    if !s.hotkey_enabled || s.hotkey.trim().is_empty() {
        return Ok(());
    }
    gs.register(s.hotkey.trim()).map_err(|e| format!("Couldn't use {} as the hotkey: {e}", s.hotkey))
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open_i = MenuItem::with_id(app, "open", "Open MemeForge", true, None::<&str>)?;
    let quick_i = MenuItem::with_id(app, "quick", "Quick meme", true, None::<&str>)?;
    let refresh_i = MenuItem::with_id(app, "refresh", "Refresh library", true, None::<&str>)?;
    let folder_i = MenuItem::with_id(app, "folder", "Open memes folder", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open_i, &quick_i, &refresh_i, &folder_i, &sep, &quit_i])?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id("tray")
        .icon(icon)
        .tooltip("MemeForge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => open_window(app),
            "quick" => toggle_quick(app),
            "refresh" => start_refresh(),
            "folder" => {
                let f = settings::load().save_folder;
                let _ = std::fs::create_dir_all(&f);
                let _ = open::that(f);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                open_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn background_jobs() {
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(8));
        loop {
            if sources::due() && !sources::RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
                start_refresh();
            }
            updater::daily_check(&|t, b| notify(t, b));
            std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
        }
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let tray_only = args.iter().any(|a| a == "--tray");
    if args.iter().any(|a| a == "--setup") {
        settings::set_autostart(settings::load().start_with_windows);
        return;
    }
    if args.iter().any(|a| a == "--remove-integration") {
        settings::set_autostart(false);
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _| {
            if !argv.iter().any(|a| a == "--tray") {
                open_window(app);
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed {
                        toggle_quick(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![call, export_frame, save_still])
        .register_uri_scheme_protocol("lib", |_ctx, req| serve_library(req.uri().path()))
        .setup(move |app| {
            let _ = APP.set(app.handle().clone());
            build_tray(app)?;
            if let Err(e) = register_hotkey(app.handle()) {
                eprintln!("{e}");
            }
            if !settings::load().first_run_done {
                let mut s = settings::load();
                s.first_run_done = true;
                let _ = settings::save(&s);
                settings::set_autostart(s.start_with_windows);
            }
            if !tray_only {
                open_window(app.handle());
            }
            // warm up the quick window so the hotkey opens it instantly
            let h = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(2500));
                let h2 = h.clone();
                let _ = h.run_on_main_thread(move || {
                    if let Some(w) = build_quick(&h2) {
                        if !w.is_visible().unwrap_or(true) {
                            // long enough for its page to load
                            sleep::later(&w, std::time::Duration::from_secs(20));
                        }
                    }
                });
            });
            background_jobs();
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("couldn't start MemeForge")
        .run(|_app, ev| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = ev {
                // closing the last window keeps the tray running; Quit passes a code
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

/// lib://localhost/<path under library/> - media and thumbnails for the page (CORS-open so
/// the editor can draw them on a canvas and still export it).
fn serve_library(path: &str) -> tauri::http::Response<Vec<u8>> {
    let rel = percent_encoding::percent_decode_str(path.trim_start_matches('/')).decode_utf8_lossy().to_string();
    let bad = rel.contains("..") || rel.contains(':') || rel.is_empty();
    let full = settings::library_dir().join(&rel);
    let resp = |code: u16, ct: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(code)
            .header("Content-Type", ct)
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "max-age=31536000, immutable")
            .body(body)
            .unwrap()
    };
    if bad {
        return resp(400, "text/plain", b"bad path".to_vec());
    }
    match std::fs::read(&full) {
        Ok(b) => {
            let ct = match full.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
                "gif" => "image/gif",
                "png" => "image/png",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                _ => "image/jpeg",
            };
            resp(200, ct, b)
        }
        Err(_) => resp(404, "text/plain", b"not found".to_vec()),
    }
}
