use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, State};

/// One pane's PTY: a writer for keystrokes, the master for resizing, and the
/// child handle so the pane can be killed on close.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    shell_pid: Option<u32>,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<u32, PtySession>>,
}

/// An output chunk for one pane, streamed to the frontend as `pty-output`.
/// Raw bytes (not a string) so xterm.js reassembles split UTF-8 sequences.
#[derive(Clone, Serialize)]
struct PtyOutput {
    id: u32,
    bytes: Vec<u8>,
}

/// Spawn a shell in a new PTY identified by `id`, sized to the pane's viewport.
/// Idempotent per id.
#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: State<AppState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(&id) {
        return Ok(());
    }

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let mut cmd = CommandBuilder::new(shell);
    // Spawn a login shell so it reads .zprofile/.profile (brew shellenv, etc.),
    // matching Terminal.app and iTerm2. Without this, launching the-wall from
    // Finder (where nothing is inherited) leaves Homebrew off PATH.
    cmd.arg("-l");
    cmd.env("TERM", "xterm-256color");
    // CommandBuilder seeds itself from our process environment, so the shell
    // would otherwise inherit the TERM_PROGRAM of whatever launched the-wall
    // (e.g. Apple_Terminal under `tauri dev`), which terminal-detection tools
    // like neofetch report. Identify ourselves instead.
    cmd.env("TERM_PROGRAM", "the-wall");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    // Give the session our own id rather than leaking (or dropping) the
    // launching terminal's. Tools like zsh-notify gate on TERM_SESSION_ID being
    // present, and setting it ourselves keeps that working even when the-wall
    // is launched from Finder, where nothing would be inherited.
    cmd.env("TERM_SESSION_ID", format!("the-wall:{id}"));
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let shell_pid = child.process_id();
    // Drop the slave so the master reader sees EOF once the shell exits.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app.emit("pty-exit", id);
                    break;
                }
                Ok(n) => {
                    let _ = app.emit(
                        "pty-output",
                        PtyOutput {
                            id,
                            bytes: buf[..n].to_vec(),
                        },
                    );
                }
            }
        }
    });

    sessions.insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
            shell_pid,
        },
    );
    Ok(())
}

/// Forward keystrokes into pane `id`'s PTY.
#[tauri::command]
fn write_pty(state: State<AppState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get_mut(&id) {
        s.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        s.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize pane `id`'s PTY (delivers SIGWINCH to the shell).
#[tauri::command]
fn resize_pty(state: State<AppState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(s) = sessions.get(&id) {
        s.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Kill pane `id`'s shell and drop its PTY.
#[tauri::command]
fn close_pty(state: State<AppState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

/// True if a foreground process other than the shell itself is running in the
/// pane — i.e. the PTY's foreground process group differs from the shell's pid.
#[tauri::command]
fn pane_busy(state: State<AppState>, id: u32) -> Result<bool, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    match sessions.get(&id) {
        Some(s) => match (s.master.process_group_leader(), s.shell_pid) {
            (Some(fg), Some(shell)) => Ok(fg as u32 != shell),
            _ => Ok(false),
        },
        None => Ok(false),
    }
}

/// The directory a pane is working in. A docked pane that has not been given a
/// name (⌘E) titles its strip with this directory's name, so the frontend reads
/// it once a second for the panes that are docked.
#[tauri::command]
fn pane_cwd(state: State<AppState>, id: u32) -> Result<Option<String>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get(&id) else {
        return Ok(None);
    };
    // The foreground process is asked first, and the shell only when there is
    // none: a subshell that has `cd`'d, or a server started from a directory
    // the shell has since left, is where the pane actually is. For an idle pane
    // the foreground process *is* the shell, so the two answers agree.
    let foreground = session.master.process_group_leader().map(|pid| pid as u32);
    Ok(foreground
        .and_then(cwd_of)
        .or_else(|| session.shell_pid.and_then(cwd_of)))
}

/// One process's working directory, or `None` when it cannot be read — the
/// process has gone, or the platform has no way to ask.
#[cfg(target_os = "macos")]
fn cwd_of(pid: u32) -> Option<String> {
    // proc_pidinfo(PROC_PIDVNODEPATHINFO) is how lsof reads another process's
    // cwd on macOS. It needs no entitlement for a process of our own uid, which
    // a pane's shell and everything it spawns are.
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut libc::proc_vnodepathinfo as *mut libc::c_void,
            size,
        )
    };
    // <= 0 when the process is gone or the lookup was refused; anything short of
    // the whole struct did not fill in the path.
    if written != size {
        return None;
    }
    // A fixed 1024-byte NUL-terminated buffer, which libc types as nested arrays
    // to stay compatible with old rustc versions. Read it as the bytes it is.
    let path = &info.pvi_cdir.vip_path;
    let bytes = unsafe {
        std::slice::from_raw_parts(path.as_ptr().cast::<u8>(), std::mem::size_of_val(path))
    };
    let end = bytes.iter().position(|&b| b == 0)?;
    (end > 0).then(|| String::from_utf8_lossy(&bytes[..end]).into_owned())
}

/// Linux keeps it in procfs. Anywhere else this reads as "not known", and a
/// docked pane is titled by its ⌘E name or nothing.
#[cfg(not(target_os = "macos"))]
fn cwd_of(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Opens a link a pane's program marked with OSC 8 (nvim does this for markdown
/// links) in the default browser. xterm.js's own handler asks `confirm()` first,
/// and WKWebView answers `false` without showing anything — wry implements no
/// confirm panel — so without this a click on a link does nothing. Only http(s),
/// matching what xterm.js turns into a link by default.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("not an http(s) link: {url}"));
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let mut child = std::process::Command::new(opener)
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    // Reap it off the main thread; `open` hands the URL over and exits.
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// When the app is launched for screenshot capture, `THE_WALL_DEMO` holds the
/// directory the demo panes should run in (the repo root, so commands like
/// `bat README.md` resolve). Returns `None` for a normal launch. See
/// `scripts/screenshot.sh` and `runDemo` in the frontend.
#[tauri::command]
fn demo_dir() -> Option<String> {
    std::env::var("THE_WALL_DEMO").ok().filter(|s| !s.is_empty())
}

/// `cargo test`, from `src-tauri`. `cwd_of` is the one thing in here that can be
/// checked without a window: everything else needs a pty, an app handle or both.
#[cfg(all(test, unix))]
mod tests {
    use super::cwd_of;

    /// Against the one process whose working directory is already known — ours.
    /// This is the FFI that the rest of the file cannot show is right by being
    /// read: the struct layout, the flavor constant, and where the path ends.
    #[test]
    fn reads_a_process_working_directory() {
        let here = std::env::current_dir().unwrap().canonicalize().unwrap();
        let got = cwd_of(std::process::id()).expect("our own working directory");
        assert_eq!(std::path::Path::new(&got), here);

        // A pid no process has reads as "not known" rather than as a directory.
        // macOS stops handing out pids well below this one.
        assert_eq!(cwd_of(i32::MAX as u32), None);
    }

    /// Every pid `pane_cwd` actually asks about belongs to someone else — a
    /// pane's shell, or whatever that shell is running — and reading another
    /// process is a different permission from reading our own.
    #[test]
    fn reads_another_process_working_directory() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg("sleep 30")
            .current_dir(&dir)
            .spawn()
            .expect("a child process to ask about");

        let got = cwd_of(child.id());
        let _ = child.kill();
        let _ = child.wait();

        assert_eq!(got.as_deref().map(std::path::Path::new), Some(dir.as_path()));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Minimal macOS menu: keep Quit / clipboard / Minimize, but omit
        // "Close Window" so its Cmd+W accelerator is free for closing a pane.
        .menu(|app| {
            let app_menu = Submenu::with_items(
                app,
                "the-wall",
                true,
                &[&PredefinedMenuItem::quit(app, None)?],
            )?;
            // Paste only: native Cmd+V pastes into xterm's textarea. Copy is
            // handled in JS (Cmd+C) because the canvas selection isn't a DOM
            // selection the OS can read.
            let edit_menu = Submenu::with_items(
                app,
                "Edit",
                true,
                &[&PredefinedMenuItem::paste(app, None)?],
            )?;
            let window_menu = Submenu::with_items(
                app,
                "Window",
                true,
                &[&PredefinedMenuItem::minimize(app, None)?],
            )?;
            Menu::with_items(app, &[&app_menu, &edit_menu, &window_menu])
        })
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_pty, write_pty, resize_pty, close_pty, pane_busy, pane_cwd, demo_dir, open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
