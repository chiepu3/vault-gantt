import type { ContextReadPort } from "../contracts/ports";
import type { RequestContext, ReadResultV1 } from "../contracts/context";
/** Only overview is automatic. Selection/content detail always requires an explicit read tool. */
export class ContextBuilder {
  constructor(private readonly port: ContextReadPort, readonly byteBudget = 8192) {}
  async build(context: RequestContext): Promise<string> {
    const response = await this.port.query("context.overview", {}, context);
    if (response.status === "error") return "コンテキスト取得失敗: " + JSON.stringify(response.error);
    const overview = response.result;
    if (overview.data.kind !== "overview") throw new Error("INVALID_CONTEXT");
    // Counts/date/revision/capabilities are retained; large definition arrays are fetched explicitly.
    const compact: ReadResultV1 = { ...overview, data: { ...overview.data, settings: {
      taskFolder: overview.data.settings.taskFolder, autoPriorityEnabled: overview.data.settings.autoPriorityEnabled,
      ganttWorkloadDailyCapacityHours: overview.data.settings.ganttWorkloadDailyCapacityHours,
    } } };
    const json = JSON.stringify(compact);
    if (new TextEncoder().encode(json).length > this.byteBudget) return JSON.stringify({ schemaVersion: 1, today: overview.today, timezone: overview.timezone, snapshotRevision: overview.snapshotRevision, counts: overview.data.counts, capabilities: overview.data.capabilities, omitted: "parse error詳細はcontext.overviewで取得してください。" });
    return json;
  }
}
