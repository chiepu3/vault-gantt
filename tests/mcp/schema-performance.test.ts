import { it, expect } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startMcpServer, DEFAULT_MCP_SETTINGS } from "../../src/mcp/server";
import { createFakeMcp } from "./fakes";

it.each(["HTTP", "stdio"])("%s initial read preserves schema validation", async (transportKind) => {
  const dir = await mkdtemp(join(tmpdir(), "vg-schema-bench-"));
  const handle = await startMcpServer(createFakeMcp().deps, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 0 });
  const client = new Client({ name: "schema-benchmark", version: "1" });
  try {
    const bridge = join(dir, "bridge.cjs");
    if (transportKind === "stdio") await build({ entryPoints: ["tools/mcp-bridge/cli.ts"], outfile: bridge, bundle: true, platform: "node", format: "cjs", target: "node20" });
    const transport = transportKind === "HTTP"
      ? new StreamableHTTPClientTransport(new URL(handle.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${handle.sessionToken}` } } })
      : new StdioClientTransport({ command: process.execPath, args: [bridge], env: { VAULT_GANTT_MCP_URL: handle.endpoint!, VAULT_GANTT_MCP_TOKEN: handle.sessionToken!, VAULT_GANTT_MCP_VAULT_INSTANCE_ID: "vault-test" }, stderr: "pipe" });
    const start = performance.now();
    await client.connect(transport, { timeout: 40_000 });
    const connected = performance.now();
    const tools = await client.listTools();
    const listed = performance.now();
    const result = await client.callTool({ name: "context.overview", arguments: {} });
    const read = performance.now();
    expect(result.isError).not.toBe(true);
    if (process.env.VG_SCHEMA_BENCH) console.log(JSON.stringify({ transport: transportKind, connectMs: connected - start, schemaListMs: listed - connected, firstReadMs: read - listed, totalMs: read - start, tools: tools.tools.length }));
    // The shared proposal contract is identical across tool names; keep its
    // complete shape and reuse compilation rather than dropping output checks.
    if (!process.env.VG_SCHEMA_BASELINE) {
      const proposals = tools.tools.filter((tool) => tool.name.endsWith(".propose"));
      expect(new Set(proposals.map((tool) => tool.outputSchema?.$id)).size).toBe(1);
      expect(proposals[0].outputSchema?.$id).toBeTruthy();
      expect(proposals[0].outputSchema?.properties).toHaveProperty("data");
      const invalid = await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "test" }, callerIntentId: "invalid", confirmed: true } });
      expect(invalid.isError).toBe(true);
    }
  } finally { await client.close(); await handle.stop(); await rm(dir, { recursive: true, force: true }); }
}, 90_000);
