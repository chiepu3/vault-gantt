import { describe, it, expect } from "vitest";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ selector: m[1].trim(), body: m[2] }));
const STICKY = /\.task-gantt-(parent-left|fixed-left|parent-add-cell|header-left)(?![\w-])/;

describe("sticky Gantt left column stays opaque in every state", () => {
  it("never paints a translucent tint without an opaque base", () => {
    const stickyRules = rules.filter(r => STICKY.test(r.selector));
    expect(stickyRules.length).toBeGreaterThan(3);
    for (const r of stickyRules) {
      for (const m of r.body.matchAll(/(?:^|[;\s])background(?:-color)?\s*:\s*([^;]+)/g)) {
        expect(m[1], r.selector).toMatch(/var\(--background-(primary|secondary)\)/);
      }
    }
  });
  it("covers hover and drag-over with a tint layered over an opaque base", () => {
    const hover = rules.find(r => r.selector.startsWith(".task-gantt-parent-left:hover"))!;
    expect(hover.body).toMatch(/linear-gradient\(var\(--vg-tint-hover\), var\(--vg-tint-hover\)\), var\(--background-primary\)/);
    const drag = rules.find(r => r.selector === ".task-gantt-parent-left.is-drag-over")!;
    expect(drag.body).toMatch(/linear-gradient\(.*\), var\(--background-primary\)/);
  });
  it("isolates the parent timeline so its z-index 7/8 bars cannot paint over the sticky column", () => {
    expect(rules.find(r => r.selector === ".task-gantt-parent-timeline")!.body).toContain("isolation: isolate");
  });
  it("caps the parent timeline at the row content box so it cannot overflow into the row border strip", () => {
    expect(rules.find(r => r.selector === ".task-gantt-parent-timeline")!.body).toContain("max-height: 100%");
  });
});
