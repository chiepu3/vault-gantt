
// tools/e2e/obsidian-runtime.mjs

// E2E runtime for running a REAL Obsidian instance headlessly and driving it
// over the Chrome DevTools Protocol (CDP). Ports the technique proven during


// - The Obsidian AppImage cannot mount via FUSE in this environment (and
// likely not on CI runners), so it is extracted once with
// `--appimage-extract` and the extracted squashfs-root/obsidian binary is
// launched directly.
// - Xvfb is started with `-listen tcp` and Obsidian connects via
// `DISPLAY=127.0.0.1:<display>` (TCP transport), NOT the Unix socket,
// because /tmp/.X11-unix permissions are broken under this WSL setup.
// - A fresh `--user-data-dir` per run carries a pre-written obsidian.json
// (vaults map) so Obsidian skips the vault-picker screen on first start.
// - A fresh vault's global "community plugins enabled" toggle is OFF by
// default and is SEPARATE from the per-vault community-plugins.json
// enabled-list, so the plugin silently never loads unless we explicitly
// run `app.plugins.setEnable(true)` + `app.plugins.loadPlugin(id)` after
// startup (see enablePlugin below).

// Requires Node >= 22 (global WebSocket / fetch). On the dev machine the
// default `node` is v16 — use `~/.nvm/versions/node/v22.23.2/bin/node` there.
// In CI, actions/setup-node@v4 with node-version 22 provides it on PATH.


import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatStartupDiagnostics, trackExit } from "./diagnostics.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Pinned Obsidian version for reproducibility (verified against
// obsidianmd/obsidian-releases GitHub releases: the AppImage asset is
// https://github.com/obsidianmd/obsidian-releases/releases/download/v<VER>/Obsidian-<VER>.AppImage).
// Bump deliberately, never "latest".
export const OBSIDIAN_VERSION = "1.13.4";

const APPIMAGE_URL =
  `https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}.AppImage`;

/**
 * Cache directory for downloaded/extracted binaries and logs.
 * Gitignored (tools/e2e/cache/). Override with E2E_CACHE_DIR if needed.
 */
export function cacheDir() {
  return process.env.E2E_CACHE_DIR
    ? path.resolve(process.env.E2E_CACHE_DIR)
    : path.join(REPO_ROOT, "tools", "e2e", "cache");
}

function logDir() {
  const dir = path.join(cacheDir(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}


// Binary management: download (pinned version) + extract AppImage


/**
 * Ensures the extracted Obsidian binary exists in the cache and returns its
 * absolute path. Downloads the pinned AppImage if missing. Set
 * E2E_OBSIDIAN_APPIMAGE to reuse an existing AppImage without downloading
 * (e.g. the dev-machine cache at ~/tools/obsidian-headless/Obsidian.AppImage).
 */
export async function ensureObsidianBinary() {
  const cache = cacheDir();
  fs.mkdirSync(cache, { recursive: true });

  const appImagePath = path.join(cache, `Obsidian-${OBSIDIAN_VERSION}.AppImage`);
  const extractDir = path.join(cache, `obsidian-${OBSIDIAN_VERSION}`);
  const binary = path.join(extractDir, "squashfs-root", "obsidian");

  if (fs.existsSync(binary)) {
    return binary;
  }

  if (!fs.existsSync(appImagePath)) {
    const source = process.env.E2E_OBSIDIAN_APPIMAGE
      ? path.resolve(process.env.E2E_OBSIDIAN_APPIMAGE)
      : null;
    if (source) {
      console.log(`[runtime] copying AppImage from ${source}`);
      fs.copyFileSync(source, appImagePath);
    } else {
      console.log(`[runtime] downloading Obsidian ${OBSIDIAN_VERSION} AppImage ...`);
      await downloadFile(APPIMAGE_URL, appImagePath);
    }
    fs.chmodSync(appImagePath, 0o755);
  }

  console.log(`[runtime] extracting AppImage (FUSE-free --appimage-extract) ...`);
  fs.mkdirSync(extractDir, { recursive: true });
  const result = spawnSync(appImagePath, ["--appimage-extract"], {
    cwd: extractDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`--appimage-extract failed with status ${result.status}`);
  }
  if (!fs.existsSync(binary)) {
    throw new Error(`extraction finished but ${binary} does not exist`);
  }
  return binary;
}

async function downloadFile(url, outPath) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  const tmpPath = `${outPath}.part`;
  const file = fs.createWriteStream(tmpPath);
  let received = 0;
  let lastPct = -1;
  for await (const chunk of res.body) {
    file.write(chunk);
    received += chunk.length;
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        console.log(`[runtime] download ${pct}% (${received}/${total} bytes)`);
        lastPct = pct;
      }
    }
  }
  file.end();
  await new Promise((resolve, reject) => {
    file.on("finish", resolve);
    file.on("error", reject);
  });
  fs.renameSync(tmpPath, outPath);
}


// Port / display helpers


/** True if nothing is listening on 127.0.0.1:port. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("error", () => resolve(false));
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
  });
}

async function findFreePort(start, end) {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`no free TCP port in ${start}-${end}`);
}

export async function pollUntil(fn, { timeoutMs, intervalMs = 250, label = "condition" }) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (err) {
      lastErr = err;
    }
    if (Date.now() > deadline) {
      const suffix = lastErr ? ` (last error: ${lastErr.message})` : "";
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// Xvfb


/**
 * Starts Xvfb on a free display with `-listen tcp -ac`. Returns
 * { display, displayNum, port, process, kill }. The DISPLAY value to hand to
 * child processes is `127.0.0.1:<displayNum>` (TCP transport — see header
 * comment for why the Unix socket is not used).
 */
export async function startXvfb() {

  // launch.sh conventionally uses:99 on this machine).
  const candidates = [];
  for (let n = 90; n <= 120; n++) {
    if (n !== 99) {
      candidates.push(n);
    }
  }

  let displayNum = null;
  for (const n of candidates) {
    const lockExists = fs.existsSync(`/tmp/.X11-unix/X${n}`);
    if (lockExists) {
      continue;
    }
    if (await isPortFree(6000 + n)) {
      displayNum = n;
      break;
    }
  }
  if (displayNum === null) {
    throw new Error("no free X display in 90-120");
  }

  const logFile = path.join(logDir(), `xvfb-${displayNum}-${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  const proc = spawn(
    "Xvfb",
    // 1920x1080 (16:9 FHD) so screenshots match a standard monitor aspect
    // ratio; must be >= the --window-size passed to Obsidian below or the
    // window gets clipped against the virtual screen bounds.
    [`:${displayNum}`, "-screen", "0", "1920x1080x24", "-listen", "tcp", "-ac"],
    { detached: true, stdio: ["ignore", out, out] }
  );
  fs.closeSync(out);
  const xvfbExit = trackExit(proc);

  // A spawn failure (e.g. ENOENT if the Xvfb binary isn't installed, or
  // EACCES) fires an async 'error' event; with no listener attached, Node
  // treats that as an uncaught exception that crashes the whole process
  // immediately, before the try/catch below ever runs — so race the
  // readiness poll against that event instead of leaving it unhandled.
  const spawnError = new Promise((_, reject) => proc.once("error", reject));

  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  };

  try {
    await Promise.race([
      pollUntil(() => isPortListening(6000 + displayNum), {
        timeoutMs: 10000,
        label: `Xvfb :${displayNum} TCP port ${6000 + displayNum}`,
      }),
      spawnError,
    ]);
  } catch (err) {
    const diagnostics = formatStartupDiagnostics([
      { name: "xvfb", pid: xvfbExit.pid, state: xvfbExit.state(), logFile },
    ]);
    kill();
    throw new Error(`${err.message} (log: ${logFile})\n${diagnostics}`);
  }

  return {
    display: `127.0.0.1:${displayNum}`,
    displayNum,
    port: 6000 + displayNum,
    process: proc,
    logFile,
    exit: xvfbExit,
    kill,
  };
}


// CDP session


/**
 * Minimal CDP client over the raw WebSocket JSON-RPC protocol (no external
 * dependencies — Node 22's built-in WebSocket). Captures console errors and
 * uncaught exceptions while the Runtime/Log domains are enabled, so scenarios
 * can assert "zero errors during the scenario" at the end.
 */
export class CdpSession {
  constructor(ws, pageUrl) {
    this.ws = ws;
    this.pageUrl = pageUrl;
    this.nextId = 1;
    this.pending = new Map();
    /** @type {{source: string, text: string}[]} */
    this.captured = [];

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) {
          reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        } else {
          resolve(msg.result);
        }
        return;
      }
      this.handleEvent(msg);
    });

    ws.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  handleEvent(msg) {
    if (msg.method === "Runtime.exceptionThrown") {
      const details = msg.params?.exceptionDetails ?? {};
      const remote = details.exception;
      const text =
        remote?.description || remote?.value?.toString?.() || details.text || "unknown exception";
      this.captured.push({ source: "Runtime.exceptionThrown", text: String(text) });
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
      const text = (msg.params.args ?? [])
        .map((a) => a.description || a.value?.toString?.() || a.unserializableValue || a.type)
        .join(" ");
      this.captured.push({ source: "console.error", text });
    } else if (msg.method === "Log.entryAdded" && msg.params?.entry?.level === "error") {
      this.captured.push({ source: "Log.error", text: msg.params.entry.text ?? "" });
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
 * Runtime.evaluate with returnByValue + awaitPromise. Throws on evaluation
 * exceptions so failures surface immediately.
 *
 * GOTCHA (hit during the manual session): DOMRect does not serialize
 * through returnByValue — destructure {left,top,width,height} inside the
 * expression and return a plain object.
 */
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      const remote = result.exceptionDetails.exception;
      const text = remote?.description || result.exceptionDetails.text || "evaluate failed";
      throw new Error(`page evaluate failed: ${text}`);
    }
    return result.result.value;
  }

  /** Polls an expression until it returns a truthy value. */
  async waitForExpression(expression, { timeoutMs = 15000, intervalMs = 250, label } = {}) {
    return pollUntil(async () => this.evaluate(expression), {
      timeoutMs,
      intervalMs,
      label: label ?? `expression: ${expression.slice(0, 80)}`,
    });
  }

  async screenshot(outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPath, Buffer.from(result.data, "base64"));
  }

  /** Starts console/exception capture (Runtime + Log domains). */
  async startErrorCapture() {
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Page.enable");
  }

  /** Clears captured errors (call at scenario start). */
  resetCapturedErrors() {
    this.captured = [];
  }

  /**
 * Returns captured console errors / uncaught exceptions, optionally
 * excluding entries whose text matches a known-noise pattern (e.g.
 * Obsidian's own network calls in offline CI). Exclusions must be
 * deliberate and documented at the call site.
 */
  capturedErrors(excludePatterns = []) {
    return this.captured.filter(
      (entry) => !excludePatterns.some((re) => re.test(entry.text))
    );
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

/**
 * Waits for CDP to come up on the port, then connects to the first "page"
 * target. Returns a CdpSession with error capture already enabled.
 */
export async function connectCdp(cdpPort, { host = "127.0.0.1", timeoutMs = 45000 } = {}) {
  await pollUntil(async () => {
    const res = await fetch(`http://${host}:${cdpPort}/json/version`).catch(() => null);
    return res !== null && res.ok;
  }, { timeoutMs, intervalMs: 500, label: `CDP /json/version on :${cdpPort}` });

  const targets = await pollUntil(async () => {
    const res = await fetch(`http://${host}:${cdpPort}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === "page");
    return page || null;
  }, { timeoutMs: 30000, intervalMs: 500, label: "CDP page target" });

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket error on connect")), {
      once: true,
    });
  });

  const session = new CdpSession(ws, targets.url);
  await session.startErrorCapture();
  return session;
}


// Obsidian process


// Tracks kill of every currently-running startObsidian runtime so a
// Ctrl-C / CI cancellation (SIGINT/SIGTERM) reaps Xvfb+Obsidian instead of
// leaking them past this process's lifetime. Populated on successful start,
// cleared by the runtime's own kill.
const activeRuntimeKills = new Set();
let signalHandlersRegistered = false;

function registerSignalHandlersOnce() {
  if (signalHandlersRegistered) {
    return;
  }
  signalHandlersRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      for (const kill of activeRuntimeKills) {
        try {
          kill();
        } catch {
          // best-effort — we're exiting regardless
        }
      }
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

/**
 * Starts a fully isolated Obsidian instance against `vaultDir`:
 * fresh --user-data-dir, pre-registered vault (skips the vault picker),
 * its own Xvfb display and a dynamically chosen free CDP port.
 *
 * Returns { cdp, cdpPort, display, userDataDir, logFile, kill }.
 * kill tears down Obsidian (process group), the Xvfb it started AND
 * removes the temporary user-data-dir (best-effort).
 */
export async function startObsidian({ vaultDir, obsidianBin, display }) {
  const binary = obsidianBin ?? (await ensureObsidianBinary());

  // Fresh profile per run — never reuse ~/.config/obsidian (the real user
  // profile on this machine). Pre-register the vault so the vault-picker
  // screen is skipped on first launch.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-obsidian-profile-"));
  const vaultId = Math.random().toString(16).slice(2, 18);
  fs.writeFileSync(
    path.join(userDataDir, "obsidian.json"),
    JSON.stringify(
      {
        vaults: {
          [vaultId]: {
            path: path.resolve(vaultDir),
            ts: Date.now(),
            open: true,
          },
        },
      },
      null,
      2
    )
  );

  const xvfb = display ? { display, kill: () => undefined } : await startXvfb();
  const cdpPort = await findFreePort(9400, 9799);

  const logFile = path.join(logDir(), `obsidian-${Date.now()}.log`);
  const out = fs.openSync(logFile, "a");
  const proc = spawn(
    binary,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      "--no-sandbox",
      "--disable-gpu",
      // NOTE: the standard Chromium `--window-size`/`--window-position`
      // flags are silently ignored here — Obsidian's Electron main process
      // creates its own BrowserWindow with a hardcoded size, it doesn't
      // read these flags. The window is resized to FHD after launch
      // instead (see the resizeToFhd call below), via the renderer's own
      // `electron.remote.getCurrentWindow` handle.
    ],
    {
      // cwd = squashfs-root, matching the proven manual launch sequence.
      cwd: path.dirname(binary),
      env: { ...process.env, DISPLAY: xvfb.display },
      detached: true,
      stdio: ["ignore", out, out],
    }
  );
  fs.closeSync(out);
  const obsidianExit = trackExit(proc);

  // Same rationale as startXvfb: a spawn failure (e.g. ENOENT/EACCES on
  // the extracted binary) fires an async 'error' event that crashes the
  // process as an uncaught exception unless something is listening, so race
  // it against the CDP connect + readiness wait below instead.
  const spawnError = new Promise((_, reject) => proc.once("error", reject));

  // Single teardown point: used both by the returned composite kill and
  // by the error path below (launch failing before CDP connects), so the
  // temp profile dir is removed on every exit route.
  const kill = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
    xvfb.kill();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };

  let cdp;
  try {
    cdp = await Promise.race([connectCdp(cdpPort), spawnError]);
    // Wait until the Obsidian app global is usable. The window.app object
    // exists early; app.plugins must be present before enablePlugin works.
    await Promise.race([
      cdp.waitForExpression(
        "typeof app !== 'undefined' && !!app && !!app.plugins",
        { timeoutMs: 60000, intervalMs: 500, label: "Obsidian app.plugins ready" }
      ),
      spawnError,
    ]);
    // 16:9 FHD so screenshots match a standard monitor aspect ratio.
    // Command-line --window-size is a no-op for Obsidian (see spawn args
    // above), so the window is resized here via its own renderer-process
    // Electron handle instead. Best-effort: swallow failures (e.g. a future
    // Obsidian version without electron.remote) rather than fail the whole
    // launch over a cosmetic screenshot-size concern.
    await cdp
      .evaluate(
        `(() => {
          try {
            const remote = require("electron").remote || require("@electron/remote");
            const win = remote.getCurrentWindow();
            win.setSize(1920, 1080);
            win.setPosition(0, 0);
            return true;
          } catch (e) {
            return false;
          }
        })()`
      )
      .catch(() => {});
  } catch (err) {
    const diagnostics = formatStartupDiagnostics([
      { name: "obsidian", pid: obsidianExit.pid, state: obsidianExit.state(), logFile },
      ...(xvfb.logFile
        ? [{ name: "xvfb", pid: xvfb.exit?.pid, state: xvfb.exit.state(), logFile: xvfb.logFile }]
        : []),
    ]);
    kill();
    throw new Error(`${err.message} (obsidian log: ${logFile})\n${diagnostics}`);
  }

  registerSignalHandlersOnce();
  const composedKill = () => {
    cdp.close();
    kill();
    activeRuntimeKills.delete(composedKill);
  };
  activeRuntimeKills.add(composedKill);

  return {
    cdp,
    cdpPort,
    display: xvfb.display,
    userDataDir,
    logFile,
    kill: composedKill,
  };
}








export async function enablePlugin(cdp, pluginId) {
  const loaded = await cdp.evaluate(`(async () => {
    await app.plugins.setEnable(true);
    await app.plugins.loadPlugin(${JSON.stringify(pluginId)});
    return !!app.plugins.plugins[${JSON.stringify(pluginId)}];
  })()`);
  if (!loaded) {
    throw new Error(`plugin "${pluginId}" did not load — check .obsidian/plugins/${pluginId}/ contents`);
  }
}
