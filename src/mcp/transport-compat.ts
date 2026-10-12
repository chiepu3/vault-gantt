import type { McpHttpHandler, Server, ServerContext } from "@modelcontextprotocol/server";
import type { RequestContext, Capability } from "../contracts/context";

export const MCP_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25"] as const;
export const MCP_BODY_LIMIT = 1024 * 1024;

/** The official SDK owns era detection, header/envelope agreement and cancellation. */
export async function createCompatibleHandler(factory: () => Promise<Server>): Promise<McpHttpHandler> {
  const { createMcpHandler } = await import("@modelcontextprotocol/server");
  return createMcpHandler(factory, {
    legacy: "stateless", responseMode: "auto", maxRequestBodySize: MCP_BODY_LIMIT,
    // Polling is the baseline; no long-lived subscriptions are advertised.
    maxSubscriptions: 0,
  });
}

export interface McpPrincipal {
  readonly id: string;
  /** Registered human-readable identity; client labels are separate, untrusted metadata. */
  readonly label: string;
  readonly capabilities?: readonly Capability[];
}

export function mcpRequestContext(vaultInstanceId: string, principal: McpPrincipal, capabilities: readonly Capability[], ctx: ServerContext, signal: AbortSignal): RequestContext {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = envelope?.["io.modelcontextprotocol/clientInfo"] as { name?: unknown } | undefined;
  const forwardedLabel = ctx.mcpReq._meta?.["vault-gantt/clientLabel"];
  return {
    vaultInstanceId, principalId: principal.id, capabilities,
    origin: { kind: "mcp", principalId: principal.id, clientLabel: typeof forwardedLabel === "string" ? forwardedLabel.slice(0, 200)
      : typeof info?.name === "string" ? info.name.slice(0, 200) : "legacy MCP client" },
    // JSON-RPC ids can collide across stateless connections; never use them as identity.
    requestId: crypto.randomUUID(), signal,
  };
}
