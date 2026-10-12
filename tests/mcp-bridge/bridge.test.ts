import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { Client, type ClientOptions } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startMcpBridge, validateBridgeSettings } from "../../tools/mcp-bridge/bridge";
import { startMcpServer, DEFAULT_MCP_SETTINGS, type McpServerHandle } from "../../src/mcp/server";
import { createFakeMcp } from "../mcp/fakes";

const bridgePath = resolve("tools/mcp-bridge/dist/bridge.cjs");
const clients: Client[] = [];
const handles: McpServerHandle[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
beforeAll(async () => { await build({ entryPoints: ["tools/mcp-bridge/cli.ts"], outfile: bridgePath, bundle: true, platform: "node", format: "cjs", target: "node20" }); });
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const child of children.splice(0)) { child.stdin.end(); if (child.exitCode === null) child.kill(); }
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

async function server() {
  const fake = createFakeMcp();
  const handle = await startMcpServer(fake.deps, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 0 });
  handles.push(handle); return { fake, handle };
}
function bridgeEnvironment(handle: McpServerHandle) {
  return { VAULT_GANTT_MCP_URL: handle.endpoint!, VAULT_GANTT_MCP_TOKEN: handle.sessionToken!, VAULT_GANTT_MCP_VAULT_INSTANCE_ID: "vault-test" };
}
async function stdio(handle: McpServerHandle, mode: ClientOptions["versionNegotiation"]) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath], env: bridgeEnvironment(handle), stderr: "pipe" });
  let stderr = ""; transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "stdio-test", version: "1" }, { versionNegotiation: mode });
  clients.push(client); await client.connect(transport, { timeout: 10_000 }); return { client, transport, getStderr: () => stderr };
}
function data(result: { structuredContent?: unknown }): Record<string, unknown> { return (result.structuredContent as { data?: Record<string, unknown> } | undefined)?.data ?? {}; }
async function childExit(env: Record<string, string>) {
  const child = spawn(process.execPath, [bridgePath], { env, stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { code, stdout, stderr };
}

describe("stdio to authenticated plugin HTTP bridge", () => {
  it.each([{ mode: "legacy" } as const, { mode: { pin: "2026-07-28" } } as const])("relays tools, schemas, resources and proposals using SDK client in $mode era", async (mode) => {
    const { fake, handle } = await server();
    const { client, getStderr } = await stdio(handle, mode);
    const tools = await client.listTools();
    expect(tools.tools.find((tool) => tool.name === "operations.T03.propose")?.inputSchema.properties).toHaveProperty("callerIntentId");
    expect(tools.tools.some((tool) => tool.name === "previews.approve")).toBe(false);
    expect(data(await client.callTool({ name: "context.overview", arguments: {} })).status).toBe("success");
    expect(fake.contexts.at(-1)?.origin).toMatchObject({ kind: "mcp", clientLabel: "stdio-test" });
    expect((await client.listResources()).resources[0].uri).toBe("vault-gantt://context/overview");
    expect(JSON.parse(((await client.readResource({ uri: "vault-gantt://context/overview" })).contents[0] as { text: string }).text).status).toBe("success");
    const arguments_ = { input: { name: "bridge task" }, callerIntentId: "bridge-intent" };
    const results = await Promise.all([1, 2].map(() => client.callTool({ name: "operations.T03.propose", arguments: arguments_ })));
    expect(data(results[0]).previewId).toBe(data(results[1]).previewId); expect(fake.calls.propose).toHaveBeenCalledTimes(1);
    expect(data(await client.callTool({ name: "previews.status", arguments: { previewId: data(results[0]).previewId } })).status).toBe("pending_approval");
    const denied = await client.callTool({ name: "operations.T03.propose", arguments: { ...arguments_, confirmed: true } });
    expect(denied.isError).toBe(true); expect(denied.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(getStderr()).not.toContain(handle.sessionToken);
  }, 60_000);
  it("returns APP_NOT_RUNNING on stderr and exits without stdout when plugin is absent", async () => {
    const { handle } = await server(); const env = bridgeEnvironment(handle); await handle.stop();
    const result = await childExit(env); expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("APP_NOT_RUNNING"); expect(result.stderr).not.toContain(env.VAULT_GANTT_MCP_TOKEN);
  });
  it("rejects wrong Vault and wrong authentication without a Vault fallback", async () => {
    const { handle } = await server();
    const wrongVault = await childExit({ ...bridgeEnvironment(handle), VAULT_GANTT_MCP_VAULT_INSTANCE_ID: "other-vault" });
    expect(wrongVault.code).toBe(1); expect(wrongVault.stderr).toContain("MCP_BRIDGE_VAULT_MISMATCH"); expect(wrongVault.stdout).toBe("");
    const wrongAuth = await childExit({ ...bridgeEnvironment(handle), VAULT_GANTT_MCP_TOKEN: "a".repeat(43) });
    expect(wrongAuth.code).toBe(1); expect(wrongAuth.stderr).toContain("MCP_AUTHENTICATION_FAILED"); expect(wrongAuth.stdout).toBe("");
  });
  it("reports APP_NOT_RUNNING for a later disconnection", async () => {
    const { handle } = await server(); const { client } = await stdio(handle, { mode: "legacy" }); await handle.stop();
    await expect(client.callTool({ name: "context.overview", arguments: {} })).rejects.toThrow("APP_NOT_RUNNING");
  });
  it("exits promptly on stdin EOF", async () => {
    const { handle } = await server();
    const child = spawn(process.execPath, [bridgePath], { env: bridgeEnvironment(handle), stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
    child.stdin.end();
    expect(await new Promise((resolve) => child.once("close", resolve))).toBe(0);
  });
  it("validates loopback-only configuration before opening a connection", async () => {
    const token = "a".repeat(43); const vaultInstanceId = "vault-test";
    for (const url of ["http://localhost:8788/mcp", "http://0.0.0.0:8788/mcp", "http://[::1]:8788/mcp", "https://127.0.0.1:8788/mcp", "http://127.0.0.1:8788/mcp?token=x", "http://user:pass@127.0.0.1:8788/mcp", "http://127.0.0.1:8788/other"]) expect(() => validateBridgeSettings({ url, token, vaultInstanceId })).toThrow("MCP_BRIDGE_CONFIGURATION");
    await expect(startMcpBridge({ url: "http://example.test:8788/mcp", token, vaultInstanceId })).rejects.toThrow("MCP_BRIDGE_CONFIGURATION");
  });
  it("has no Vault/Obsidian/domain imports and no stdout diagnostics", async () => {
    const source = await readFile("tools/mcp-bridge/bridge.ts", "utf8");
    expect(source).not.toMatch(/from ["'].*(?:src\/|obsidian|contracts|agent-tools|\/app\/)/);
    expect(source).not.toMatch(/console\.log|process\.stdout\.write/);
  });
  it("forwards cancellation from stdio to the HTTP SDK request signal", async () => {
    const { fake, handle } = await server(); const { client } = await stdio(handle, { mode: "legacy" });
    let cancelled = false;
    fake.hooks.query = async (_id, _input, context) => new Promise((_resolve, reject) => {
      context.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
    });
    const abort = new AbortController(); const request = client.callTool({ name: "context.overview", arguments: {} }, { signal: abort.signal });
    const rejection = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(fake.calls.query).toHaveBeenCalledTimes(1)); abort.abort(); await rejection;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
});
