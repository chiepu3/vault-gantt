import type { TaskWorkbenchSettings } from "../core/types";
import { canonical } from "./operations/runtime";

type Key = keyof TaskWorkbenchSettings;
/** Shares the operation queue, including changes made by existing UI callers. */
export class SettingsPersistence {
  private observed: TaskWorkbenchSettings;
  private readonly generations = new Map<Key, number>();
  private readonly pendingUi = new Map<Key, number>();
  constructor(private readonly host: {
    settings(): TaskWorkbenchSettings;
    coordinate<T>(run: () => Promise<T>): Promise<T>;
    write(settings: TaskWorkbenchSettings): Promise<void>;
    read(): Promise<unknown>;
  }) { this.observed = structuredClone(host.settings()); }

  save(): Promise<void> {
    const current = structuredClone(this.host.settings());
    const keys = (Object.keys(current) as Key[]).filter((key) => canonical(current[key]) !== canonical(this.observed[key]));
    // Observation and the queued patch must never share a mutable object.
    this.observed = structuredClone(current);
    for (const key of keys) {
      this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      this.pendingUi.set(key, (this.pendingUi.get(key) ?? 0) + 1);
    }
    return this.host.coordinate(async () => {
      try { await this.persist(current, keys, false); }
      finally { for (const key of keys) this.pendingUi.set(key, this.pendingUi.get(key)! - 1); }
    });
  }

  /** Called inside the common queue; never enqueue recursively. */
  async persist(changes: TaskWorkbenchSettings, keys: readonly Key[], publish = true): Promise<void> {
    const before = structuredClone(this.host.settings());
    const generations = new Map(keys.map((key) => [key, this.generations.get(key) ?? 0]));
    const candidate = structuredClone(before);
    for (const key of keys) Object.assign(candidate, { [key]: structuredClone(changes[key]) });
    await this.host.write(candidate);
    const actual = await this.host.read() as Partial<TaskWorkbenchSettings> | null;
    if (!actual || typeof actual !== "object" || Array.isArray(actual) || keys.some((key) => canonical(actual[key]) !== canonical(candidate[key]))) throw new Error("SETTINGS_SAVE_CONFLICT");
    for (const key of publish ? keys : []) {
      // Equal values do not mean equal intent: a UI edit may have returned
      // to its original value while the disk write awaited completion.
      if ((this.generations.get(key) ?? 0) !== generations.get(key) || (this.pendingUi.get(key) ?? 0) > 0) continue;
      // UI changes made during the await already have a queued patch. Preserve
      // those values in memory until that patch is persisted.
      if (canonical(this.host.settings()[key]) === canonical(before[key])) Object.assign(this.host.settings(), { [key]: structuredClone(candidate[key]) });
      if (canonical(this.observed[key]) === canonical(before[key])) Object.assign(this.observed, { [key]: structuredClone(candidate[key]) });
    }
  }
}
