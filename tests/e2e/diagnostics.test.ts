import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProcessState,
  formatStartupDiagnostics,
  isProcessAlive,
  readLogTail,
} from "../../tools/e2e/diagnostics.mjs";

function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-diag-"));
  const file = path.join(dir, "x.log");
  fs.writeFileSync(file, content);
  return file;
}

describe("e2e diagnostics helpers", () => {
  it("returns only the tail of a large log", () => {
    const file = tmpFile("a".repeat(100) + "TAIL");
    expect(readLogTail(file, 10)).toBe("a".repeat(6) + "TAIL");
  });

  it("handles empty and missing files without throwing", () => {
    expect(readLogTail(tmpFile(""))).toBe("(empty)");
    expect(readLogTail("/nonexistent/x.log")).toContain("unreadable");
  });

  it("formats exit and liveness", () => {
    const exited = { exited: true, code: null, signal: "SIGTRAP", alive: false };
    expect(formatProcessState("obsidian", 12, exited)).toBe("obsidian pid=12 exited code=null signal=SIGTRAP");
    const running = { exited: false, code: null, signal: null, alive: true };
    expect(formatProcessState("xvfb", 3, running)).toBe("xvfb pid=3 still running");
  });

  it("builds a diagnostics block with log tails", () => {
    const file = tmpFile("boom: sandbox failure\n");
    const out = formatStartupDiagnostics([
      { name: "obsidian", pid: 5, state: { exited: true, code: 1, signal: null, alive: false }, logFile: file },
    ]);
    expect(out).toContain("obsidian pid=5 exited code=1 signal=null");
    expect(out).toContain("boom: sandbox failure");
  });

  it("detects own process as alive and missing pid as not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(undefined)).toBe(false);
  });
});
