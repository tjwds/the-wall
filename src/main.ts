import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { computeLayout, type LayoutName } from "./layout";

// Iceberg (dark) — https://cocopon.github.io/iceberg.vim/
const TERM_OPTIONS: ITerminalOptions = {
  fontFamily: '"Fira Mono for Powerline", Menlo, monospace',
  fontSize: 13,
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
}

const workspace = document.getElementById("workspace") as HTMLDivElement;
const panes = new Map<number, Pane>();
const layouts: LayoutName[] = ["grid", "master"];
let layoutIndex = 0;
let focusedId: number | null = null;
let nextId = 1;
let modalOpen = false;

const paneList = (): Pane[] => [...panes.values()];

function focusedIndex(): number {
  const i = paneList().findIndex((p) => p.id === focusedId);
  return i === -1 ? 0 : i;
}

/** Recompute every pane's geometry, re-fit it, and resize its PTY to match. */
function applyLayout(): void {
  const list = paneList();
  const rects = computeLayout(layouts[layoutIndex], list.length, focusedIndex());
  const W = workspace.clientWidth;
  const H = workspace.clientHeight;
  list.forEach((pane, i) => {
    const r = rects[i];
    pane.el.style.left = `${r.x * W}px`;
    pane.el.style.top = `${r.y * H}px`;
    pane.el.style.width = `${r.w * W}px`;
    pane.el.style.height = `${r.h * H}px`;
    pane.el.classList.toggle("focused", pane.id === focusedId);
    pane.el.classList.toggle("solo", list.length === 1);
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

  const pane: Pane = { id, term, fit, el };
  panes.set(id, pane);
  term.onData((data) => void invoke("write_pty", { id, data }));
  el.addEventListener("mousedown", () => setFocus(id));

  focusedId = id;
  applyLayout(); // size the element first so fit() yields real cols/rows
  await invoke("spawn_pty", { id, cols: term.cols, rows: term.rows });
  term.focus();
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

// Cmd-prefixed shortcuts, intercepted in the capture phase so the focused
// terminal never receives them.
window.addEventListener(
  "keydown",
  (e) => {
    if (!e.metaKey || modalOpen) return;
    let handled = true;
    switch (e.key.toLowerCase()) {
      case "t":
      case "enter":
        void createPane();
        break;
      case "w":
        if (focusedId != null) void requestClose(focusedId);
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
