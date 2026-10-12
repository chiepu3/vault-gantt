import type { OperationResult, TaskDiff } from "./operation-registry";
export interface ScheduleGhost { taskId: string; name: string; before: { start: string; end: string }; after: { start: string; end: string } }
// Ephemeral, bounded to the most recent confirmed result. No vault/settings writes.
export class ScheduleGhostStore {
  readonly entries = new Map<string, ScheduleGhost>();
  private readonly fingerprints = new Map<string, string>();
  fingerprint(path: string): string { return this.fingerprints.get(path) ?? ""; }
  private timer?: ReturnType<typeof setTimeout>;
  private readonly listeners = new Set<(event: "show" | "clear") => void>();
  constructor(private readonly ttlMs = 60000) {}
  subscribe(listener: (event: "show" | "clear") => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  show(result: OperationResult): void {
    this.clear();
    for (const diff of result.diffs.slice(0, 100)) {
      if (!isScheduleDiff(diff) || !diff.schedule) continue;
      this.entries.set(diff.taskId, { taskId: diff.taskId, name: diff.name, ...structuredClone(diff.schedule) });
    }
    if (!this.entries.size) return;
    for (const ghost of this.entries.values()) {
      const path = ghost.taskId.split("::")[0];
      this.fingerprints.set(path, (this.fingerprints.get(path) ?? "") + JSON.stringify(ghost));
    }
    this.timer = setTimeout(() => this.clear(), this.ttlMs);
    for (const listener of this.listeners) listener("show");
  }
  clear(): void {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (!this.entries.size) return;
    this.entries.clear(); this.fingerprints.clear(); for (const listener of this.listeners) listener("clear");
  }
}
export function isScheduleDiff(diff: TaskDiff): boolean { return diff.fields.some((field) => ["plannedStartDate", "plannedEndDate", "dueDate"].includes(field.field)); }
