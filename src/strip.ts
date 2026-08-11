// Which rows of a docked pane's terminal its strip shows (⌘D — server mode).
//
// A docked pane is clipped rather than resized, so the process keeps the row
// count it had and the strip slides over it (see updateClip in main.ts). Which
// rows land in the strip is the arithmetic here — split out of main.ts for the
// same reason layout.ts is, no window in it, so test/strip.test.ts can check it.

/** How many rows of the screen are in use: one past the last row with anything
    on it.

    Not the cursor's row. A dev server's cursor spends its life on the fresh
    blank line under the line it just printed, and a three-row strip cannot
    afford to spend a third of itself on it — but an interactive program draws
    *below* its cursor. fzf in `--reverse` puts its query line at the top of its
    region and the matches under it; a menu, a completion listing and a shell's
    multi-line prompt all do the same. Measuring from the bottom of the screen
    covers both: for the server, the rows under the cursor are blank and this is
    the line it just printed; for fzf, it is the last match.

    `lineAt` reads row `i` of the viewport with trailing blanks trimmed, so a
    row of spaces counts as empty. Rows are read from the bottom up and only
    until one has something on it, which is the first read in the common case. */
export function contentRows(rows: number, lineAt: (i: number) => string): number {
  let n = rows;
  while (n > 0 && lineAt(n - 1) === "") n--;
  return n;
}

/** The first row a strip `stripRows` tall shows, given `content` rows in use.

    Normally the tail: the last row in use lands on the strip's bottom edge.
    Negative before the screen has filled — the rows are pushed *down* so the
    last one still sits on that edge, which keeps new output appearing in the
    same place and makes peek reveal history above the tail rather than walk the
    tail up the screen.

    `cursorRow` is where the user is typing, or null when the program has hidden
    the cursor and there is no such place. A visible cursor above the tail pulls
    the strip up to it: fzf's query line is at the top of its region with the
    matches below, so anchoring on the tail alone would show the matches and
    clip the line being typed into. It never pulls the strip *down* — a cursor
    below the last row in use is the blank line under the tail, which is the row
    this deliberately does not spend. */
export function stripTop(content: number, stripRows: number, cursorRow: number | null): number {
  const tail = content - stripRows;
  return cursorRow != null && cursorRow < tail ? cursorRow : tail;
}
