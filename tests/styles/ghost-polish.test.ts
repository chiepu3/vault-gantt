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
    expect(rule(".vg-ai-mini-row")).toContain("display: flex");
    expect(rule(".vg-ai-content")).toContain("max-width: 760px");
    expect(rule(".vg-ai-content")).toContain("calc(100% - 32px)");
    const icon = rule(".vg-ai-icon-button");
    expect(icon).toContain("width: 32px"); expect(icon).toContain("height: 32px"); expect(icon).toContain("justify-content: center"); expect(icon).not.toContain("margin");
    expect(rule(".vg-ai-icon-button svg")).toContain("width: 16px");
    expect(rule(".vg-ai-model-label")).toContain("text-overflow: ellipsis");
    expect(rule(".vg-ai-mini-before .vg-ai-mini-bar")).toContain("dashed");
    expect(rule(".vg-ai-mini-after .vg-ai-mini-bar")).toContain("var(--interactive-accent)");
    expect(rule(".task-gantt-container .task-gantt-version-info")).toContain("display: none");
    expect(css).not.toMatch(/!\s*important/i);
  });
  it("scopes Gantt-only preview selectors to the Gantt container", () => {
    const selectors = css.split("}").map(block => block.split("{")[0].trim()).filter(Boolean);
    const ganttOnly = /\.vg-pv-(dockhost|dock|dockhead|gantt|gruler|gparent|gparent-title|grow|glabel|gname|gtrack|glane|gbar|gtick|gnote|gpoint|live-[a-z]+|delete-target)(?![a-z-])/;
    const found = selectors.flatMap(selector => selector.split(",").map(part => part.trim())).filter(part => ganttOnly.test(part));
    expect(found.length).toBeGreaterThan(20);
    for (const part of found) expect(part).toMatch(/^\.task-gantt-container /);
  });
  it("preview cards use theme variables only and no text under 12px", () => {
    const rules = css.split("}").map(block => block.split("{")).filter(([selector]) => /\.vg-pv-/.test(selector));
    expect(rules.length).toBeGreaterThan(40);
    for (const [selector, body] of rules) {
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
      for (const size of body.matchAll(/font-size:\s*([\d.]+)px/g)) expect(Number(size[1]), selector).toBeGreaterThanOrEqual(12);
      for (const size of body.matchAll(/font-size:\s*var\((--[a-z-]+)\)/g)) expect(["--font-ui-small", "--font-ui-smaller", "--font-ui-medium"], selector).toContain(size[1]);
      expect(body, selector).not.toMatch(/color:\s*var\(--text-accent\)/);
      expect(body, selector).not.toMatch(/animation|transition|!important/);
    }
  });
  it("keeps the mini timeline rules available to every card host", () => {
    expect(rule(".vg-ai-mini-tick")).toContain("border-inline-start");
    expect(rule(".vg-pv-card")).toContain("overflow-wrap: anywhere");
    expect(rule(".task-gantt-container .vg-pv-dockhost[hidden]")).toContain("display: none");
  });
});
