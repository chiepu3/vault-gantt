// tools/e2e/sandbox-assert.mjs
// Asserts the REAL Obsidian process tree runs with Chromium's sandbox enabled.
// Reads only argv (/proc/<pid>/cmdline) of the harness's own descendants and
// whether CHROME_DEVEL_SANDBOX is set — env values are never logged.

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
 * Throws unless: no process in the tree has a sandbox-disable flag, a
 * renderer process exists, CHROME_DEVEL_SANDBOX is not set on the main
 * process, and the renderer's own CDP-visible argv is clean too.
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
  console.log(
    `[runtime] sandbox check ok: ${pids.length} processes (${summary.join(",")}), ` +
      `renderer pid ${renderer.pid}, process.sandboxed=${renderer.sandboxed}`
  );
}
