import { PARENT_COL_WIDTH } from "../app/gantt-constants";

/**
 * A bar title keeps its start visible when the bar is scrolled under the
 * sticky parent-name column: the title sits at least `326px` (the 320px
 * column + 6px) from the scroll viewport's left edge, but never leaves its
 * bar. Doing that with `position: sticky` on every title made each one a
 * compositor layer plus a sticky constraint, so every layout, hover and
 * scroll frame paid for thousands of them. Only bars that actually overlap
 * that edge need a shift, so this tracker computes the same offset in JS and
 * applies it as `transform: translateX(...)` to just those titles, on scroll.
 * Every other title is plain static content.
 */
export const STICKY_TITLE_OFFSET_PX = PARENT_COL_WIDTH + 6;
/** Rows this far outside the viewport are not updated until they approach it. */
export const STICKY_TITLE_ROW_MARGIN_PX = 300;
/** The bar's 1px border sits between the bar edge and its title. */
const BAR_BORDER_PX = 1;

interface RectLike { top: number; bottom: number; width: number }
interface TitleLike { style: { transform: string }; getBoundingClientRect(): RectLike }
interface RowLike { isConnected: boolean; getBoundingClientRect(): RectLike }
interface BarEntry {
  title: TitleLike;
  /** Bar border-box left edge in the scroll content, and its width. */
  x0: number;
  width: number;
  /** Title border-box width, measured the first time the bar overlaps the edge. */
  titleWidth: number;
  shift: number;
}
interface RowEntry { row: RowLike; bars: BarEntry[] }
export interface StickyViewport { scrollLeft: number; scrollTop: number; top: number; bottom: number }
export interface StickyBarInput { el: object; title: TitleLike | undefined; left: number; width: number }

/** The sticky offset for a title: how far it must move right to stay at the viewport's left offset, capped to its bar. */
export function stickyTitleShift(scrollLeft: number, barX0: number, barWidth: number, titleWidth: number): number {
  const wanted = scrollLeft + STICKY_TITLE_OFFSET_PX - (barX0 + BAR_BORDER_PX);
  if (wanted <= 0) return 0;
  const room = barWidth - 2 * BAR_BORDER_PX - titleWidth;
  return room <= 0 ? 0 : Math.min(wanted, room);
}

export class StickyTitleTracker {
  private rows = new Map<RowLike, RowEntry>();
  private byEl = new WeakMap<object, BarEntry>();
  private scrollLeft = 0;
  private lastKey = "";

  /** Registers one parent row; `left` is relative to the row's timeline, as the bar's style.left. */
  register(row: RowLike, bars: Iterable<StickyBarInput>): void {
    const entries: BarEntry[] = [];
    for (const bar of bars) {
      if (bar.title === undefined) continue;
      const entry: BarEntry = { title: bar.title, x0: PARENT_COL_WIDTH + bar.left, width: bar.width, titleWidth: -1, shift: 0 };
      entries.push(entry);
      this.byEl.set(bar.el, entry);
    }
    this.rows.set(row, { row, bars: entries });
    this.lastKey = "";
  }

  /**
   * Applies the sticky offset to every title of the rows near the viewport.
   * `top`/`bottom` are the scroll viewport's client rect; rows are located by
   * their live rect so row-height changes never leave a stale cache.
   */
  update(view: StickyViewport): void {
    const key = `${view.scrollLeft}|${view.scrollTop}|${view.top}|${view.bottom}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.scrollLeft = view.scrollLeft;
    const rowTop = view.top - STICKY_TITLE_ROW_MARGIN_PX, rowBottom = view.bottom + STICKY_TITLE_ROW_MARGIN_PX;
    // Reads first (row rects, title widths), writes after, so no read sees a layout the writes invalidated.
    const pending: [BarEntry, number][] = [];
    for (const entry of this.rows.values()) {
      if (!entry.row.isConnected) { this.rows.delete(entry.row); continue; }
      const rect = entry.row.getBoundingClientRect();
      if (rect.bottom <= rowTop || rect.top >= rowBottom) continue;
      for (const bar of entry.bars) {
        // Bars wholly right of the edge, or already unshifted, are the common case: no measurement, no write.
        if (bar.shift === 0 && view.scrollLeft + STICKY_TITLE_OFFSET_PX <= bar.x0 + BAR_BORDER_PX) continue;
        if (bar.titleWidth < 0) bar.titleWidth = bar.title.getBoundingClientRect().width;
        const shift = stickyTitleShift(view.scrollLeft, bar.x0, bar.width, bar.titleWidth);
        if (shift !== bar.shift) pending.push([bar, shift]);
      }
    }
    for (const [bar, shift] of pending) this.apply(bar, shift);
  }

  private apply(bar: BarEntry, shift: number): void {
    bar.shift = shift;
    bar.title.style.transform = shift === 0 ? "" : `translateX(${shift}px)`;
  }

  /** A bar's live geometry changed (drag preview): re-place just its title against the last scroll offset. */
  setGeometry(el: object, left: number, width: number): void {
    const bar = this.byEl.get(el);
    if (bar === undefined) return;
    bar.x0 = PARENT_COL_WIDTH + left;
    bar.width = width;
    if (bar.titleWidth < 0 && this.scrollLeft + STICKY_TITLE_OFFSET_PX > bar.x0 + BAR_BORDER_PX) bar.titleWidth = bar.title.getBoundingClientRect().width;
    const shift = bar.titleWidth < 0 ? 0 : stickyTitleShift(this.scrollLeft, bar.x0, bar.width, bar.titleWidth);
    if (shift !== bar.shift) this.apply(bar, shift);
  }

  /** Forces the next update to re-evaluate every row (after geometry changed). */
  invalidate(): void { this.lastKey = ""; }

  clear(): void { this.rows.clear(); this.lastKey = ""; }
}
