// tools/e2e/sandbox-assert.mjs
// Evidence-based guard that the REAL Obsidian process tree was NOT launched
// with any Chromium sandbox bypass. Reads only argv (/proc/<pid>/cmdline) of
// the harness's own descendants and whether CHROME_DEVEL_SANDBOX is set — env
// values are never logged.
//
// What this proves: no process in the tree carries a sandbox-disable flag, no
// CHROME_DEVEL_SANDBOX override is present, and the CDP-visible renderer is a
// real --type=renderer process of this tree. Combined with the CI-verified
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

/** All descendant pids of rootPid (inclusive), from /proc/<pid>/stat ppids. */
export function listDescendants(rootPid) {
  const children = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProc(name, "stat");
    if (!stat) continue;
    // comm may contain spaces/parens; ppid is the 2nd field after the last ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(name));
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

/**
 * Throws on any actual bypass: a sandbox-disable flag in any process argv,
 * CHROME_DEVEL_SANDBOX on the main process, no renderer process, or a CDP
 * renderer pid that is not a --type=renderer process of this tree. Logs (does
 * not assert) the renderer's observed seccomp/NoNewPrivs/process.sandboxed.
 */
export async function assertSandboxEnabled(rootPid, cdp) {
  const pids = listDescendants(rootPid);
  const summary = [];
  let renderers = 0;
  for (const pid of pids) {
    const raw = readProc(pid, "cmdline");
    if (raw === null) continue;
    const argv = parseCmdline(raw);
    const bad = findSandboxDisableFlags(argv);
    if (bad.length) {
      throw new Error(`sandbox disabled in pid ${pid} argv: ${bad.join(" ")}`);
    }
    const type = argv.find((a) => a.startsWith("--type="));
    if (type === "--type=renderer") renderers++;
    summary.push(type ?? "main");
  }
  const mainEnv = readProc(rootPid, "environ");
  if (mainEnv !== null && mainEnv.split("\0").some((e) => e.startsWith("CHROME_DEVEL_SANDBOX="))) {
    throw new Error("CHROME_DEVEL_SANDBOX is set on the Obsidian process (sandbox bypass)");
  }
  if (renderers === 0) {
    throw new Error("no --type=renderer process found under the Obsidian process tree");
  }
  const renderer = JSON.parse(
    await cdp.evaluate(
      "JSON.stringify({ argv: process.argv, pid: process.pid, sandboxed: process.sandboxed ?? null })"
    )
  );
  const bad = findSandboxDisableFlags(renderer.argv);
  if (bad.length) {
    throw new Error(`renderer argv has sandbox-disable flags: ${bad.join(" ")}`);
  }
  const rendererRaw = readProc(renderer.pid, "cmdline");
  if (rendererRaw === null || !parseCmdline(rendererRaw).includes("--type=renderer")) {
    throw new Error("CDP renderer pid is not a --type=renderer process of this tree");
  }
  if (!pids.includes(renderer.pid)) {
    throw new Error("CDP renderer pid is not a descendant of the launched Obsidian process");
  }
  const status = readProc(renderer.pid, "status") ?? "";
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
  console.log(
    `[runtime] no sandbox bypass: ${pids.length} processes (${summary.join(",")}), ` +
      `renderer pid ${renderer.pid}; observed (not asserted): seccomp=${field("Seccomp")}, ` +
      `no_new_privs=${field("NoNewPrivs")}, process.sandboxed=${renderer.sandboxed}`
  );
}
