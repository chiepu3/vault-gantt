// tools/e2e/sandbox-assert.mjs
// Evidence-based guard that the REAL Obsidian process tree was NOT launched
// with any Chromium sandbox bypass. Reads only argv (/proc/<pid>/cmdline) of
// the harness's own descendants and whether CHROME_DEVEL_SANDBOX is set — env
// values are never logged.
//
// What this proves (gate, throws on violation):
//   - the chrome-sandbox helper next to the binary is root:root 4755;
//   - no process of the launched tree has a sandbox-disable flag in its
//     readable /proc/<pid>/cmdline (the root entry is the actual launch argv);
//   - CHROME_DEVEL_SANDBOX is not set on the main process;
//   - the main process's own process.argv (read through the renderer's
//     electron.remote handle, when available) has no such flag;
//   - the CDP-reported renderer pid is a descendant of the launched process.
// Combined with the root:root 4755 helper, a caller-supplied bypass would show
// up in the root argv and fail here.
//
// What this does NOT prove: that the Obsidian renderer is OS-sandboxed.
// Obsidian's windows use Node integration (webPreferences.sandbox=false), for
// which Electron ITSELF appends --no-sandbox and --no-zygote to that
// renderer's command line (shell/browser/web_contents_preferences.cc,
// AppendCommandLineSwitches). The renderer's CDP-visible process.argv therefore
// carries those flags even though nobody passed them at launch; that is
// Electron-synthesized per-renderer metadata, not a launch-time bypass, and it
// is only LOGGED ("renderer metadata flags"), never used to pass or hide
// anything. A flag a caller really supplied is in the root argv and still
// throws. Browser.getBrowserCommandLine is unusable: it only answers when
// --enable-automation is on the command line. seccomp / no_new_privs /
// process.sandboxed are observed and logged, not asserted.

import fs from "node:fs";
import path from "node:path";

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
 * Throws on any launch-time bypass: chrome-sandbox not root:root 4755, a
 * sandbox-disable flag in any readable /proc argv of the tree (root = actual
 * launch argv) or in the main process's own argv, CHROME_DEVEL_SANDBOX on the
 * main process, or a CDP renderer pid outside the launched tree. The renderer
 * is identified through CDP (its own process.pid), not by scanning /proc for
 * --type=renderer. The renderer's CDP process.argv is Electron-synthesized
 * metadata (see header) and is only logged. Failures carry a secret-free
 * process table.
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
  // Flag NAMES only (values such as --user-data-dir paths are never printed).
  const flagNames = (argv) => argv.filter((a) => a.startsWith("--")).map((a) => a.split("=")[0]);
  const exe = parseCmdline(readProc(rootPid, "cmdline") ?? "")[0];
  let helper;
  try {
    const st = fs.statSync(path.join(path.dirname(exe), "chrome-sandbox"));
    helper = { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) };
  } catch (e) {
    throw new Error(`chrome-sandbox helper stat failed (${e.code ?? "error"})`);
  }
  const dump = () =>
    `\n  chrome-sandbox: uid=${helper.uid} gid=${helper.gid} mode=${helper.mode}` +
    `\n  root: ${describe(rootPid)}` +
    `\n  cdp renderer metadata process.argv flags=[${flagNames(renderer.argv).join(",")}]` +
    `\n  cdp renderer /proc: ${describe(renderer.pid)}\n  tree (${pids.length}):\n` +
    pids.map((p) => `    ${describe(p)}`).join("\n");
  if (helper.uid !== 0 || helper.gid !== 0 || helper.mode !== "4755") {
    throw new Error(`chrome-sandbox is not root:root 4755${dump()}`);
  }
  // Main process argv as Electron reports it (best-effort; unavailable if the
  // renderer has no electron.remote). Real caller-supplied flags show here.
  let mainFlags = "unavailable";
  try {
    const mainArgv = JSON.parse(
      await cdp.evaluate(
        "JSON.stringify(require('electron').remote.process.argv)"
      )
    );
    const mainBad = findSandboxDisableFlags(mainArgv);
    if (mainBad.length) {
      throw new Error(`main process argv has sandbox-disable flags: ${mainBad.join(" ")}${dump()}`);
    }
    mainFlags = `[${flagNames(mainArgv).join(",")}]`;
  } catch (e) {
    if (String(e.message).startsWith("main process argv")) throw e;
  }
  const procArgv = parseCmdline(readProc(renderer.pid, "cmdline") ?? "");
  const procBad = findSandboxDisableFlags(procArgv);
  if (procBad.length) {
    throw new Error(`renderer /proc argv has sandbox-disable flags: ${procBad.join(" ")}${dump()}`);
  }
  if (!pids.includes(renderer.pid)) {
    throw new Error(
      `CDP renderer pid ${renderer.pid} is not a descendant of the launched Obsidian process ` +
        `(ancestry: ${ancestry(renderer.pid, rootPid).join("<-")})${dump()}`
    );
  }
  const metadataFlags = findSandboxDisableFlags(renderer.argv);
  const status = readProc(renderer.pid, "status") ?? "";
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "m"))?.[1] ?? "?";
  console.log(
    `[runtime] no launch-time sandbox bypass: helper root:root ${helper.mode}, ` +
      `${pids.length} processes (${summary.join(",")}), main argv flags=${mainFlags}; ` +
      `renderer pid ${renderer.pid}; observed (not asserted): ` +
      `renderer metadata flags=[${metadataFlags.join(",")}] (Electron-synthesized for ` +
      `sandbox:false windows, absent from the launch argv), seccomp=${field("Seccomp")}, ` +
      `no_new_privs=${field("NoNewPrivs")}, process.sandboxed=${renderer.sandboxed}`
  );
}
