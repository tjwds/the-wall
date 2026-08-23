// Run with `npm test`. Which part of a pane a click landed on, which is what
// says whether the browser's default action can be left alone or has to be
// suppressed to keep the terminal focused. The cases are the places a pointer
// actually goes in a docked pane — the strip is a 20px header over three rows,
// with the padding around them clipped out of the hit test, so "not the
// terminal" is about half of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { clickRegion } from "../src/click.ts";

/** A stand-in for an Element: a class, a parent, and the two lookups
    clickRegion uses over them. Built as a chain, innermost first. */
interface Fake {
  cls: string;
  parent: Fake | null;
  closest(selector: string): Fake | null;
  contains(other: Fake | null): boolean;
}

function node(cls: string, parent: Fake | null = null): Fake {
  const self: Fake = {
    cls,
    parent,
    closest(selector) {
      for (let n: Fake | null = self; n; n = n.parent) if (`.${n.cls}` === selector) return n;
      return null;
    },
    contains(other) {
      for (let n = other; n; n = n.parent) if (n === self) return true;
      return false;
    },
  };
  return self;
}

/** clickRegion over the fakes above, which have what it reads of an Element. */
const regionOf = (target: Fake | null, term: Fake | null): string =>
  clickRegion(target as unknown as Element, term as unknown as Element);

// A docked pane: its status header and the name span in it, its terminal and a
// row inside that, and the ⌘E editor — a child of the pane, not of the terminal.
const pane = node("pane");
const head = node("strip-head", pane);
const headName = node("nm", head);
const xterm = node("xterm", pane);
const screen = node("xterm-screen", xterm);
const row = node("xterm-rows", screen);
const editor = node("pane-name-input", pane);

test("a click on the terminal is xterm's own", () => {
  assert.equal(regionOf(row, xterm), "terminal");
  assert.equal(regionOf(screen, xterm), "terminal");
  // The .xterm element itself is its padding — still xterm's, wherever the clip
  // path has not taken it out of the hit test.
  assert.equal(regionOf(xterm, xterm), "terminal");
});

test("a click on a strip's header is chrome, span or no span", () => {
  assert.equal(regionOf(head, xterm), "chrome");
  assert.equal(regionOf(headName, xterm), "chrome", "the name, the uptime, the ⌘N");
});

test("a click that reaches the pane itself is chrome", () => {
  // The border, and the padding a docked strip clips away at either edge: the
  // terminal is not a hit target there, so the pane is what the click hits.
  assert.equal(regionOf(pane, xterm), "chrome");
});

test("the ⌘E name field takes its own clicks", () => {
  assert.equal(regionOf(editor, xterm), "editor");
});

test("a pane with no terminal element yet is all chrome", () => {
  assert.equal(regionOf(pane, null), "chrome");
  assert.equal(regionOf(null, xterm), "chrome", "and a click with no target at all");
});
