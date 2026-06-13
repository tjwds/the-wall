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

/// When the app is launched for screenshot capture, `THE_WALL_DEMO` holds the
/// directory the demo panes should run in (the repo root, so commands like
/// `bat README.md` resolve). Returns `None` for a normal launch. See
/// `scripts/screenshot.sh` and `runDemo` in the frontend.
#[tauri::command]
fn demo_dir() -> Option<String> {
    std::env::var("THE_WALL_DEMO").ok().filter(|s| !s.is_empty())
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
            spawn_pty, write_pty, resize_pty, close_pty, pane_busy, demo_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
