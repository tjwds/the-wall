import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { applyShrink, computeLayout, type LayoutName } from "./layout";

// Iceberg (dark) — https://cocopon.github.io/iceberg.vim/
const TERM_OPTIONS: ITerminalOptions = {
  fontFamily: '"Fira Mono for Powerline", Menlo, monospace',
  fontSize: 11,
  cursorBlink: true,
  scrollback: 5000,
  theme: {
    background: "#161821",
    foreground: "#c6c8d1",
    cursor: "#c6c8d1",
    cursorAccent: "#161821",
    selectionBackground: "#c6c8d1",
    selectionForeground: "#161821",
    black: "#1e2132",
    red: "#e27878",
    green: "#b4be82",
    yellow: "#e2a478",
    blue: "#84a0c6",
    magenta: "#a093c7",
    cyan: "#89b8c2",
    white: "#c6c8d1",
    brightBlack: "#6b7089",
    brightRed: "#e98989",
    brightGreen: "#c0ca8e",
    brightYellow: "#e9b189",
    brightBlue: "#91acd1",
    brightMagenta: "#ada0d3",
    brightCyan: "#95c4ce",
    brightWhite: "#d2d4de",
  },
};

interface Pane {
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  badge: HTMLDivElement;
  name: string;
  nameEl: HTMLDivElement;
  shrunk: boolean; // ⌘0: capped to SHRUNK_ROWS lines, column-mates fill the rest
}

// Height, in rows, of a pane shrunk with ⌘0.
const SHRUNK_ROWS = 10;

const workspace = document.getElementById("workspace") as HTMLDivElement;
const panes = new Map<number, Pane>();
const layouts: LayoutName[] = ["grid", "master"];
let layoutIndex = 0;
let focusedId: number | null = null;
let nextId = 1;
let modalOpen = false;
let renaming = false;

const paneList = (): Pane[] => [...panes.values()];

function focusedIndex(): number {
  const i = paneList().findIndex((p) => p.id === focusedId);
  return i === -1 ? 0 : i;
}

/** Pixel height that makes a pane's terminal render exactly SHRUNK_ROWS rows.
    Inverts FitAddon's rows = floor((paneHeight − borders − padding) / cellHeight),
    reading the same cell height FitAddon divides by. Returns null before the
    terminal has measured its cell (no reliable height yet). */
function shrunkHeightPx(pane: Pane): number | null {
  const cellH = (pane.term as any)._core?._renderService?.dimensions?.css?.cell?.height;
  const xterm = pane.term.element;
  if (!cellH || cellH <= 0 || !xterm) return null;
  const el = getComputedStyle(pane.el);
  const borderV = parseFloat(el.borderTopWidth) + parseFloat(el.borderBottomWidth);
  const pad = getComputedStyle(xterm);
  const padV = parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  // +0.5 so float error in the division never floors down to SHRUNK_ROWS − 1.
  return SHRUNK_ROWS * cellH + padV + borderV + 0.5;
}

/** Recompute every pane's geometry, re-fit it, and resize its PTY to match. */
function applyLayout(): void {
  const list = paneList();
  let rects = computeLayout(layouts[layoutIndex], list.length, focusedIndex());
  const W = workspace.clientWidth;
  const H = workspace.clientHeight;
  // Cap any shrunk panes to SHRUNK_ROWS lines; their column-mates fill the rest.
  const shrunkPane = list.find((p) => p.shrunk);
  if (shrunkPane && H > 0) {
    const shPx = shrunkHeightPx(shrunkPane);
    if (shPx != null) rects = applyShrink(rects, list.map((p) => p.shrunk), shPx / H);
  }
  list.forEach((pane, i) => {
    const r = rects[i];
    pane.el.style.left = `${r.x * W}px`;
    pane.el.style.top = `${r.y * H}px`;
    pane.el.style.width = `${r.w * W}px`;
    pane.el.style.height = `${r.h * H}px`;
    pane.el.classList.toggle("focused", pane.id === focusedId);
    pane.el.classList.toggle("solo", list.length === 1);
    // ⌘1–9 focus panes by list index; later panes have no shortcut to show.
    pane.badge.textContent = `⌘${i + 1}`;
    pane.badge.hidden = i >= 9;
    pane.fit.fit();
    void invoke("resize_pty", { id: pane.id, cols: pane.term.cols, rows: pane.term.rows });
  });
}

function setFocus(id: number): void {
  focusedId = id;
  panes.get(id)?.term.focus();
  // master/monocle change geometry with focus; grid only restyles.
  const name = layouts[layoutIndex];
  if (name === "master") {
    applyLayout();
  } else {
    paneList().forEach((p) => p.el.classList.toggle("focused", p.id === focusedId));
  }
}

async function createPane(): Promise<void> {
  const id = nextId++;
  const el = document.createElement("div");
  el.className = "pane";
  workspace.appendChild(el);

  const term = new Terminal(TERM_OPTIONS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // Shortcut hint, shown in the corner only while ⌘ is held (see show-shortcuts).
  const badge = document.createElement("div");
  badge.className = "pane-badge";
  el.appendChild(badge);

  // Optional user-set name, shown as tiny text in the same corner (⌘E to edit).
  const nameEl = document.createElement("div");
  nameEl.className = "pane-name";
  el.appendChild(nameEl);

  const pane: Pane = { id, term, fit, el, badge, name: "", nameEl, shrunk: false };
  panes.set(id, pane);
  term.onData((data) => void invoke("write_pty", { id, data }));
  el.addEventListener("mousedown", () => setFocus(id));

  focusedId = id;
  applyLayout(); // size the element first so fit() yields real cols/rows
  await invoke("spawn_pty", { id, cols: term.cols, rows: term.rows });
  term.focus();
}

/** Inline-edit the focused pane's name via a text field in its corner (⌘E).
    Enter commits, Escape cancels, and clicking away keeps what was typed. */
function startRename(id: number): void {
  const pane = panes.get(id);
  if (!pane || renaming) return;
  renaming = true;

  const input = document.createElement("input");
  input.className = "pane-name-input";
  input.value = pane.name;
  input.placeholder = "name…";
  input.maxLength = 40;
  pane.el.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (commit: boolean, refocus: boolean) => {
    if (done) return; // removing a focused input fires blur, which re-enters
    done = true;
    if (commit) {
      pane.name = input.value.trim();
      pane.nameEl.textContent = pane.name;
    }
    input.remove();
    renaming = false;
    if (refocus) pane.term.focus();
  };

  // The global ⌘ handler bails while renaming, so native editing keys (⌘A/C/V,
  // arrows) work; here we only handle Enter to commit and Escape to cancel.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false, true);
    }
  });
  // Clicking away commits the name but leaves focus wherever it went.
  input.addEventListener("blur", () => finish(true, false));
}

/** A themed, in-app confirm. Resolves true on "Close pane"/Enter, false otherwise. */
function askConfirm(message: string): Promise<boolean> {
  modalOpen = true;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal";
    const text = document.createElement("p");
    text.textContent = message;
    const buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.textContent = "Close pane";
    ok.dataset.variant = "danger";
    buttons.append(cancel, ok);
    modal.append(text, buttons);
    overlay.append(modal);
    document.body.append(overlay);

    const finish = (val: boolean) => {
      modalOpen = false;
      overlay.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === "Tab") {
        // Trap focus between the two buttons. Enter is left to the browser so
        // it activates whichever button is focused.
        e.preventDefault();
        e.stopPropagation();
        const order = [cancel, ok];
        const i = order.indexOf(document.activeElement as HTMLButtonElement);
        order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length].focus();
      }
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) finish(false);
    });
    window.addEventListener("keydown", onKey, true);
    ok.focus();
  });
}

/** Confirm before closing a pane that has a foreground process running. */
async function requestClose(id: number): Promise<void> {
  const busy = await invoke<boolean>("pane_busy", { id }).catch(() => false);
  if (busy && !(await askConfirm("A process is still running in this pane. Close it anyway?"))) {
    panes.get(id)?.term.focus(); // restore focus to the pane on cancel
    return;
  }
  await closePane(id);
}

async function closePane(id: number): Promise<void> {
  const pane = panes.get(id);
  if (!pane) return;
  const idx = paneList().findIndex((p) => p.id === id);

  panes.delete(id);
  pane.term.dispose();
  pane.el.remove();
  await invoke("close_pty", { id });

  if (panes.size === 0) {
    await createPane();
    return;
  }
  if (focusedId === id) {
    focusedId = paneList()[Math.min(idx, panes.size - 1)]?.id ?? null;
  }
  applyLayout();
  if (focusedId != null) panes.get(focusedId)?.term.focus();
}

function focusRelative(delta: number): void {
  const list = paneList();
  if (list.length === 0) return;
  const i = (focusedIndex() + delta + list.length) % list.length;
  setFocus(list[i].id);
}

function focusByIndex(i: number): void {
  const list = paneList();
  if (i >= 0 && i < list.length) setFocus(list[i].id);
}

function cycleLayout(): void {
  layoutIndex = (layoutIndex + 1) % layouts.length;
  applyLayout();
}

/** Toggle whether a pane is shrunk to SHRUNK_ROWS lines (see applyShrink). */
function toggleShrink(id: number): void {
  const pane = panes.get(id);
  if (!pane) return;
  pane.shrunk = !pane.shrunk;
  applyLayout();
}

// Cmd-prefixed shortcuts, intercepted in the capture phase so the focused
// terminal never receives them.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || modalOpen || renaming) return;
    let handled = true;
    switch (e.key.toLowerCase()) {
      case "t":
      case "enter":
        void createPane();
        break;
      case "w":
        if (focusedId != null) void requestClose(focusedId);
        break;
      case "e":
        if (focusedId != null) startRename(focusedId);
        break;
      case "j":
      case "]":
        focusRelative(1);
        break;
      case "k":
      case "[":
        focusRelative(-1);
        break;
      case "l":
        cycleLayout();
        break;
      case "0":
        if (focusedId != null) toggleShrink(focusedId);
        break;
      case "c": {
        const sel = focusedId != null ? panes.get(focusedId)?.term.getSelection() : "";
        if (sel) void navigator.clipboard?.writeText(sel);
        break;
      }
      default:
        if (/^[1-9]$/.test(e.key)) focusByIndex(Number(e.key) - 1);
        else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

// Reveal each pane's ⌘N hint once ⌘ has been held for SHORTCUT_HINT_DELAY, so a
// quick ⌘-key chord (e.g. ⌘1) doesn't flash them. Clear on key-up and on blur,
// so the hints never stick if ⌘ is released while the window isn't focused.
const SHORTCUT_HINT_DELAY = 750;
let shortcutHintTimer: number | undefined;

function hideShortcuts(): void {
  clearTimeout(shortcutHintTimer);
  shortcutHintTimer = undefined;
  workspace.classList.remove("show-shortcuts");
}
window.addEventListener("keydown", (e) => {
  // keydown repeats while ⌘ is held; only arm the timer on the first press.
  if (e.key === "Meta" && !e.repeat && !modalOpen && shortcutHintTimer === undefined) {
    shortcutHintTimer = window.setTimeout(() => {
      workspace.classList.add("show-shortcuts");
    }, SHORTCUT_HINT_DELAY);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Meta") hideShortcuts();
});
window.addEventListener("blur", hideShortcuts);

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    applyLayout();
  });
});

(async () => {
  await listen<{ id: number; bytes: number[] }>("pty-output", ({ payload }) => {
    panes.get(payload.id)?.term.write(new Uint8Array(payload.bytes));
  });
  await listen<number>("pty-exit", ({ payload: id }) => {
    if (panes.has(id)) void closePane(id);
  });
  await createPane();
})();
