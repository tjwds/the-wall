export type LayoutName = "grid" | "master";

/** A pane rectangle in [0,1] fractions of the workspace. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Compute a rect (in [0,1] workspace fractions) for each pane, by list index. */
export function computeLayout(name: LayoutName, count: number, focused: number): Rect[] {
  if (count === 0) return [];
  if (count === 1) return [{ x: 0, y: 0, w: 1, h: 1 }];
  return name === "master" ? masterStack(count, focused) : grid(count);
}

/** Even-ish grid: ~sqrt(n) rows, each row's panes split the width equally.
    Three panes are special-cased so the odd one out is a full-height column. */
function grid(n: number): Rect[] {
  if (n === 3) {
    return [
      { x: 0, y: 0, w: 0.5, h: 1 }, // odd one out: full height
      { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
    ];
  }
  const rows = Math.max(1, Math.round(Math.sqrt(n)));
  const rects: Rect[] = [];
  let placed = 0;
  for (let r = 0; r < rows; r++) {
    const cols = Math.ceil((n - placed) / (rows - r));
    const h = 1 / rows;
    const w = 1 / cols;
    for (let c = 0; c < cols; c++) {
      rects.push({ x: c * w, y: r * h, w, h });
    }
    placed += cols;
  }
  return rects;
}

/** Most of the workspace the dock may take. Past this, extra dock rows share
    the band instead of growing it, so the tiled panes always keep a quarter of
    the height however many servers are docked. */
const MAX_DOCK_FRAC = 0.75;

/** Compute rects with some panes docked (⌘D — server mode).

    The undocked panes tile the area above the dock exactly as `computeLayout`
    would lay them out if the docked ones had been closed: docking removes a
    pane from the tiler's input, so six shells behind three servers become the
    plain 3×2 grid rather than whatever the 9-pane grid left over. The docked
    panes flow left to right across a band along the bottom edge, wrapping to
    another dock row once a strip would fall below `minStripFrac` wide; a row is
    split the way `grid()` splits its rows, so five strips dock as 3 + 2.

    `stripFrac` is one strip's height and `minStripFrac` the narrowest strip
    worth drawing, both in workspace fractions. `focused` indexes the full pane
    list and only matters to `master`; a docked pane is not a candidate for the
    master column, so an index pointing at one falls back to the first tiled
    pane. If every pane is docked there is nothing to hand the freed space to,
    so they tile as usual — the same case `applyShrink` skips. */
export function computeLayoutWithDock(
  name: LayoutName,
  docked: boolean[],
  focused: number,
  stripFrac: number,
  minStripFrac: number,
): Rect[] {
  const n = docked.length;
  const dockIdx: number[] = [];
  const tileIdx: number[] = [];
  for (let i = 0; i < n; i++) (docked[i] ? dockIdx : tileIdx).push(i);
  if (dockIdx.length === 0 || tileIdx.length === 0) return computeLayout(name, n, focused);

  const perRow = minStripFrac > 0 ? Math.max(1, Math.floor(1 / minStripFrac)) : dockIdx.length;
  const dockRows = Math.max(1, Math.ceil(dockIdx.length / perRow));
  const dockH = Math.min(dockRows * stripFrac, MAX_DOCK_FRAC);
  const stripH = dockH / dockRows;

  const rects: Rect[] = new Array(n);
  let placed = 0;
  for (let r = 0; r < dockRows; r++) {
    const cols = Math.ceil((dockIdx.length - placed) / (dockRows - r));
    const w = 1 / cols;
    for (let c = 0; c < cols; c++) {
      rects[dockIdx[placed + c]] = { x: c * w, y: 1 - dockH + r * stripH, w, h: stripH };
    }
    placed += cols;
  }

  // The tiled panes get their own layout, scaled into the space left above.
  const top = 1 - dockH;
  const sub = computeLayout(name, tileIdx.length, Math.max(0, tileIdx.indexOf(focused)));
  tileIdx.forEach((idx, k) => {
    const s = sub[k];
    rects[idx] = { x: s.x, y: s.y * top, w: s.w, h: s.h * top };
  });
  return rects;
}

const EPS = 1e-6;

/** Cap each shrunk pane to a fixed height `sh` (in workspace fractions) and give
    the freed space to its non-shrunk column-mates.

    Panes are grouped into columns by matching x and width (so the vertical stack
    in master, the right column of the 3-pane grid, and aligned grid columns are
    each one column). Within a column the shrunk panes take `sh` each and the
    rest split the remaining height in proportion to their original heights,
    repacked top-to-bottom so order — and a shrunk pane's place in the stack — is
    preserved. A column with no non-shrunk pane (e.g. a full-height solo column,
    like a side-by-side grid pane or the master pane) has nothing to absorb the
    freed space, so it's left unchanged. */
export function applyShrink(rects: Rect[], shrunk: boolean[], sh: number): Rect[] {
  const out = rects.map((r) => ({ ...r }));
  const claimed = new Array(rects.length).fill(false);
  for (let i = 0; i < rects.length; i++) {
    if (claimed[i]) continue;
    const col: number[] = [];
    for (let j = i; j < rects.length; j++) {
      if (Math.abs(rects[j].x - rects[i].x) < EPS && Math.abs(rects[j].w - rects[i].w) < EPS) {
        col.push(j);
        claimed[j] = true;
      }
    }
    const shrunkCount = col.filter((k) => shrunk[k]).length;
    const grownIdx = col.filter((k) => !shrunk[k]);
    if (shrunkCount === 0 || grownIdx.length === 0) continue;

    col.sort((a, b) => rects[a].y - rects[b].y);
    const colTop = Math.min(...col.map((k) => rects[k].y));
    const colBottom = Math.max(...col.map((k) => rects[k].y + rects[k].h));
    const remaining = colBottom - colTop - shrunkCount * sh;
    if (remaining <= 0) continue; // shrunk strips wouldn't leave room; skip

    const grownOrigTotal = grownIdx.reduce((s, k) => s + rects[k].h, 0);
    let y = colTop;
    for (const k of col) {
      const h = shrunk[k] ? sh : remaining * (rects[k].h / grownOrigTotal);
      out[k] = { ...rects[k], y, h };
      y += h;
    }
  }
  return out;
}

/** Focused pane fills a left master column; the rest stack on the right. */
function masterStack(n: number, focused: number): Rect[] {
  const masterW = 0.6;
  const master = Math.max(0, Math.min(focused, n - 1));
  const rects: Rect[] = new Array(n);
  rects[master] = { x: 0, y: 0, w: masterW, h: 1 };

  const stack: number[] = [];
  for (let i = 0; i < n; i++) if (i !== master) stack.push(i);
  const h = 1 / stack.length;
  stack.forEach((idx, k) => {
    rects[idx] = { x: masterW, y: k * h, w: 1 - masterW, h };
  });
  return rects;
}
