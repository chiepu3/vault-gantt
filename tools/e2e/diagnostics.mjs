// tools/e2e/diagnostics.mjs
// Pure, secret-free helpers for the failure diagnostics of the E2E runtime.
// Only exit status, liveness and the tail of the harness's own Xvfb/Obsidian
// log files are reported — never env vars, user data or vault content.

import fs from "node:fs";

const DEFAULT_TAIL_BYTES = 4096;

/**
 * Last `maxBytes` of a text file (whole file if smaller). Never throws:
 * a missing/unreadable file yields a short placeholder.
 */
export function readLogTail(file, maxBytes = DEFAULT_TAIL_BYTES) {
  try {
    const { size } = fs.statSync(file);
    const length = Math.min(size, maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, size - length);
      const text = buf.toString("utf8").trimEnd();
      return text === "" ? "(empty)" : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `(unreadable: ${err.code ?? err.message})`;
  }
}

/** Whether `pid` is still alive (signal 0 probe). */
export function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Tracks the exit of a spawned child. `state()` reports exit code/signal once
 * the child has exited, or `alive` while it is still running.
 */
export function trackExit(proc) {
  const exit = { exited: false, code: null, signal: null };
  proc.once("exit", (code, signal) => {
    exit.exited = true;
    exit.code = code;
    exit.signal = signal;
  });
  return {
    pid: proc.pid,
    state: () => ({ ...exit, alive: !exit.exited && isProcessAlive(proc.pid) }),
  };
}

/** One-line description of a tracked process state. */
export function formatProcessState(name, pid, state) {
  if (state.exited) {
    return `${name} pid=${pid ?? "n/a"} exited code=${state.code} signal=${state.signal}`;
  }
  return `${name} pid=${pid ?? "n/a"} ${state.alive ? "still running" : "not running (no exit event)"}`;
}

/**
 * Multi-line diagnostic block appended to startup failure errors.
 * `entries`: [{ name, pid, state, logFile }]
 */
export function formatStartupDiagnostics(entries, { tailBytes = DEFAULT_TAIL_BYTES } = {}) {
  const lines = ["--- startup diagnostics ---"];
  for (const { name, pid, state, logFile } of entries) {
    lines.push(formatProcessState(name, pid, state));
    if (logFile) {
      lines.push(`--- ${name} log tail (${logFile}) ---`, readLogTail(logFile, tailBytes));
    }
  }
  lines.push("--- end diagnostics ---");
  return lines.join("\n");
}
