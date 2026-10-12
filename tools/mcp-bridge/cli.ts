import { startMcpBridge } from "./bridge";

// Secrets never occur in argv or stdout. The host supplies environment variables.
async function main() {
  try {
    const handle = await startMcpBridge({
      url: process.env.VAULT_GANTT_MCP_URL ?? "http://127.0.0.1:8788/mcp",
      token: process.env.VAULT_GANTT_MCP_TOKEN ?? "",
      vaultInstanceId: process.env.VAULT_GANTT_MCP_VAULT_INSTANCE_ID ?? "",
    });
    const close = () => { void handle.close().catch(() => {}).finally(() => process.exit(0)); };
    process.stdin.once("end", close);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    const code = error instanceof Error && error.message.startsWith("MCP_BRIDGE_") ? error.message.split(":")[0]
      : typeof error === "object" && error !== null && "status" in error && (error.status === 401 || error.status === 403) ? "MCP_AUTHENTICATION_FAILED"
      : "APP_NOT_RUNNING";
    process.stderr.write(`${code}: Obsidianの起動、MCP設定、対象Vaultを確認してください。\n`);
    process.exitCode = 1;
  }
}
void main();
