/**
 * The three view modes, drawn rather than named.
 *
 * The sidebar had accumulated too many words: `List` and `Grid`, then `Small` and `Large` appearing
 * beside them once you were in the grid. Four text buttons for three states, in a column that also
 * carries All, Unplaced, Invert and the section headers — and the eye has no way to skim past a
 * word the way it skims past a shape.
 *
 * Icons work here specifically because **a view mode is a layout, and a layout is a picture of
 * itself**. A row of thumbnails with lines beside them, a coarse grid, a fine grid: each icon is a
 * small diagram of what the pane will look like. That is the rare case where a symbol is clearer
 * than its own name — `Small` and `Large` never said *small what*, whereas nine squares against
 * four is unambiguous without a caption.
 *
 * Same drawing conventions as `Wordmark.tsx`: inline SVG so there is no request and no second asset
 * for dark mode, `currentColor` so the pressed state colours the icon along with its button, and
 * `aria-hidden` because the button carries the accessible name.
 *
 * ## The tiles are filled, and that is arithmetic rather than taste
 *
 * They were outlined first, like the wordmark. It does not survive the sums. A stroke is centred on
 * the path, so a 1.5 stroke takes 0.75 from each side of the gap between two cells; the fine grid's
 * nine 5-unit squares leave gaps of 1.5, so the strokes of neighbouring cells **exactly meet** and
 * the whole icon renders as one solid mesh. Widening the gaps enough to survive that would leave
 * cells too small to read at 18px, and thinning the stroke to compensate makes the icon fainter
 * than everything around it.
 *
 * Filled cells have no such problem: the gap you draw is the gap you get. It also puts the two
 * grids on the same footing as each other, which matters more than matching the wordmark — the one
 * thing these icons must do is be *distinguishable at a glance*.
 *
 * The list keeps a stroked pair of text lines, because a filled line is just a thicker line.
 */

/** Only the list's text lines are stroked now, and lighter than the wordmark's 1.7 at this size. */
const STROKE = 1.5;

function Icon({ children }: { readonly children: React.ReactNode }) {
  return (
    <svg
      className="view-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/**
 * The list: a thumbnail with its details beside it, twice.
 *
 * Not the usual three plain horizontal lines. That glyph means "a list of text", and this list's
 * whole point is that every row carries the photograph — so the square has to be in it, or the icon
 * describes a different view from the one it selects.
 *
 * The second line of each row is short, which is what makes two lines read as *text* rather than as
 * two more rules.
 */
export function ListIcon() {
  return (
    <Icon>
      {[5, 13].map((y) => (
        <g key={y}>
          <rect x="3.25" y={y} width="6" height="6" rx="1.2" />
          <path
            d={`M12.5 ${y + 2.3}h8.25`}
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
          <path
            d={`M12.5 ${y + 5.4}h5.25`}
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        </g>
      ))}
    </Icon>
  );
}

/**
 * The fine grid: nine tiles, so more photographs at once and no room for words.
 *
 * 5-unit cells on a 6.5 pitch — a 1.5 gap that stays a 1.5 gap, because nothing is stroked.
 */
export function GridSmallIcon() {
  return (
    <Icon>
      {[3, 9.5, 16].map((y) => [3, 9.5, 16].map((x) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="5" height="5" rx="1" />
      )))}
    </Icon>
  );
}

/** The coarse grid: four tiles, big enough to recognise a frame by eye. */
export function GridLargeIcon() {
  return (
    <Icon>
      {[3.25, 13.25].map((y) => [3.25, 13.25].map((x) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="7.5" height="7.5" rx="1.4" />
      )))}
    </Icon>
  );
}
