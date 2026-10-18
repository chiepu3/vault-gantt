import { describe, it, expect } from "vitest";
import { STICKY_TITLE_OFFSET_PX, StickyTitleTracker, stickyTitleShift } from "../../src/ui/gantt-sticky-titles";
import { PARENT_COL_WIDTH } from "../../src/app/gantt-constants";

const title = (width: number) => ({ style: { transform: "" }, width, reads: 0, getBoundingClientRect() { this.reads += 1; return { top: 0, bottom: 24, width: this.width }; } });
const row = (top: number, bottom = top + 300) => ({ isConnected: true, getBoundingClientRect: () => ({ top, bottom, width: 0 }) });
const view = (scrollLeft: number, scrollTop = 0) => ({ scrollLeft, scrollTop, top: 100, bottom: 900 });
const bar = (left: number, width: number, t = title(60)) => ({ el: {}, title: t, left, width });

describe("stickyTitleShift (the old `position: sticky; left: 326px` as arithmetic)", () => {
  it("does not move a title whose bar starts right of the sticky offset", () => {
    // bar x0 = 320 + 100 = 420, border 1 => title at 421; the offset line is at scrollLeft + 326
    expect(stickyTitleShift(0, 420, 200, 80)).toBe(0);
    expect(stickyTitleShift(95, 420, 200, 80)).toBe(0);
  });
  it("moves the title one pixel per scrolled pixel once the bar crosses the offset line", () => {
    expect(stickyTitleShift(100, 420, 200, 80)).toBe(100 + 326 - 421);
    expect(stickyTitleShift(150, 420, 200, 80)).toBe(55);
  });
  it("keeps the title inside its bar (content box) at the bar's right end", () => {
    // room = 200 - 2 - 80 = 118
    expect(stickyTitleShift(400, 420, 200, 80)).toBe(118);
    expect(stickyTitleShift(5000, 420, 200, 80)).toBe(118);
  });
  it("never moves a title that already fills its bar", () => {
    expect(stickyTitleShift(300, 420, 100, 98)).toBe(0);
    expect(stickyTitleShift(300, 420, 100, 120)).toBe(0);
  });
  it("uses the 320px name column plus 6px as the offset", () => {
    expect(STICKY_TITLE_OFFSET_PX).toBe(PARENT_COL_WIDTH + 6);
  });
});

describe("StickyTitleTracker", () => {
  it("transforms only the titles whose bars overlap the left edge and clears them when they leave", () => {
    const tracker = new StickyTitleTracker();
    const far = title(60), crossing = title(60);
    tracker.register(row(120), [bar(2000, 150, far), bar(50, 200, crossing)]);
    tracker.update(view(100));
    expect(crossing.style.transform).toBe(`translateX(${100 + 326 - (320 + 50 + 1)}px)`);
    expect(far.style.transform).toBe("");
    tracker.update(view(0));
    expect(crossing.style.transform).toBe("");
  });

  it("measures a title width only once and only when it first needs a shift", () => {
    const tracker = new StickyTitleTracker();
    const t = title(60), idle = title(60);
    tracker.register(row(120), [bar(50, 200, t), bar(3000, 100, idle)]);
    tracker.update(view(0));
    expect(t.reads).toBe(0);
    tracker.update(view(150)); tracker.update(view(160)); tracker.update(view(170));
    expect(t.reads).toBe(1);
    expect(idle.reads).toBe(0);
  });

  it("leaves rows far outside the viewport alone", () => {
    const tracker = new StickyTitleTracker();
    const offscreen = title(60), near = title(60);
    tracker.register(row(5000), [bar(50, 200, offscreen)]);
    tracker.register(row(500), [bar(50, 200, near)]);
    tracker.update(view(150));
    expect(offscreen.style.transform).toBe("");
    expect(near.style.transform).not.toBe("");
  });

  it("skips bars without an inline title (their label is external)", () => {
    const tracker = new StickyTitleTracker();
    const t = title(60);
    tracker.register(row(120), [{ el: {}, title: undefined, left: 50, width: 200 }, bar(50, 200, t)]);
    expect(() => tracker.update(view(150))).not.toThrow();
    expect(t.style.transform).not.toBe("");
  });

  it("follows a dragged bar's live geometry and resets when the drag restores it", () => {
    const tracker = new StickyTitleTracker();
    const t = title(60), el = {};
    tracker.register(row(120), [{ el, title: t, left: 50, width: 200 }]);
    tracker.update(view(150));
    expect(t.style.transform).not.toBe("");
    tracker.setGeometry(el, 900, 200); // dragged far right, away from the edge
    expect(t.style.transform).toBe("");
    tracker.setGeometry(el, 50, 200); // drag ended, original geometry back
    expect(t.style.transform).toBe(`translateX(${150 + 326 - (320 + 50 + 1)}px)`);
  });

  it("forgets rows that left the document", () => {
    const tracker = new StickyTitleTracker();
    const t = title(60), r = row(120);
    tracker.register(r, [bar(50, 200, t)]);
    r.isConnected = false;
    tracker.update(view(150));
    expect(t.style.transform).toBe("");
  });
});
