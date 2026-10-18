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
export const VIRTUAL_OVERSCAN_PX = 600;

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

/** Display width estimate of a string: CJK / full-width characters count double. */
export function textWeight(text: string | null | undefined): number {
  if (!text) return 0;
  let weight = 0;
  for (let i = 0; i < text.length; i += 1) {
    weight += text.charCodeAt(i) >= 0x2e80 ? 2 : 1;
  }
  return weight;
}

export interface WidthProbeMetrics {
  /** Estimated width of the name cell content. */
  name: number;
  /** Rows of different structure (parent / subtask) are ranked separately for the name column. */
  group: number;
  /** Estimated width of the current-status text. */
  status: number;
  /** Estimated width of the tag chips. */
  tags: number;
}

/**
 * Picks the rows that most likely set each auto-layout column's width (the
 * widest name per group, status text and tags). Rendering them in the table
 * as zero-height `visibility: collapse` rows keeps column widths the same as
 * if every row were in the DOM.
 */
export function selectWidthProbes(
  count: number,
  metricsAt: (index: number) => WidthProbeMetrics,
  perColumn = 2
): number[] {
  interface Slot {
    index: number;
    value: number;
  }
  const best = new Map<string, Slot[]>();
  const consider = (key: string, index: number, value: number): void => {
    if (value <= 0) return;
    let slots = best.get(key);
    if (!slots) {
      slots = [];
      best.set(key, slots);
    }
    if (slots.length < perColumn) {
      slots.push({ index, value });
      slots.sort((a, b) => b.value - a.value);
    } else if (value > slots[slots.length - 1].value) {
      slots[slots.length - 1] = { index, value };
      slots.sort((a, b) => b.value - a.value);
    }
  };
  for (let i = 0; i < count; i += 1) {
    const m = metricsAt(i);
    consider(`name:${m.group}`, i, m.name);
    consider("status", i, m.status);
    consider("tags", i, m.tags);
  }
  const picked = new Set<number>();
  for (const slots of best.values()) {
    for (const slot of slots) picked.add(slot.index);
  }
  return [...picked].sort((a, b) => a - b);
}
