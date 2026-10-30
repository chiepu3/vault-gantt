import type { GanttMarker, TaskWorkbenchSettings } from "../core/types";
import { setStyleVar } from "./tag-chip";

export interface MilestonePopoverOptions {
  anchor: HTMLElement;
  settings: TaskWorkbenchSettings;
  milestone: GanttMarker;
  onSave(result: { title: string; tags: string[] }): void;
  onDelete?(): void;
}

/**
 * A small popover under `anchor` for one milestone: name and tags (its date moves by dragging it in the gantt). Closes on save, delete, Escape or a click
 * outside, and returns its closer.
 */
export function openMilestonePopover(options: MilestonePopoverOptions): () => void {
  const { anchor, settings, milestone } = options;
  const root = document.createElement("div");
  root.classList.add("twb-milestone-popover");
  let tags = [...(milestone.tags ?? [])];

  const field = (label: string, input: HTMLInputElement): void => {
    const wrap = root.createDiv({ cls: "twb-milestone-popover-field" });
    wrap.createEl("label", { text: label });
    wrap.appendChild(input);
  };
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.value = milestone.title;
  titleInput.placeholder = "マイルストーン名";
  field("名前", titleInput);

  const definitions = settings.ganttFeatureTagsEnabled && Array.isArray(settings.ganttTags)
    ? settings.ganttTags.filter((definition) => definition.name.trim() !== "")
    : [];
  if (definitions.length > 0) {
    const tagRow = root.createDiv({ cls: "twb-milestone-popover-tags" });
    for (const definition of definitions) {
      const chip = tagRow.createEl("button", { text: definition.name, cls: ["vg-chip", "is-tag", "twb-milestone-popover-tag"] });
      const paint = (): void => { chip.classList.toggle("is-selected", tags.includes(definition.name)); };
      if (definition.color) setStyleVar(chip, "--vg-chip-color", definition.color);
      paint();
      chip.addEventListener("click", () => {
        tags = tags.includes(definition.name) ? tags.filter((tag) => tag !== definition.name) : [...tags, definition.name];
        paint();
      });
    }
  }

  const buttons = root.createDiv({ cls: "twb-milestone-popover-buttons" });
  const save = buttons.createEl("button", { text: "保存", cls: "mod-cta" });
  if (options.onDelete) {
    const remove = buttons.createEl("button", { text: "削除", cls: "mod-warning" });
    remove.addEventListener("click", () => { close(); options.onDelete?.(); });
  }
  buttons.createEl("button", { text: "キャンセル" }).addEventListener("click", () => close());

  const submit = (): void => {
    const result = { title: titleInput.value.trim() || milestone.title, tags };
    close();
    options.onSave(result);
  };
  save.addEventListener("click", submit);
  root.addEventListener("keydown", (evt) => {
    if (evt.key === "Enter" && !evt.isComposing && evt.target instanceof HTMLInputElement) { evt.preventDefault(); submit(); }
  });

  const onOutside = (evt: PointerEvent): void => {
    if (!root.contains(evt.target as Node) && !anchor.contains(evt.target as Node)) close();
  };
  const onKey = (evt: KeyboardEvent): void => { if (evt.key === "Escape") close(); };
  function close(): void {
    document.removeEventListener("pointerdown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }

  document.body.appendChild(root);
  const rect = anchor.getBoundingClientRect();
  const width = root.offsetWidth;
  const height = root.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const top = rect.bottom + 4 + height > window.innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4;
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);
  titleInput.focus();
  titleInput.select();
  return close;
}
