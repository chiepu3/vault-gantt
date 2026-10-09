import type { OperationErrorV1 } from "../../contracts/context";
import type { TaskRow, TaskWorkbenchSettings } from "../../core/types";
import type { VaultAdapter } from "../task-operations";

export class OperationFailure extends Error {
  constructor(readonly error: OperationErrorV1, detail: string = error.code) { super(detail); }
}
export function fail(code: OperationErrorV1["code"], detail: string, field?: string): never {
  throw new OperationFailure({ code, ...(field ? { field } : {}), retryable: ["REVISION_CONFLICT", "CURSOR_STALE", "PLAN_EXPIRED"].includes(code), nextAction: detail }, detail);
}
export function canonical(value: unknown): string {
  const order = (item: unknown): unknown => Array.isArray(item) ? item.map(order)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, order(child)])) : item;
  return JSON.stringify(order(value));
}
export async function contentRevision(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(typeof value === "string" ? value : canonical(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export interface TaskSnapshot {
  parents: TaskRow[];
  contents: Map<string, string>;
  revisions: Map<string, string>;
  statRevisions: Map<string, string>;
  settings: TaskWorkbenchSettings;
  revision: string;
  settingsRevision: string;
  calendarRevision: string;
  today: string;
  timezone: string;
  parseFailures: string[];
}
export interface HandlerEnvironment {
  snapshot: TaskSnapshot;
  vault: VaultAdapter;
}
export interface TaskChange { taskId: string; patch: import("../../core/types").TaskPatch; expectedRevision?: string }
export function flatten(parents: readonly TaskRow[]): TaskRow[] { return parents.flatMap((parent) => [parent, ...parent.subtasks?.values() ?? []]); }
export function findTask(snapshot: TaskSnapshot, id: string, kind?: TaskRow["kind"]): TaskRow {
  const row = flatten(snapshot.parents).find((task) => task.id === id);
  if (!row) fail("NOT_FOUND", `対象 ${id} を検索し直してください。`, "taskId");
  if (kind && row.kind !== kind) fail("KIND_MISMATCH", `${kind}のIDを指定してください。`, "taskId");
  return row;
}
export function checkRevision(snapshot: TaskSnapshot, row: TaskRow, expected?: string): void {
  if (expected && expected !== snapshot.revisions.get(row.file.path)) fail("REVISION_CONFLICT", "詳細を再取得して再プレビューしてください。", "expectedRevision");
}
