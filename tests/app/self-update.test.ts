import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BACKUP_DIR, SelfUpdater, sortTargets, type UpdateAdapter, type UpdateTarget } from "../../src/app/self-update";

const enc = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer;
const sha = async (d: ArrayBuffer): Promise<string> => createHash("sha256").update(Buffer.from(d)).digest("hex");

function makeSite(files: Record<string, string>, tamper?: (name: string) => string | undefined) {
  const meta = { branch: "feat", sha: "abc1234def", version: "9.9.9", builtAt: "x", files: {} as Record<string, { size: number; sha256: string }> };
  for (const [n, c] of Object.entries(files)) meta.files[n] = { size: Buffer.byteLength(c), sha256: createHash("sha256").update(c).digest("hex") };
  const targets = { targets: [
    { branch: "main", slug: "main", sha: "1", kind: "main", status: "success", plugin: true, commitTime: "2026-01-01" },
    { branch: "x-all", slug: "x-all", sha: "2", kind: "all", status: "success", plugin: true, commitTime: "2026-01-03" },
    { branch: "feat", slug: "feat", sha: "abc1234def", kind: "pr", pr: { number: 7, title: "feat: t" }, status: "success", plugin: true, commitTime: "2026-01-02" },
    { branch: "bad", slug: "../evil", sha: "3", kind: "pr", status: "success", plugin: true },
    { branch: "nobuild", slug: "nobuild", sha: "4", kind: "pr", status: "success", plugin: false },
    { branch: "failed", slug: "failed", sha: "5", kind: "pr", status: "failure", plugin: true },
  ] };
  const http = async (url: string) => {
    const u = url.replace("https://site", "").split("?")[0];
    if (u === "/targets.json") return { status: 200, arrayBuffer: enc(JSON.stringify(targets)) };
    if (u === "/b/feat/plugin/meta.json") return { status: 200, arrayBuffer: enc(JSON.stringify(meta)) };
    const m = /^\/b\/feat\/plugin\/(.+)$/.exec(u);
    if (m && files[m[1]] !== undefined) return { status: 200, arrayBuffer: enc(tamper?.(m[1]) ?? files[m[1]]) };
    return { status: 404, arrayBuffer: enc("") };
  };
  return http;
}

function memoryAdapter(initial: Record<string, string>) {
  const store = new Map<string, ArrayBuffer>(Object.entries(initial).map(([k, v]) => [k, enc(v)]));
  const dirs = new Set<string>();
  const adapter: UpdateAdapter = {
    exists: async (p) => store.has(p) || dirs.has(p),
    mkdir: async (p) => { dirs.add(p); },
    readBinary: async (p) => store.get(p) as ArrayBuffer,
    writeBinary: async (p, d) => { store.set(p, d); },
  };
  return { adapter, text: (p: string) => new TextDecoder().decode(store.get(p)) };
}

const NEW = { "main.js": "new-main", "manifest.json": JSON.stringify({ id: "vault-gantt", version: "9.9.9" }), "styles.css": "new-css" };
const DIR = ".obsidian/plugins/vault-gantt";

describe("SelfUpdater", () => {
  it("lists only installable targets, main first then -all then PRs", async () => {
    const u = new SelfUpdater({ http: makeSite(NEW), adapter: memoryAdapter({}).adapter, pluginDir: DIR, siteBase: "https://site", sha256Hex: sha });
    expect((await u.listTargets()).map((t) => t.branch)).toEqual(["main", "x-all", "feat"]);
  });

  it("installs verified files and keeps the previous ones in .backup", async () => {
    const mem = memoryAdapter({ [`${DIR}/main.js`]: "old-main", [`${DIR}/manifest.json`]: "old-man", [`${DIR}/styles.css`]: "old-css" });
    const u = new SelfUpdater({ http: makeSite(NEW), adapter: mem.adapter, pluginDir: DIR, siteBase: "https://site", sha256Hex: sha });
    const target = (await u.listTargets()).find((t) => t.slug === "feat") as UpdateTarget;
    expect(await u.install(target)).toEqual({ version: "9.9.9", sha: "abc1234def" });
    expect(mem.text(`${DIR}/main.js`)).toBe("new-main");
    expect(mem.text(`${DIR}/${BACKUP_DIR}/main.js`)).toBe("old-main");
    await u.restoreBackup();
    expect(mem.text(`${DIR}/main.js`)).toBe("old-main");
    expect(mem.text(`${DIR}/styles.css`)).toBe("old-css");
  });

  it("rejects a corrupted download without touching installed files", async () => {
    const mem = memoryAdapter({ [`${DIR}/main.js`]: "old-main" });
    const u = new SelfUpdater({ http: makeSite(NEW, (n) => (n === "main.js" ? "corrupt!!" : undefined)), adapter: mem.adapter, pluginDir: DIR, siteBase: "https://site", sha256Hex: sha });
    const target = (await u.listTargets()).find((t) => t.slug === "feat") as UpdateTarget;
    await expect(u.install(target)).rejects.toThrow("main.js");
    expect(mem.text(`${DIR}/main.js`)).toBe("old-main");
    expect(await u.hasBackup()).toBe(false);
  });

  it("rejects a manifest that is not vault-gantt", async () => {
    const files = { ...NEW, "manifest.json": JSON.stringify({ id: "other" }) };
    const mem = memoryAdapter({});
    const u = new SelfUpdater({ http: makeSite(files), adapter: mem.adapter, pluginDir: DIR, siteBase: "https://site", sha256Hex: sha });
    const target = (await u.listTargets()).find((t) => t.slug === "feat") as UpdateTarget;
    await expect(u.install(target)).rejects.toThrow("Vault Gantt");
  });

  it("refuses unsafe slugs", async () => {
    const u = new SelfUpdater({ http: makeSite(NEW), adapter: memoryAdapter({}).adapter, pluginDir: DIR, siteBase: "https://site", sha256Hex: sha });
    await expect(u.install({ branch: "b", slug: "../x", sha: "1", kind: "pr", pr: null, commitTime: null })).rejects.toThrow();
  });

  it("sortTargets orders by kind then newest commit", () => {
    const mk = (branch: string, kind: UpdateTarget["kind"], commitTime: string): UpdateTarget => ({ branch, slug: branch, sha: "", kind, pr: null, commitTime });
    expect(sortTargets([mk("a", "pr", "2"), mk("b", "pr", "3"), mk("m", "main", "1")]).map((t) => t.branch)).toEqual(["m", "b", "a"]);
  });
});
