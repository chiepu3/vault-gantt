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
  it("never presents a one-sided period as a complete range or as a cleared one", () => {
    expect(periodText({ start: null, end: "2026-10-15" })).toBe("開始日未設定 ～ 2026-10-15");
    expect(periodText({ start: "2026-10-13", end: "" })).toBe("2026-10-13 ～ 終了日未設定");
    expect(scheduleDelta({ before, after: { start: null, end: "2026-10-15" } })).toBe("両日を設定".replace("両日を設定", "片日のみ設定"));
    expect(scheduleDelta({ before: { start: null, end: null }, after: { start: null, end: "2026-10-15" } })).toBe("片日のみ設定");
    expect(scheduleDelta({ before: { start: null, end: "2026-10-15" }, after: before })).toBe("両日を設定");
    expect(scheduleDelta({ before: { start: null, end: "2026-10-15" }, after: { start: null, end: null } })).toBe("日程解除");
  });
});
