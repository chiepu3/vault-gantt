import type { ConnectionConfig } from "./chat-session";
import { validEndpoint } from "./sdk-provider";

/** Secret storage id for the AI chat API key. The key value itself is never part of the settings object. */
export const AI_SECRET_ID = "vault-gantt-ai-api-key";

export type AiPreset = "openrouter" | "local" | "custom";
export const AI_PRESET_URLS: Record<Exclude<AiPreset, "custom">, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  local: "http://localhost:1234/v1",
};
export const AI_PRESET_LABELS: Record<AiPreset, string> = {
  openrouter: "OpenRouter",
  local: "ローカル（LM Studio など）",
  custom: "カスタム",
};

/**
 * Saved in data.json under `ai`, outside TaskWorkbenchSettings, so it never reaches
 * settings snapshots, previews, AI context or MCP responses.
 * `apiKey` is only used when Obsidian's secret storage is unavailable.
 */
export interface AiConnectionSettings {
  preset: AiPreset;
  baseUrl: string;
  model: string;
  useApiKey: boolean;
  apiKey?: string;
}

export function defaultAiSettings(): AiConnectionSettings {
  return { preset: "openrouter", baseUrl: AI_PRESET_URLS.openrouter, model: "", useApiKey: true };
}

/** Tolerates missing or malformed stored data; unknown fields are dropped. */
export function normalizeAiSettings(raw: unknown): AiConnectionSettings {
  const base = defaultAiSettings();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const preset: AiPreset = value.preset === "local" || value.preset === "custom" || value.preset === "openrouter" ? value.preset : base.preset;
  const baseUrl = typeof value.baseUrl === "string" && value.baseUrl.trim() ? value.baseUrl.trim() : preset === "custom" ? "" : AI_PRESET_URLS[preset];
  const result: AiConnectionSettings = {
    preset, baseUrl,
    model: typeof value.model === "string" ? value.model.trim() : "",
    useApiKey: typeof value.useApiKey === "boolean" ? value.useApiKey : preset === "openrouter",
  };
  if (typeof value.apiKey === "string" && value.apiKey) result.apiKey = value.apiKey;
  return result;
}

export function normalizeBaseUrl(url: string): string { return url.trim().replace(/\/+$/, ""); }

export function toConnectionConfig(settings: AiConnectionSettings): ConnectionConfig {
  return { provider: "openai-compatible", endpoint: normalizeBaseUrl(settings.baseUrl), model: settings.model.trim(), auth: settings.useApiKey ? "secret" : "none", secretId: settings.useApiKey ? AI_SECRET_ID : "" };
}

export type ModelListResult = { ok: true; models: string[] } | { ok: false; reason: string };

/** Fixed Japanese messages only: response bodies, URLs and keys are never echoed. */
export async function listModels(options: { baseUrl: string; apiKey?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<ModelListResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) return { ok: false, reason: "接続先URLを入力してください。" };
  if (!validEndpoint(baseUrl)) return { ok: false, reason: "接続先URLは https:// で始まるものか、http://localhost のものを指定してください。" };
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10000);
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.apiKey) headers.authorization = "Bearer " + options.apiKey;
    const response = await fetchImpl(baseUrl + "/models", { method: "GET", headers, redirect: "error", signal: controller.signal });
    if (response.status === 401 || response.status === 403) return { ok: false, reason: `APIキーが受け付けられませんでした（HTTP ${response.status}）。` };
    if (response.status === 404) return { ok: false, reason: "モデル一覧が見つかりません（HTTP 404）。接続先URLの末尾が /v1 になっているか確認してください。" };
    if (!response.ok) return { ok: false, reason: `接続先がエラーを返しました（HTTP ${response.status}）。` };
    let body: unknown;
    try { body = await response.json(); } catch { return { ok: false, reason: "モデル一覧の形式を読み取れませんでした。" }; }
    const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) return { ok: false, reason: "モデル一覧の形式を読み取れませんでした。" };
    const models = [...new Set(data.map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0))].sort((a, b) => a.localeCompare(b));
    if (!models.length) return { ok: false, reason: "接続先にモデルがありません。ローカルLLMではモデルを読み込んでから再取得してください。" };
    return { ok: true, models };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "接続先から応答がありません（タイムアウト）。" : "接続できませんでした。URLと、接続先のアプリが起動しているかを確認してください。LM Studio では、サーバー設定の「CORSを有効にする」もオンにしてください。" };
  } finally { clearTimeout(timer); }
}
