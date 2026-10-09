import type { RequestContext, ContextQueryId, ContextQueryMap } from "../contracts/context";

export const OVERVIEW_URI = "vault-gantt://context/overview";

export function resourceTarget(uri: string):
  | { kind: "query"; id: ContextQueryId; input: ContextQueryMap[ContextQueryId] }
  | { kind: "preview"; previewId: string } {
  if (uri === OVERVIEW_URI) return { kind: "query", id: "context.overview", input: {} };
  // Match the raw URI before URL normalization can erase traversal segments.
  const match = /^vault-gantt:\/\/(tasks|previews)\/([^?#/]+)$/.exec(uri);
  if (!match) throw new Error("Unmanaged resource URI");
  const id = decodeURIComponent(match[2]);
  assertScopedIdentifier(id);
  if (match[1] === "previews") return { kind: "preview", previewId: id };
  return { kind: "query", id: "tasks.get-many", input: { taskIds: [id] } };
}

/** Lexical checks only. Registry/Vault scope and symlink resolution remain port responsibilities. */
export function assertScopedIdentifier(id: string): void {
  if (!id || id.length > 1000 || /[\0\r\n\\]/.test(id) || id.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(id)
    || /^[A-Za-z]:/.test(id) || id.split("/").some((part) => part === ".." || part === ".")) throw new Error("Unsafe target identifier");
}

const scopedFields = new Set(["taskId", "taskIds", "parentTaskId", "parentId", "parentIds", "subtaskId", "path", "taskFolder", "templatePath", "orderedParentIds", "orderedIds"]);
export function validateScopedInputs(input: unknown): void {
  if (!input || typeof input !== "object") return;
  for (const [key, value] of Object.entries(input)) {
    if (scopedFields.has(key)) {
      for (const item of Array.isArray(value) ? value : [value]) if (typeof item === "string" && item !== "") assertScopedIdentifier(item);
    }
    if (Array.isArray(value)) value.forEach(validateScopedInputs);
    else if (typeof value === "object") validateScopedInputs(value);
  }
}

export function ownsPreview(preview: { readonly vaultInstanceId: string; readonly origin: { readonly kind: string; readonly principalId?: string } }, context: RequestContext): boolean {
  return preview.vaultInstanceId === context.vaultInstanceId && preview.origin.kind === "mcp" && preview.origin.principalId === context.principalId;
}
