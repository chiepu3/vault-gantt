import { Client, StreamableHTTPClientTransport, ProtocolError, type ServerContext } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle, type ServeStdioOptions } from "@modelcontextprotocol/server/stdio";

export interface BridgeSettings {
  readonly url: string;
  readonly token: string;
  readonly vaultInstanceId: string;
}

export function validateBridgeSettings(settings: BridgeSettings): URL {
  const url = new URL(settings.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/mcp" || !url.port
    || url.username || url.password || url.search || url.hash) throw new Error("MCP_BRIDGE_CONFIGURATION: use http://127.0.0.1:PORT/mcp");
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(settings.token) || !settings.vaultInstanceId) throw new Error("MCP_BRIDGE_CONFIGURATION: token and vaultInstanceId are required");
  return url;
}

function unavailable(error: unknown): never {
  if (error instanceof ProtocolError) throw error;
  throw new ProtocolError(-32603, "APP_NOT_RUNNING: start Obsidian and enable MCP for the configured Vault", { code: "APP_NOT_RUNNING" });
}

function forwardOptions(context: ServerContext) {
  return {
    signal: context.mcpReq.signal,
    onprogress: (progress: { progress: number; total?: number; message?: string }) => {
      const progressToken = context.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) void context.mcpReq.notify({ method: "notifications/progress", params: { ...progress, progressToken } }).catch(() => {});
    },
  };
}

/** Transport-only process: imports no Vault, domain operation or Obsidian code. */
export async function startMcpBridge(settings: BridgeSettings, options: ServeStdioOptions = {}): Promise<StdioServerHandle> {
  const url = validateBridgeSettings(settings);
  const client = new Client({ name: "vault-gantt-stdio-bridge", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${settings.token}` }, redirect: "error" },
  });
  try {
    await client.connect(transport, { timeout: 5000 });
    const identity = await client.callTool({ name: "server.identity", arguments: {} });
    const data = (identity.structuredContent as { data?: { vaultInstanceId?: unknown } } | undefined)?.data;
    if (identity.isError || data?.vaultInstanceId !== settings.vaultInstanceId) throw new Error("MCP_BRIDGE_VAULT_MISMATCH: verify the configured Vault instance");
  } catch (error) { await client.close(); throw error; }
  const capabilities = client.getServerCapabilities();
  let handle: StdioServerHandle;
  handle = serveStdio(() => {
    const server = new Server({ name: "vault-gantt-stdio-bridge", version: "1.0.0" }, {
      supportedProtocolVersions: ["2026-07-28", "2025-11-25"], capabilities: { tools: capabilities?.tools ?? {}, resources: capabilities?.resources ?? {} },
      instructions: client.getInstructions(),
    });
    server.setRequestHandler("tools/list", async (request, ctx) => {
      try { return await client.listTools(request.params, forwardOptions(ctx)); } catch (error) { return unavailable(error); }
    });
    server.setRequestHandler("tools/call", async (request, ctx) => {
      const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
      const info = envelope?.["io.modelcontextprotocol/clientInfo"] as { name?: unknown } | undefined;
      const label = typeof info?.name === "string" ? info.name : server.getClientVersion()?.name;
      // Preserve application metadata, while each SDK leg owns its protocol envelope.
      const meta = Object.fromEntries(Object.entries(request.params._meta ?? {}).filter(([key]) => !key.startsWith("io.modelcontextprotocol/")));
      if (label) meta["vault-gantt/clientLabel"] = label.slice(0, 200);
      try { return await client.callTool({ ...request.params, _meta: meta }, forwardOptions(ctx)); } catch (error) { return unavailable(error); }
    });
    server.setRequestHandler("resources/list", async (request, ctx) => {
      try { return await client.listResources(request.params, forwardOptions(ctx)); } catch (error) { return unavailable(error); }
    });
    server.setRequestHandler("resources/templates/list", async (request, ctx) => {
      try { return await client.listResourceTemplates(request.params, forwardOptions(ctx)); } catch (error) { return unavailable(error); }
    });
    server.setRequestHandler("resources/read", async (request, ctx) => {
      try { return await client.readResource(request.params, forwardOptions(ctx)); } catch (error) { return unavailable(error); }
    });
    return server;
  }, options);
  let stopped: Promise<void> | undefined;
  return { close() { return stopped ??= (async () => { try { await handle.close(); } finally { await client.close(); } })(); } };
}
