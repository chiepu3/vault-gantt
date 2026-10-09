import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";
import { createFakeMcp } from "./fakes";
import type { startMcpServer } from "../../src/mcp/server";

describe("MCP mobile import boundary", () => {
  it("evaluates the bundled entry and disabled/mobile start without evaluating Node builtins", async () => {
    const bundle = await build({ entryPoints: ["src/mcp/server.ts"], bundle: true, platform: "node", format: "cjs", target: "es2018", external: ["node:*"], write: false });
    const module = { exports: {} as { startMcpServer: typeof startMcpServer } };
    const imports: string[] = [];
    runInNewContext(bundle.outputFiles[0].text, {
      module, exports: module.exports,
      require(name: string) { imports.push(name); throw new Error(`Node import evaluated: ${name}`); },
      console, URL, TextEncoder, TextDecoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    });
    const fake = createFakeMcp();
    expect((await module.exports.startMcpServer({ ...fake.deps, isDesktop: false }, { enabled: true, port: 8788, secretId: null, allowedOrigins: [] })).running).toBe(false);
    expect((await module.exports.startMcpServer(fake.deps)).running).toBe(false);
    expect(imports).toEqual([]);
  });
});
