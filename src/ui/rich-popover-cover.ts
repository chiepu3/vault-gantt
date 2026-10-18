/** Geometry helpers for finding the bar the pointer rests on beneath an open rich popover. */
export interface CoverRect { left: number; top: number; right: number; bottom: number }

export function rectsIntersect(a: CoverRect, b: CoverRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * The topmost candidate under the point. Candidates are in document order, and
 * a later bar paints above an earlier one, so the last containing match wins —
 * the same bar `document.elementsFromPoint(...)` listed first.
 */
export function pickTopmostAt<T>(candidates: readonly { el: T; rect: CoverRect }[], x: number, y: number): T | undefined {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const { el, rect } = candidates[i];
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return el;
  }
  return undefined;
}
