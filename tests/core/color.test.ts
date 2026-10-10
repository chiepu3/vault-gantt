import { describe, it, expect } from "vitest";
import {
  BAR_TEXT_DARK,
  BAR_TEXT_LIGHT,
  readableTextColor,
} from "../../src/core/color";

describe("readableTextColor", () => {
  it("returns white on dark backgrounds and black on light ones", () => {
    expect(readableTextColor("#2563eb")).toBe(BAR_TEXT_LIGHT);
    expect(readableTextColor("#7c3aed")).toBe(BAR_TEXT_LIGHT);
    expect(readableTextColor("#dc2626")).toBe(BAR_TEXT_LIGHT);
    expect(readableTextColor("#000000")).toBe(BAR_TEXT_LIGHT);
    expect(readableTextColor("#ffffff")).toBe(BAR_TEXT_DARK);
    expect(readableTextColor("#facc15")).toBe(BAR_TEXT_DARK);
  });

  it("switches to black for the default tag colors whose white text is below AA", () => {
    expect(readableTextColor("#16a34a")).toBe(BAR_TEXT_DARK);
    expect(readableTextColor("#d97706")).toBe(BAR_TEXT_DARK);
    expect(readableTextColor("#0891b2")).toBe(BAR_TEXT_DARK);
  });

  it("accepts 3-digit hex and is case-insensitive", () => {
    expect(readableTextColor("#FFF")).toBe(BAR_TEXT_DARK);
    expect(readableTextColor("#000")).toBe(BAR_TEXT_LIGHT);
    expect(readableTextColor(" #2563EB ")).toBe(BAR_TEXT_LIGHT);
  });

  it("returns undefined for non-hex values", () => {
    expect(readableTextColor("")).toBeUndefined();
    expect(readableTextColor("red")).toBeUndefined();
    expect(readableTextColor("rgb(0,0,0)")).toBeUndefined();
    expect(readableTextColor("#12345")).toBeUndefined();
  });
});
