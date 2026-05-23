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
