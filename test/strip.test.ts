// Run with `npm test`. Which rows of a docked pane's terminal its strip shows.
// The cases are screens the app actually has to draw: a dev server printing
// lines, and fzf — whose `--reverse` layout puts the line you type into at the
// top of its region and the matches under it, which is what the first version
// of this arithmetic clipped away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contentRows, stripTop } from "../src/strip.ts";

const DOCK_ROWS = 3; // an unfocused strip
const PEEK_ROWS = 18; // and a focused one

/** contentRows over a screen written out as lines, blanks and all. */
const rowsOf = (screen: string[]): number => contentRows(screen.length, (i) => screen[i]);

/** A screen `rows` tall holding `lines` at the top and blanks under them. */
const screen = (lines: string[], rows: number): string[] =>
  lines.concat(new Array(Math.max(0, rows - lines.length)).fill(""));

test("content is measured to the last row with anything on it", () => {
  assert.equal(rowsOf(["a", "b", "", "", ""]), 2);
  assert.equal(rowsOf(["", "", ""]), 0, "a blank screen uses no rows");
  assert.equal(rowsOf(["a", "", "b"]), 3, "a blank row between two used ones still counts");
  assert.equal(rowsOf(["a", "b"]), 2, "a full screen uses all of it");
});

test("a server's tail lands on the strip's bottom edge", () => {
  // Eighteen rows, twelve printed, the cursor on the blank line under them.
  const s = screen(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10", "l11", "l12"], 18);
  const content = rowsOf(s);
  assert.equal(content, 12);
  // The strip shows rows 9, 10, 11 — the last three lines printed, and not the
  // blank line the cursor is sitting on.
  assert.equal(stripTop(content, DOCK_ROWS, 12), 9);
});

test("a screen shorter than the strip is pushed down, not up", () => {
  // Two lines in an eighteen-row terminal, peeked: the offset goes negative so
  // the last line still sits on the bottom edge rather than floating at the top.
  assert.equal(stripTop(rowsOf(screen(["l1", "l2"], 18)), PEEK_ROWS, 2), 2 - PEEK_ROWS);
});

test("a hidden cursor never moves the strip", () => {
  const content = rowsOf(screen(["l1", "l2", "l3", "l4", "l5"], 18));
  assert.equal(stripTop(content, DOCK_ROWS, null), 2, "the tail, as if there were no cursor");
});

test("the cursor is never scrolled off the top of the strip", () => {
  // fzf --reverse in a 42-row terminal: the shell's prompt and command, then
  // the query line at row 3 with eight matches under it. The tail alone would
  // show three matches and clip the line being typed into.
  const s = screen(
    ["", "~", "➜ seq 1 100 | fzf", "> 7", "──────", "▌ 7", "  70", "  71", "  72", "  73"],
    42,
  );
  const content = rowsOf(s);
  assert.equal(content, 10);
  assert.equal(stripTop(content, DOCK_ROWS, 3), 3, "the strip starts at the query line");
  // Peeked there is room for all of it, so the cursor rule doesn't fire and the
  // rows are pushed down onto the bottom edge as usual.
  assert.equal(stripTop(content, PEEK_ROWS, 3), 10 - PEEK_ROWS);
});

test("the cursor pulls the strip up, never down", () => {
  // The blank line under a server's tail is exactly the row the strip declines
  // to spend, so a cursor below the content is ignored...
  assert.equal(stripTop(12, DOCK_ROWS, 12), 9);
  // ...as is one inside the strip already.
  assert.equal(stripTop(12, DOCK_ROWS, 10), 9);
  // Only one above the top row moves it.
  assert.equal(stripTop(12, DOCK_ROWS, 8), 8);
});
