import type { GanttProjectionV1, OperationPreviewV1, PreviewEffect, PreviewEffectKind } from "../contracts/preview";
import { buildNameMap, entryTitle, h, renderEffect, effectIsNoop } from "./preview-renderers";

/** Effects with no natural Gantt shape. A bar here would invent a schedule that does not exist. */
export const PANEL_EFFECT_KINDS = ["service-state", "settings", "view", "external-send", "diagnostic", "conversation"] as const satisfies readonly PreviewEffectKind[];
const PANEL_TITLES: Record<(typeof PANEL_EFFECT_KINDS)[number], string> = {
  "service-state": "管理値の保存", settings: "設定の変更", view: "表示の変更", "external-send": "同期の状態", diagnostic: "診断の状態", conversation: "チャットの状態",
};
const PANEL_NOTES: Record<(typeof PANEL_EFFECT_KINDS)[number], string> = {
  "service-state": "サービスの管理値を保存します。利用者が編集する設定ではありません。", settings: "この変更はGanttのバーとしては表示されません。変更後の設定値を示します。",
  view: "Ganttの見た目に関わる変更です。バーの日程は変わりません。",
  "external-send": "送信する内容の見本です。Ganttには何も追加されません。",
  diagnostic: "時間軸には何も表示されません。記録の状態だけを示します。",
  conversation: "チャットの状態に関する変更です。日程の変更はありません。",
};
const FEATURE_TEXT = { "feature-disabled": "機能がオフのためGanttに表示されない対象" } as const;

export function isPanelEffect(effect: PreviewEffect): effect is Extract<PreviewEffect, { kind: (typeof PANEL_EFFECT_KINDS)[number] }> {
  return (PANEL_EFFECT_KINDS as readonly string[]).includes(effect.kind);
}
export function panelEffects(preview: OperationPreviewV1): { readonly actionId: string; readonly displayName: string; readonly effect: PreviewEffect }[] {
  return preview.entries.flatMap((entry) => entry.effects.filter((effect) => isPanelEffect(effect) && !effectIsNoop(effect)).map((effect) => ({ actionId: entry.actionId, displayName: entry.displayName, effect })));
}

/** The "Gantt does not show this" panel for settings, sync, diagnostics, chat and view changes. */
export function renderNonGanttPanel(parent: HTMLElement, preview: OperationPreviewV1, projection: GanttProjectionV1 | null = preview.projection): HTMLElement | undefined {
  const items = panelEffects(preview);
  if (!items.length) return undefined;
  const panel = h(parent, "section", "vg-pv-panel"); panel.setAttribute("aria-label", "Ganttに表示されない変更");
  h(panel, "div", "vg-pv-subtitle", "Ganttに表示されない変更");
  const ctx = { projection, names: buildNameMap(projection) };
  const kinds = [...new Set(items.map((item) => item.effect.kind))] as (typeof PANEL_EFFECT_KINDS)[number][];
  for (const kind of kinds) {
    const group = h(panel, "div", "vg-pv-panel-group"); group.dataset.kind = kind;
    h(group, "div", "vg-pv-panel-title", PANEL_TITLES[kind]);
    h(group, "p", "vg-pv-note", PANEL_NOTES[kind]);
    for (const item of items.filter((entry) => entry.effect.kind === kind)) {
      const entry = preview.entries.find((candidate) => candidate.actionId === item.actionId);
      if (entry) h(group, "div", "vg-pv-muted", entryTitle(entry));
      renderEffect(group, item.effect, { ...ctx, entity: entry?.entity });
    }
  }
  const hidden = projection?.visibility.filter((item) => item.state === "feature-disabled") ?? [];
  if (hidden.length) {
    const reasons = h(panel, "div", "vg-pv-hidden"); reasons.dataset.state = "feature-disabled";
    h(reasons, "div", "vg-pv-hidden-title", `${FEATURE_TEXT["feature-disabled"]}: ${hidden.length}件`);
    for (const item of hidden.slice(0, 5)) h(reasons, "div", "vg-pv-muted", item.reason);
  }
  return panel;
}
