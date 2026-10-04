import { describe, it, expect, vi, afterEach } from "vitest";
import { compactDelta, renderScheduleTimeline } from "../../src/ui/schedule-timeline";
import { createFakeDocument, makeFakeEl, byClass } from "../stubs/fake-dom";

afterEach(() => vi.unstubAllGlobals());
const schedule = { before: { start: "2026-10-01", end: "2026-10-03" }, after: { start: "2026-10-04", end: "2026-10-06" } };
describe("compact shared-axis result timeline", () => {
  it("places old/new on the same date scale and exposes full periods without prose", () => {
    vi.stubGlobal("document", createFakeDocument()); const root = makeFakeEl(); const snapshot = structuredClone(schedule);
    renderScheduleTimeline(root as unknown as HTMLElement, schedule);
    const bars = byClass(root, "vg-ai-mini-bar");
    expect(bars).toHaveLength(2); expect(bars[0].style).toMatchObject({ left: "0%", width: "50%" });
    expect(bars[1].style).toMatchObject({ left: "50%", width: "50%" });
    expect(byClass(root, "vg-ai-mini-delta")[0].textContent).toBe("+3d");
    expect(byClass(root, "vg-ai-mini-timeline")[0].getAttribute("aria-label")).toContain("3日後ろへ");
    expect(schedule).toEqual(snapshot);
  });
  it("represents removed dates explicitly and retains the old period", () => {
    vi.stubGlobal("document", createFakeDocument()); const root = makeFakeEl();
    renderScheduleTimeline(root as unknown as HTMLElement, { ...schedule, after: { start: "", end: "" } });
    expect(byClass(root, "vg-ai-mini-bar")).toHaveLength(1); expect(byClass(root, "vg-ai-mini-unset")[0].textContent).toBe("未設定");
  });
  it("keeps backward movement and duration deltas signed", () => {
    expect(compactDelta({ ...schedule, after: { start: "2026-09-29", end: "2026-10-03" } })).toBe("-2d · 期間+2d");
  });
});
