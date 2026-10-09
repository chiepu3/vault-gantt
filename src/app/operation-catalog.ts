import { OPERATION_IDS, OPERATION_CONTRACTS, DIRECT_UI_ONLY_OPERATION_IDS, operationInputSchemas, operationOutputSchemas, type OperationId, type OperationDefinition } from "../contracts/operations";
import type { PublicOperationDescription } from "../contracts/ports";
import { operationDescription } from "../agent-tools/descriptions";
import { TASK_OPERATION_IDS } from "./operations/task-handlers";
import { SCHEDULE_OPERATION_IDS } from "./operations/schedule-handlers";
import { MARKER_WORKLOAD_OPERATION_IDS } from "./operations/marker-workload-handlers";
import { EVENT_WEEKLY_OPERATION_IDS } from "./operations/event-weekly-handlers";
import { SETTINGS_OPERATION_IDS } from "./operations/settings-handlers";
import { DAILY_OPERATION_IDS } from "./operations/daily-handlers";
import { INTEGRATION_OPERATION_IDS } from "./operations/integration-handlers";
import { VIEW_OPERATION_IDS } from "./operations/view-handlers";
import { CONTROL_OPERATION_IDS } from "./operations/control-handlers";
export const UNIMPLEMENTED_OPERATION_REASONS = {
  T30: "自動優先度の管理値保存に対応する専用effectが契約にありません。契約変更が必要です。",
  S05: "設定変更に伴うT30の管理値保存に対応する専用effectが契約にありません。契約変更が必要です。",
} as const;
export const IMPLEMENTED_OPERATION_IDS = new Set<OperationId>(([...TASK_OPERATION_IDS, ...SCHEDULE_OPERATION_IDS, ...MARKER_WORKLOAD_OPERATION_IDS, ...EVENT_WEEKLY_OPERATION_IDS, ...SETTINGS_OPERATION_IDS, ...DAILY_OPERATION_IDS, ...INTEGRATION_OPERATION_IDS, ...VIEW_OPERATION_IDS, ...CONTROL_OPERATION_IDS, "Q07", "Q08"] as OperationId[]).filter((id) => !(id in UNIMPLEMENTED_OPERATION_REASONS)));
export function operationDefinition<K extends OperationId>(id: K): OperationDefinition<K> {
  const [classification, previewKinds, capabilities] = OPERATION_CONTRACTS[id];
  return { id, classification, previewKinds, capabilities, requestPolicy: (DIRECT_UI_ONLY_OPERATION_IDS as readonly string[]).includes(id) ? "direct-ui-only" : "capabilities", inputSchema: operationInputSchemas[id] as unknown as OperationDefinition<K>["inputSchema"], outputSchema: operationOutputSchemas[id], description: operationDescription(id) };
}
export class OperationCatalog {
  readonly ids = OPERATION_IDS;
  get<K extends OperationId>(id: K): OperationDefinition<K> { return operationDefinition(id); }
  describe(ids: readonly OperationId[] = OPERATION_IDS): readonly PublicOperationDescription[] {
    return ids.map((id) => { const { inputSchema: _input, outputSchema: _output, ...description } = this.get(id); void _input; void _output;
      return { ...description, available: IMPLEMENTED_OPERATION_IDS.has(id), ...(!IMPLEMENTED_OPERATION_IDS.has(id) ? { denial: { code: "POLICY_DENIED" as const, retryable: false, nextAction: UNIMPLEMENTED_OPERATION_REASONS[id as keyof typeof UNIMPLEMENTED_OPERATION_REASONS] ?? `${id}はこのruntimeでは未実装です。既存の人間用UIを使用してください。` } } : {}) };
    }) as PublicOperationDescription[];
  }
}
