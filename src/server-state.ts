// The half of server mode (⌘D) that isn't the DOM: what a docked pane's status
// header says, and the rules that read it out of the pane's output. It lives
// apart from main.ts for the same reason layout.ts does — it is string and
// number work with no window in it, so test/server-state.test.ts can check the
// rules against real dev-server output. The rules are also the part of this
// feature most likely to need extending, and this is the file to extend.

/** What a docked server is doing, as its strip header spells it out. Derived
    from whether a foreground process holds the pty (pane_busy) and, while one
    does, from the output it prints (STATE_RULES). */
export type ServerState = "idle" | "starting" | "building" | "ready" | "error" | "exited";

/** What each state is called, and whether its dot is filled. Hollow for the
    states that aren't serving — idle, starting, exited — so the distinction
    survives without colour. */
export const STATE_WORD: Record<ServerState, string> = {
  idle: "idle",
  starting: "starting",
  building: "building",
  ready: "ready",
  error: "error",
  exited: "exited",
};
export const DOT_FILLED = new Set<ServerState>(["building", "ready", "error"]);

/** Which line of output means what. A table, not a protocol: these are the
    shapes Next.js and friends print, and a server that matches none of them
    still shows starting/exited, its uptime and its tail — which is the point of
    the mode. Rules are tried in order; the last line to match a rule wins. */
export const STATE_RULES: { re: RegExp; state: ServerState }[] = [
  {
    re: /^\s*[⨯✖✘]|^\s*error\b|\b(?:failed to compile|type error|module not found|syntaxerror)\b/i,
    state: "error",
  },
  { re: /\bcompiling\b|^\s*building\b/i, state: "building" },
  {
    re: /^\s*[✓✔]\s*(?:ready|compiled)\b|\bready\s+in\b|^\s*(?:listening|serving)\b|\blocal:\s+https?:\/\//i,
    state: "ready",
  },
];

/** The port a server announces. Scraped from the output rather than asked of
    the OS, so it only knows what the process chose to print. */
export const PORT_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b|\bport\s+(\d{2,5})\b/i;

// Escape sequences arrive interleaved with the text; xterm parses them, the
// rules just need them gone. Enough of CSI/OSC/two-byte escapes to leave plain
// lines behind.
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x0c\x0e-\x1f]/g;
const MAX_CARRY = 2048; // cap on a partial line held back between chunks

/** The output-derived part of a docked pane's header: the last state a line
    matched, the port the process announced, and the trailing partial line held
    back until it is complete. A Pane satisfies this. */
export interface OutputState {
  matched: ServerState | null;
  port: number | null;
  carry: string;
}

/** Run the state and port rules over freshly printed lines. */
export function applyRules(s: OutputState, lines: string[]): void {
  for (const line of lines) {
    const rule = STATE_RULES.find((r) => r.re.test(line));
    if (rule) s.matched = rule.state;
    const m = PORT_RE.exec(line);
    if (m) s.port = Number(m[1] ?? m[2]);
  }
}

/** Feed a chunk of a docked pane's output to the rules, and say whether the
    header now reads differently — output arrives far more often than a server
    changes state. A partial last line is held back rather than matched twice, so
    "…Type err" + "or:" reads as one line and a later "✓ Ready" is not overruled
    by re-reading it. */
export function scanChunk(s: OutputState, chunk: string): boolean {
  const wasState = s.matched;
  const wasPort = s.port;
  const text = s.carry + chunk.replace(ANSI_RE, "");
  const nl = text.lastIndexOf("\n");
  s.carry = nl === -1 ? text.slice(-MAX_CARRY) : text.slice(nl + 1).slice(-MAX_CARRY);
  if (nl !== -1) applyRules(s, text.slice(0, nl).split("\n"));
  return s.matched !== wasState || s.port !== wasPort;
}

/** A docked pane's state, in the order it is knowable: a pane whose shell has
    gone has exited whatever else it says, a pane with nothing in the foreground
    is between commands, and one with a process in it says what that process
    last printed — or "starting", until it prints something recognisable. */
export function stateOf(pane: {
  alive: boolean;
  running: boolean;
  ranOnce: boolean;
  matched: ServerState | null;
}): ServerState {
  if (!pane.alive) return "exited";
  if (!pane.running) return pane.ranOnce ? "exited" : "idle";
  return pane.matched ?? "starting";
}

/** What a docked pane's strip calls itself: the name it was given with ⌘E, or —
    if it was never given one — the name of the directory it is working in. A
    pane is docked for what it is running, and what it is running is usually
    named after the directory it runs in, so three docked servers read as three
    project names with nothing typed. ⌘E wins wherever it is set, and clearing a
    name goes back to the directory.

    `cwd` is an absolute path (the pane_cwd command), or null when it could not
    be read; the name is its last component. The root directory has no last
    component and no other name, so it is "/". */
export function stripTitle(pane: { name: string; cwd: string | null }): string {
  if (pane.name) return pane.name;
  if (!pane.cwd) return "";
  const dir = pane.cwd.replace(/\/+$/, "");
  return dir === "" ? "/" : dir.slice(dir.lastIndexOf("/") + 1);
}

/** "3s", "58m", "1h 12m" — the time since a process took the pane over. */
export function uptimeText(startedAt: number | null, now: number): string {
  if (startedAt == null) return "—";
  const s = Math.floor((now - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
