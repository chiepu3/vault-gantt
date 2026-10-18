import { describe, it, expect } from "vitest";
import { pickTopmostAt, rectsIntersect } from "../../src/ui/rich-popover-cover";

describe("rectsIntersect", () => {
  it("is true only for a real overlap, not for touching edges", () => {
    const a = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(rectsIntersect(a, { left: 50, top: 25, right: 150, bottom: 80 })).toBe(true);
    expect(rectsIntersect(a, { left: 100, top: 0, right: 200, bottom: 50 })).toBe(false);
    expect(rectsIntersect(a, { left: 0, top: 50, right: 100, bottom: 90 })).toBe(false);
    expect(rectsIntersect(a, { left: 200, top: 200, right: 300, bottom: 300 })).toBe(false);
  });
});

describe("pickTopmostAt", () => {
  const bars = [
    { el: "low", rect: { left: 0, top: 0, right: 100, bottom: 24 } },
    { el: "high", rect: { left: 50, top: 0, right: 150, bottom: 24 } },
  ];
  it("returns the bar under the point, treating the right and bottom edges as outside like a hit test", () => {
    expect(pickTopmostAt(bars, 10, 10)).toBe("low");
    expect(pickTopmostAt(bars, 140, 10)).toBe("high");
    expect(pickTopmostAt(bars, 150, 10)).toBeUndefined();
    expect(pickTopmostAt(bars, 10, 24)).toBeUndefined();
  });
  it("prefers the later bar where two overlap (it paints on top)", () => {
    expect(pickTopmostAt(bars, 75, 10)).toBe("high");
  });
  it("returns undefined without candidates", () => {
    expect(pickTopmostAt([], 1, 1)).toBeUndefined();
  });
});
