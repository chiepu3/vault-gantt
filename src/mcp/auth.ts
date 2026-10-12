import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Dedicated MCP secret; never persist this in Vault plugin data. */
export function generateMcpToken(): string {
  return randomBytes(32).toString("base64url");
}

export function validateMcpToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error("MCP token must contain at least 32 random bytes (base64url)");
}

export function authenticateBearer(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function validateLocalHeaders(headers: IncomingHttpHeaders, port: number, origins: readonly string[]): boolean {
  return headers.host === `127.0.0.1:${port}`
    && (headers.origin === undefined || (typeof headers.origin === "string" && origins.includes(headers.origin)));
}
