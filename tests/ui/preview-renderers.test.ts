/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { PREVIEW_EFFECT_KINDS, previewEffectSchema, type PreviewEffect } from "../../src/contracts/preview";
import { EFFECT_FIXTURES, PREVIEW_FIXTURES, DELETE_PREVIEW, CHILD_ID, DATE } from "../contracts/fixtures";
import {
  EFFECT_RENDERERS, EFFECT_TITLES, FIELD_LABELS, renderEffect, renderEntryEffects, renderGenericEffect, effectIsNoop, buildNameMap, formatScalar, fmtBytes,
} from "../../src/ui/preview-renderers";
import { EDITABLE_SETTING_KEYS, } from "../../src/contracts/context";
import { OPERATION_IDS } from "../../src/contracts/operations";
import { runtimeFixture } from "../app/operation-runtime-fixture";
import { cardTitle, renderOperationPreviewCard } from "../../src/ui/operation-preview-card";
import { OPERATION_LABELS, entryTitle, fieldLabel, operationLabel } from "../../src/ui/preview-renderers";
import { renderNonGanttPanel } from "../../src/ui/preview-panels";
import { ENTITY_FIELDS } from "../../src/contracts/preview";
import { createFakeDocument, makeFakeEl, byClass, deepText, findAll, type FakeEl } from "../stubs/fake-dom";

beforeEach(() => { vi.stubGlobal("document", createFakeDocument()); });
afterEach(() => vi.unstubAllGlobals());
const root = () => makeFakeEl("div") as unknown as HTMLElement & FakeEl;
const text = (el: unknown) => deepText(el as FakeEl);

describe("effect renderers cover every contract variant", () => {
  it.each(["S30", "S31", "S32"] as const)("%s shows source format, template and creation permission instead of only its unchanged label", async (id) => {
    const f = await runtimeFixture();
    f.settings.dailyTodoSources[0].format = "[daily/]YYYY-MM-DD";
    f.settings.dailyTodoSources[0].creatableFromGantt = false;
    const input = id === "S30" ? { sourceKey: "main", momentFormat: "[other/]YYYY-MM-DD" }
      : id === "S31" ? { sourceKey: "main", templatePath: "templates/daily.md" } : { sourceKey: "main", creatableFromGantt: true };
    const preview = await f.service.propose(id, input as any, f.context);
    const parent = root(); for (const entry of preview.entries) renderEntryEffects(parent, entry, {});
    const before = byClass(parent as any, "vg-pv-before")[0], after = byClass(parent as any, "vg-pv-after")[0];
    expect(text(before)).toContain("日次"); expect(text(after)).toContain("日次");
    expect(text(before)).toContain("ファイル名形式"); expect(text(after)).toContain("ファイル名形式");
    expect(text(before)).toContain("[daily/]YYYY-MM-DD");
    expect(text(after)).toContain(id === "S30" ? "[other/]YYYY-MM-DD" : "[daily/]YYYY-MM-DD");
    expect(text(before)).toContain("テンプレート"); expect(text(before)).toContain("未設定");
    expect(text(after)).toContain(id === "S31" ? "templates/daily.md" : "未設定");
    expect(text(before)).toContain("Ganttから作成"); expect(text(before)).toContain("オフ");
    expect(text(after)).toContain(id === "S32" ? "オン" : "オフ");
    for (const internal of ["dailyTodoSources", "templatePath", "creatableFromGantt", '"format"', '"label"']) expect(text(parent)).not.toContain(internal);
    f.service.dispose();
  });
  it("keeps every field of named object arrays in scalar summaries with Japanese labels", () => {
    const text = formatScalar("dailyTodoSources", [{ label: "日次", format: "[other/]YYYY-MM-DD", templatePath: "templates/daily.md", creatableFromGantt: false }]);
    for (const value of ["日次", "ファイル名形式: [other/]YYYY-MM-DD", "テンプレート: templates/daily.md", "Ganttから作成: オフ"]) expect(text).toContain(value);
    expect(text).not.toContain("templatePath"); expect(text).not.toContain("creatableFromGantt");
  });
  it("has a renderer and a title for each effect kind", () => {
    expect(PREVIEW_EFFECT_KINDS).toHaveLength(18);
    expect(Object.keys(EFFECT_RENDERERS).sort()).toEqual([...PREVIEW_EFFECT_KINDS].sort());
    expect(Object.keys(EFFECT_TITLES).sort()).toEqual([...PREVIEW_EFFECT_KINDS].sort());
  });
  it("the shared fixtures include every kind and each one validates against the schema", () => {
    const kinds = new Set(EFFECT_FIXTURES.map((effect) => effect.kind));
    for (const kind of PREVIEW_EFFECT_KINDS) expect(kinds.has(kind), kind).toBe(true);
    for (const effect of EFFECT_FIXTURES) expect(previewEffectSchema.safeParse(effect).success).toBe(true);
  });
  it.each(EFFECT_FIXTURES.map((effect, index) => [effect.kind + "#" + index, effect] as const))("renders %s with its title and no unsupported-kind notice", (_name, effect) => {
    const parent = root();
    const section = renderEffect(parent, effect as PreviewEffect, {}) as unknown as FakeEl;
    expect(section.dataset.kind).toBe(effect.kind);
    expect(section.getAttribute("aria-label")).toBe(EFFECT_TITLES[effect.kind]);
    expect(text(section).length).toBeGreaterThan(EFFECT_TITLES[effect.kind].length);
    expect(text(section)).not.toContain("未対応");
  });
  it("keeps every field of an unknown future effect instead of dropping it", () => {
    const parent = root();
    renderEffect(parent, { kind: "future-kind", stuff: { a: 1 }, name: "値" } as any, {});
    const shown = text(parent);
    expect(shown).toContain("値"); expect(shown).toContain("その他の項目"); expect(shown).toContain('{"a":1}');
    const direct = root(); renderGenericEffect(direct, { kind: "x", extra: true } as any); expect(text(direct)).toContain("その他の項目");
  });
  it("labels every public entity field and editable setting in Japanese", () => {
    const fields = new Set<string>([...Object.values(ENTITY_FIELDS).flat(), ...EDITABLE_SETTING_KEYS]);
    const missing = [...fields].filter((field) => !FIELD_LABELS[field]);
    expect(missing).toEqual([]);
  });
});

describe("fields", () => {
  const change = (field: string, before: unknown, after: unknown, reason = "requested") => ({ field, before, after, reason }) as any;
  it("shows requested changes first and folds derived, normalized and update-date changes", () => {
    const parent = root();
    renderEffect(parent, { kind: "fields", fields: [change("completed", false, true), change("statusLabel", "active", "done", "derived"), change("updatedAt", "2026-10-01", "2026-10-09", "normalized")] }, {});
    const folded = byClass(parent as any, "vg-pv-derived")[0];
    expect(folded).toBeTruthy();
    expect(text(folded)).toContain("補正・連動した変更（2件）"); expect(text(folded)).toContain("更新日"); expect(text(folded)).toContain("連動"); expect(text(folded)).toContain("完了");
    const main = byClass(parent as any, "vg-pv-row").filter((row) => !findAll(folded, (el) => el === row).length);
    expect(main).toHaveLength(1); expect(text(main[0])).toContain("未完了"); expect(text(main[0])).toContain("完了");
    expect(text(main[0])).toContain("前"); expect(text(main[0])).toContain("後");
  });
  it("renders tags as chips, empty values as 未設定, dates with a weekday and masks secrets", () => {
    const parent = root();
    renderEffect(parent, { kind: "fields", fields: [change("tags", ["A"], ["A", "B"]), change("dueDate", "", DATE), change("secretId", "abc", "def")] }, {});
    expect(byClass(parent as any, "vg-pv-chip").map(text)).toEqual(["A", "A", "B"]);
    expect(text(parent)).toContain("未設定"); expect(text(parent)).toContain("2026-10-13（火）");
    expect(text(parent)).not.toContain("abc"); expect(text(parent)).toContain("表示しません");
    expect(formatScalar("notes", null)).toBe("未設定");
  });
  it("tells a request equal to the current state apart from an update-date-only change", () => {
    const noop = root();
    renderEntryEffects(noop, { actionId: "a", entity: { kind: "task", taskId: CHILD_ID }, displayName: "x", effects: [{ kind: "fields", fields: [change("completed", true, true)] }] } as any);
    expect(text(noop)).toContain("現在の状態と同じため"); expect(byClass(noop as any, "vg-pv-effect")).toHaveLength(0);
    const dateOnly = root();
    renderEntryEffects(dateOnly, { actionId: "a", entity: { kind: "task", taskId: CHILD_ID }, displayName: "x", effects: [{ kind: "fields", fields: [change("updatedAt", "2026-10-01", "2026-10-09", "normalized")] }] } as any);
    expect(text(dateOnly)).toContain("更新日だけが変わります");
    expect(effectIsNoop({ kind: "schedule", before: { start: DATE, end: DATE }, after: { start: DATE, end: DATE }, unit: "calendar-day" })).toBe(true);
  });
});

describe("schedule, deadline and marker", () => {
  it("draws both periods on one axis and names the day unit", () => {
    const parent = root();
    renderEffect(parent, { kind: "schedule", before: { start: DATE, end: "2026-10-15" }, after: { start: "2026-10-16", end: "2026-10-18" }, unit: "business-day" }, {});
    expect(byClass(parent as any, "vg-ai-mini-bar")).toHaveLength(2); expect(text(parent)).toContain("営業日");
  });
  it("shows a one-sided period as a tick with a note, never a bar or a zero-day position", () => {
    const parent = root();
    renderEffect(parent, { kind: "schedule", before: { start: DATE, end: "2026-10-15" }, after: { start: null, end: "2026-10-15" }, unit: "calendar-day" }, {});
    expect(byClass(parent as any, "vg-ai-mini-bar")).toHaveLength(1);
    expect(byClass(parent as any, "vg-ai-mini-tick")).toHaveLength(1);
    expect(text(parent)).toContain("開始日未設定"); expect(text(parent)).toContain("片方の日付だけ");
    expect((byClass(parent as any, "vg-ai-mini-timeline")[0] as any).getAttribute("aria-label")).toContain("開始日未設定 ～ 2026-10-15");
  });
  it("shows an unset-to-set period and a cleared period explicitly", () => {
    const set = root(); renderEffect(set, { kind: "schedule", before: { start: null, end: null }, after: { start: DATE, end: DATE }, unit: "calendar-day" }, {});
    expect(text(set)).toContain("未設定"); expect(byClass(set as any, "vg-ai-mini-bar")).toHaveLength(1);
    const cleared = root(); renderEffect(cleared, { kind: "schedule", before: { start: DATE, end: DATE }, after: { start: null, end: null }, unit: "calendar-day" }, {});
    expect(text(cleared)).toContain("解除");
  });
  it("renders deadline and marker moves on a point axis with glyph and label", () => {
    const deadline = root(); renderEffect(deadline, { kind: "deadline", before: null, after: DATE }, {});
    expect(byClass(deadline as any, "vg-pv-point")).toHaveLength(1); expect(text(deadline)).toContain("⚑"); expect(text(deadline)).toContain("未設定");
    const moved = root(); renderEffect(moved, { kind: "deadline", before: DATE, after: "2026-10-16" }, {});
    expect(text(moved)).toContain("3日後ろへ");
    const marker = root(); renderEffect(marker, PREVIEW_FIXTURES.marker.entries[0].effects[0], {});
    expect(text(marker)).toContain("移動"); expect(text(marker)).toContain("◆"); expect(text(marker)).toContain("1日後ろへ");
    const added = root(); renderEffect(added, { kind: "marker", before: null, after: { key: "k", title: "新マーカー", date: DATE, tags: ["t"] } }, {});
    expect(text(added)).toContain("追加"); expect(text(added)).toContain("新マーカー");
    const removed = root(); renderEffect(removed, { kind: "marker", before: { key: "k", title: "消す", date: DATE, tags: [] }, after: null }, {});
    expect(text(removed)).toContain("削除"); expect(byClass(removed as any, "is-removed")).toHaveLength(1);
  });
});

describe("workload, order, membership and the rest", () => {
  it("shows only changed days, folds unchanged ones and says what the total covers", () => {
    const parent = root(); const same = { plan: 1, actual: 1 };
    const cells = [{ date: "2026-10-12", before: same, after: same }, { date: "2026-10-13", before: { plan: 0, actual: 0 }, after: { plan: 0, actual: 2 } }, { date: "2026-10-14", before: same, after: same }, { date: "2026-10-15", before: same, after: same }];
    renderEffect(parent, { kind: "workload", cells } as never, {});
    const shown = text(parent);
    expect(shown).toContain("10-13"); expect(shown).not.toContain("10-12"); expect(shown).not.toContain("10-15");
    expect(shown).toContain("ほか 3日は変更なし"); expect(shown).toContain("変更した1日分だけの合計");
    const allSame = root(); renderEffect(allSame, { kind: "workload", cells: [cells[0]] } as never, {}); expect(text(allSame)).toContain("時間の変更はありません");
  });
  it("lists dates with plan/actual before and after, totals, and the projection's capacity warning", () => {
    const parent = root();
    renderEffect(parent, PREVIEW_FIXTURES.partial.entries[0].effects[1], { projection: PREVIEW_FIXTURES.partial.projection });
    const shown = text(parent);
    expect(shown).toContain("10-13"); expect(shown).toContain("1.5h → 8h"); expect(shown).toContain("合計"); expect(shown).toContain("+6.5h");
    expect(shown).toContain("上限超過"); expect(shown).toContain("上限 7h");
    const nochange = root(); renderEffect(nochange, { kind: "workload", cells: [] }, {}); expect(text(nochange)).toContain("時間の変更はありません");
  });
  it("marks moved, added and removed items in the order lists", () => {
    const parent = root();
    renderEffect(parent, { kind: "order", before: ["a", "b", "c"], after: ["b", "a", "d"] }, { names: new Map([["a", "親A"]]) });
    const shown = text(parent);
    expect(shown).toContain("親A"); expect(shown).toContain("外れる"); expect(shown).toContain("追加"); expect(shown).toContain("移動");
  });
  it("states what is kept when a task leaves the Gantt", () => {
    const parent = root(); renderEffect(parent, EFFECT_FIXTURES.find((effect) => effect.kind === "membership")! as any, {});
    expect(text(parent)).toContain("表示対象"); expect(text(parent)).toContain("表示しない"); expect(text(parent)).toContain("保持されるデータ: 日程・作業時間・マーカー");
  });
  it("shows created and deleted things with their contents; a delete lists time and markers that vanish too", () => {
    const created = root(); renderEffect(created, PREVIEW_FIXTURES.create.entries[0].effects[0], {});
    expect(text(created)).toContain("作成"); expect(text(created)).toContain("新しい子");
    const removed = root();
    renderEntryEffects(removed, DELETE_PREVIEW.entries[0], { projection: DELETE_PREVIEW.projection, names: buildNameMap(DELETE_PREVIEW.projection) });
    expect(text(removed)).toContain("削除されるもの"); expect(byClass(removed as any, "is-removed").length).toBeGreaterThan(0);
    expect(text(removed)).toContain("作業時間: 予定 1.5h / 実績 1h"); expect(text(removed)).toContain("◆ 確認");
  });
  it("renders tag definitions, weekly work, daily todo lines and holidays", () => {
    const find = (kind: string) => EFFECT_FIXTURES.find((effect) => effect.kind === kind) as PreviewEffect;
    const tag = root(); renderEffect(tag, find("tag-definition"), {}); expect(text(tag)).toContain("追加"); expect(text(tag)).toContain("影響するタグ付け: 1件"); expect(byClass(tag as any, "vg-pv-swatch")[0].style.background).toBe("#4488cc");
    const weekly = root(); renderEffect(weekly, find("weekly"), {}); expect(text(weekly)).toContain("毎週火曜・60分");
    const daily = root(); renderEffect(daily, find("daily-todo"), {}); expect(text(daily)).toContain("- [ ] 確認"); expect(text(daily)).toContain("daily/2026-10-13.md");
    const calendar = root(); renderEffect(calendar, find("calendar"), {}); expect(text(calendar)).toContain("追加 1日"); expect(text(calendar)).toContain("手動の休日"); expect(text(calendar)).toContain("再配置されません");
  });
  it("renders settings, view zoom, external send, diagnostics and chat control", () => {
    const find = (kind: string) => EFFECT_FIXTURES.find((effect) => effect.kind === kind) as PreviewEffect;
    const settings = root(); renderEffect(settings, find("settings"), {}); expect(text(settings)).toContain("作業時間を表示"); expect(text(settings)).toContain("オフ");
    const view = root(); renderEffect(view, { kind: "view", before: { dayWidth: 28 }, after: { dayWidth: 36 }, affectedIds: [] }, {});
    expect(text(view)).toContain("28px"); expect(text(view)).toContain("36px"); expect(byClass(view as any, "vg-pv-zoomcell")).toHaveLength(14);
    const send = root(); renderEffect(send, find("external-send"), {});
    expect(text(send)).toContain("送信が成功するまで「適用済み」にはなりません"); expect(text(send)).toContain("https://example.test/api/snapshot"); expect(text(send)).toContain("タイトル"); expect(text(send)).toContain("100 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    const diagnostic = root(); renderEffect(diagnostic, find("diagnostic"), {}); expect(text(diagnostic)).toContain("記録しない"); expect(text(diagnostic)).toContain("秘密情報はここには表示しません");
    const conversation = root(); renderEffect(conversation, { kind: "conversation", action: "configure", before: { model: "a", secretId: "xyz" }, after: { model: "b", secretId: "xyz2" } }, {});
    expect(text(conversation)).toContain("接続設定の変更"); expect(text(conversation)).not.toContain("xyz");
  });
});

// Words that are product names or units, not internal names.
const ALLOWED_LATIN = /^(AI|Gantt|Daily|ToDo|Notes|MCP|OpenAI|Vault|KB|MB|URL|ID|px|h|B|x)$/;
const latinWords = (value: string): string[] => (value.replace(/\S*[/:.#]\S*/g, "").match(/[A-Za-z][A-Za-z0-9_]*/g) ?? []).filter((word) => word.length > 1 && !ALLOWED_LATIN.test(word));

describe("no internal names on screen", () => {
  it("every operation has a plain Japanese label without Latin jargon", () => {
    expect(Object.keys(OPERATION_LABELS).sort()).toEqual([...OPERATION_IDS].sort());
    for (const id of OPERATION_IDS) { expect(OPERATION_LABELS[id], id).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/); expect(latinWords(OPERATION_LABELS[id]), id).toEqual([]); }
    expect(operationLabel("Z99")).toBe("操作");
  });
  it("every public field and setting has a label with no Latin jargon; unknown keys read その他の項目", () => {
    const keys = new Set<string>([...Object.values(ENTITY_FIELDS).flat(), ...EDITABLE_SETTING_KEYS]);
    for (const key of keys) { expect(latinWords(fieldLabel(key)), key).toEqual([]); }
    expect(fieldLabel("someInternalKey")).toBe("その他の項目");
  });
  it("a setting card never shows the key, and its heading follows the direction of the change", () => {
    for (const [before, after, expected] of [[true, false, "完了済みを初期表示で隠す: オン → オフ"], [false, true, "完了済みを初期表示で隠す: オフ → オン"]] as const) {
      const preview = { ...PREVIEW_FIXTURES.settings, operationId: "S03", operationLabel: "完了を初期非表示にする設定", projection: null,
        entries: [{ actionId: "a", entity: { kind: "setting", key: "hideCompletedByDefault" }, displayName: "hideCompletedByDefault", effects: [{ kind: "settings", fields: [{ field: "hideCompletedByDefault", before, after, reason: "requested" }] }] }] } as any;
      expect(cardTitle(preview)).toBe(expected);
      const card = renderOperationPreviewCard(root(), preview, { now: Date.parse("2026-10-09T03:05:00Z") });
      expect(text(card)).toContain(expected); expect(text(card)).not.toContain("hideCompletedByDefault"); expect(text(card)).not.toContain("初期非表示にする設定");
      expect(entryTitle(preview.entries[0])).toBe("完了済みを初期表示で隠す");
    }
  });
  it("falls back to the operation name when more than one value changes, never to the catalog's UI wording", () => {
    const preview = { ...PREVIEW_FIXTURES.create, operationId: "T20", operationLabel: "子の期間全体を移動／bar drag" } as any;
    expect(cardTitle(preview)).toBe("予定をまとめて移動");
    expect(text(renderOperationPreviewCard(root(), preview, {}))).not.toContain("bar drag");
  });
  it("unknown keys and enum values show Japanese or neutral text with the raw key only in a title attribute", () => {
    const parent = root();
    renderEffect(parent, { kind: "fields", fields: [{ field: "weirdKey" as any, before: "a", after: "b", reason: "requested" }] }, {});
    expect(text(parent)).toContain("その他の項目"); expect(text(parent)).not.toContain("weirdKey");
    expect(byClass(parent as any, "vg-pv-label")[0].title).toBe("weirdKey");
    const conv = root(); renderEffect(conv, { kind: "conversation", action: "configure", before: { provider: "disconnected", auth: "none" }, after: { provider: "openai-compatible", auth: "secret" } }, {});
    expect(latinWords(text(conv))).toEqual(["OpenAI"].filter(() => false));
  });
  it("rendering every effect fixture, every setting key and the entity kinds leaves no Latin jargon", () => {
    const outputs: string[] = [];
    for (const effect of EFFECT_FIXTURES) { const parent = root(); renderEffect(parent, effect as PreviewEffect, {}); outputs.push(text(parent)); }
    for (const key of EDITABLE_SETTING_KEYS) {
      const preview = { ...PREVIEW_FIXTURES.settings, projection: null, entries: [{ actionId: "a", entity: { kind: "setting", key }, displayName: key, effects: [{ kind: "settings", fields: [{ field: key, before: null, after: null, reason: "requested" }, { field: key, before: true, after: false, reason: "derived" }] }] }] } as any;
      const card = renderOperationPreviewCard(root(), preview, {}); outputs.push(text(card));
      const panel = root(); renderNonGanttPanel(panel, preview); outputs.push(text(panel));
      expect(text(card), key).not.toContain(key);
    }
    for (const kind of ["task", "marker", "event", "weekly", "daily-todo", "daily-file", "tag-definition", "source", "setting", "view", "conversation", "integration"]) {
      const card = renderOperationPreviewCard(root(), { ...PREVIEW_FIXTURES.create, entries: [{ actionId: "a", entity: { kind } as any, displayName: "", effects: [] }] } as any, {}); outputs.push(text(card));
    }
    for (const output of outputs) expect(latinWords(output), output.slice(0, 80)).toEqual([]);
  });
  it("shows the day-counting basis in plain words", () => {
    const business = root(); renderEffect(business, { kind: "schedule", before: { start: DATE, end: DATE }, after: { start: "2026-10-14", end: "2026-10-14" }, unit: "business-day" }, {});
    expect(text(business)).toContain("日数の数え方: 営業日（休日を除く）");
    const calendar = root(); renderEffect(calendar, { kind: "schedule", before: { start: DATE, end: DATE }, after: { start: "2026-10-14", end: "2026-10-14" }, unit: "calendar-day" }, {});
    expect(text(calendar)).toContain("日数の数え方: 暦日（休日も数える）");
  });
});
