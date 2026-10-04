import { describe, expect, it } from "vitest";
import {
  assertSandboxEnabled,
  ancestry,
  findSandboxDisableFlags,
  listDescendants,
  parseCmdline,
} from "../../tools/e2e/sandbox-assert.mjs";

describe("sandbox-assert", () => {
  it("flags every sandbox-disabling switch", () => {
    expect(
      findSandboxDisableFlags([
        "--type=renderer",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-seccomp-filter-sandbox",
        "--disable-gpu",
      ])
    ).toEqual(["--no-sandbox", "--disable-setuid-sandbox", "--disable-seccomp-filter-sandbox"]);
  });

  it("accepts a clean argv", () => {
    expect(findSandboxDisableFlags(["--type=renderer", "--disable-gpu", "--user-data-dir=/x"])).toEqual([]);
  });

  it("parses NUL-separated cmdline", () => {
    expect(parseCmdline("a\0--b\0")).toEqual(["a", "--b"]);
  });

  it("lists the current process as its own descendant root", () => {
    expect(listDescendants(process.pid)).toContain(process.pid);
  });

  it("walks the ppid chain up to the root pid", () => {
    expect(ancestry(process.pid, process.pid)).toEqual([process.pid]);
    const chain = ancestry(process.pid, process.ppid);
    expect(chain).toEqual([process.pid, process.ppid]);
  });

  it("fails closed when the chrome-sandbox helper is not root:root 4755", async () => {
    // process.execPath's dir has no chrome-sandbox, and a test run is not root.
    const cdp = { evaluate: async () => JSON.stringify({ argv: [], pid: process.pid, sandboxed: null }) };
    await expect(assertSandboxEnabled(process.pid, cdp)).rejects.toThrow(/chrome-sandbox/);
  });
});
