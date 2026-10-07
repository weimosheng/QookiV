// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::path::{Path, PathBuf};

use base64::Engine as _;
use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Creates the parent directory of `path` when it is missing.
fn create_parent_dir(path: &Path) -> std::io::Result<()> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => std::fs::create_dir_all(parent),
        _ => Ok(()),
    }
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    create_parent_dir(&target).map_err(|e| e.to_string())?;
    std::fs::write(&target, contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    create_parent_dir(&target).map_err(|e| e.to_string())?;
    std::fs::write(&target, data).map_err(|e| e.to_string())
}

/// Writes a base64 payload as binary, decoding on the Rust side.
///
/// Large artefacts — an exported MP4, an inlined screenshot — must not cross IPC
/// as one JSON number per byte: that is orders of magnitude slower and can exhaust
/// memory before the write even starts.
#[tauri::command]
fn write_base64_file(path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| e.to_string())?;
    let target = PathBuf::from(&path);
    create_parent_dir(&target).map_err(|e| e.to_string())?;
    std::fs::write(&target, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_binary_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn copy_file(src: String, dest: String) -> Result<(), String> {
    let target = PathBuf::from(&dest);
    create_parent_dir(&target).map_err(|e| e.to_string())?;
    std::fs::copy(&src, &target).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn path_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|metadata| metadata.len())
        .map_err(|e| e.to_string())
}

/// Reveals `path` in the platform file manager, selecting the file when supported.
#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    reveal_path(&target).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn reveal_path(target: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;

    // Explorer expects the switch and the path glued together inside a single set
    // of quotes: `explorer.exe /select,"C:\dir with spaces\clip.mp4"`.
    // `raw_arg` lets us emit that command line verbatim instead of letting Rust
    // re-quote (and thereby escape) the embedded quotes.
    let mut command = std::process::Command::new("explorer");
    command.raw_arg(format!("/select,\"{}\"", target.display()));
    command.spawn().map(|_| ())
}

#[cfg(target_os = "macos")]
fn reveal_path(target: &Path) -> std::io::Result<()> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(target)
        .spawn()
        .map(|_| ())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn reveal_path(target: &Path) -> std::io::Result<()> {
    // No portable "reveal and select" flag; open the containing directory instead.
    let directory = match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => target.to_path_buf(),
    };
    std::process::Command::new("xdg-open")
        .arg(directory)
        .spawn()
        .map(|_| ())
}

/// Percent-encodes `input` exactly like JavaScript's `encodeURIComponent`, which
/// leaves `A-Z a-z 0-9 - _ . ! ~ * ' ( )` untouched.
fn encode_uri_component(input: &str) -> String {
    const UNRESERVED: &[u8] = b"-_.!~*'()";

    let mut encoded = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        if byte.is_ascii_alphanumeric() || UNRESERVED.contains(byte) {
            encoded.push(*byte as char);
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

/// Mirrors `tauri::Webview::convert_file_src` for the case where no webview is
/// available yet.
fn asset_url_without_webview(path: &str) -> String {
    let encoded = encode_uri_component(path);
    if cfg!(windows) || cfg!(target_os = "android") {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

/// Converts an absolute OS path into a URL the webview can load (`asset:` protocol).
///
/// Tauri v2 has no `Manager::convert_file_src`: the Rust equivalent of the
/// JavaScript `convertFileSrc` lives on the webview itself
/// (`Webview::convert_file_src` / `WebviewWindow::convert_file_src`), so the
/// command resolves the calling window first.
#[tauri::command]
fn to_asset_url(path: String, app: tauri::AppHandle) -> Result<String, String> {
    let webview = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());

    match webview {
        Some(webview) => webview
            .convert_file_src(&path, None)
            .map_err(|e| e.to_string()),
        None => Ok(asset_url_without_webview(&path)),
    }
}

/// Minimal media metadata probe: existence plus byte length.
#[tauri::command]
fn probe_media(path: String) -> Result<serde_json::Value, String> {
    let target = Path::new(&path);
    let exists = target.exists();
    let bytes = if exists {
        std::fs::metadata(target)
            .map(|metadata| metadata.len())
            .unwrap_or(0)
    } else {
        0
    };

    Ok(serde_json::json!({
        "exists": exists,
        "bytes": bytes,
    }))
}

/// Path to the on-disk autosave draft: `<app_data_dir>/autosave/draft.json`.
fn autosave_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("autosave").join("draft.json"))
}

#[tauri::command]
fn write_autosave_file(contents: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = autosave_path(&app)?;
    create_parent_dir(&path).map_err(|e| e.to_string())?;
    std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_autosave_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = autosave_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_autosave_file(app: tauri::AppHandle) -> Result<(), String> {
    let path = autosave_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Path to the recent-projects list: `<app_data_dir>/recent.json`.
fn recent_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("recent.json"))
}

#[tauri::command]
fn write_recent_file(contents: String, app: tauri::AppHandle) -> Result<(), String> {
    let path = recent_path(&app)?;
    create_parent_dir(&path).map_err(|e| e.to_string())?;
    std::fs::write(&path, contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_recent_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = recent_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            read_text_file,
            write_text_file,
            write_binary_file,
            write_base64_file,
            read_binary_base64,
            copy_file,
            ensure_dir,
            path_exists,
            file_size,
            reveal_in_explorer,
            to_asset_url,
            probe_media,
            write_autosave_file,
            read_autosave_file,
            clear_autosave_file,
            write_recent_file,
            read_recent_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
