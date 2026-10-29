import { z } from "zod";
import type { ToolSet } from "ai";
import type { OperationService } from "../app/operation-service";
import type { RequestContext } from "../contracts/context";
import { dateOnlySchema } from "../contracts/context";
import { operationInputSchemas } from "../contracts/operations";
import type { OperationPreviewV1 } from "../contracts/preview";
import { compactForMatch, matchScore } from "../core/fuzzy-match";
import { validatedTool } from "./validated-tool";

const candidatesSchema = z.object({ date: dateOnlySchema, labels: z.array(z.string().trim().min(1).max(200)).min(1).max(20) }).strict();
const proposeSchema = operationInputSchemas.T31;

type Emit = (preview: OperationPreviewV1, input: unknown) => Promise<unknown>;
/** "リリース準備の設計見直し" has no space, so the parent name only shows up as a prefix of the label; matchScore can't see that. */
function labelStartsWithName(label: string, name: string): boolean {
  const compactName = compactForMatch(name);
  return compactName.length >= 2 && compactForMatch(label).startsWith(compactName);
}
/** Daily work-log entry: resolve each line to a subtask/project/event, then propose actual hours as ordinary approval cards. */
export function worklogTools(service: OperationService, context: RequestContext, emit: Emit): ToolSet {
  const top = <T extends { score: number }>(rows: T[], max: number) => {
    const strict = rows.filter((row) => row.score >= 2);
    return (strict.length ? strict : rows).sort((a, b) => b.score - a.score).slice(0, max);
  };
  return {
    worklog_candidates: validatedTool("日報の各行（作業名）に対する候補を一度に取得。日付dateの実績時間付きで、親(プロジェクト)・サブタスク・イベントの類似候補を返す。labelsには1作業=1要素（例:「プロジェクト2 設計」）。結果から対象を選び worklog_propose へ。候補が無い行は、親がありサブタスクが無ければ新規サブタスク、親も無ければイベントとして登録する。", candidatesSchema, async ({ date, labels }) => {
      const snapshot = await service.contextPort.snapshot();
      const results = labels.map((label) => {
        const parents = top(snapshot.parents.map((parent) => ({ score: Math.max(matchScore(label, [parent.displayName || parent.title]), labelStartsWithName(label, parent.displayName || parent.title) ? 2 : 0), parentId: parent.id, name: parent.displayName || parent.title, childCount: parent.subtasks?.size ?? 0 })).filter((row) => row.score > 0), 3);
        const subtasks = top(snapshot.parents.flatMap((parent) => [...parent.subtasks?.values() ?? []].map((child) => ({
          score: matchScore(label, [child.displayName || child.title, `${parent.displayName} ${child.displayName}`]), subtaskId: child.id, name: child.displayName || child.title, parentName: parent.displayName || parent.title, parentId: parent.id,
          completed: child.completed, ...(child.disabled ? { disabled: true } : {}), actualOnDate: child.workloadActual?.[date] ?? 0, planOnDate: child.workloadPlan?.[date] ?? 0 }))).filter((row) => row.score > 0), 5);
        const events = top(snapshot.settings.ganttEvents.map((event) => ({ score: matchScore(label, [event.title]), eventKey: event.key, title: event.title, date: event.date, actualOnDate: event.workloadActual?.[date] ?? 0 })).filter((row) => row.score > 0), 3);
        return { label, parents: parents.map(({ score: _s, ...rest }) => rest), subtasks: subtasks.map(({ score: _s, ...rest }) => rest), events: events.map(({ score: _s, ...rest }) => rest),
          matchQuality: subtasks[0] && subtasks[0].score >= 2 || parents[0] && parents[0].score >= 2 || events[0] && events[0].score >= 2 ? "match" : "near-or-none" };
      });
      return { status: "success", date, results, note: "actualOnDate=その日の既存実績(0は未記録)。disabled=trueのサブタスクは一時無効で、実績を入れても集計に入らない。matchQualityがnear-or-noneの行は推測で確定せず、候補が無ければ新規作成/イベント扱いにする。" };
    }),
    worklog_propose: validatedTool("日報の実績時間をまとめて登録する変更案を1枚のカードで作成（保存は承認後）。entries各要素は hours(0.5刻み)と、既存サブタスク{subtaskId} / 親の下に新規サブタスク{parentId,newSubtaskName} / 既存イベント{eventKey} / 新規イベント{eventTitle} のいずれか。同じ対象の複数行は合算される。その日(date)の実績は指定値で置き換わり、他の日は保持される。", proposeSchema, async (input) => emit(await service.propose("T31", input, context), input)),
  };
}
