import type { GanttTagDefinition, TaskWorkbenchSettings } from "../core/types";

/**
 * Sets a CSS custom property inline. The real DOM exposes
 * CSSStyleDeclaration.setProperty; the small fake DOM used by the unit tests
 * exposes style as a plain record.
 */
export function setStyleVar(el: HTMLElement, name: string, value: string): void {
  if (typeof el.style.setProperty === "function") {
    el.style.setProperty(name, value);
  } else {
    (el.style as unknown as Record<string, string>)[name] = value;
  }
}

/**
 * `getGanttTags`/`findGanttTag` equivalent — looks
 * up a configured tag by either its stable key or its current display name.
 */
export function findGanttTagDefinition(
  settings: TaskWorkbenchSettings,
  name: string
): GanttTagDefinition | undefined {
  if (name === "") {
    return undefined;
  }
  const definitions = Array.isArray(settings.ganttTags) ? settings.ganttTags : [];
  // Plain loop: this runs per table row, so it avoids allocating iterator callbacks.
  for (const definition of definitions) {
    if (definition.name === name || definition.key === name) {
      return definition;
    }
  }
  return undefined;
}

/**
 * Appends one `.vg-chip.is-tag` per non-empty tag to `parent`. The chip colour
 * comes from the Gantt tag registry; unregistered tags keep the muted default.
 */
export function appendTagChips(
  parent: HTMLElement,
  tags: readonly string[],
  settings: TaskWorkbenchSettings
): void {
  for (const tag of tags) {
    if (tag === "") {
      continue;
    }
    const chip = document.createElement("span");
    chip.classList.add("task-workbench-tag-chip", "vg-chip", "is-tag");
    chip.textContent = tag;
    const definition = findGanttTagDefinition(settings, tag);
    if (definition?.color) {
      setStyleVar(chip, "--vg-chip-color", definition.color);
    }
    parent.appendChild(chip);
  }
}
