import { z } from "zod";
import type { ToolSet } from "ai";
import type { OperationService } from "../app/operation-service";
import { contextQueryInputSchemas, type ContextQueryId, type ContextQueryMap, type RequestContext } from "../contracts/context";
import { operationInputSchemas, operationRequestDenial, type WriteOperationId, type OperationId, type OperationInputMap, type ReadOperationId, type ExternalRequestOperationId } from "../contracts/operations";
import type { ChatEvent } from "../ai/chat-session";
import { selectOperationIds } from "../ai/tool-selection";
import { fullDescription } from "./descriptions";
import { parseObject, inputError, validatedTool } from "./validated-tool";

const object = z.record(z.string(), z.unknown());
const copySchema = z.object({ subtaskId: z.string().min(1), name: z.string().trim().min(1).max(200) }).strict();
export function chatTools(service: OperationService, context: RequestContext, text: string, proposed: (event: Extract<ChatEvent, { type: "plan" }>) => void): ToolSet {
  const rows = service.describe().filter((row) => row.available && !operationRequestDenial(row.id, context.origin) && row.capabilities.every((capability) => context.capabilities.includes(capability)));
  const ids = new Set(rows.map((row) => row.id));
  const descriptions = (selected: readonly OperationId[]) => rows.filter((row) => selected.includes(row.id)).map((row) => ({ operationId: row.id, description: fullDescription(row.id), inputSchema: z.toJSONSchema(operationInputSchemas[row.id]) }));
  const queryIds = Object.keys(contextQueryInputSchemas).filter((id) => !["tasks.search", "tasks.get-many"].includes(id)) as [ContextQueryId, ...ContextQueryId[]];
  const tools: ToolSet = {};
  if (context.capabilities.includes("read")) {
    tools.tasks_search = validatedTool("タスク候補を名前の部分一致で検索する唯一の入口。親名と子名を別々に検索し、parentIdで所属を確認する。kind省略は親子両方。fieldsで必要情報を一度に取得: identity/status/schedule/derived/priority/tags/content/markers/workload/children。名前はname、本文はtext。旧queryはnameの互換引数。曖昧な同名は確認し、IDを作らない。", contextQueryInputSchemas["tasks.search"], (input) => service.contextPort.query("tasks.search", input, context), (value) => {
      const parsed = parseObject(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "query" in parsed && !("name" in parsed) && !("text" in parsed)) {
        const { query, ...rest } = parsed as Record<string, unknown>; return { ...rest, name: query };
      }
      return parsed;
    });
    tools.tasks_get_many = validatedTool("検索で得たtaskIdsの必要include groupを取得。markersのkeyは表示名と異なる。workloadはhours配列のdate/plan/actual。未取得と未記録を区別する。", contextQueryInputSchemas["tasks.get-many"], (input) => service.contextPort.query("tasks.get-many", input, context));
    tools.context_read = validatedTool('タスク以外の詳細取得。queryIdとinputを指定。calendar.get:{from,to}、projects.get:{parentTaskId,includeChildren:true,childFields:["identity","schedule"]}、daily.get:{dateRange:{from,to},includeItems:true}、settings.get:{sections:["display"]}、events.get/weekly.get:{}、workload.get:{from,to,detail:true}。必要schemaはoperations_describeのqueryIdで取得。', z.object({ queryId: z.enum(queryIds), input: object }).strict(), ({ queryId, input }) => {
      const schema = contextQueryInputSchemas[queryId]; const parsed = schema.safeParse(input);
      return parsed.success ? service.contextPort.query(queryId, parsed.data as ContextQueryMap[ContextQueryId], context) : inputError(parsed.error, schema);
    }, (value) => normalizeEnvelope(value));
  }
  tools.operations_describe = validatedTool("必要な操作のschema・例・制約を取得。idsは最大6件。queryで日本語の目的を検索。ids/query未指定は操作名の索引だけを返す。queryIdでcontext_readの入力schemaを取得。複製はcopy-subtask（子の全編集値を同じ親に新しい名前/keyで複製、承認待ち）。", z.object({ ids: z.array(z.string()).max(6).optional(), query: z.string().max(200).optional(), queryId: z.enum(queryIds).optional() }).strict(), ({ ids: selected, query, queryId }) => {
    if (queryId) return { queryId, inputSchema: z.toJSONSchema(contextQueryInputSchemas[queryId]) };
    if (selected?.includes("copy-subtask") || query && /複製|コピー/.test(query)) return { operationId: "copy-subtask", inputSchema: z.toJSONSchema(copySchema), description: "同じ親の下に全編集値を複製。元は保持、新ID/key・作成更新日は今日。設定/親の複製は非対応。人間の承認待ち、Undo可。" };
    if (selected) {
      if (selected.some((id) => !ids.has(id as OperationId))) return { status: "error", error: { code: "POLICY_DENIED", nextAction: "利用可能な操作索引から選んでください。" } };
      return descriptions(selected as OperationId[]);
    }
    return rows.filter((row) => !query || row.description.purpose.includes(query)).map((row) => ({ operationId: row.id, purpose: row.description.purpose.split("／")[0], classification: row.classification }));
  });
  const hints = descriptions(selectOperationIds(text));
  const index = rows.map((row) => `${row.id}:${row.description.purpose.split("／")[0]}`).join("、");
  tools.operations_propose = validatedTool("操作の共通入口。writeは保存せず人間の承認待ち、read/requestは分類どおり実行。配列/時間mapは全置換、既存値を取得して保持。日付YYYY-MM-DD、calendarDeltaは暦日、親期間は集計値。単純変更は検索→提案だけでよい。必要なschemaだけoperations_describeで取得。\n今回の候補（schemaと例）:" + JSON.stringify(hints) + '\ncopy-subtask:{subtaskId,name}は同じ親へ子を複製する承認待ち提案。\n索引:' + index,
    z.object({ operationId: z.string().min(1).max(100), input: object }).strict(), async ({ operationId, input }) => {
      if (operationId !== "copy-subtask" && !ids.has(operationId as OperationId) || operationId === "copy-subtask" && !ids.has("T04")) return { status: "error", error: { code: "POLICY_DENIED", nextAction: "利用可能な操作を選んでください。" } };
      if (operationId === "copy-subtask") {
        const parsed = copySchema.safeParse(input); if (!parsed.success) return inputError(parsed.error, copySchema);
        const preview = await service.proposeTaskCopy(parsed.data.subtaskId, parsed.data.name, context);
        return emit(preview, input);
      }
      const id = operationId as OperationId, schema = operationInputSchemas[id];
      const parsed = schema.safeParse(input); if (!parsed.success) return inputError(parsed.error, schema);
      const classification = service.catalog.get(id).classification;
      if (classification === "read") return service.read(id as ReadOperationId, parsed.data as OperationInputMap[ReadOperationId], context);
      if (classification !== "write") {
        const result = await service.request(id as ExternalRequestOperationId, parsed.data as OperationInputMap[ExternalRequestOperationId], context);
        return id === "Q08" ? emit(result as import("../contracts/preview").OperationPreviewV1, input) : result;
      }
      return emit(await service.propose(id as WriteOperationId, parsed.data as OperationInputMap[WriteOperationId], context), input);
    }, normalizeEnvelope);
  async function emit(preview: import("../contracts/preview").OperationPreviewV1, input: unknown) {
    if (context.signal?.aborted) { service.discard(preview.previewId); return { status: "error", error: { code: "CANCELLED" } }; }
    proposed({ type: "plan", plan: service.legacyPlan(preview), preview, operationId: preview.operationId as WriteOperationId, operation: "update-batch", input });
    await service.request("Q07", { previewId: preview.previewId }, context);
    return { status: "proposal-created", previewId: preview.previewId, operationId: preview.operationId, entries: preview.entries, warnings: preview.warnings, saved: false, nextAction: "利用者がカードを確認して承認するまで保存されません。" };
  }
  return tools;
}
function normalizeEnvelope(value: unknown): unknown {
  const parsed = parseObject(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) && "input" in parsed ? { ...parsed, input: parseObject(parsed.input) } : parsed;
}
