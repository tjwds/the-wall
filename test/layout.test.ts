// Run with `npm test`. Node runs TypeScript directly, so this needs no
// toolchain of its own; the layout module is pure arithmetic over numbers,
// which is what makes it worth testing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyShrink, computeLayout, computeLayoutWithDock, type Rect } from "../src/layout.ts";

// The numbers the app runs at: a 1200×800 window is a 1200×770 workspace, and
// a 3-row strip under a 20px header is 74px of it.
const W = 1200;
const H = 770;
const STRIP = 74 / H;
const MIN_STRIP = 287 / W; // 40 columns, below which the dock wraps

const close = (a: number, b: number, what: string): void =>
  assert.ok(Math.abs(a - b) < 1e-9, `${what}: ${a} ≠ ${b}`);

const area = (r: Rect): number => r.w * r.h;

/** Every rect is inside the workspace, and together they cover it exactly once. */
function assertTiles(rects: Rect[], msg: string): void {
  for (const r of rects) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9, `${msg}: rect starts outside the workspace`);
    assert.ok(r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9, `${msg}: rect runs off the edge`);
    assert.ok(r.w > 0 && r.h > 0, `${msg}: rect has no area`);
  }
  close(
    rects.reduce((s, r) => s + area(r), 0),
    1,
    `${msg}: rects cover the workspace`,
  );
}

test("no docked panes lays out exactly as it does today", () => {
  for (const name of ["grid", "master"] as const) {
    for (let n = 1; n <= 9; n++) {
      assert.deepEqual(
        computeLayoutWithDock(name, new Array(n).fill(false), 0, STRIP, MIN_STRIP),
        computeLayout(name, n, 0),
        `${name}, ${n} panes`,
      );
    }
  }
});

test("three servers and six shells: the shells tile as if the servers were closed", () => {
  const docked = [true, true, true, false, false, false, false, false, false];
  const rects = computeLayoutWithDock("grid", docked, 3, STRIP, MIN_STRIP);
  const top = 1 - STRIP;

  // The six tiled panes are grid(6) — a 3×2 — squeezed above the dock.
  const plain = computeLayout("grid", 6, 0);
  rects
    .filter((_, i) => !docked[i])
    .forEach((r, k) => {
      close(r.x, plain[k].x, `shell ${k} x`);
      close(r.w, plain[k].w, `shell ${k} width`);
      close(r.y, plain[k].y * top, `shell ${k} y`);
      close(r.h, plain[k].h * top, `shell ${k} height`);
    });

  // A shell keeps its full width and gains rows: 18 today, 25 with the dock.
  const rowsIn = (h: number): number => Math.floor((h * H - 2 - 20) / 13);
  const colsIn = (w: number): number => Math.floor((w * W - 2 - 20) / 6.6094);
  assert.equal(rowsIn(rects[3].h), 25);
  assert.equal(colsIn(rects[3].w), 57);
  assert.equal(rowsIn(computeLayout("grid", 9, 0)[0].h), 18);

  // The three strips share one dock row along the bottom edge.
  const strips = rects.filter((_, i) => docked[i]);
  for (const s of strips) {
    close(s.h, STRIP, "strip height");
    close(s.y + s.h, 1, "strip sits on the bottom edge");
    close(s.w, 1 / 3, "strip width");
  }
  assert.deepEqual(
    strips.map((s) => s.x),
    [0, 1 / 3, 2 / 3],
  );
  assertTiles(rects, "dock + grid");
});

test("the dock wraps to a second row, split the way grid() splits rows", () => {
  const docked = [...new Array(5).fill(true), ...new Array(6).fill(false)];
  const rects = computeLayoutWithDock("grid", docked, 5, STRIP, MIN_STRIP);
  const strips = rects.filter((_, i) => docked[i]);

  // Five strips are 3 + 2, not 4 + 1: ceil(remaining / rows left).
  assert.deepEqual(
    strips.map((s) => s.w),
    [1 / 3, 1 / 3, 1 / 3, 1 / 2, 1 / 2],
  );
  close(strips[0].y, 1 - 2 * STRIP, "first dock row");
  close(strips[3].y, 1 - STRIP, "second dock row");
  close(rects[10].y + rects[10].h, 1 - 2 * STRIP, "the tiled area stops above both rows");
  assertTiles(rects, "two dock rows");

  // Four fit on one row at this minimum; five don't.
  const four = [...new Array(4).fill(true), false];
  assert.equal(computeLayoutWithDock("grid", four, 0, STRIP, MIN_STRIP)[0].w, 1 / 4);
});

test("a dock that would swallow the workspace shares a capped band instead", () => {
  const docked = [...new Array(40).fill(true), false];
  const rects = computeLayoutWithDock("grid", docked, 0, STRIP, MIN_STRIP);
  const shell = rects[40];
  assert.ok(shell.h >= 0.25 - 1e-9, "the tiled panes keep a quarter of the height");
  assertTiles(rects, "capped dock");
});

test("every pane docked tiles as usual — there is nothing to give the space to", () => {
  const docked = new Array(4).fill(true);
  assert.deepEqual(
    computeLayoutWithDock("grid", docked, 0, STRIP, MIN_STRIP),
    computeLayout("grid", 4, 0),
  );
});

test("master keeps its column above the dock, and never gives it to a strip", () => {
  const docked = [true, false, false, false];
  // focused points at the docked pane: the master column falls back to the
  // first tiled pane rather than being handed to a strip.
  const rects = computeLayoutWithDock("master", docked, 0, STRIP, MIN_STRIP);
  close(rects[1].w, 0.6, "master column width");
  close(rects[1].h, 1 - STRIP, "master column stops above the dock");
  close(rects[0].y + rects[0].h, 1, "the strip still docks");
  assertTiles(rects, "master + dock");

  // Focus on a tiled pane still picks it out as the master.
  const focused = computeLayoutWithDock("master", docked, 2, STRIP, MIN_STRIP);
  close(focused[2].w, 0.6, "focused pane is the master");
});

test("⌘0 among the tiled panes is unaffected by the dock", () => {
  const docked = [true, false, false, false, false, false, false];
  const rects = computeLayoutWithDock("grid", docked, 1, STRIP, MIN_STRIP);
  const tiled = rects.filter((_, i) => !docked[i]);
  const sh = 0.1;
  const grown = applyShrink(tiled, [true, false, false, false, false, false], sh);
  close(grown[0].h, sh, "the shrunk pane takes its fixed height");
  close(
    grown.reduce((s, r) => s + area(r), 0),
    tiled.reduce((s, r) => s + area(r), 0),
    "shrink moves height between column-mates without changing the total",
  );
});
