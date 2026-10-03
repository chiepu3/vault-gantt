import { describe, it, expect } from "vitest";
import { periodText, scheduleDelta } from "../../src/ui/schedule-summary";

const before = { start: "2026-10-01", end: "2026-10-03" };
describe("read-only schedule summaries", () => {
  it.each([
    [{ start: "2026-10-04", end: "2026-10-06" }, "3日後ろへ"],
    [{ start: "2026-09-29", end: "2026-10-01" }, "2日前へ"],
    [{ start: "2026-10-01", end: "2026-10-05" }, "期間を2日延長"],
    [{ start: "2026-10-01", end: "2026-10-01" }, "期間を2日短縮"],
    [{ start: "2026-10-04", end: "2026-10-08" }, "3日後ろへ · 期間を2日延長"],
    [before, "日程変更なし"],
    [{ start: "", end: "" }, "日程解除"],
  ])("summarizes movement and duration for %o", (after, expected) => {
    const schedule = { before, after }; const snapshot = structuredClone(schedule);
    expect(scheduleDelta(schedule)).toBe(expected); expect(schedule).toEqual(snapshot);
  });
  it("labels newly assigned and unset periods explicitly", () => {
    expect(scheduleDelta({ before: { start: "", end: "" }, after: before })).toBe("日程設定");
    expect(periodText(before)).toBe("2026-10-01 ～ 2026-10-03");
    expect(periodText({ start: "", end: "" })).toBe("日程未設定");
  });
});
