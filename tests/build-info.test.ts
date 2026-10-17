import { describe, expect, it } from "vitest";
import { formatBuildLabel, getBuildInfo } from "../src/build-info";

describe("build info", () => {
  it("falls back when build constants are not injected", () => {
    expect(getBuildInfo("1.2.3")).toEqual({ version: "1.2.3", commit: "unknown", builtAt: "unknown" });
  });
  it("formats version with commit, omitting an unknown commit", () => {
    expect(formatBuildLabel({ version: "0.3.0", commit: "92e8f50" })).toBe("v0.3.0 (92e8f50)");
    expect(formatBuildLabel({ version: "0.3.0", commit: "unknown" })).toBe("v0.3.0");
  });
});
