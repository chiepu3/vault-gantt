import { createServer, type Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authenticateBearer, generateMcpToken, validateLocalHeaders, validateMcpToken } from "./auth";
import { McpAdapter, type McpDependencies, type McpServerHandle, type McpSettings } from "./server";
import { createCompatibleHandler, MCP_BODY_LIMIT } from "./transport-compat";

function listen(server: HttpServer, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => { reject(error); };
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      const address = server.address();
      if (!address || typeof address === "string") { reject(new Error("MCP listener has no TCP address")); return; }
      resolve(address.port);
    });
  });
}

/** Desktop-only module. Owner plugin calls stop on unload; no global listener sharing. */
export async function startMcpHttpServer(deps: McpDependencies, settings: McpSettings): Promise<McpServerHandle> {
  if (!deps.isDesktop || !settings.enabled) throw new Error("MCP HTTP requires an enabled desktop plugin");
  if (Number(process.versions.node.split(".")[0]) < 20) throw new Error("MCP SDK requires Node.js >=20");
  let token = deps.token ?? generateMcpToken();
  validateMcpToken(token);
  let adapter = new McpAdapter(deps);
  let handler = await createCompatibleHandler(() => adapter.createProtocolServer());
  let serve = toNodeHandler(handler, { maxRequestBodySize: MCP_BODY_LIMIT });
  let accepting = true;
  let running = false;
  let port = settings.port;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!accepting) { response.writeHead(503); response.end(); return; }
    if (!validateLocalHeaders(request.headers, port, settings.allowedOrigins)) { response.writeHead(403); response.end(); return; }
    if (!authenticateBearer(request.headers.authorization, token)) { response.writeHead(401); response.end(); return; }
    // Query credentials/extra endpoints are deliberately not accepted.
    if (request.url !== "/mcp") { response.writeHead(404); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }); response.end(); return; }
    void serve(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  // Bound slow/incomplete request headers and bodies independently of operation time.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxConnections = 32;
  try { port = await listen(server, settings.port); running = true; }
  catch (error) { await handler.close(); throw error; }
  const timer = setInterval(() => { void adapter.rejectExpired().catch(() => {}); }, 30_000);
  timer.unref();
  let stopped: Promise<void> | undefined;
  let rotating = false;

  function stop(): Promise<void> {
    if (stopped) return stopped;
    accepting = false;
    running = false;
    clearInterval(timer);
    stopped = (async () => {
      const closed = new Promise<void>((resolve) => { server.close(() => resolve()); });
      try { await adapter.revoke(); } finally {
        try { await handler.close(); } finally {
          for (const socket of sockets) socket.destroy();
          await closed;
        }
      }
    })();
    return stopped;
  }

  return {
    get running() { return running; },
    get endpoint() { return running ? `http://127.0.0.1:${port}/mcp` : null; },
    get sessionToken() { return running ? token : null; },
    stop,
    async regenerateToken() {
      if (!running || rotating) throw new Error("MCP is stopped or token regeneration is already in progress");
      rotating = true;
      accepting = false;
      try {
        try { await adapter.revoke(); } finally {
          try { await handler.close(); } finally { for (const socket of sockets) socket.destroy(); }
        }
        if (!running) throw new Error("MCP stopped during token regeneration");
        token = generateMcpToken();
        adapter = new McpAdapter(deps);
        handler = await createCompatibleHandler(() => adapter.createProtocolServer());
        if (!running) { await adapter.revoke(); await handler.close(); throw new Error("MCP stopped during token regeneration"); }
        serve = toNodeHandler(handler, { maxRequestBodySize: MCP_BODY_LIMIT });
        accepting = true;
        return token;
      } catch (error) { await stop().catch(() => {}); throw error; }
      finally { rotating = false; }
    },
  };
}
