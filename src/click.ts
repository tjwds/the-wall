// Where a mousedown inside a pane landed, which is what says whether the click
// can be left to the browser or has to be taken off it. Split out of main.ts for
// the same reason strip.ts is — no window in it, so test/click.test.ts can check
// it — and it reads only the two lookups every Element has.

/** The three parts of a pane a pointer can land on.

    - `terminal` — xterm's own element, rows and padding alike. Its mousedown
      handler focuses the terminal and calls preventDefault itself, and the
      listeners it hangs off the event are what drag-select, so the click is
      xterm's and nothing here should take it.

    - `editor` — the ⌘E name field (see startRename). A real input: it takes the
      focus and the caret from the browser's own handling of the click, so the
      pane must neither steal that focus back nor suppress the default that
      places the caret.

    - `chrome` — the pane's own furniture: a docked pane's status header, the
      padding its clip-path takes out of the hit test along with the pixels it
      hides, the border, and the sliver left under a tiled pane's last row.
      These are the clicks that focus has to be held onto by hand. None of it is
      focusable, and mousedown's default action moves focus to the nearest
      focusable ancestor of what was clicked — of which there is none, so the
      browser *clears* the focus, textarea included. Focusing the terminal in
      the handler is not enough: the default action runs after it, and takes it
      straight back off. Nearly half a three-row strip's height is chrome (a
      20px header and 13px of clipped padding, against 3 rows of terminal), so
      on a docked pane this is the common click rather than the corner case. */
export type PaneRegion = "terminal" | "editor" | "chrome";

/** The ⌘E name field, which is a child of the pane and not of the terminal. */
const NAME_EDITOR = ".pane-name-input";

/** Classify a mousedown target inside a pane. `term` is the pane's terminal
    element, or null before xterm has opened one. */
export function clickRegion(target: Element | null, term: Element | null): PaneRegion {
  if (!target) return "chrome";
  if (target.closest(NAME_EDITOR)) return "editor";
  return term?.contains(target) ? "terminal" : "chrome";
}
