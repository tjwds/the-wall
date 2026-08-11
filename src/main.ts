import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import "@xterm/xterm/css/xterm.css";
import {
  applyShrink,
  computeLayout,
  computeLayoutWithDock,
  type LayoutName,
  type Rect,
} from "./layout";
import {
  applyRules,
  DOT_FILLED,
  scanChunk,
  STATE_WORD,
  stateOf,
  uptimeText,
  type ServerState,
} from "./server-state";
import { contentRows, stripTop } from "./strip";

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

/** The elements of a docked pane's status header (see stripHead). */
interface StripHead {
  el: HTMLDivElement;
  dot: HTMLElement;
  name: HTMLElement;
  state: HTMLElement;
  port: HTMLElement;
  up: HTMLElement;
  kb: HTMLElement;
}

interface Pane {
  id: number;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  badge: HTMLDivElement;
  name: string;
  nameEl: HTMLDivElement;
  shrunk: boolean; // ⌘0: capped to SHRUNK_ROWS lines, column-mates fill the rest
  // ⌘D (server mode): out of the tiling grid, into the dock along the bottom.
  docked: boolean;
  head: StripHead;
  keptRows: number; // rows the terminal holds while docked — it is clipped, not resized
  stripRows: number; // how many of them the strip is tall enough to show
  cellH: number; // measured cell height, for the clip offset
  padTop: number; // the terminal's top padding, above its first row
  padBot: number; // and below its last, which the strip clips away too
  // Current offset and clip, so a chunk of output only writes styles on a change.
  clipOffset: number;
  clipInset: string;
  alive: boolean; // false once the pty exits; a docked pane outlives its shell
  running: boolean; // a foreground process holds the pty (pane_busy)
  ranOnce: boolean; // one has held it at some point, so "exited" means something
  startedAt: number | null; // when it took over, for uptime
  matched: ServerState | null; // last state the output matched
  port: number | null;
  decoder: TextDecoder; // for the state/port rules; xterm gets the raw bytes
  carry: string; // trailing partial line, held back until it is complete
}

// Height, in rows, of a pane shrunk with ⌘0.
const SHRUNK_ROWS = 10;

// Server mode (⌘D). A docked pane shows DOCK_ROWS rows under its header, and
// PEEK_ROWS while it is focused; MIN_STRIP_COLS is the narrowest strip worth
// drawing, past which the dock wraps to a second row.
const DOCK_ROWS = 3;
const PEEK_ROWS = 18;
const MIN_STRIP_COLS = 40;

// How long a visual bell lingers on the already-focused pane before fading.
const BELL_FLASH_MS = 1500;
// Pending fade timers for visual bells, keyed by pane id (see flagBell).
const bellTimers = new Map<number, number>();

const workspace = document.getElementById("workspace") as HTMLDivElement;
const panes = new Map<number, Pane>();
const layouts: LayoutName[] = ["grid", "master"];
let layoutIndex = 0;
let focusedId: number | null = null;
// The last tiled pane to hold focus. Focusing a docked pane peeks it rather
// than rearranging the grid, so the master column stays where it was.
let masterId: number | null = null;
let nextId = 1;
let modalOpen = false;
let renaming = false;

const paneList = (): Pane[] => [...panes.values()];

function focusedIndex(): number {
  const i = paneList().findIndex((p) => p.id === focusedId);
  return i === -1 ? 0 : i;
}

/** The css cell size xterm is rendering at — the same numbers FitAddon divides
    by. Null before the terminal has measured its cell (no reliable size yet). */
function cellSize(pane: Pane): { w: number; h: number } | null {
  const cell = (pane.term as any)._core?._renderService?.dimensions?.css?.cell;
  if (!cell || !(cell.width > 0) || !(cell.height > 0)) return null;
  return { w: cell.width, h: cell.height };
}

/** The chrome a pane wraps around its terminal's rows: borders plus the
    .xterm padding, plus the strip header once the pane is docked. Read off the
    elements rather than hardcoded, so the css stays the single source. */
function chromePx(pane: Pane): { v: number; h: number } | null {
  const xterm = pane.term.element;
  if (!xterm) return null;
  const el = getComputedStyle(pane.el);
  const pad = getComputedStyle(xterm);
  const head = pane.docked ? pane.head.el.offsetHeight : 0;
  return {
    v:
      parseFloat(el.borderTopWidth) +
      parseFloat(el.borderBottomWidth) +
      parseFloat(pad.paddingTop) +
      parseFloat(pad.paddingBottom) +
      head,
    h:
      parseFloat(el.borderLeftWidth) +
      parseFloat(el.borderRightWidth) +
      parseFloat(pad.paddingLeft) +
      parseFloat(pad.paddingRight),
  };
}

/** Pixel height that makes a pane's terminal render exactly SHRUNK_ROWS rows.
    Inverts FitAddon's rows = floor((paneHeight − borders − padding) / cellHeight),
    reading the same cell height FitAddon divides by. Returns null before the
    terminal has measured its cell (no reliable height yet). */
function shrunkHeightPx(pane: Pane): number | null {
  const cell = cellSize(pane);
  const chrome = chromePx(pane);
  if (!cell || !chrome) return null;
  // +0.5 so float error in the division never floors down to SHRUNK_ROWS − 1.
  return SHRUNK_ROWS * cell.h + chrome.v + 0.5;
}

/** Pixel height of a docked strip showing `rows` terminal rows: its header and
    padding, plus the rows themselves. The inverse of stripRowsIn. */
function stripHeightPx(pane: Pane, rows: number): number | null {
  const cell = cellSize(pane);
  const chrome = chromePx(pane);
  if (!cell || !chrome) return null;
  return rows * cell.h + chrome.v + 0.5;
}

/** How many terminal rows a strip `h` pixels tall has room for. */
function stripRowsIn(pane: Pane, h: number): number {
  const cell = cellSize(pane);
  const chrome = chromePx(pane);
  if (!cell || !chrome) return DOCK_ROWS;
  return Math.max(1, Math.floor((h - chrome.v) / cell.h));
}

/** Pixel width below which a strip stops being worth drawing and the dock wraps
    to another row. */
function minStripWidthPx(pane: Pane): number {
  const cell = cellSize(pane);
  const chrome = chromePx(pane);
  if (!cell || !chrome) return 0;
  return MIN_STRIP_COLS * cell.w + chrome.h;
}

/** Which pane the tiled layouts treat as focused. `master` gives it the master
    column, and a docked pane must not claim one — focusing a strip peeks it
    and leaves the grid alone — so focus on a docked pane falls back to the last
    tiled pane that held it. */
function tiledFocusIndex(list: Pane[]): number {
  const i = list.findIndex((p) => p.id === focusedId);
  if (i !== -1 && !list[i].docked) return i;
  return list.findIndex((p) => p.id === masterId);
}

/** Recompute every pane's geometry, re-fit it, and resize its PTY to match.
    Docked panes are the exception: they keep the row count they had when they
    docked and are clipped to the strip instead (see updateClip), so a running
    server sees a SIGWINCH only when the strip's width changes. */
function applyLayout(): void {
  const list = paneList();
  const W = workspace.clientWidth;
  const H = workspace.clientHeight;
  const dockRef = list.find((p) => p.docked);
  const stripPx = dockRef && W > 0 && H > 0 ? stripHeightPx(dockRef, DOCK_ROWS) : null;

  let rects =
    dockRef && stripPx != null
      ? computeLayoutWithDock(
          layouts[layoutIndex],
          list.map((p) => p.docked),
          tiledFocusIndex(list),
          stripPx / H,
          minStripWidthPx(dockRef) / W,
        )
      : computeLayout(layouts[layoutIndex], list.length, tiledFocusIndex(list));

  // Cap any shrunk panes to SHRUNK_ROWS lines; their column-mates fill the rest.
  // ⌘0 applies among the tiled panes only, so the docked ones are left out of
  // the column grouping entirely rather than passed in as unshrunk.
  const tiled = list.flatMap((p, i) => (p.docked ? [] : [i]));
  const shrunkPane = tiled.map((i) => list[i]).find((p) => p.shrunk);
  if (shrunkPane && H > 0) {
    const shPx = shrunkHeightPx(shrunkPane);
    if (shPx != null) {
      const grown = applyShrink(
        tiled.map((i) => rects[i]),
        tiled.map((i) => list[i].shrunk),
        shPx / H,
      );
      rects = rects.slice();
      tiled.forEach((i, k) => (rects[i] = grown[k]));
    }
  }

  list.forEach((pane, i) => {
    const peeking = pane.docked && pane.id === focusedId;
    const r = peeking ? peekRect(pane, rects[i], H) : rects[i];
    pane.el.style.left = `${r.x * W}px`;
    pane.el.style.top = `${r.y * H}px`;
    pane.el.style.width = `${r.w * W}px`;
    pane.el.style.height = `${r.h * H}px`;
    pane.el.classList.toggle("focused", pane.id === focusedId);
    pane.el.classList.toggle("solo", list.length === 1);
    pane.el.classList.toggle("peek", peeking);
    // ⌘1–9 focus panes by list index; later panes have no shortcut to show.
    // Docking does not reorder the list, so a pane keeps the number it had.
    pane.badge.textContent = `⌘${i + 1}`;
    pane.badge.hidden = i >= 9;
    pane.head.kb.textContent = i < 9 ? `⌘${i + 1}` : "";
    if (pane.docked) {
      fitDocked(pane, r.h * H);
    } else {
      pane.fit.fit();
      void invoke("resize_pty", { id: pane.id, cols: pane.term.cols, rows: pane.term.rows });
    }
  });
}

/** Where a focused strip draws: it grows upward out of the dock, over the grid,
    with its bottom edge staying put. Nothing else moves — the tiled panes are
    not re-fitted, and the other strips stay where they are. */
function peekRect(pane: Pane, r: Rect, H: number): Rect {
  // Never taller than the terminal it is showing. A pane docked out of a busy
  // grid kept fewer rows than PEEK_ROWS — docking the first of three servers
  // re-tiles the other two, so they dock from a 3-row grid at 16 rows, not 18 —
  // and a drawer taller than its own content is blank space under the tail.
  const px = stripHeightPx(pane, Math.min(PEEK_ROWS, pane.keptRows));
  if (px == null || H <= 0) return r;
  const h = Math.min(px / H, r.y + r.h); // never taller than the workspace
  return h <= r.h ? r : { x: r.x, y: r.y + r.h - h, w: r.w, h };
}

/** Size a docked pane's terminal. Its height is fixed at the row count it
    docked with; only a width change reaches the process, and then just once. */
function fitDocked(pane: Pane, heightPx: number): void {
  const cell = cellSize(pane);
  if (cell) pane.cellH = cell.h;
  if (pane.term.element) {
    const pad = getComputedStyle(pane.term.element);
    pane.padTop = parseFloat(pad.paddingTop) || 0;
    pane.padBot = parseFloat(pad.paddingBottom) || 0;
  }
  pane.stripRows = stripRowsIn(pane, heightPx);
  const cols = pane.fit.proposeDimensions()?.cols;
  if (cols && cols !== pane.term.cols) {
    pane.term.resize(cols, pane.keptRows);
    void invoke("resize_pty", { id: pane.id, cols, rows: pane.keptRows });
  }
  updateClip(pane);
}

/** Slide a docked terminal inside its strip so the rows worth seeing are the
    ones visible — the tail of its output, and the line being typed into if
    there is one (see stripTop). The terminal is not resized to do this, so the
    scrollback is never reflowed and peeking is a height change and nothing more.

    The terminal has to be clipped to the strip as well as offset, at both
    edges. The header only covers its own 20px, so without a clip at its lower
    edge the row above the first visible one shows through the padding gap
    beneath it as a sliver of cut-off text; the rows below the last visible one
    do the same thing against the strip's bottom edge. */
function updateClip(pane: Pane): void {
  const buf = pane.term.buffer.active;
  const top = stripTop(
    contentRows(pane.term.rows, (i) => buf.getLine(buf.baseY + i)?.translateToString(true) ?? ""),
    pane.stripRows,
    cursorRow(pane),
  );
  // Negative while the terminal has printed fewer rows than the strip can show:
  // the rows are pushed *down* so the last one still lands on the strip's bottom
  // edge. New output then always appears in the same place, and peeking reveals
  // history above the tail instead of walking the tail up the screen.
  const offset = top * pane.cellH;
  // Clip to the strip's own window, not to the bottom of the output: an
  // interactive program draws below its cursor, and those rows are as much
  // outside the strip as the scrollback above it.
  const bottom = Math.max(0, pane.term.rows - top - pane.stripRows) * pane.cellH + pane.padBot;
  const inset = `inset(${Math.max(0, offset) + pane.padTop}px 0 ${bottom}px 0)`;
  if (offset === pane.clipOffset && inset === pane.clipInset) return;
  pane.clipOffset = offset;
  pane.clipInset = inset;
  const xterm = pane.term.element;
  if (!xterm) return;
  xterm.style.transform = `translateY(${-offset}px)`;
  xterm.style.clipPath = inset;
}

/** Where the user is typing in a docked pane, for stripTop: the cursor's row,
    or null when the program has hidden the cursor (DECTCEM) and there is no
    such row. htop and a server drawing a spinner park a hidden cursor wherever
    their last write left it, which is not somewhere the strip should follow. */
function cursorRow(pane: Pane): number | null {
  const core = (pane.term as any)._core;
  if (core?._coreService?.isCursorHidden) return null;
  return pane.term.buffer.active.cursorY;
}

// --- The strip header --------------------------------------------------------
// A docked pane trades the corner name pill for a status line: state dot, name,
// state, then port, uptime and its ⌘N. Everything in it is derived — nothing
// asks the process anything it doesn't already say.

const SEED_LINES = 400; // how far back docking reads to seed state and port

/** Build the status header. Hidden by css until the pane is docked. */
function stripHead(): StripHead {
  const el = document.createElement("div");
  el.className = "strip-head";
  const span = (cls: string): HTMLElement => {
    const s = document.createElement("span");
    s.className = cls;
    el.appendChild(s);
    return s;
  };
  const dot = span("dot");
  const name = span("nm");
  const state = span("st");
  span("sp"); // spacer: everything after it is right-aligned
  const port = span("port");
  const up = span("up");
  const kb = span("kb");
  return { el, dot, name, state, port, up, kb };
}

/** Redraw a pane's header. Cheap enough to call on every tick of the poll. */
function renderHead(pane: Pane): void {
  const state = stateOf(pane);
  for (const s of Object.keys(STATE_WORD) as ServerState[]) {
    pane.el.classList.toggle(`s-${s}`, pane.docked && s === state);
  }
  pane.head.dot.classList.toggle("fill", DOT_FILLED.has(state));
  pane.head.name.textContent = pane.name;
  pane.head.state.textContent = STATE_WORD[state];
  pane.head.port.textContent = pane.port != null && pane.running ? `:${pane.port}` : "";
  pane.head.up.textContent = uptimeText(pane.startedAt, Date.now());
}

/** Decode a chunk of a docked pane's output and run the rules over it. The
    decoder is per-pane and streaming, so a multi-byte character split across two
    `pty-output` events is one character here too. */
function scanOutput(pane: Pane, bytes: Uint8Array): boolean {
  return scanChunk(pane, pane.decoder.decode(bytes, { stream: true }));
}

/** Seed state and port from what the pane already has on screen, so docking a
    server that came up ten minutes ago doesn't wait for its next line of
    output. Reads the parsed buffer, so there are no escape sequences in it. */
function seedState(pane: Pane): void {
  pane.matched = null;
  pane.port = null;
  const buf = pane.term.buffer.active;
  const lines: string[] = [];
  for (let i = Math.max(0, buf.length - SEED_LINES); i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? "");
  }
  applyRules(pane, lines);
}

// Whether a foreground process holds each pane, polled rather than pushed:
// there is no event for it, and it is what "uptime" counts from. Every pane is
// polled, not just the docked ones, so a server docked an hour after it started
// shows the hour rather than the moment it was docked.
const BUSY_POLL_MS = 1000;

async function pollBusy(): Promise<void> {
  await Promise.all(
    paneList().map(async (pane) => {
      if (!pane.alive) return;
      const busy = await invoke<boolean>("pane_busy", { id: pane.id }).catch(() => pane.running);
      if (busy !== pane.running) {
        pane.running = busy;
        pane.startedAt = busy ? Date.now() : null;
        if (busy) {
          pane.ranOnce = true;
        } else {
          // The process is gone, so what it said about itself no longer holds.
          // Only cleared here, on the way out: the poll notices a process up to
          // BUSY_POLL_MS after it started, and a server that says "✓ Ready in
          // 800ms" says it once — clearing on the way in would throw that line
          // away and leave the strip reading "starting" until the next compile.
          pane.matched = null;
          pane.port = null;
        }
      }
    }),
  );
  for (const pane of paneList()) if (pane.docked) renderHead(pane);
}
setInterval(() => void pollBusy(), BUSY_POLL_MS);

/** Mark a visual bell on a pane (xterm onBell). A bell in a background pane
    persists until that pane is focused (cleared in setFocus), like tmux's window
    highlight; a bell in the already-focused pane shows briefly, then fades. */
function flagBell(pane: Pane): void {
  pane.el.classList.add("bell");
  clearTimeout(bellTimers.get(pane.id));
  bellTimers.delete(pane.id);
  if (pane.id === focusedId) {
    bellTimers.set(
      pane.id,
      window.setTimeout(() => {
        bellTimers.delete(pane.id);
        pane.el.classList.remove("bell");
      }, BELL_FLASH_MS),
    );
  }
}

function clearBell(id: number): void {
  clearTimeout(bellTimers.get(id));
  bellTimers.delete(id);
  panes.get(id)?.el.classList.remove("bell");
}

function setFocus(id: number): void {
  clearBell(id); // looking at a pane clears its pending bell
  const left = focusedId != null ? panes.get(focusedId) : undefined;
  focusedId = id;
  const pane = panes.get(id);
  pane?.term.focus();
  if (pane && !pane.docked) masterId = id;
  // master changes geometry with focus, and a docked pane peeks when it takes
  // focus and drops back when it loses it; grid alone only restyles.
  if (layouts[layoutIndex] === "master" || pane?.docked || left?.docked) {
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

  // Status header for server mode; css hides it until the pane is docked.
  const head = stripHead();
  el.appendChild(head.el);

  const pane: Pane = {
    id,
    term,
    fit,
    el,
    badge,
    name: "",
    nameEl,
    shrunk: false,
    docked: false,
    head,
    keptRows: term.rows,
    stripRows: DOCK_ROWS,
    cellH: 0,
    padTop: 0,
    padBot: 0,
    clipOffset: 0,
    clipInset: "",
    alive: true,
    running: false,
    ranOnce: false,
    startedAt: null,
    matched: null,
    port: null,
    decoder: new TextDecoder(),
    carry: "",
  };
  panes.set(id, pane);
  term.onData((data) => void invoke("write_pty", { id, data }));
  term.onBell(() => flagBell(pane));
  // Which rows a strip shows moves with the output, so it is recomputed each
  // time a chunk has been parsed into the buffer. Not onRender: that fires from
  // the render service's "viewport changed" event, which a terminal being
  // written to steadily does not emit — a strip driven by it froze on the screen
  // it had when it docked, and only caught up when something re-laid out.
  term.onWriteParsed(() => {
    if (pane.docked) updateClip(pane);
  });
  el.addEventListener("mousedown", () => setFocus(id));

  focusedId = id;
  masterId = id;
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
      pane.head.name.textContent = pane.name; // a docked pane shows it in its header
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
  clearBell(id); // drop any pending fade timer for the closed pane
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
  if (masterId === id) masterId = paneList().find((p) => !p.docked)?.id ?? null;
  applyLayout();
  if (focusedId != null) {
    clearBell(focusedId); // the pane focus falls back to is now being viewed
    panes.get(focusedId)?.term.focus();
  }
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

/** Toggle whether a pane is shrunk to SHRUNK_ROWS lines (see applyShrink).
    Shrink is a rearrangement of the tiled panes, so a docked one ignores it. */
function toggleShrink(id: number): void {
  const pane = panes.get(id);
  if (!pane || pane.docked) return;
  pane.shrunk = !pane.shrunk;
  applyLayout();
}

/** Toggle server mode on a pane (⌘D). A docked pane leaves the tiling grid —
    the rest tile as if it had been closed — and reappears in the dock along the
    bottom edge as a strip DOCK_ROWS tall under a status header. Its ⌘N does not
    move: docking doesn't reorder the pane list. */
function toggleDock(id: number): void {
  const pane = panes.get(id);
  if (!pane) return;
  if (pane.docked) {
    // A pane only outlives its shell because it is docked (see the pty-exit
    // listener), so undocking a dead one is the close that was deferred.
    if (!pane.alive) {
      void closePane(id);
      return;
    }
    pane.docked = false;
    pane.el.classList.remove("docked", "peek");
    pane.clipOffset = 0;
    pane.clipInset = "";
    if (pane.term.element) {
      pane.term.element.style.transform = "";
      pane.term.element.style.clipPath = "";
    }
    if (pane.id === focusedId) masterId = id;
  } else {
    pane.docked = true;
    pane.shrunk = false; // ⌘0 applies among the tiled panes only
    pane.keptRows = pane.term.rows; // the height it keeps for as long as it is docked
    pane.decoder = new TextDecoder();
    pane.carry = "";
    pane.el.classList.add("docked"); // before applyLayout: the header is measured
    seedState(pane);
    if (masterId === id) masterId = paneList().find((p) => !p.docked)?.id ?? null;
  }
  applyLayout();
  renderHead(pane);
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
      case "d":
        if (focusedId != null) toggleDock(focusedId);
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

// --- Demo mode (README screenshot capture) -----------------------------------
// Active only when launched with THE_WALL_DEMO set to the repo dir (see the
// demo_dir command and scripts/screenshot.sh). Lays out a fixed set of panes
// running representative commands so the README screenshot is reproducible.
// Inert in normal use.
const DEMO_SIZE = { width: 1200, height: 800 };

/** Single-quote a string for safe interpolation into a shell command line. */
function shquote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Each demo pane gets a name (shown via the ⌘E corner pill) and a command. The
// first is the master (left) column; the rest stack on the right, top to bottom
// — mirroring the composition of the README shot. The cowsay message is
// single-quoted (shquote) so its "!" isn't taken as zsh history expansion.
const DEMO_PANES = [
  { name: "readme", cmd: "bat --paging=never --style=plain README.md" },
  { name: "cowsay", cmd: `cowsay -s ${shquote("Tryin'a make it through the wall!")}` },
  { name: "system", cmd: "neofetch" },
];
// Readiness gating for "typing" into the demo shells (see runDemo): wait for the
// PTY output stream to fall quiet this long, capped by the overall timeout.
const SHELL_READY_TIMEOUT_MS = 6000;
const SHELL_QUIET_MS = 700;

// PTY-output bookkeeping for the readiness check: which panes have produced any
// output (shell started) and when output last arrived. Set by the pty-output
// listener; read by runDemo.
const seenOutput = new Set<number>();
let lastOutputAt = 0;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Build the fixed demo layout for the README screenshot: a master column plus
    a right-hand stack. Each pane is named and, once its shell is ready, cd'd
    into `dir` (so repo-relative commands resolve) and cleared, so only the
    command's output shows — not the cd or the typed command line. */
async function runDemo(dir: string): Promise<void> {
  // Resize/center for a consistent frame, but never let a failure here (e.g. a
  // missing window capability) abort the demo and leave a blank window.
  try {
    const win = getCurrentWindow();
    await win.setSize(new LogicalSize(DEMO_SIZE.width, DEMO_SIZE.height));
    await win.center();
  } catch (e) {
    console.error("demo: window resize failed", e);
  }
  layoutIndex = layouts.indexOf("master"); // first pane becomes the master column

  for (const { name } of DEMO_PANES) {
    await createPane();
    const pane = paneList()[panes.size - 1]; // the pane just created
    pane.name = name; // showcase pane naming (⌘E) in the corner pill
    pane.nameEl.textContent = name;
  }
  const list = paneList();

  // Typing before zsh's line editor initializes makes the command echo twice
  // (raw tty echo, then the editor redrawing) and can mangle quoting. Wait until
  // every shell has produced output AND the stream has gone quiet — proof the
  // prompts are drawn and the editors are idle — capped so a chatty prompt
  // (e.g. a clock) can't stall the demo indefinitely.
  const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const allStarted = list.every((p) => seenOutput.has(p.id));
    if (allStarted && Date.now() - lastOutputAt >= SHELL_QUIET_MS) break;
    await delay(50);
  }

  list.forEach((pane, i) => {
    void invoke("write_pty", {
      id: pane.id,
      data: `cd ${shquote(dir)} && clear && ${DEMO_PANES[i].cmd}\n`,
    });
  });

  setFocus(list[0].id); // focus the first pane so it's the master column
}

(async () => {
  await listen<{ id: number; bytes: number[] }>("pty-output", ({ payload }) => {
    seenOutput.add(payload.id); // shell has started (demo readiness signal)
    lastOutputAt = Date.now(); // for the demo's quiet-stream readiness check
    const pane = panes.get(payload.id);
    if (!pane) return;
    const bytes = new Uint8Array(payload.bytes);
    pane.term.write(bytes);
    // The state and port rules run for docked panes only — a tiled pane has no
    // header to show them in, and docking seeds itself from the buffer.
    if (pane.docked && scanOutput(pane, bytes)) renderHead(pane);
  });
  await listen<number>("pty-exit", ({ payload: id }) => {
    const pane = panes.get(id);
    if (!pane) return;
    // A docked pane keeps its strip and its scrollback when its shell goes, so
    // a server that died is still on screen saying so rather than silently
    // back in the grid. ⌘W closes it; ⌘D does too, being the deferred close.
    if (pane.docked) {
      pane.alive = false;
      pane.running = false;
      pane.startedAt = null;
      pane.port = null;
      renderHead(pane);
      return;
    }
    void closePane(id);
  });
  const demoDir = await invoke<string | null>("demo_dir").catch(() => null);
  if (demoDir) await runDemo(demoDir);
  else await createPane();
})();

