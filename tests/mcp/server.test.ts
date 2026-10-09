import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type ClientOptions } from "@modelcontextprotocol/client";
import { request as httpRequest } from "node:http";
import { startMcpServer, DEFAULT_MCP_SETTINGS, buildMcpSettingsDescription, McpAdapter, protocolPreviewStatus, type McpServerHandle } from "../../src/mcp/server";
import { authenticateBearer, generateMcpToken, validateMcpToken, validateLocalHeaders } from "../../src/mcp/auth";
import { resourceTarget } from "../../src/mcp/resource-adapter";
import { OPERATION_IDS, OPERATION_CONTRACTS } from "../../src/contracts/operations";
import { INPUT_FIXTURES, CONTEXT_QUERY_FIXTURES, PARTIAL_PREVIEW, PARTIAL_OUTCOME } from "../contracts/fixtures";
import { createFakeMcp } from "./fakes";

const handles: McpServerHandle[] = [];
const clients: Client[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); await Promise.all(handles.splice(0).map((handle) => handle.stop())); });

export function resultData(result: CallToolResult): Record<string, unknown> { return (result.structuredContent as { data?: Record<string, unknown> } | undefined)?.data ?? {}; }
function resultError(result: CallToolResult): string | undefined { return (result.structuredContent as { error?: { code?: string } } | undefined)?.error?.code; }

async function running(capabilities?: Parameters<typeof createFakeMcp>[0], mode: ClientOptions["versionNegotiation"] = { mode: "auto" }) {
  const fake = createFakeMcp(capabilities);
  const handle = await startMcpServer(fake.deps, { ...DEFAULT_MCP_SETTINGS, enabled: true, port: 0 });
  handles.push(handle);
  const client = new Client({ name: "sdk-test", version: "1" }, { versionNegotiation: mode });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(handle.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${handle.sessionToken}` } } }));
  return { fake, handle, client };
}

function raw(endpoint: string, headers: Record<string, string>, body = "{}", method = "POST") {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(endpoint, { method, headers }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
    });
    req.on("error", reject); req.end(body);
  });
}

describe("MCP authentication and settings", () => {
  it("uses separate random 32-byte tokens and exact bearer, Host and Origin checks", () => {
    const token = generateMcpToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(generateMcpToken()).not.toBe(token);
    expect(authenticateBearer(`Bearer ${token}`, token)).toBe(true);
    for (const value of [undefined, "", token, `Basic ${token}`, `Bearer ${token}x`, `Bearer ${"x".repeat(token.length)}`]) expect(authenticateBearer(value, token)).toBe(false);
    expect(() => validateMcpToken("short")).toThrow();
    expect(validateLocalHeaders({ host: "127.0.0.1:8788" }, 8788, [])).toBe(true);
    expect(validateLocalHeaders({ host: "localhost:8788" }, 8788, [])).toBe(false);
    expect(validateLocalHeaders({ host: "127.0.0.1:8788", origin: "https://example.test" }, 8788, [])).toBe(false);
    expect(validateLocalHeaders({ host: "127.0.0.1:8788", origin: "https://example.test" }, 8788, ["https://example.test"])).toBe(true);
  });
  it("defaults disabled and does not listen on mobile or when disabled", async () => {
    expect(DEFAULT_MCP_SETTINGS).toMatchObject({ enabled: false, port: 8788, secretId: null, allowedOrigins: [] });
    expect(buildMcpSettingsDescription(DEFAULT_MCP_SETTINGS).map((row) => row.key)).toContain("regenerateToken");
    const fake = createFakeMcp();
    expect((await startMcpServer(fake.deps)).running).toBe(false);
    expect((await startMcpServer({ ...fake.deps, isDesktop: false }, { ...DEFAULT_MCP_SETTINGS, enabled: true })).endpoint).toBeNull();
  });
  it("authenticates every HTTP method and rejects wrong Host, Origin, endpoints and credentials", async () => {
    const { handle } = await running();
    const auth = { Authorization: `Bearer ${handle.sessionToken}` };
    expect((await raw(handle.endpoint!, {})).status).toBe(401);
    expect((await raw(handle.endpoint!, { Authorization: "Bearer wrong" })).status).toBe(401);
    expect((await raw(handle.endpoint!, { ...auth, Host: "evil.example" })).status).toBe(403);
    expect((await raw(handle.endpoint!, { ...auth, Host: "127.0.0.1:1", "X-Forwarded-Host": new URL(handle.endpoint!).host })).status).toBe(403);
    expect((await raw(handle.endpoint!, { ...auth, Origin: "null" })).status).toBe(403);
    for (const method of ["GET", "DELETE", "OPTIONS"]) expect((await raw(handle.endpoint!, auth, "", method)).status).toBe(405);
    expect((await raw(`${handle.endpoint}?token=${handle.sessionToken}`, auth)).status).toBe(404);
    expect((await raw(handle.endpoint!, {}, "", "GET")).status).toBe(401);
    expect((await raw(handle.endpoint!, { ...auth, "Content-Type": "application/json" }, JSON.stringify({ padding: "a".repeat(1024 * 1024) }))).status).toBe(413);
  });
  it("does not explore a different port on EADDRINUSE", async () => {
    const { handle } = await running();
    const port = Number(new URL(handle.endpoint!).port);
    await expect(startMcpServer(createFakeMcp().deps, { ...DEFAULT_MCP_SETTINGS, enabled: true, port })).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});

describe("HTTP SDK interoperability", () => {
  it.each([{ mode: "auto" } as const, { mode: "legacy" } as const])("communicates using official SDK in $mode era", async (versionNegotiation) => {
    const { client, fake } = await running(undefined, versionNegotiation);
    const list = await client.listTools();
    expect(list.tools.map((tool) => tool.name)).toContain("context.overview");
    expect(list.tools.map((tool) => tool.name)).not.toContain("operations.V14.request");
    expect(list.tools.find((tool) => tool.name === "tasks.search")?.annotations?.readOnlyHint).toBe(true);
    expect(list.tools.find((tool) => tool.name === "operations.T03.propose")?.description).toContain("人間承認");
    const description = resultData(await client.callTool({ name: "operations.describe", arguments: {} }));
    const operations = description.operations as { id: string; available: boolean; denial?: { code: string } }[];
    expect(operations.map((op) => op.id)).toEqual([...OPERATION_IDS]);
    expect(operations.find((op) => op.id === "V14")).toMatchObject({ available: false, denial: { code: "POLICY_DENIED" } });
    expect(resultData(await client.callTool({ name: "context.overview", arguments: {} })).status).toBe("success");
    expect(fake.contexts.at(-1)).toMatchObject({ vaultInstanceId: "vault-test", principalId: "principal-test", origin: { kind: "mcp", principalId: "principal-test" }, capabilities: ["read", "propose"] });
    const resources = await client.listResources();
    expect(resources.resources[0].uri).toBe("vault-gantt://context/overview");
    const resource = await client.readResource({ uri: "vault-gantt://context/overview" });
    expect(JSON.parse((resource.contents[0] as { text: string }).text).status).toBe("success");
  }, 30_000);
  it("validates every context query against the frozen input/output DTOs", async () => {
    const { client, fake } = await running();
    for (const [name, input] of Object.entries(CONTEXT_QUERY_FIXTURES)) {
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError, name).not.toBe(true);
      expect(resultData(result).status).toBe("success");
    }
    expect(fake.calls.query).toHaveBeenCalledTimes(Object.keys(CONTEXT_QUERY_FIXTURES).length);
    fake.hooks.query = async () => ({ status: "success", result: { invalid: true } });
    expect(resultError(await client.callTool({ name: "context.overview", arguments: {} }))).toBe("RESET_REQUIRED");
  });
  it("dispatches ledger operations through the correct ports, excluding V14", async () => {
    const { client, fake } = await running(["read", "propose", "ui", "external", "diagnostic", "chat-control"]);
    for (const id of OPERATION_IDS) {
      if (["V14", "Q07", "Q08"].includes(id)) continue;
      const classification = OPERATION_CONTRACTS[id][0];
      const suffix = classification === "write" ? "propose" : classification === "read" ? "read" : "request";
      const result = await client.callTool({ name: `operations.${id}.${suffix}`, arguments: classification === "write" ? { input: INPUT_FIXTURES[id], callerIntentId: id } : INPUT_FIXTURES[id] });
      expect(result.isError, `${id} ${JSON.stringify(result.structuredContent)}`).not.toBe(true);
      if (classification === "write") {
        const previewId = resultData(result).previewId as string;
        await client.callTool({ name: "previews.reject", arguments: { previewId } });
      }
    }
    expect(fake.calls.read).toHaveBeenCalledTimes(3);
    expect(fake.calls.propose.mock.calls.length).toBeGreaterThan(80);
  }, 30_000);
  it("validates modern version, method and name header agreement using SDK", async () => {
    const { handle } = await running();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "server.identity", arguments: {}, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {},
    } } });
    const headers = { Authorization: `Bearer ${handle.sessionToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "server.identity" };
    expect((await raw(handle.endpoint!, headers, body)).status).toBe(200);
    for (const changed of [{ "MCP-Protocol-Version": "2025-11-25" }, { "Mcp-Method": "tools/list" }, { "Mcp-Name": "evil" }]) {
      const result = await raw(handle.endpoint!, { ...headers, ...changed }, body);
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body).error.code).toBe(-32020);
    }
  });
});

describe("proposal approval boundary and isolation", () => {
  it("deduplicates parallel proposals with callerIntentId; MCP only polls human outcomes", async () => {
    const { client, fake } = await running();
    const args = { input: { name: "task" }, callerIntentId: "intent-1" };
    const results = await Promise.all([1, 2, 3].map(() => client.callTool({ name: "operations.T03.propose", arguments: args })));
    const previewId = resultData(results[0]).previewId as string;
    expect(new Set(results.map((result) => resultData(result).previewId))).toEqual(new Set([previewId]));
    expect(fake.calls.propose).toHaveBeenCalledTimes(1);
    expect(fake.contexts[0].callerIntentId).toBe("intent-1");
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { ...args, input: { name: "different" } } }))).toBe("INVALID_INPUT");
    expect(resultData(await client.callTool({ name: "previews.status", arguments: { previewId } })).status).toBe("pending_approval");
    // Represents an outcome independently published by Obsidian's human UI.
    fake.outcomes.set(previewId, { previewId, status: "success", actions: [], undoEntryId: "history-entry", actualProjection: null });
    fake.previews.set(previewId, { ...fake.previews.get(previewId)!, status: "success" });
    const status = resultData(await client.callTool({ name: "previews.status", arguments: { previewId } }));
    expect(status.status).toBe("committed");
    expect(status.undo).toMatchObject({ entryId: "history-entry", state: "available" });
    expect(resultData(await client.callTool({ name: "operations.T03.propose", arguments: args })).status).toBe("committed");
    expect(fake.calls.propose).toHaveBeenCalledTimes(1);
  });
  it("retains registered proposals when the client cancels and recovers the lost response on intent replay", async () => {
    const { client, fake } = await running();
    fake.hooks.propose = async (id, _input, context) => {
      const preview = fake.makePreview(id, context); fake.previews.set(preview.previewId, preview);
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return preview;
    };
    const abort = new AbortController();
    const args = { input: { name: "registered" }, callerIntentId: "registered-intent" };
    const request = client.callTool({ name: "operations.T03.propose", arguments: args }, { signal: abort.signal });
    const rejection = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(fake.previews.size).toBe(1)); abort.abort(); await rejection;
    const replay = resultData(await client.callTool({ name: "operations.T03.propose", arguments: args }));
    expect(replay).toMatchObject({ previewId: "preview-1", status: "pending_approval" });
    expect(fake.calls.propose).toHaveBeenCalledTimes(1); expect(fake.calls.reject).not.toHaveBeenCalled();
  });
  it("denies impersonation, confirmed assertions, hidden capabilities, direct UI V14 and approval/commit", async () => {
    const { client, fake } = await running();
    for (const extra of [{ confirmed: true }, { principalId: "other" }, { origin: { kind: "ui" } }, { capabilities: ["ui"] }]) {
      expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "fake", ...extra } }))).toBe("INVALID_INPUT");
    }
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task", confirmed: true }, callerIntentId: "fake" } }))).toBe("INVALID_INPUT");
    for (const name of ["previews.approve", "previews.commit", "operations.V14.request", "operations.S21.propose"]) {
      expect(resultError(await client.callTool({ name, arguments: {} }))).toBe("POLICY_DENIED");
    }
    expect(fake.calls.propose).not.toHaveBeenCalled();
    expect(fake.calls.request).not.toHaveBeenCalled();
  });
  it("denies V14 even with every external capability", async () => {
    const { client, fake } = await running(["read", "propose", "ui", "external", "diagnostic", "chat-control"]);
    expect(resultError(await client.callTool({ name: "operations.V14.request", arguments: { viewId: "gantt", dayWidth: 40 } }))).toBe("POLICY_DENIED");
    expect(fake.calls.request).not.toHaveBeenCalled();
  });
  it("checks preview Vault and principal before status, reject, approval-request, repreview, paging and resources", async () => {
    const { client, fake } = await running();
    fake.previews.set("foreign", { ...fake.makePreview("T03", { vaultInstanceId: "vault-other", principalId: "principal-other", capabilities: [], requestId: "test", origin: { kind: "mcp", principalId: "principal-other", clientLabel: "other" } }), previewId: "foreign" });
    for (const name of ["previews.status", "previews.reject", "operations.Q07.request"]) expect(resultError(await client.callTool({ name, arguments: { previewId: "foreign" } }))).toBe("POLICY_DENIED");
    expect(resultError(await client.callTool({ name: "operations.Q08.propose", arguments: { input: { previewId: "foreign" }, callerIntentId: "repreview-foreign" } }))).toBe("POLICY_DENIED");
    expect(resultError(await client.callTool({ name: "previews.projection-page", arguments: { previewId: "foreign", cursor: "cursor", projectionKind: "planned" } }))).toBe("POLICY_DENIED");
    expect(JSON.parse(((await client.readResource({ uri: "vault-gantt://previews/foreign" })).contents[0] as { text: string }).text).error.code).toBe("POLICY_DENIED");
    expect((await client.listResources()).resources.map((r) => r.uri)).not.toContain("vault-gantt://previews/foreign");
    expect(fake.calls.request).not.toHaveBeenCalled(); expect(fake.calls.reject).not.toHaveBeenCalled(); expect(fake.calls.projection).not.toHaveBeenCalled();
    expect(resultError(await client.callTool({ name: "previews.status", arguments: { previewId: "lost-after-restart" } }))).toBe("UNKNOWN_AFTER_RESTART");
  });
  it("keeps approval requests distinct from commit and serializes repreview proposals", async () => {
    const { client, fake } = await running();
    const previewId = resultData(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "intent" } })).previewId as string;
    expect(resultData(await client.callTool({ name: "operations.Q07.request", arguments: { previewId } })).status).toBe("requested");
    expect(fake.previews.get(previewId)?.status).toBe("pending");
    const args = { input: { previewId }, callerIntentId: "repreview-intent" };
    const a = resultData(await client.callTool({ name: "operations.Q08.propose", arguments: args }));
    const b = resultData(await client.callTool({ name: "operations.Q08.propose", arguments: args }));
    expect(a.previewId).toBe(b.previewId);
    expect(fake.calls.request).toHaveBeenCalledTimes(2);
  });
  it("rechecks the original operation's capability for Q08 repreview", async () => {
    const { client, fake } = await running();
    const context = { vaultInstanceId: "vault-test", principalId: "principal-test", capabilities: ["propose", "external"] as const,
      requestId: "test", origin: { kind: "mcp", principalId: "principal-test", clientLabel: "test" } as const };
    const preview = { ...fake.makePreview("S21", context), status: "rejected" as const }; fake.previews.set(preview.previewId, preview);
    const result = await client.callTool({ name: "operations.Q08.propose", arguments: { input: { previewId: preview.previewId }, callerIntentId: "external-repreview" } });
    expect(resultError(result)).toBe("POLICY_DENIED"); expect(fake.calls.request).not.toHaveBeenCalled();
  });
  it("publishes validated partial outcomes with their actual projection, and rejects malformed outcomes", async () => {
    const { client, fake } = await running();
    const preview = { ...PARTIAL_PREVIEW, vaultInstanceId: "vault-test", origin: { kind: "mcp", principalId: "principal-test", clientLabel: "test" } as const };
    fake.previews.set(preview.previewId, preview); fake.outcomes.set(preview.previewId, PARTIAL_OUTCOME);
    const status = resultData(await client.callTool({ name: "previews.status", arguments: { previewId: preview.previewId } }));
    expect(status.status).toBe("partial");
    expect(status.outcome).toMatchObject({ actualProjection: PARTIAL_OUTCOME.actualProjection });
    fake.outcomes.set(preview.previewId, { ...PARTIAL_OUTCOME, actions: [] });
    expect(resultError(await client.callTool({ name: "previews.status", arguments: { previewId: preview.previewId } }))).toBe("RESET_REQUIRED");
  });
  it("enforces principal pending limit and port TTL", async () => {
    const { client, fake } = await running();
    for (let i = 0; i < 10; i++) expect((await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: `intent-${i}` } })).isError).not.toBe(true);
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "over-limit" } }))).toBe("POLICY_DENIED");
    expect(fake.calls.propose).toHaveBeenCalledTimes(10);
    await client.callTool({ name: "previews.reject", arguments: { previewId: "preview-1" } });
    expect((await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "over-limit" } })).isError).not.toBe(true);
    await client.callTool({ name: "previews.reject", arguments: { previewId: "preview-2" } });
    fake.hooks.propose = async (id, _input, context) => ({ ...fake.makePreview(id, context), expiresAt: new Date(Date.now() + 700_000).toISOString() });
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "bad-ttl" } }))).toBe("RESET_REQUIRED");
  });
  it("maps contract statuses explicitly without mutating DTO status", () => {
    expect(protocolPreviewStatus("pending")).toBe("pending_approval"); expect(protocolPreviewStatus("success")).toBe("committed");
    for (const status of ["applying", "partial", "failed", "cancelled", "rejected", "stale", "expired"] as const) expect(protocolPreviewStatus(status)).toBe(status);
  });
  it("rotates tokens, invalidates pending proposals and closes cleanly without touching applying or foreign previews", async () => {
    const { client, handle, fake } = await running();
    await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "intent" } });
    fake.previews.set("applying", { ...fake.previews.get("preview-1")!, previewId: "applying", status: "applying" });
    fake.previews.set("foreign", { ...fake.previews.get("preview-1")!, previewId: "foreign", vaultInstanceId: "another-vault" });
    const oldToken = handle.sessionToken;
    const newToken = await handle.regenerateToken();
    expect(newToken).not.toBe(oldToken);
    expect(fake.previews.get("preview-1")?.status).toBe("rejected");
    expect(fake.previews.get("applying")?.status).toBe("applying"); expect(fake.previews.get("foreign")?.status).toBe("pending");
    expect((await raw(handle.endpoint!, { Authorization: `Bearer ${oldToken}` })).status).toBe(401);
    const fresh = new Client({ name: "fresh", version: "1" }, { versionNegotiation: { mode: "auto" } }); clients.push(fresh);
    await fresh.connect(new StreamableHTTPClientTransport(new URL(handle.endpoint!), { requestInit: { headers: { Authorization: `Bearer ${newToken}` } } }));
    expect(resultData(await fresh.callTool({ name: "server.identity", arguments: {} })).vaultInstanceId).toBe("vault-test");
    await handle.stop(); await handle.stop(); expect(handle.running).toBe(false); expect(handle.sessionToken).toBeNull();
  });
  it("releases the listener and attempts every pending invalidation even if a port rejects", async () => {
    const { client, handle, fake } = await running(); const port = Number(new URL(handle.endpoint!).port);
    await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "one" } });
    await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "two" } });
    const reject = fake.deps.previews.reject.bind(fake.deps.previews);
    vi.spyOn(fake.deps.previews, "reject").mockImplementationOnce(async () => { throw new Error("port failure"); }).mockImplementation(reject);
    await expect(handle.stop()).rejects.toThrow("port failure");
    handles.splice(handles.indexOf(handle), 1);
    expect(fake.previews.get("preview-2")?.status).toBe("rejected"); expect(handle.running).toBe(false);
    const replacement = await startMcpServer(createFakeMcp().deps, { ...DEFAULT_MCP_SETTINGS, enabled: true, port }); handles.push(replacement);
    expect(replacement.running).toBe(true);
  });
});

describe("resource scope and concurrency", () => {
  it("honors the catalog's live availability for listing and direct calls", async () => {
    const { client, fake } = await running(["read"]);
    const describe = fake.deps.operations.describe.bind(fake.deps.operations);
    vi.spyOn(fake.deps.operations, "describe").mockImplementation((ids) => describe(ids).map((item) => item.id === "T01" ? { ...item, available: false } : item));
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain("operations.T01.read");
    expect(resultError(await client.callTool({ name: "operations.T01.read", arguments: {} }))).toBe("POLICY_DENIED");
    expect(fake.calls.read).not.toHaveBeenCalled();
  });
  it("allows managed encoded ids and denies arbitrary URL/path/traversal", async () => {
    const { client, fake } = await running();
    expect(resourceTarget(`vault-gantt://tasks/${encodeURIComponent("tasks/タスク.md::child")}`)).toMatchObject({ kind: "query", input: { taskIds: ["tasks/タスク.md::child"] } });
    await client.readResource({ uri: `vault-gantt://tasks/${encodeURIComponent("tasks/タスク.md::child")}` });
    expect(fake.calls.query).toHaveBeenCalledTimes(1);
    for (const uri of ["file:///etc/passwd", "https://example.test", "vault-gantt://tasks/%2E%2E%2Fsecret", "vault-gantt://tasks/%2Fabsolute", "vault-gantt://tasks/a?token=x", "vault-gantt://tasks/a/b", "vault-gantt://tasks/%zz"]) {
      const result = await client.readResource({ uri }); expect(JSON.parse((result.contents[0] as { text: string }).text).error).toBeDefined();
    }
    expect(fake.calls.query).toHaveBeenCalledTimes(1);
    expect(resultError(await client.callTool({ name: "operations.T02.read", arguments: { taskId: "../outside.md" } }))).toBe("INVALID_INPUT");
  });
  it("filters capabilities in listings and still denies direct hidden calls", async () => {
    const { client } = await running(["read"]);
    expect((await client.listTools()).tools.some((tool) => tool.name.endsWith(".propose"))).toBe(false);
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "fake" } }))).toBe("POLICY_DENIED");
  });
  it("caps concurrent reads at four without an unbounded queue", async () => {
    const { client, fake } = await running();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    fake.hooks.query = async (id) => { await gate; return { status: "success", result: (await import("../contracts/fixtures")).CONTEXT_QUERY_OUTPUT_FIXTURES[id] }; };
    const reads = [1, 2, 3, 4].map(() => client.callTool({ name: "context.overview", arguments: {} }));
    await vi.waitFor(() => expect(fake.calls.query).toHaveBeenCalledTimes(4));
    expect(resultError(await client.callTool({ name: "context.overview", arguments: {} }))).toBe("POLICY_DENIED");
    release(); expect((await Promise.all(reads)).every((result) => !result.isError)).toBe(true);
  });
  it("expires owned pending proposals using frozen reject port", async () => {
    const fake = createFakeMcp();
    const context = { vaultInstanceId: "vault-test", principalId: "principal-test", capabilities: ["read"] as const, requestId: "test", origin: { kind: "mcp", principalId: "principal-test", clientLabel: "test" } as const };
    const preview = { ...fake.makePreview("T03", context), createdAt: new Date(Date.now() - 700_000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    fake.previews.set(preview.previewId, preview);
    const adapter = new McpAdapter(fake.deps); await adapter.rejectExpired(); expect(fake.previews.get(preview.previewId)?.status).toBe("rejected"); await adapter.revoke();
  });
  it("cancels modern HTTP requests on disconnect", async () => {
    const { client, fake } = await running();
    let cancelled = false;
    fake.hooks.query = async (_id, _input, context) => new Promise((_resolve, reject) => {
      context.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
    });
    const abort = new AbortController();
    const request = client.callTool({ name: "context.overview", arguments: {} }, { signal: abort.signal });
    const rejection = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(fake.calls.query).toHaveBeenCalledTimes(1)); abort.abort(); await rejection;
    await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it("cancels legacy HTTP requests only on explicit cancel notifications, not disconnection", async () => {
    const { handle, fake } = await running(undefined, { mode: "legacy" });
    let cancelled = false;
    fake.hooks.query = async (_id, _input, context) => new Promise((_resolve, reject) => {
      context.signal!.addEventListener("abort", () => { cancelled = true; reject(new Error("cancelled")); }, { once: true });
    });
    const headers = { Authorization: `Bearer ${handle.sessionToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" };
    const abort = new AbortController();
    const reading = fetch(handle.endpoint!, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: "legacy-request", method: "tools/call", params: { name: "context.overview", arguments: {} } }), signal: abort.signal })
      .then((response) => response.text()).catch(() => "cancelled connection");
    await vi.waitFor(() => expect(fake.calls.query).toHaveBeenCalledTimes(1)); abort.abort(); await reading;
    // Wait for SDK disconnect teardown to run before checking the application signal.
    await new Promise((resolve) => setTimeout(resolve, 50)); expect(cancelled).toBe(false);
    const notification = await raw(handle.endpoint!, headers, JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "legacy-request" } }));
    expect(notification.status).toBe(202); await vi.waitFor(() => expect(cancelled).toBe(true));
  });
  it("serializes proposal ports and bounds Vault-wide pending count", async () => {
    const { client, fake } = await running();
    let active = 0, maxActive = 0;
    fake.hooks.propose = async (id, _input, context) => {
      active++; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 10)); active--;
      return fake.makePreview(id, context);
    };
    const results = await Promise.all([1, 2, 3].map((i) => client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: `serial-${i}` } })));
    expect(results.every((result) => !result.isError)).toBe(true); expect(maxActive).toBe(1);
    const sample = fake.previews.get("preview-1")!;
    for (let i = 0; i < 47; i++) fake.previews.set(`other-${i}`, { ...sample, previewId: `other-${i}`, origin: { kind: "mcp", principalId: "another-principal", clientLabel: "other" } });
    expect(resultError(await client.callTool({ name: "operations.T03.propose", arguments: { input: { name: "task" }, callerIntentId: "over-vault-limit" } }))).toBe("POLICY_DENIED");
    expect(fake.calls.propose).toHaveBeenCalledTimes(3);
  });
});
