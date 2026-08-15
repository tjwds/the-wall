// Run with `npm test`. What a docked pane's header says, checked against the
// output real dev servers actually print — colour codes, \r\n, chunk boundaries
// and all. The rules are a table that will need extending (vite, rails, django);
// these cases are what "extending it" has to keep working.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRules,
  scanChunk,
  stateOf,
  stripTitle,
  uptimeText,
  type OutputState,
} from "../src/server-state.ts";

const fresh = (): OutputState => ({ matched: null, port: null, carry: "" });

// A pane the state rules have said nothing about yet, for stateOf.
const pane = (o: Partial<Parameters<typeof stateOf>[0]>): Parameters<typeof stateOf>[0] => ({
  alive: true,
  running: false,
  ranOnce: false,
  matched: null,
  ...o,
});

test("a Next.js server coming up reads as ready, on the port it announced", () => {
  const s = fresh();
  // What `next dev` prints, escape codes included, over a pty (so \r\n).
  const changed = scanChunk(
    s,
    "\x1b[2J\x1b[3J\x1b[H\x1b]0;npm run dev\x07" +
      "   \x1b[1m▲ Next.js 15.1.6\x1b[22m (Turbopack)\r\n" +
      "   - Local:        http://localhost:3000\r\n" +
      "   - Network:      http://192.168.1.24:3000\r\n" +
      "\r\n" +
      " \x1b[32m✓\x1b[39m Starting...\r\n" +
      " \x1b[32m✓\x1b[39m Ready in 1.4s\r\n",
  );
  assert.equal(changed, true);
  assert.equal(s.matched, "ready");
  assert.equal(s.port, 3000); // the Local line, not the LAN address after it
});

test("a compile cycle goes building → ready, and request logs change nothing", () => {
  const s = fresh();
  scanChunk(s, " \x1b[32m✓\x1b[39m Ready in 1.4s\r\n");

  assert.equal(scanChunk(s, " \x1b[34m○\x1b[39m Compiling /checkout ...\r\n"), true);
  assert.equal(s.matched, "building");

  assert.equal(scanChunk(s, " \x1b[32m✓\x1b[39m Compiled /checkout in 892ms\r\n"), true);
  assert.equal(s.matched, "ready");

  // A server sitting in ready serves all day. Its request log must not redraw
  // the header on every line, or the poll is the cheap part.
  assert.equal(scanChunk(s, " GET /checkout 200 in 934ms\r\n"), false);
  assert.equal(s.matched, "ready");
});

test("a type error reads as error, and the fix reads as ready again", () => {
  const s = fresh();
  scanChunk(s, " \x1b[32m✓\x1b[39m Ready in 1.4s\r\n");

  scanChunk(
    s,
    " \x1b[31m⨯\x1b[39m ./app/(docs)/guide/[slug]/page.tsx:14:22\r\n" +
      " \x1b[31mType error:\x1b[39m Property 'slug' does not exist on type 'Params'.\r\n",
  );
  assert.equal(s.matched, "error");

  scanChunk(s, " \x1b[32m✓\x1b[39m Compiled /guide/[slug] in 1.1s\r\n");
  assert.equal(s.matched, "ready");
});

test("a line split across two chunks is matched once, when it is complete", () => {
  // The half-line must not match on its own…
  const s = fresh();
  assert.equal(scanChunk(s, " Type err"), false);
  assert.equal(s.matched, null);
  // …and once completed it is matched in place, so the ready line after it wins.
  scanChunk(s, "or: x\r\n \x1b[32m✓\x1b[39m Ready in 1s\r\n");
  assert.equal(s.matched, "ready");

  // The other order: a complete line, then a partial one that lands next chunk.
  const t = fresh();
  scanChunk(t, " ✓ Compiled in 1.0s\r\n Type err");
  assert.equal(t.matched, "ready");
  scanChunk(t, "or: nope\r\n");
  assert.equal(t.matched, "error");
});

test("ports come off the line the server printed them on", () => {
  const vite = fresh();
  scanChunk(vite, "  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n");
  assert.equal(vite.matched, "ready");
  assert.equal(vite.port, 5173);

  const bare = fresh();
  scanChunk(bare, "Listening on port 8080\r\n");
  assert.equal(bare.matched, "ready");
  assert.equal(bare.port, 8080);
});

test("what the rules do not know, they say nothing about", () => {
  // Rails prints its address on a line the table has no rule for: the port is
  // scraped, the state stays whatever it was. A strip with no state still shows
  // running/exited, uptime and three rows of tail, which is the point.
  const rails = fresh();
  scanChunk(rails, "* Listening on http://127.0.0.1:3000\r\n");
  assert.equal(rails.matched, null);
  assert.equal(rails.port, 3000);

  // And the documented false positive: a port in a URL that isn't being served.
  const stripe = fresh();
  scanChunk(stripe, "stripe listen --forward-to http://localhost:3000/api/hook\r\n");
  assert.equal(stripe.port, 3000);
  assert.equal(stripe.matched, null);
});

test("seeding replays lines with no escape codes in them (the xterm buffer)", () => {
  // What seedState passes in: already-parsed rows, trailing blanks and all.
  const s = fresh();
  applyRules(s, ["~/p/storefront ❯ npm run dev", "   - Local:        http://localhost:3001", " ✓ Ready in 980ms", "", ""]);
  assert.equal(s.matched, "ready");
  assert.equal(s.port, 3001);
});

test("state is read in the order it is knowable", () => {
  // A pane whose shell has gone has exited, whatever its last line said.
  assert.equal(stateOf(pane({ alive: false, running: true, matched: "ready" })), "exited");
  // Nothing in the foreground: between commands, or never used at all.
  assert.equal(stateOf(pane({ ranOnce: true })), "exited");
  assert.equal(stateOf(pane({})), "idle");
  // Something in the foreground that hasn't said anything recognisable yet.
  assert.equal(stateOf(pane({ running: true })), "starting");
  assert.equal(stateOf(pane({ running: true, matched: "building" })), "building");
});

test("an unnamed strip is titled by the directory the pane is working in", () => {
  // ⌘E wins wherever it is set, whatever the pane is working in.
  assert.equal(stripTitle({ name: "storefront", cwd: "/Users/j/src/api" }), "storefront");
  // Unnamed: the last component of the path, trailing slash or not.
  assert.equal(stripTitle({ name: "", cwd: "/Users/j/src/storefront" }), "storefront");
  assert.equal(stripTitle({ name: "", cwd: "/Users/j/src/storefront/" }), "storefront");
  // A dot-directory is a name like any other; the root has no other one.
  assert.equal(stripTitle({ name: "", cwd: "/Users/j/.config" }), ".config");
  assert.equal(stripTitle({ name: "", cwd: "/" }), "/");
  // Nothing to go on: no name, and the working directory could not be read
  // (the shell has gone, or the platform has no way to ask). The header hides
  // an empty name rather than leaving a gap where one would be.
  assert.equal(stripTitle({ name: "", cwd: null }), "");
});

test("uptime reads as a glance, not a duration", () => {
  const t0 = 1_000_000;
  const at = (s: number): string => uptimeText(t0, t0 + s * 1000);
  assert.equal(uptimeText(null, t0), "—");
  assert.equal(at(0), "0s");
  assert.equal(at(59), "59s");
  assert.equal(at(60), "1m");
  assert.equal(at(58 * 60), "58m");
  assert.equal(at(60 * 60), "1h 00m");
  assert.equal(at(72 * 60), "1h 12m"); // the uptime the wireframes draw
});
