import { describe, it, expect } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(escaped + "\\s*\\{([^}]+)\\}"))?.[1] ?? "";
};
describe("scoped Ghost and result-card presentation", () => {
  it("keeps old/current marks inside the existing lane without a black double outline", () => {
    expect(rule(".task-gantt-container .vg-ai-ghost")).toContain("height: 9px");
    expect(rule(".task-gantt-container .vg-ai-target")).toContain("translateY(4px)");
    expect(rule(".task-gantt-container .vg-ai-target")).not.toMatch(/outline|border|height|top|left|width/);
    expect(css).not.toMatch(/2px double/);
  });
  it("scopes all new Ghost selectors to the Gantt container", () => {
    const selectors = css.split("}").map(block => block.split("{")[0].trim());
    for (const selector of selectors.filter(value => /\.vg-ai-(ghost|target|legend)/.test(value))) {
      for (const part of selector.split(",")) expect(part.trim()).toMatch(/^\.task-gantt-container /);
    }
  });
  it("overrides host padding with specificity and makes result periods wrap", () => {
    const root = rule(".workspace-leaf-content .view-content.vg-ai-chat");
    expect(root).toContain("padding: 0"); expect(root).not.toContain("box-sizing"); expect(root).toContain("height: auto");
    expect(rule(".vg-ai-chat .vg-ai-mini-row")).toContain("display: flex");
    expect(rule(".vg-ai-content")).toContain("max-width: 760px");
    expect(rule(".vg-ai-content")).toContain("calc(100% - 32px)");
    const icon = rule(".vg-ai-icon-button");
    expect(icon).toContain("width: 32px"); expect(icon).toContain("height: 32px"); expect(icon).toContain("justify-content: center"); expect(icon).not.toContain("margin");
    expect(rule(".vg-ai-icon-button svg")).toContain("width: 16px");
    expect(rule(".vg-ai-model-label")).toContain("text-overflow: ellipsis");
    expect(rule(".vg-ai-chat .vg-ai-mini-before .vg-ai-mini-bar")).toContain("dashed");
    expect(rule(".vg-ai-chat .vg-ai-mini-after .vg-ai-mini-bar")).toContain("var(--interactive-accent)");
    expect(rule(".task-gantt-container .task-gantt-version-info")).toContain("display: none");
    expect(css).not.toMatch(/!\s*important/i);
  });
});
