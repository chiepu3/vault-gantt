import { describe, expect, it } from "vitest";
import {
  VIRTUAL_MIN_ROWS,
  buildOffsets,
  computeVirtualRange,
  extendRangeToInclude,
  findRowAtOffset,
  selectWidthProbes,
  spacerHeights,
  textWeight,
} from "../../src/app/workbench-virtual";

const uniform = (count: number, height = 35): Float64Array =>
  buildOffsets(count, () => height);

describe("buildOffsets", () => {
  it("returns prefix sums with the total at the end", () => {
    const offsets = buildOffsets(4, (i) => [10, 20, 30, 40][i]);
    expect(Array.from(offsets)).toEqual([0, 10, 30, 60, 100]);
  });

  it("handles zero rows", () => {
    expect(Array.from(buildOffsets(0, () => 5))).toEqual([0]);
  });
});

describe("findRowAtOffset", () => {
  const offsets = buildOffsets(5, () => 10); // 0,10,20,30,40,50

  it("finds the row containing y", () => {
    expect(findRowAtOffset(offsets, 0)).toBe(0);
    expect(findRowAtOffset(offsets, 9.9)).toBe(0);
    expect(findRowAtOffset(offsets, 10)).toBe(1);
    expect(findRowAtOffset(offsets, 49)).toBe(4);
  });

  it("clamps outside the table", () => {
    expect(findRowAtOffset(offsets, -100)).toBe(0);
    expect(findRowAtOffset(offsets, 50)).toBe(4);
    expect(findRowAtOffset(offsets, 9999)).toBe(4);
  });

  it("returns -1 for an empty table", () => {
    expect(findRowAtOffset(new Float64Array(1), 5)).toBe(-1);
  });

  it("works with variable heights", () => {
    const o = buildOffsets(4, (i) => [30, 60, 30, 100][i]); // 0,30,90,120,220
    expect(findRowAtOffset(o, 29)).toBe(0);
    expect(findRowAtOffset(o, 30)).toBe(1);
    expect(findRowAtOffset(o, 119)).toBe(2);
    expect(findRowAtOffset(o, 120)).toBe(3);
  });
});

describe("computeVirtualRange", () => {
  it("renders small tables in full", () => {
    const offsets = uniform(VIRTUAL_MIN_ROWS);
    expect(
      computeVirtualRange({ offsets, viewTop: 0, viewHeight: 500 })
    ).toEqual({ start: 0, end: VIRTUAL_MIN_ROWS });
  });

  it("covers the viewport plus overscan at the top", () => {
    const offsets = uniform(1000);
    const range = computeVirtualRange({
      offsets,
      viewTop: 0,
      viewHeight: 700,
      overscanPx: 350,
    });
    expect(range.start).toBe(0);
    // bottom edge = 700 + 350 = 1050px -> row 30 (30 * 35 = 1050), inclusive
    expect(range.end).toBe(31);
  });

  it("is centred on the viewport mid-table", () => {
    const offsets = uniform(1000);
    const range = computeVirtualRange({
      offsets,
      viewTop: 10_000,
      viewHeight: 700,
      overscanPx: 350,
    });
    expect(offsets[range.start]).toBeLessThanOrEqual(10_000 - 350);
    expect(offsets[range.end]).toBeGreaterThanOrEqual(10_000 + 700 + 350);
    expect(range.end - range.start).toBeLessThanOrEqual(42);
  });

  it("clamps at the bottom and with a viewport above the first row", () => {
    const offsets = uniform(1000);
    const bottom = computeVirtualRange({
      offsets,
      viewTop: 40_000,
      viewHeight: 700,
    });
    expect(bottom.end).toBe(1000);
    expect(bottom.start).toBeGreaterThan(900);
    const above = computeVirtualRange({
      offsets,
      viewTop: -32,
      viewHeight: 700,
      overscanPx: 0,
    });
    expect(above.start).toBe(0);
  });

  it("renders only the visible rows with zero overscan", () => {
    const offsets = uniform(1000);
    const range = computeVirtualRange({
      offsets,
      viewTop: 3500,
      viewHeight: 350,
      overscanPx: 0,
    });
    expect(range.start).toBe(100);
    expect(range.end).toBe(111);
  });

  it("uses measured (variable) heights", () => {
    const offsets = buildOffsets(500, (i) => (i % 2 === 0 ? 20 : 80));
    const range = computeVirtualRange({
      offsets,
      viewTop: 5000,
      viewHeight: 400,
      overscanPx: 0,
    });
    expect(offsets[range.start]).toBeLessThanOrEqual(5000);
    expect(offsets[range.start + 1]).toBeGreaterThan(5000);
    expect(offsets[range.end - 1]).toBeLessThan(5400 + 1);
    expect(offsets[range.end]).toBeGreaterThan(5400);
  });
});

describe("extendRangeToInclude / spacerHeights", () => {
  it("extends below and above, and ignores out-of-range indices", () => {
    const base = { start: 10, end: 20 };
    expect(extendRangeToInclude(base, 5, 100)).toEqual({ start: 5, end: 20 });
    expect(extendRangeToInclude(base, 50, 100)).toEqual({ start: 10, end: 51 });
    expect(extendRangeToInclude(base, 15, 100)).toEqual(base);
    expect(extendRangeToInclude(base, -1, 100)).toEqual(base);
    expect(extendRangeToInclude(base, 100, 100)).toEqual(base);
  });

  it("spacers plus rendered rows add up to the total height", () => {
    const offsets = buildOffsets(200, (i) => 30 + (i % 3));
    const range = { start: 40, end: 90 };
    const { top, bottom } = spacerHeights(offsets, range);
    const rendered = offsets[range.end] - offsets[range.start];
    expect(top + rendered + bottom).toBeCloseTo(offsets[200], 6);
    expect(top).toBe(offsets[40]);
  });
});

describe("selectWidthProbes", () => {
  it("picks the widest rows per column and group, deduplicated and sorted", () => {
    const data = [
      { name: 10, group: 0, status: 0, tags: 0 },
      { name: 90, group: 0, status: 5, tags: 0 },
      { name: 50, group: 1, status: 0, tags: 40 },
      { name: 70, group: 1, status: 99, tags: 0 },
      { name: 20, group: 1, status: 0, tags: 0 },
    ];
    const picked = selectWidthProbes(data.length, (i) => data[i], 1);
    // name group 0 -> row 1, name group 1 -> row 3, status -> row 3, tags -> row 2
    expect(picked).toEqual([1, 2, 3]);
  });

  it("returns nothing when every metric is zero", () => {
    expect(
      selectWidthProbes(3, () => ({ name: 0, group: 0, status: 0, tags: 0 }))
    ).toEqual([]);
  });

  it("is bounded by perColumn regardless of the row count", () => {
    const picked = selectWidthProbes(
      5000,
      (i) => ({ name: i % 97, group: 0, status: i % 89, tags: i % 83 }),
      2
    );
    expect(picked.length).toBeLessThanOrEqual(6);
  });
});

describe("textWeight", () => {
  it("counts full-width characters double", () => {
    expect(textWeight("abc")).toBe(3);
    expect(textWeight("あい")).toBe(4);
    expect(textWeight("")).toBe(0);
    expect(textWeight(undefined)).toBe(0);
  });
});
