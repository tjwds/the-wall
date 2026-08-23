# Server mode

A pane mode for long-running dev servers: keep them visible, stop them taking a
tiled pane's worth of space. Wireframes are in [`server-mode.html`](./server-mode.html) —
open it in a browser, or run `npm run wireframes -- <outdir>` to render one PNG
per frame (add frame ids — `… <outdir> f4` — to re-render just those).

This is the design the wireframes draw, the arithmetic behind the numbers on
them, and what the code does — <kbd>⌘D</kbd> is implemented. "Decisions" at the
end records how each open question was settled, and what was left out.

## The situation

Three Next.js dev servers and six shells is nine panes. `computeLayout("grid", 9)`
is a 3×3, so all nine get the same rectangle. At the app's 1200×800 window that
is 400×257px each, which FitAddon turns into 57×18.

The servers spend the day showing three useful things — a compile line, a request
line, and whether they are still alive. They hold 18 rows to do it. The six shells
being typed into hold 18 rows as well.

### What ⌘0 already does

`applyShrink` caps a shrunk pane to `SHRUNK_ROWS` (10) lines and hands the freed
height to its column-mates. Pressing ⌘0 on each of the three servers today gives:

| | rows |
|---|---|
| server panes | 10 |
| shell panes | 22 (up from 18) |

Three things keep that from being the answer:

1. **It depends on where the servers landed.** `applyShrink` groups panes into
   columns by matching `x` and `w`, and a column with no unshrunk pane is left
   alone. Three servers opened first land one per column of a 3×3 and it works;
   three opened in the middle of a session may not.
2. **Ten rows is more than a server needs**, and the ⌘0 height is global — the
   same constant that makes a shell usable at 10 rows is more than a strip wants.
3. **A shrunk pane is still just a pane.** No state, no port. Telling "compiling"
   from "crashed" means reading the tail.

Server mode is those three fixed: make the arrangement a rule rather than a
coincidence, use a strip height suited to a server, and put a header on it.

## The proposal

<kbd>⌘D</kbd> toggles server mode on the focused pane. A pane in server mode:

- **leaves the tiling grid.** It is not in `computeLayout`'s input at all, so the
  remaining panes tile exactly as they would if it had been closed. Six shells
  become the 3×2 grid.
- **docks** in a fixed-height band along the bottom edge, as a strip three
  terminal rows tall under a 20px status header.
- **keeps its ⌘N.** Docking does not reorder `panes`, so the focus shortcuts do
  not move. (See "Open questions".)
- **peeks** when focused: the strip grows upward out of the dock to `PEEK_ROWS`,
  over the grid, and drops back when focus leaves.

### Geometry

At a 1200×800 window the workspace is 1200×770 (30px is the titlebar strip).
FitAddon's arithmetic, which everything below uses:

```
rows = floor((paneH − 2·border − 2·padding) / cellH)   // border 1, padding 10
cols = floor((paneW − 2·border − 2·padding) / cellW)
```

`cellW` × `cellH` is 6.61 × 13px for 11px "Fira Mono for Powerline", the font in
`TERM_OPTIONS`.

A strip is `2·border + header + 4 + DOCK_ROWS·cellH + 9` = **74px** for
`DOCK_ROWS = 3`. So for three servers and six shells:

| | today (3×3) | ⌘0 today | server mode |
|---|---|---|---|
| shell pane | 400×257 → 57×18 | 400×309 → 57×22 | 400×348 → **57×25** |
| server pane | 400×257 → 57×18 | 400×152 → 57×10 | 400×74 → **57×3** |
| cost of the servers | 33.3% of the workspace | 19.8% | **9.6%** |

The six shells gain 39% more rows each and lose no width.

### The strip header

Left to right: state dot, name, state, then port, uptime, ⌘N. What each costs:

| | source | cost |
|---|---|---|
| name | `pane.name` (⌘E), or the directory the pane is working in | one Tauri command (below) |
| ⌘N | the index `applyLayout` already computes | free |
| running / exited | the `pty-exit` event; `pane_busy` for the foreground process | one branch (below) |
| uptime | the moment `pane_busy` first went true | keep one timestamp |
| state (starting / building / ready / error) | matching the output stream | frontend only, but framework-shaped |
| port | see below | the only part that needs new backend work |

**Name** is what ⌘E sets, and a pane is docked for what it is running — which is
usually named after the directory it runs in. So an unnamed strip titles itself
with the last component of that directory: `storefront` for `~/src/storefront`.
Three docked servers read as three project names with nothing typed; ⌘E wins
wherever it is set, and clearing a name goes back to the directory.

That is the one part of this that needed the backend. `pane_cwd` reads the
working directory of the pane's foreground process — `proc_pidinfo` on macOS,
procfs elsewhere — falling back to the login shell when nothing else holds the
pty. The foreground process is asked first because a subshell that has `cd`'d,
or a server started from a directory the shell has since left, is where the pane
actually is; for an idle pane the two are the same process anyway. It is read on
the `pane_busy` poll, docked panes only, so a strip follows a `cd` — and a strip
whose shell has gone keeps the last directory it had, since the poll stops at
`alive`.

**Exited** reads as free from the table and isn't quite. The `pty-exit` listener
in `main.ts` used to call `closePane(id)` for any pane it knew about, so a
server that died took its pane with it and there was nothing left to label
`exited`. Drawing that state means the listener branches: a docked pane keeps
its element and its scrollback and only changes state, and an undocked pane
closes as it did before. That branch is the whole cost, and it is paid — see
decision 4.

There is also a state below `exited`: a docked pane that has never had a
foreground process shows `idle`. The wireframes never draw it because you would
not dock such a pane, but ⌘D does not stop you.

**State** is a table of rules (`STATE_RULES`) over the bytes the `pty-output`
listener already receives — `⨯` or a line starting `error` → error, `Compiling`
→ building, `✓ Ready` or `✓ Compiled` → ready. That is Next.js-shaped by
construction. It is a table that can be extended or come up empty, not a
protocol: a server matching no rule still shows starting/exited and its tail,
which is the whole point of the mode. The rules run per line, over docked panes
only, and the last line to match one wins; docking seeds itself by replaying
the last 400 lines already in the buffer, so a server docked an hour after it
started doesn't sit blank until its next request.

The rules are also the one part of this feature that can be checked without a
window, and `test/server-state.test.ts` checks them against real output: a
`next dev` startup, a compile cycle, a type error and its fix, a line split
across two `pty-output` events, and two things the table does *not* know —
Rails' `* Listening on http://127.0.0.1:3000` yields a port and no state, and
the false positive below.

**Port** has two honest options:

- *Scrape the output.* One regex for `http://…:<port>` or `port <n>`. No backend
  change, but it only knows what the process chose to print, and it will read a
  port out of any URL — a `stripe listen --forward-to http://localhost:3000/api/hook`
  reports `:3000` although it is not listening on anything.
- *Ask the OS.* A new Tauri command that walks the pane's process group and
  reports listening TCP sockets — `libproc` on macOS, or shelling out to
  `lsof -nP -iTCP -sTCP:LISTEN`. General, correct across restarts, and works for
  servers that print nothing. It is also the only part of this design that needs
  Rust.

The first is what is implemented, and it is cleared when the process exits.
Neither is required: a strip with name, running/exited, uptime and three rows of
tail already does the job the wireframes are about.

### Clipping, not resizing

There are two ways to show only three rows of a running server, and they are not
equivalent.

1. **Resize the PTY to 3 rows.** Simple — `fit()` already does it. But it
   delivers SIGWINCH, and the server reflows its output to a 3-row terminal;
   undocking reflows it back. Anything that redraws is squeezed, and the
   scrollback is rewritten at a width and height nobody wanted.
2. **Leave the terminal at its row count and clip the pane to the bottom three
   rows.** Slide `.xterm` up inside the `overflow: hidden` strip so the rows
   above the tail go under the header. No SIGWINCH at all, the scrollback stays
   as it was, and peek becomes a CSS height change.

(2) is the one where docking a running server does not visibly disturb it, and
it is what makes peek cheap. It costs: `applyLayout` must not call `fit()` on a
docked pane — on a window resize it wants `term.resize(colsIn(stripW), keptRows)`
instead, so a width change is one SIGWINCH at dock time rather than one per
glance.

Which rows that leaves visible is `stripTop` in [`src/strip.ts`](../src/strip.ts),
and applying it is `updateClip`. Six details only show up once it is running.

**The tail is not the bottom of the screen.** An 18-row terminal that has printed
five lines has thirteen blank rows under them, and clipping to the last three
would show nothing. The offset is measured from the rows in use, not from the
frame.

**Nor is it the cursor's row.** A server's cursor spends its life on the fresh
blank line under the line it just printed, and a three-row strip cannot afford to
spend a third of itself on it. `contentRows` measures up from the *bottom of the
screen* to the last row with anything on it, so the strip shows three lines of
output — what the wireframes draw. A prompt, a spinner, anything that leaves the
row non-blank, keeps it.

**But an interactive process draws below its cursor.** fzf under a
`--reverse`-shaped `FZF_DEFAULT_OPTS` puts its query line at the top of its
region and the matches under it; a menu, a completion listing and a multi-line
prompt all do the same. Measuring down from the cursor rather than up from the
bottom clipped every one of those matches away, so typing into a docked fzf
changed a line you could see and a list you could not — the mode looked like it
was refusing input. Two rules together cover both shapes: content is measured
from the bottom, and a *visible* cursor above the strip's top row pulls the strip
up to it, so the line being typed into is never scrolled off. It only ever pulls
the strip up; a cursor below the last row in use is the blank line under the
tail, which is the row the strip deliberately does not spend. A cursor the
program has hidden (htop, a spinner) is not somewhere anyone is typing, so it
does not move the strip at all.

**The offset goes negative.** Before the screen has filled, `content − stripRows`
is less than zero and the rows are pushed *down*, so the last one still lands on
the strip's bottom edge. Without that, a server that has printed ten lines draws
its tail ten rows down from the top of the strip — and peeking walks the tail up
the screen instead of revealing history above it.

**The terminal is clipped at both edges.** The header only covers its own 20px,
so without a `clip-path` at its lower edge the row above the first visible one
shows through the padding gap beneath it as a 4px sliver of cut-off text. The
rows below the strip's own window do the same thing against its bottom edge —
its window, not the bottom of the output, since an interactive process has rows
below the strip as well as above it.

**It is recomputed per chunk of output, not per render.** `onWriteParsed` fires
once a frame after a `write` has been parsed into the buffer. xterm's `onRender`
looks like the right event and is not: it is fired from the render service's
"viewport changed" event, which a terminal being written to steadily does not
emit — over a session of eight lines printed into a strip it fired once. A strip
driven by it froze on the screen it had when it docked and only caught up when
something else re-laid the workspace out, which for a server is invisible (once
the screen has filled, `content − stripRows` stops changing) and for anything
still filling its first screen is the whole bug.

Peek is capped at the rows the terminal actually kept, which is not always
`PEEK_ROWS`: docking the first of three servers re-tiles the other two, so they
dock from a 3-row grid holding 16 rows rather than 18, and a drawer taller than
its own content is blank space under the tail. The cap runs the other way too,
and that one is a limit rather than a nicety: a pane docked from a side-by-side
split keeps 40-odd rows, and a peek shows 18 of them. A process drawing a screen
taller than that — vim, htop, `less` on a wide window — is only ever partly
visible in the dock, `stripTop` choosing which part.

### Dock overflow

Strips flow left to right and wrap to another dock row when one would fall below
a minimum width (40 columns, 287px). Splitting a row reuses the rule `grid()`
already uses — `ceil(remaining / rows left)` — so five servers dock as 3 + 2.

Each dock row costs another 74px. Six servers would cost 148px, 19% of the
workspace, at which point the dock is doing what the 3×3 grid was doing and the
answer is probably fewer servers or a second window. Past `MAX_DOCK_FRAC` (75%
of the workspace) the band stops growing and the strips share it, so however
many panes are docked the tiled ones keep a quarter of the height.

### Where it interacts with what exists

- **`master` layout.** The dock reserves the band; master and its stack tile the
  area above. No change to `masterStack` itself.
- **⌘0.** Shrink applies among the tiled panes only. `applyShrink` runs on the
  tiled rects before they are scaled into the band. A docked pane ignores ⌘0.
- **Bells.** An error state is worth the same warm-ring treatment `.pane.bell`
  already uses, in red. The existing rule — a bell in a background pane persists
  until that pane is focused — is exactly right for a docked server.
- **⌘W.** Unchanged. `pane_busy` will be true for a running server, so closing
  one still asks first.

## Where the code is

- **`src/layout.ts`** — `computeLayoutWithDock`, alongside `computeLayout`:

  ```ts
  export function computeLayoutWithDock(
    name: LayoutName,
    docked: boolean[],
    focused: number,
    stripFrac: number,    // one strip's height, in workspace fractions
    minStripFrac: number, // narrowest strip width before the dock wraps
  ): Rect[]
  ```

  It runs `computeLayout` over the undocked subset, scales those rects into
  `y ∈ [0, 1 − dockFrac]`, and lays the docked ones across the band. If every
  pane is docked it returns `computeLayout` over all of them — an all-dock
  workspace has nothing to give the freed space to, the same case `applyShrink`
  skips.

  This is a pure function over numbers, which is the one thing in this repo that
  is cheap to test, and it is what `test/layout.test.ts` covers — the repo's
  first test. `npm test`; Node runs the TypeScript directly, so there is no test
  toolchain to install.

- **`src/strip.ts`** — which rows of a docked terminal its strip shows:
  `contentRows` and `stripTop`. Pure arithmetic over numbers for the same reason
  `layout.ts` is separate, and `test/strip.test.ts` covers it — a dev server
  printing lines, fzf's `--reverse` layout, a hidden cursor, and the negative
  offset before a screen has filled.
- **`src/server-state.ts`** — the half of the header that isn't the DOM:
  `ServerState`, `STATE_WORD`/`DOT_FILLED`, `STATE_RULES`, `PORT_RE`,
  `scanChunk` (decoded output in, "did the header change" out), `stateOf`,
  `stripTitle` (the ⌘E name, or the directory's) and `uptimeText`. Split out of
  `main.ts` for the same reason `layout.ts` is separate — no window in it, so
  `test/server-state.test.ts` can run it.
- **`src/main.ts`** — `Pane.docked` and the state the header reads, the `⌘D`
  case and `createPane`'s `docked` option (⌘⇧T), `stripHead`, `applyLayout`
  calling `fitDocked` rather than `fit()` for docked panes, `peekRect`,
  `updateClip` and the `onWriteParsed` that drives it, `cursorRow`, `scanOutput`
  in the `pty-output` listener, the once-a-second `pane_busy` poll behind
  `running`/uptime — which `refreshCwd` rides for the title — and the `pty-exit`
  branch that leaves a docked pane on screen as `exited`.

  The poll is what makes `running` and uptime, and it only ever *clears* the
  output-derived state — the port and the matched line — when a process goes
  away. It cannot clear on the way in: it notices a process up to a second after
  it started, and `✓ Ready in 800ms` is printed once, so clearing there would
  throw that line away and leave the strip reading `starting` until the server's
  next compile.
- **`src/styles.css`** — `.pane.docked`, `.strip-head`, `.pane.peek` and the
  per-state colours.
- **`src-tauri/src/lib.rs`** — `pane_cwd` and `cwd_of`, the one thing here the
  backend had to answer: the directory an unnamed strip is titled with, which no
  amount of reading the output can tell you. `cwd_of` is also the first Rust code
  in this repo with a test (`cargo test`, in `src-tauri`) — the struct layout and
  flavor constant a `proc_pidinfo` call needs are not the sort of thing reading
  it can confirm. The port could have been a second command and is scraped from
  the output instead.

## Decisions

Each was open when the wireframes were drawn; each is settled the way they draw
it, which is worth knowing if any of them turns out to be wrong in use.

1. **Focus peeks**, rather than peek being its own gesture. ⌘J cycling past a
   docked pane pops its drawer open for as long as it is focused, and drops it
   when focus leaves. The alternative — focus leaves the strip at three rows, you
   can still type ^C into it, and peek is a second ⌘D — is a two-line change in
   `applyLayout` if cycling through a dock turns out to feel busy.
2. **Docking does not renumber.** Servers opened first stay ⌘1–3 and the grid
   runs ⌘4–9; the pane list is not reordered by ⌘D. The alternative is that the
   tiled panes always hold ⌘1–n and the dock gets its own row of shortcuts.
3. **`DOCK_ROWS` is fixed at 3**, and `PEEK_ROWS` at 18. Three fits a compile
   line and two requests. Per-pane heights would make the dock ragged.
4. **⌘D survives the process exiting.** The strip stays, showing `exited`, so a
   server that died is still on screen rather than silently back in the grid.
   Since the pane only outlived its shell because it was docked, ⌘D on a dead
   strip is the close that was deferred, and ⌘W still closes it.
5. **A pane never enters server mode by itself.** Everything else in this app is
   an explicit keystroke, and auto-docking a pane the moment it binds a port
   would move a pane the user is looking at. ⌘D and ⌘⇧T — which opens a pane
   into the dock rather than moving one there — are the only ways in, and both
   are a keystroke.

   A pane opened docked has no grid rectangle to take its row count from, so it
   takes `PEEK_ROWS`: the rows it holds are exactly the rows its peek shows.

Two things the wireframes draw are not built: the right-hand rail of frame 7,
which was drawn as the alternative rather than the proposal, and the OS-derived
port of frame 4's legend — the port is scraped from the output instead.
