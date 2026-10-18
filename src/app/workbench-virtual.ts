/**
 * Pure virtual-scroll math for the task workbench table.
 *
 * Rows have variable (measured) heights, so everything is expressed through a
 * prefix-sum `offsets` array: `offsets[i]` is the top of row i relative to the
 * top of the tbody and `offsets[count]` is the total height.
 */

/** Tables up to this many rows are rendered in full (identical to the legacy layout). */
export const VIRTUAL_MIN_ROWS = 120;

/** Pixels rendered above and below the visible area. */
export const VIRTUAL_OVERSCAN_PX = 900;

/** Row height guess before anything has been measured. */
export const VIRTUAL_DEFAULT_ROW_HEIGHT = 35;

export interface VirtualRange {
  /** First rendered row index (inclusive). */
  start: number;
  /** One past the last rendered row index (exclusive). */
  end: number;
}

/** Builds the prefix-sum offsets (length count + 1). */
export function buildOffsets(
  count: number,
  heightAt: (index: number) => number
): Float64Array {
  const offsets = new Float64Array(count + 1);
  let acc = 0;
  for (let i = 0; i < count; i += 1) {
    offsets[i] = acc;
    acc += heightAt(i);
  }
  offsets[count] = acc;
  return offsets;
}

/** Index of the row containing offset y (clamped to [0, count - 1]); -1 for no rows. */
export function findRowAtOffset(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return -1;
  if (y <= 0) return 0;
  if (y >= offsets[count]) return count - 1;
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Range of rows to render for the viewport [viewTop, viewTop + viewHeight)
 * (tbody coordinates) plus `overscanPx` on both sides. Small tables
 * (<= minRows) are rendered in full.
 */
export function computeVirtualRange(args: {
  offsets: Float64Array;
  viewTop: number;
  viewHeight: number;
  overscanPx?: number;
  minRows?: number;
}): VirtualRange {
  const count = args.offsets.length - 1;
  const minRows = args.minRows ?? VIRTUAL_MIN_ROWS;
  if (count <= minRows) return { start: 0, end: Math.max(0, count) };
  const overscan = args.overscanPx ?? VIRTUAL_OVERSCAN_PX;
  const top = Math.max(0, args.viewTop - overscan);
  const bottom = args.viewTop + Math.max(0, args.viewHeight) + overscan;
  const start = findRowAtOffset(args.offsets, top);
  const last = findRowAtOffset(args.offsets, bottom);
  return { start, end: Math.min(count, last + 1) };
}

/** Grows the range so that it contains `index` (no-op for out-of-range indices). */
export function extendRangeToInclude(
  range: VirtualRange,
  index: number,
  count: number
): VirtualRange {
  if (index < 0 || index >= count) return range;
  return {
    start: Math.min(range.start, index),
    end: Math.max(range.end, index + 1),
  };
}

/** Spacer heights above and below the rendered range. */
export function spacerHeights(
  offsets: Float64Array,
  range: VirtualRange
): { top: number; bottom: number } {
  const count = offsets.length - 1;
  if (count <= 0) return { top: 0, bottom: 0 };
  return {
    top: offsets[range.start],
    bottom: offsets[count] - offsets[range.end],
  };
}
