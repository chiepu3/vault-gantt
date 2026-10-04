// tools/e2e/sandbox-assert.mjs
// Evidence-based guard that the REAL Obsidian process tree was NOT launched
// with any Chromium sandbox bypass. Reads only argv (/proc/<pid>/cmdline) of
// the harness's own descendants and whether CHROME_DEVEL_SANDBOX is set — env
// values are never logged.
//
// What this proves: no process in the tree carries a sandbox-disable flag, no
// CHROME_DEVEL_SANDBOX override is present, and the CDP-visible renderer
// (identified via its own process.pid/argv) is a --type=renderer process
// descended from this tree. Combined with the CI-verified
// root:root 4755 chrome-sandbox helper, Chromium would abort at startup rather
// than silently run unsandboxed, so a successful launch means no bypass.
//
// What this does NOT prove: that this renderer is OS-sandboxed. Obsidian
// renderers use Node integration, so Electron's `process.sandboxed` may be
// false and the renderer's seccomp state may be 0; neither is asserted. They
// are only logged as observed evidence ("seccomp" / "sandboxed" below).

import fs from "node:fs";

const FORBIDDEN_FLAG = /^--(no-sandbox|disable-[a-z-]*sandbox|no-zygote-sandbox)(=|$)/;

/** Sandbox-disabling flags found in an argv list. */
export function findSandboxDisableFlags(argv) {
  return argv.filter((arg) => FORBIDDEN_FLAG.test(arg));
}

/** Parses the raw NUL-separated /proc/<pid>/cmdline content. */
export function parseCmdline(raw) {
  return raw.split("\0").filter((s) => s !== "");
}

function readProc(pid, file) {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
}

/** {comm, ppid} from /proc/<pid>/stat, or null when the process is gone. */
function readStat(pid) {
  const stat = readProc(pid, "stat");
  if (!stat) return null;
  // comm may contain spaces/parens; ppid is the 2nd field after the last ')'.
  const close = stat.lastIndexOf(")");
  return {
    comm: stat.slice(stat.indexOf("(") + 1, close),
    ppid: Number(stat.slice(close + 2).split(" ")[1]),
  };
}

/** All descendant pids of rootPid (inclusive), from /proc/<pid>/stat ppids. */
export function listDescendants(rootPid) {
  const children = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const st = readStat(name);
    if (!st) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(Number(name));
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    out.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** ppid chain from pid upwards (inclusive), stopping at rootPid, 0/1 or a loop. */
export function ancestry(pid, rootPid) {
  const chain = [pid];
  while (chain[chain.length - 1] !== rootPid) {
    const st = readStat(chain[chain.length - 1]);
    if (!st || st.ppid <= 1 || chain.includes(st.ppid)) break;
    chain.push(st.ppid);
  }
  return chain;
}

/** Secret-free one-line description: flag NAMES only (no values), never env. */
function describe(pid) {
  const st = readStat(pid);
  const raw = readProc(pid, "cmdline");
  const status = readProc(pid, "status") ?? "";
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
  const argv = raw === null ? [] : parseCmdline(raw);
  const flags = argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]);
  return (
    `pid=${pid} ppid=${st?.ppid ?? "?"} comm=${st?.comm ?? "?"} uid=${field("Uid")} ` +
    `seccomp=${field("Seccomp")} nnp=${field("NoNewPrivs")} flags=[${flags.join(",")}]`
  );
}

/**
 * Throws on any actual bypass: a sandbox-disable flag in any process argv,
 * CHROME_DEVEL_SANDBOX on the main process, or a CDP renderer that is not a
 * --type=renderer process descended from the launched Obsidian process. The
 * renderer is identified through CDP (its own process.pid/argv), NOT by
 * scanning /proc for --type=renderer, because zygote-forked Chromium children
 * may not expose that flag in /proc/<pid>/cmdline. On failure the thrown
 * message carries a secret-free process table so CI shows the real shape.
 * Logs (does not assert) the renderer's observed seccomp/NoNewPrivs/sandboxed.
 */
export async function assertSandboxEnabled(rootPid, cdp) {
  const pids = listDescendants(rootPid);
  const summary = [];
  for (const pid of pids) {
    const raw = readProc(pid, "cmdline");
    if (raw === null) continue;
    const argv = parseCmdline(raw);
    const bad = findSandboxDisableFlags(argv);
    if (bad.length) {
      throw new Error(`sandbox disabled in pid ${pid} argv: ${bad.join(" ")}`);
    }
    summary.push(argv.find((a) => a.startsWith("--type=")) ?? "main");
  }
  const mainEnv = readProc(rootPid, "environ");
  if (mainEnv !== null && mainEnv.split("\0").some((e) => e.startsWith("CHROME_DEVEL_SANDBOX="))) {
    throw new Error("CHROME_DEVEL_SANDBOX is set on the Obsidian process (sandbox bypass)");
  }
  const renderer = JSON.parse(
    await cdp.evaluate(
      "JSON.stringify({ argv: process.argv, pid: process.pid, sandboxed: process.sandboxed ?? null })"
    )
  );
  const dump = () =>
    `\n  root: ${describe(rootPid)}\n  cdp renderer: ${describe(renderer.pid)}\n  tree (${pids.length}):\n` +
    pids.map((p) => `    ${describe(p)}`).join("\n");
  const bad = findSandboxDisableFlags(renderer.argv);
  if (bad.length) {
    throw new Error(`renderer argv has sandbox-disable flags: ${bad.join(" ")}`);
  }
  const procArgv = parseCmdline(readProc(renderer.pid, "cmdline") ?? "");
  const procBad = findSandboxDisableFlags(procArgv);
  if (procBad.length) {
    throw new Error(`renderer /proc argv has sandbox-disable flags: ${procBad.join(" ")}`);
  }
  if (!renderer.argv.includes("--type=renderer") && !procArgv.includes("--type=renderer")) {
    throw new Error(`CDP renderer pid ${renderer.pid} is not a --type=renderer process${dump()}`);
  }
  if (!pids.includes(renderer.pid)) {
    throw new Error(
      `CDP renderer pid ${renderer.pid} is not a descendant of the launched Obsidian process ` +
        `(ancestry: ${ancestry(renderer.pid, rootPid).join("<-")})${dump()}`
    );
  }
  const status = readProc(renderer.pid, "status") ?? "";
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
  console.log(
    `[runtime] no sandbox bypass: ${pids.length} processes (${summary.join(",")}), ` +
      `renderer pid ${renderer.pid}; observed (not asserted): seccomp=${field("Seccomp")}, ` +
      `no_new_privs=${field("NoNewPrivs")}, process.sandboxed=${renderer.sandboxed}`
  );
}
