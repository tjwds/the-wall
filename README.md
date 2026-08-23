# the-wall

> Tryin'a make it through the wall!  Tryin'a make it through the wall!  You can see me if you're tall!  You can see me if you're tall!  Looking over!

An opinionated auto-tiling terminal multiplexer. Each pane is an [xterm.js](https://xtermjs.org/)
terminal backed by a PTY ([portable-pty](https://crates.io/crates/portable-pty)) in a
[Tauri](https://tauri.app/) (Rust) backend. Panes tile automatically and reflow as you
add, close, or focus them.

![Screenshot of terminal emulator](./assets/the-wall.png)

## Develop

Requires Node and a Rust toolchain.

```sh
npm install
npm run tauri dev
npm test        # node --test, over the modules that are pure functions
cargo test --manifest-path src-tauri/Cargo.toml   # the backend's cwd lookup
```

To regenerate the screenshot above, run `npm run screenshot`. It launches the
app in a fixed demo layout, captures its window to `assets/the-wall.png`, and
quits. macOS only; needs Screen Recording permission for the terminal you run it
from.

## Keybindings

| Key | Action |
|---|---|
| `Cmd`+`T` / `Cmd`+`Return` | new pane |
| `Cmd`+`Shift`+`T` / `Cmd`+`Shift`+`Return` | new pane, docked (server mode) |
| `Cmd`+`W` | close focused pane (warns if a process is running) |
| `Cmd`+`E` | name the focused pane (shown in its upper-right corner) |
| `Cmd`+`J` / `Cmd`+`]` | focus next |
| `Cmd`+`K` / `Cmd`+`[` | focus previous |
| `Cmd`+`1`…`9` | focus pane N |
| `Cmd`+`L` | cycle layout (grid ↔ focus-stack) |
| `Cmd`+`0` | toggle focused pane to 10 lines tall (its column-mates fill the freed space) |
| `Cmd`+`D` | server mode: dock the focused pane as a 3-line strip along the bottom |
| `Cmd`+`C` / `Cmd`+`V` | copy selection / paste |

### Server mode

`Cmd`+`D` takes a pane out of the tiling grid and docks it along the bottom edge
as a strip three lines tall, under a header showing its name — the directory it
is working in, unless `Cmd`+`E` gave it one — what it is doing, the port it
announced, how long it has been running and its `Cmd`+`N`. The
remaining panes tile the space above as if it had been closed — three docked dev
servers and six shells is a clean 3×2 grid plus a 74px dock. Focusing a docked
pane grows its strip up over the grid; `Cmd`+`D` again puts it back.

`Cmd`+`Shift`+`T` opens a new pane straight into the dock, so a server you are
about to start never passes through the grid and the tiled panes never reflow
around it. Such a pane holds as many rows as a focused strip shows, so all of
them are on screen while it is focused.

See [`docs/server-mode.md`](./docs/server-mode.md) for the design and the
arithmetic, and `docs/server-mode.html` for the wireframes.

## Theme

Colors are [Iceberg](https://cocopon.github.io/iceberg.vim/) (dark), by
[cocopon](https://github.com/cocopon/iceberg.vim). Theme customization will come later.
