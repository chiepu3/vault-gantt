















import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const cssPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "styles.css"
);
const rawCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : "";

/* ---------------------------------------------------------------------------
 * Minimal flat-CSS parser (justified by, asserted before reliance).
 * ------------------------------------------------------------------------- */

interface Declaration {
  prop: string;
  value: string;
}

interface CssRule {
  /** Normalized selector list (trimmed, whitespace collapsed). */
  selectors: string[];
  decls: Declaration[];
  /** Offset of the opening brace in the comment-stripped source. */
  offset: number;
}

/** Replace comments with equal-length whitespace so offsets are preserved. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));
}

/** Split a selector list on top-level commas (paren-aware for:has). */
function splitSelectorList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));
  return parts
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

function parseDeclarations(body: string): Declaration[] {
  const decls: Declaration[] = [];
  for (const segment of body.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      throw new Error(`unparseable declaration segment: "${trimmed}"`);
    }
    decls.push({
      prop: trimmed.slice(0, colon).trim().toLowerCase(),
      value: trimmed.slice(colon + 1).trim(),
    });
  }
  return decls;
}

function parseFlatCss(cssNoComments: string): CssRule[] {
  const rules: CssRule[] = [];
  let pos = 0;
  while (pos < cssNoComments.length) {
    const open = cssNoComments.indexOf("{", pos);
    if (open === -1) {
      if (cssNoComments.slice(pos).trim().length > 0) {
        throw new Error(
          `non-whitespace text outside any rule block: "${cssNoComments
            .slice(pos)
            .trim()}"`
        );
      }
      break;
    }
    const close = cssNoComments.indexOf("}", open);
    if (close === -1) {
      throw new Error("unbalanced braces in styles.css");
    }
    const body = cssNoComments.slice(open + 1, close);
    if (body.includes("{") || body.includes("}")) {
      throw new Error("nested braces detected — styles.css must be flat CSS");
    }
    rules.push({
      selectors: splitSelectorList(cssNoComments.slice(pos, open)),
      decls: parseDeclarations(body),
      offset: open,
    });
    pos = close + 1;
  }
  return rules;
}

const noComments = stripComments(rawCss);

let cachedRules: CssRule[] | null = null;
function getRules(): CssRule[] {
  if (cachedRules === null) {
    cachedRules = parseFlatCss(noComments);
  }
  return cachedRules;
}

/* ---------------------------------------------------------------------------
 * Lookup helpers
 * ------------------------------------------------------------------------- */

/** Rules whose selector list contains this exact (normalized) selector. */
function rulesFor(selector: string): CssRule[] {
  return getRules().filter((r) => r.selectors.includes(selector));
}

/**
 * Design tokens defined on `body` (--vg-*) mapped to the value they resolve to
 * with Obsidian's default variables. declsFor() substitutes these so value
 * assertions keep checking the effective value (e.g. 8px) rather than the
 * token name. The key set must equal the token block (see "design tokens").
 */
const VG_TOKEN_REFERENCE: Readonly<Record<string, string>> = {
  "--vg-space-0": "2px",
  "--vg-space-1": "4px",
  "--vg-space-2": "6px",
  "--vg-space-3": "8px",
  "--vg-space-4": "12px",
  "--vg-space-5": "16px",
  "--vg-space-6": "24px",
  "--vg-radius-s": "4px",
  "--vg-radius-m": "8px",
  "--vg-radius-l": "12px",
  "--vg-radius-pill": "999px",
  "--vg-border-width": "1px",
  "--vg-border-color": "var(--background-modifier-border)",
  "--vg-border-color-subtle":
    "color-mix(in srgb, var(--background-modifier-border) 60%, transparent)",
  "--vg-border-color-strong": "var(--background-modifier-border-hover)",
  "--vg-border": "1px solid var(--background-modifier-border)",
  "--vg-border-subtle":
    "1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent)",
  "--vg-focus-ring": "2px solid var(--interactive-accent)",
  "--vg-shadow-flat": "0 1px 2px var(--background-modifier-box-shadow)",
  "--vg-shadow-raised": "0 2px 6px var(--background-modifier-box-shadow)",
  "--vg-shadow-popover": "var(--shadow-s)",
  "--vg-shadow-modal": "var(--shadow-l)",
  "--vg-font-micro": "10px",
  "--vg-font-xs": "11px",
  "--vg-font-s": "12px",
  "--vg-font-m": "var(--font-ui-small)",
  "--vg-font-l": "var(--font-ui-medium)",
  "--vg-weight-normal": "400",
  "--vg-weight-medium": "500",
  "--vg-weight-strong": "600",
  "--vg-leading-tight": "1.3",
  "--vg-leading-normal": "1.5",
  "--vg-icon-s": "16px",
  "--vg-alpha-tint": "0.12",
  "--vg-alpha-tint-strong": "0.18",
  "--vg-alpha-border": "0.4",
  "--vg-tint-hover": "var(--background-modifier-hover)",
  "--vg-tint-pressed": "var(--background-modifier-active-hover)",
  "--vg-tint-selected": "hsla(var(--interactive-accent-hsl), 0.15)",
  "--vg-tint-danger": "rgba(var(--color-red-rgb), 0.12)",
  "--vg-tint-warning": "rgba(var(--color-yellow-rgb), 0.12)",
  "--vg-tint-success": "rgba(var(--color-green-rgb), 0.18)",
  "--vg-tint-info": "rgba(var(--color-blue-rgb), 0.18)",
  "--vg-tint-weekend": "color-mix(in srgb, var(--text-muted) 6%, transparent)",
  "--vg-border-danger": "rgba(var(--color-red-rgb), 0.4)",
  "--vg-color-danger": "var(--text-error)",
  "--vg-color-warning": "var(--text-warning)",
  "--vg-color-success": "var(--text-success)",
  "--vg-color-info": "var(--color-blue)",
  "--vg-color-muted": "var(--text-muted)",
  "--vg-color-faint": "var(--text-faint)",
  "--vg-priority-auto": "var(--color-blue)",
  "--vg-priority-manual": "var(--color-yellow)",
  "--vg-z-overlay": "20",
};

/** Replace var(--vg-*) references with their reference value. */
function resolveVgTokens(value: string): string {
  return value.replace(/var\((--vg-[a-z0-9-]+)\)/g, (whole, name: string) => {
    const resolved = VG_TOKEN_REFERENCE[name];
    return resolved === undefined ? whole : resolveVgTokens(resolved);
  });
}

/** Union of declarations across all rules matching the selector (last wins). */
function declsFor(selector: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rule of rulesFor(selector)) {
    for (const decl of rule.decls) {
      map.set(decl.prop, resolveVgTokens(decl.value));
    }
  }
  return map;
}

function expectDecl(selector: string, prop: string, value?: string): void {
  const decls = declsFor(selector);
  expect(decls.has(prop), `${selector} must declare ${prop}`).toBe(true);
  if (value !== undefined) {
    expect(decls.get(prop), `${selector} ${prop}`).toBe(value);
  }
}

function offsetOf(selector: string): number {
  const matches = rulesFor(selector);
  expect(matches.length, `no rule found for selector: ${selector}`).toBeGreaterThan(0);
  return matches[0].offset;
}







const GENERIC_CLASSES = [
  "is-weekend",
  "is-today",
  "is-holiday",
  "is-subtask",
  "is-completed",
  "is-selected",
  "is-overdue",
  "priority-auto",
  "priority-manual",
  "compact-date",
  "strong-parent",
  "task-indent",
  "narrow-col",
  "date-col",
  "tiny-col",
  "mod-cta",
];

/** First compound of a complex selector (paren-aware for:has). */
function firstCompound(complexSelector: string): string {
  let depth = 0;
  for (let i = 0; i < complexSelector.length; i++) {
    const ch = complexSelector[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) {
      return complexSelector.slice(0, i);
    }
  }
  return complexSelector;
}

/** True if any compound of the selector carries the given class. */
function selectorHasClass(selector: string, className: string): boolean {
  const compounds: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) {
      compounds.push(selector.slice(start, i));
      start = i + 1;
    }
  }
  compounds.push(selector.slice(start));
  const classRe = new RegExp(`\\.${className}(?![A-Za-z0-9_-])`);
  return compounds.some((compound) => classRe.test(compound));
}




describe("part 1 — file rules and prohibitions", () => {
  it("styles.css is flat CSS: no at-rules, no nesting", () => {
    expect(rawCss.length, "styles.css must exist and be non-empty").toBeGreaterThan(0);
    // No at-rules of any kind (@media/@supports/@keyframes/@layer/@container/@import...).
    expect(noComments).not.toMatch(/@/);
    // Brace balance and nesting depth never exceeds 1.
    let depth = 0;
    let maxDepth = 0;
    for (const ch of noComments) {
      if (ch === "{") {
        depth++;
        if (depth > maxDepth) maxDepth = depth;
      } else if (ch === "}") {
        depth--;
      }
      expect(depth, "brace imbalance (more } than {)").toBeGreaterThanOrEqual(0);
    }
    expect(depth, "unbalanced braces").toBe(0);
    expect(maxDepth, "nested rule blocks are forbidden").toBeLessThanOrEqual(1);
    // The flat parser must succeed and leave no stray text after the last rule.
    expect(getRules().length).toBeGreaterThan(0);
    const lastClose = noComments.lastIndexOf("}");
    expect(noComments.slice(lastClose + 1).trim()).toBe("");
  });

  it("styles.css exists at the repo root", () => {
    expect(fs.existsSync(cssPath)).toBe(true);
    expect(cssPath.endsWith(`${path.sep}styles.css`)).toBe(true);
    expect(rawCss.trim().length).toBeGreaterThan(0);
  });

  it("no !important anywhere in styles.css", () => {
    expect(noComments).not.toMatch(/!\s*important/i);
  });

  it("no bare generic-class selector from the 16-name list", () => {
    for (const rule of getRules()) {
      for (const selector of rule.selectors) {
        const first = firstCompound(selector);
        const bare = first.match(/^\.([A-Za-z0-9_-]+)$/);
        if (bare !== null) {
          expect(
            GENERIC_CLASSES,
            `bare generic selector ".${bare[1]}" in: ${selector}`
          ).not.toContain(bare[1]);
        }
      }
    }
  });

  it("uses no unapproved hardcoded colors in declaration values", () => {
    // Scan CSS named colors; no hardcoded color is approved. Mask variable interiors before scanning to avoid false positives
    // from names such as --color-red-rgb.
    const COLOR_KEYWORDS = new Set(
      (
        "aliceblue antiquewhite aqua aquamarine azure beige bisque black " +
        "blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse " +
        "chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
        "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
        "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon " +
        "darkseagreen darkslateblue darkslategray darkslategrey " +
        "darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey " +
        "dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
        "ghostwhite gold goldenrod gray green greenyellow grey honeydew " +
        "hotpink indianred indigo ivory khaki lavender lavenderblush " +
        "lawngreen lemonchiffon lightblue lightcoral lightcyan " +
        "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink " +
        "lightsalmon lightseagreen lightskyblue lightslategray " +
        "lightslategrey lightsteelblue lightyellow lime limegreen linen " +
        "magenta maroon mediumaquamarine mediumblue mediumorchid " +
        "mediumpurple mediumseagreen mediumslateblue mediumspringgreen " +
        "mediumturquoise mediumvioletred midnightblue mintcream mistyrose " +
        "moccasin navajowhite navy oldlace olive olivedrab orange orangered " +
        "orchid palegoldenrod palegreen paleturquoise palevioletred " +
        "papayawhip peachpuff peru pink plum powderblue purple " +
        "rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
        "seagreen seashell sienna silver skyblue slateblue slategray " +
        "slategrey snow springgreen steelblue tan teal thistle tomato " +
        "turquoise violet wheat white whitesmoke yellow yellowgreen"
      ).split(" ")
    );

    /** Mask var(...) spans (balanced parens) so their interiors are inert. */
    function maskVarRefs(value: string): string {
      let out = "";
      let i = 0;
      while (i < value.length) {
        if (value.startsWith("var(", i)) {
          let depth = 0;
          let j = i;
          for (; j < value.length; j++) {
            if (value[j] === "(") depth++;
            else if (value[j] === ")") {
              depth--;
              if (depth === 0) break;
            }
          }
          out += " varref ";
          i = j + 1;
        } else {
          out += value[i];
          i++;
        }
      }
      return out;
    }

    const violations: string[] = [];
    const hexRe = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;

    const colorFnRe = /\b(?:rgb|rgba|hsl|hsla)\s*\(/gi;

    for (const rule of getRules()) {
      for (const decl of rule.decls) {
        const where = `${rule.selectors.join(", ")} { ${decl.prop}: ${decl.value} }`;
        // Shadows use --vg-shadow-* (theme-following); no rgba(0,0,0,..) literal is allowed.
        const isAllowedShadowLiteral = false;

        // (a) #hex literals.
        if (hexRe.test(decl.value)) {
          violations.push(`hex color: ${where}`);
        }
        // (b) color functions whose first argument is not var(--...).
        let match: RegExpExecArray | null;
        colorFnRe.lastIndex = 0;
        while ((match = colorFnRe.exec(decl.value)) !== null) {
          const rest = decl.value.slice(match.index + match[0].length).trimStart();
          if (!rest.startsWith("var(--") && !isAllowedShadowLiteral) {
            violations.push(`literal color function: ${where}`);
          }
        }
        // (c) whole-token color keywords, var interiors masked.
        const masked = maskVarRefs(decl.value).toLowerCase();
        for (const token of masked.split(/[^a-z]+/)) {
          if (token.length > 0 && COLOR_KEYWORDS.has(token)) {
            violations.push(`color keyword "${token}": ${where}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares no protected inline geometry properties", () => {

    const PROTECTED: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["task-gantt-bar", ["left", "top", "width", "height"]],
      ["task-gantt-marker", ["left", "top"]],
      ["task-gantt-external-label", ["left", "top", "max-width"]],
      ["task-gantt-bg", ["left", "width"]],
      ["task-gantt-deadline-marker", ["left", "top"]],
      ["task-gantt-month-cell", ["width"]],
      ["task-gantt-day-cell", ["width"]],
      ["task-gantt-dow-cell", ["width"]],
      ["task-gantt-parent-timeline", ["width", "height"]],
      ["task-gantt-parent-left", ["width"]],
      ["task-gantt-parent-row", ["height"]],
      ["task-gantt-workload-row", ["height"]],
      ["task-gantt-event-row", ["height"]],
      ["task-gantt-daily-row", ["height"]],
      ["task-gantt-parent-add-cell", ["width"]],
      ["task-gantt-parent-add-timeline", ["width"]],
    ];
    const violations: string[] = [];
    for (const [className, forbidden] of PROTECTED) {
      for (const rule of getRules()) {
        const applies = rule.selectors.some((sel) =>
          selectorHasClass(sel, className)
        );
        if (!applies) continue;
        for (const decl of rule.decls) {
          if (forbidden.indexOf(decl.prop) !== -1) {
            violations.push(
              `.${className} protected property "${decl.prop}" declared in: ` +
                `${rule.selectors.join(", ")}`
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("box-sizing only under the two plugin-root scopes", () => {
    const ALLOWED = [".task-workbench-container *", ".task-gantt-container *"];
    const boxRules = getRules().filter((r) =>
      r.decls.some((d) => d.prop === "box-sizing")
    );
    expect(boxRules.length, "the root-scope box-sizing rule must exist").toBeGreaterThan(0);
    const covered: string[] = [];
    for (const rule of boxRules) {
      for (const selector of rule.selectors) {
        expect(
          ALLOWED,
          `box-sizing declared outside plugin-root scope: ${selector}`
        ).toContain(selector);
        covered.push(selector);
      }
      for (const decl of rule.decls) {
        if (decl.prop === "box-sizing") {
          expect(decl.value).toBe("border-box");
        }
      }
    }
    expect(new Set(covered)).toEqual(new Set(ALLOWED));
  });

  it("no font-family / transition / animation declarations", () => {
    const violations: string[] = [];
    for (const rule of getRules()) {
      for (const decl of rule.decls) {
        if (
          decl.prop === "font-family" ||
          decl.prop.startsWith("transition") ||
          decl.prop.startsWith("animation")
        ) {
          violations.push(
            `${decl.prop} in: ${rule.selectors.join(", ")}`
          );
        }

        // (e.g. `font: 14px SomeFont`). Only the exact `inherit` form is

        // (inputs inherit the table font) without ever naming a typeface.
        if (decl.prop === "font" && decl.value !== "inherit") {
          violations.push(
            `font shorthand must be exactly "inherit", got "${decl.value}" in: ` +
              rule.selectors.join(", ")
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});




describe("part 2 — Workbench structure", () => {
  it("container: flex column + height:100%", () => {
    expectDecl(".task-workbench-container", "display", "flex");
    expectDecl(".task-workbench-container", "flex-direction", "column");
    expectDecl(".task-workbench-container", "height", "100%");
    expectDecl(".task-workbench-container", "overflow", "hidden");
  });

  it("table-wrap: flex:1 1 auto + min-height:0 + overflow:auto", () => {
    expectDecl(".task-workbench-table-wrap", "flex", "1 1 auto");
    expectDecl(".task-workbench-table-wrap", "min-height", "0");
    expectDecl(".task-workbench-table-wrap", "overflow", "auto");
  });

  it("header: flex:0 0 auto + display:flex + themed border-bottom", () => {
    expectDecl(".task-workbench-header", "flex", "0 0 auto");
    expectDecl(".task-workbench-header", "display", "flex");
    expectDecl(
      ".task-workbench-header",
      "border-bottom",
      "1px solid var(--background-modifier-border)"
    );
  });

  it("toolbar-left/right: display:flex + align-items:center + gap", () => {
    for (const selector of [
      ".task-workbench-toolbar-left",
      ".task-workbench-toolbar-right",
    ]) {
      expectDecl(selector, "display", "flex");
      expectDecl(selector, "align-items", "center");
      expectDecl(selector, "gap");
    }
  });

  it("table: border-collapse + width:100%", () => {
    expectDecl(".task-workbench-table", "border-collapse", "collapse");
    expectDecl(".task-workbench-table", "width", "100%");
  });

  it("th/td scoped padding + themed border-bottom", () => {
    const selector = ".task-workbench-table th";
    expect(rulesFor(selector).length, `rule for ${selector}`).toBeGreaterThan(0);
    expectDecl(selector, "padding", "2px 6px");
    expectDecl(
      selector,
      "border-bottom",
      "1px solid var(--background-modifier-border)"
    );
    expectDecl(".task-workbench-table td", "padding", "2px 6px");
  });

  it("thead th: sticky top:0 with opaque secondary background", () => {
    const selector = ".task-workbench-table thead th";
    expectDecl(selector, "position", "sticky");
    expectDecl(selector, "top", "0");
    expectDecl(selector, "background", "var(--background-secondary)");
  });

  it("column classes under .task-workbench-table scope", () => {
    expectDecl(".task-workbench-table .task-workbench-col-name", "min-width");
    expectDecl(
      ".task-workbench-table .task-workbench-priority-cell",
      "white-space",
      "nowrap"
    );
    expectDecl(
      ".task-workbench-table .task-workbench-priority-cell",
      "text-align",
      "center"
    );
    expectDecl(".task-workbench-table .narrow-col", "white-space", "nowrap");
    expectDecl(".task-workbench-table .date-col", "white-space", "nowrap");
    expectDecl(".task-workbench-table .tiny-col", "text-align", "center");
  });

  it("cell-text min-height keeps empty-name rows from collapsing", () => {
    expectDecl(".task-workbench-cell-text", "min-height");
  });

  it("inline editing widths incl. compound compact-date selector", () => {
    expectDecl(".task-workbench-inline-input", "max-width", "100%");
    expectDecl(".task-workbench-inline-select", "max-width", "100%");
    expectDecl(".task-workbench-title-textarea", "width", "100%");
    expectDecl(".task-workbench-inline-textarea", "width", "100%");
    expectDecl(".task-workbench-inline-input.compact-date", "width");
  });
});




describe("part 3 — Workbench readability", () => {
  it("row.twb-overdue-row compound: red tint background (alpha 0.12)", () => {

    expectDecl(
      ".task-workbench-row.twb-overdue-row",
      "background",
      "rgba(var(--color-red-rgb), 0.12)"
    );

    expectDecl(
      ".task-workbench-row.twb-overdue-row:hover",
      "background",
      "rgba(var(--color-red-rgb), 0.12)"
    );

  });

  it("row.twb-due-soon-row compound: yellow tint background (alpha 0.12)", () => {

    expectDecl(
      ".task-workbench-row.twb-due-soon-row",
      "background",
      "rgba(var(--color-yellow-rgb), 0.12)"
    );

    expectDecl(
      ".task-workbench-row.twb-due-soon-row:hover",
      "background",
      "rgba(var(--color-yellow-rgb), 0.12)"
    );

  });

  it("due-soon before overdue, both tints after the is-subtask rule", () => {
    expect(offsetOf(".task-workbench-row.twb-due-soon-row")).toBeLessThan(
      offsetOf(".task-workbench-row.twb-overdue-row")
    );

    // C1): both tint rules must follow the is-subtask rule so later-wins
    // gives the deadline emphasis over the subtask gray.
    expect(offsetOf(".task-workbench-row.is-subtask")).toBeLessThan(
      offsetOf(".task-workbench-row.twb-due-soon-row")
    );
    expect(offsetOf(".task-workbench-row.is-subtask")).toBeLessThan(
      offsetOf(".task-workbench-row.twb-overdue-row")
    );
  });

  it("row.is-subtask compound gets a secondary background", () => {
    expectDecl(
      ".task-workbench-row.is-subtask",
      "background",
      "var(--background-secondary)"
    );

    // Tint rules must use two-class compounds (0,2,0), matching this rule's
    // specificity so later source order can decide the winner. Single-class
    // tint selectors (0,1,0) would permanently lose to
    // this rule and overdue/due-soon subtask rows would render gray.
    // Require two-class compounds; a single-class tint selector would have
    // lower specificity than the row background.
    const TWO_CLASS_COMPOUND = /^\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
    const guarded = [
      ".task-workbench-row.is-subtask",
      ".task-workbench-row.twb-due-soon-row",
      ".task-workbench-row.twb-overdue-row",
    ];
    for (const selector of guarded) {
      const matches = rulesFor(selector);
      expect(matches.length, `rule for ${selector}`).toBeGreaterThan(0);
      for (const rule of matches) {
        for (const sel of rule.selectors) {
          expect(
            TWO_CLASS_COMPOUND.test(sel),
            `selector "${sel}" must remain a two-class compound (0,2,0) per reviewer C1`
          ).toBe(true);
        }
      }
    }
  });

  it("row.is-completed: line-through + faint color", () => {
    expectDecl(".task-workbench-row.is-completed", "text-decoration", "line-through");
    expectDecl(".task-workbench-row.is-completed", "color", "var(--text-faint)");
  });

  it("subtask hierarchy marker and indent", () => {
    expectDecl(".task-workbench-col-name .task-indent", "padding-left", "18px");
    expectDecl(
      ".task-workbench-row.is-subtask .task-workbench-col-name .task-workbench-cell-text::before",
      "content",
      '"↳ "'
    );
    expectDecl(
      ".task-workbench-row.is-subtask .task-workbench-col-name .task-workbench-cell-text::before",
      "color",
      "var(--text-muted)"
    );
  });

  it("strong-parent font-weight:600 scoped under cell-text", () => {
    expectDecl(".task-workbench-cell-text .strong-parent", "font-weight", "600");
  });

  it("collapse toggle/summary/parent-prefix colors and reset", () => {

    expectDecl("button.twb-collapse-toggle", "background", "transparent");
    expectDecl("button.twb-collapse-toggle", "cursor", "pointer");
    expectDecl("button.twb-collapse-toggle", "color", "var(--text-muted)");

    expectDecl(".twb-collapse-summary", "color", "var(--text-faint)");
    expectDecl(".task-workbench-parent-prefix", "color", "var(--text-muted)");
  });

  it("collapsed preview row: muted italic compound selector", () => {
    expectDecl(
      ".task-workbench-row.twb-collapsed-preview-row",
      "color",
      "var(--text-muted)"
    );
    expectDecl(
      ".task-workbench-row.twb-collapsed-preview-row",
      "font-style",
      "italic"
    );
  });

  it("workbench empty message: padding + centered + muted", () => {
    expectDecl(".task-workbench-empty", "padding");
    expectDecl(".task-workbench-empty", "text-align", "center");
    expectDecl(".task-workbench-empty", "color", "var(--text-muted)");
  });

  it("lays out priority stars and reset button correctly", () => {
    const stars = declsFor(".task-workbench-priority-stars");
    expect(stars.get("display"), "priority-stars display must be a flex form").toMatch(/flex/);
    expect(stars.get("gap"), "priority-stars gap").toBe("0");

    expectDecl("button.task-workbench-priority-star", "border", "0");
    expectDecl("button.task-workbench-priority-star", "background", "transparent");
    expectDecl("button.task-workbench-priority-star", "box-shadow", "none");
    expectDecl("button.task-workbench-priority-star", "outline", "none");
    expectDecl("button.task-workbench-priority-star", "cursor", "pointer");
    expectDecl("button.task-workbench-priority-star", "font-size", "1.05em");
    expectDecl(".task-workbench-priority-star:hover", "transform", "scale(1.12)");
    expectDecl("button.task-workbench-priority-reset", "border", "0");
    expectDecl("button.task-workbench-priority-reset", "background", "transparent");
    expectDecl("button.task-workbench-priority-reset", "box-shadow", "none");
    expectDecl("button.task-workbench-priority-reset", "outline", "none");
    expectDecl("button.task-workbench-priority-reset", "cursor", "pointer");

  });

  it("star.priority-auto compound: blue color", () => {
    expectDecl(
      ".task-workbench-priority-star.priority-auto",
      "color",
      "var(--color-blue)"
    );
    expectDecl(
      ".task-workbench-priority-readonly.priority-auto",
      "color",
      "var(--color-blue)"
    );
  });

  it("star.priority-manual compound: yellow color, after priority-auto", () => {
    expectDecl(
      ".task-workbench-priority-star.priority-manual",
      "color",
      "var(--color-yellow)"
    );
    expectDecl(
      ".task-workbench-priority-readonly.priority-manual",
      "color",
      "var(--color-yellow)"
    );
    expect(
      offsetOf(".task-workbench-priority-star.priority-auto")
    ).toBeLessThan(offsetOf(".task-workbench-priority-star.priority-manual"));
  });

  it("inline-input.is-overdue: red color + red border-color", () => {
    const decls = declsFor(".task-workbench-inline-input.is-overdue");
    expect(decls.get("color"), "is-overdue color").toMatch(
      /^rgba\(var\(--color-red-rgb\),/
    );
    expect(decls.get("border-color"), "is-overdue border-color").toMatch(
      /^rgba\(var\(--color-red-rgb\),/
    );
  });

  it("inline-input.is-today: accent border-color", () => {
    expectDecl(
      ".task-workbench-inline-input.is-today",
      "border-color",
      "var(--interactive-accent)"
    );
  });
});




describe("part 4 — Gantt structure", () => {
  it("container uses a full-height flex column and anchors tooltips", () => {
    expectDecl(".task-gantt-container", "display", "flex");
    expectDecl(".task-gantt-container", "flex-direction", "column");
    expectDecl(".task-gantt-container", "height", "100%");
    expectDecl(".task-gantt-container", "position", "relative");
  });

  it("wrap is the scrollport and fills the remaining container height", () => {
    expectDecl(".task-gantt-wrap", "flex", "1 1 auto");
    expectDecl(".task-gantt-wrap", "min-height", "0");
    expectDecl(".task-gantt-wrap", "overflow", "auto");
  });

  it("toolbar: flex:0 0 auto + display:flex + align-items:center + gap", () => {
    expectDecl(".task-gantt-toolbar", "flex", "0 0 auto");
    expectDecl(".task-gantt-toolbar", "display", "flex");
    expectDecl(".task-gantt-toolbar", "align-items", "center");
    expectDecl(".task-gantt-toolbar", "gap");
  });

  it("header: sticky top:0, max-content width, z-index:5, opaque primary background", () => {
    expectDecl(".task-gantt-header", "position", "sticky");
    expectDecl(".task-gantt-header", "top", "0");
    expectDecl(".task-gantt-header", "width", "max-content");
    expectDecl(".task-gantt-header", "z-index", "5");
    expectDecl(".task-gantt-header", "background", "var(--background-primary)");
  });

  it("month/day/dow rows: display:flex + margin-left:320px", () => {
    for (const selector of [
      ".task-gantt-month-row",
      ".task-gantt-day-row",
      ".task-gantt-dow-row",
    ]) {
      expectDecl(selector, "display", "flex");
      expectDecl(selector, "margin-left", "320px");
    }
  });

  it("header-left: sticky left:0 top:0 width:320px", () => {
    expectDecl(".task-gantt-header-left", "position", "sticky");
    expectDecl(".task-gantt-header-left", "left", "0");
    expectDecl(".task-gantt-header-left", "top", "0");
    expectDecl(".task-gantt-header-left", "width", "320px");
  });

  it("header cells: flex:0 0 auto, clipped nowrap; month left-aligned/bold; day vertical border", () => {
    for (const selector of [
      ".task-gantt-month-cell",
      ".task-gantt-day-cell",
      ".task-gantt-dow-cell",
    ]) {
      expectDecl(selector, "flex", "0 0 auto");
      if (selector !== ".task-gantt-month-cell") {
        expectDecl(selector, "text-align", "center");
      }
      expectDecl(selector, "overflow", "hidden");
      expectDecl(selector, "white-space", "nowrap");
    }
    expectDecl(".task-gantt-month-cell", "text-align", "left");
    expectDecl(".task-gantt-month-cell", "font-weight", "600");
    expectDecl(
      ".task-gantt-day-cell",
      "border-right",
      "1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent)"
    );
  });

  it("workload-row: sticky top:54px", () => {
    expectDecl(".task-gantt-workload-row", "position", "sticky");
    expectDecl(".task-gantt-workload-row", "top", "54px");
  });

  it("event-row: sticky top:106px", () => {
    expectDecl(".task-gantt-event-row", "position", "sticky");
    expectDecl(".task-gantt-event-row", "top", "106px");
  });

  it("daily-row: sticky top:150px", () => {
    expectDecl(".task-gantt-daily-row", "position", "sticky");
    expectDecl(".task-gantt-daily-row", "top", "150px");
  });

  it("fixed rows: opaque secondary background + z-index:4", () => {
    for (const selector of [
      ".task-gantt-workload-row",
      ".task-gantt-event-row",
      ".task-gantt-daily-row",
    ]) {
      expectDecl(selector, "background", "var(--background-secondary)");
      expectDecl(selector, "z-index", "4");
      expect(rulesFor(selector).length, `${selector} is defined once`).toBe(1);
    }
  });

  it("fixed-row date backgrounds: absolute layer at z-index:0 with shared date tints", () => {
    expectDecl(".task-gantt-fixed-bg", "position", "absolute");
    expectDecl(".task-gantt-fixed-bg", "top", "0");
    expectDecl(".task-gantt-fixed-bg", "bottom", "0");
    expectDecl(".task-gantt-fixed-bg", "z-index", "0");
    expectDecl(
      ".task-gantt-fixed-bg.is-weekend",
      "background",
      "color-mix(in srgb, var(--text-muted) 6%, transparent)"
    );
    expectDecl(
      ".task-gantt-fixed-bg.is-holiday",
      "background",
      "rgba(var(--color-red-rgb), 0.12)"
    );
    const fixedTodayBackground = declsFor(".task-gantt-fixed-bg.is-today").get(
      "background"
    );
    expect(fixedTodayBackground, ".task-gantt-fixed-bg.is-today background").toContain(
      "linear-gradient"
    );
    expect(fixedTodayBackground, ".task-gantt-fixed-bg.is-today background").toContain(
      "var(--text-error)"
    );
  });

  it("workload summary cells and static bar labels have the required visual rules", () => {
    expectDecl(".task-gantt-workload-summary-cell", "position", "relative");
    expectDecl(".task-gantt-workload-summary-cell", "flex-shrink", "0");
    expectDecl(".task-gantt-workload-summary-cell", "height", "100%");
    expectDecl(".task-gantt-workload-summary-cell", "overflow", "hidden");
    expectDecl(".task-gantt-workload-summary-cell", "font-size", "10px");
    expectDecl(".task-gantt-workload-summary-cell", "line-height", "1");
    expectDecl(
      ".task-gantt-workload-summary-cell",
      "border",
      "1px solid var(--background-modifier-border)"
    );
    expectDecl(
      ".task-gantt-workload-summary-cell",
      "background",
      "linear-gradient(to right, rgba(var(--color-green-rgb), 0.22) 0 var(--twb-workload-actual-ratio, 0%), transparent var(--twb-workload-actual-ratio, 0%) 100%) top / 100% 50% no-repeat, linear-gradient(to right, rgba(var(--color-blue-rgb), 0.22) 0 var(--twb-workload-plan-ratio, 0%), transparent var(--twb-workload-plan-ratio, 0%) 100%) bottom / 100% 50% no-repeat, transparent"
    );
    expectDecl(
      ".task-gantt-workload-summary-cell.is-over-capacity",
      "background",
      "rgba(var(--color-red-rgb), 0.18)"
    );
    expectDecl(
      ".task-gantt-workload-summary-cell.is-actual-over-plan",
      "box-shadow",
      "inset 0 0 0 1px rgba(var(--color-orange-rgb), 0.36)"
    );

    expectDecl(
      ".task-gantt-workload-summary-cell.is-non-working",
      "opacity",
      "0.35"
    );
    expectDecl(
      ".task-gantt-workload-summary-cell.is-non-working",
      "pointer-events",
      "none"
    );

    expectDecl(
      ".task-gantt-workload-summary-actual",
      "left",
      "2px"
    );
    expectDecl(".task-gantt-workload-summary-actual", "top", "2px");
    expectDecl(
      ".task-gantt-workload-summary-actual",
      "color",
      "var(--text-normal)"
    );
    expectDecl(".task-gantt-workload-summary-plan", "right", "2px");
    expectDecl(".task-gantt-workload-summary-plan", "bottom", "2px");
    expectDecl(
      ".task-gantt-workload-summary-plan",
      "color",
      "var(--text-muted)"
    );
    for (const selector of [
      ".task-gantt-workload-summary-actual",
      ".task-gantt-workload-summary-plan",
    ]) {
      expectDecl(selector, "position", "absolute");
      expectDecl(selector, "white-space", "nowrap");
      expectDecl(selector, "font-weight", "600");
      expectDecl(selector, "pointer-events", "none");
    }
    expectDecl(".task-gantt-workload-day-label", "position", "absolute");
    expectDecl(".task-gantt-workload-day-label", "text-align", "center");
    expectDecl(".task-gantt-workload-day-label", "font-size", "10px");
    expectDecl(".task-gantt-workload-day-label", "font-weight", "600");
    expectDecl(".task-gantt-workload-day-label", "pointer-events", "none");
    expectDecl(".task-gantt-workload-day-label", "z-index", "2");
    expectDecl(".task-gantt-workload-day-label.is-dual", "display", "flex");
    expectDecl(
      ".task-gantt-workload-day-label.is-dual",
      "flex-direction",
      "column"
    );
    expectDecl(
      ".task-gantt-workload-day-label.is-dual",
      "justify-content",
      "center"
    );
    expectDecl(".task-gantt-workload-day-label.is-dual", "height", "20px");
    expectDecl(".task-gantt-workload-day-label.is-dual", "line-height", "10px");
    expectDecl(".task-gantt-workload-day-label.is-dual", "white-space", "nowrap");
    for (const selector of [
      ".task-gantt-workload-day-label-actual",
      ".task-gantt-workload-day-label-plan",
    ]) {
      expectDecl(selector, "display", "block");
      expectDecl(selector, "height", "10px");
      expectDecl(selector, "line-height", "10px");
      expectDecl(selector, "overflow", "hidden");
      expectDecl(selector, "text-overflow", "clip");
    }
    expectDecl(
      ".task-gantt-workload-day-label-actual",
      "color",
      "var(--text-muted)"
    );
    expectDecl(
      ".task-gantt-workload-day-label-plan",
      "color",
      "var(--text-normal)"
    );
  });

  it("parent and fixed rows display the left column beside the timeline", () => {
    expectDecl(".task-gantt-parent-row", "display", "flex");
    expectDecl(".task-gantt-fixed-row", "display", "flex");
    expectDecl(".task-gantt-fixed-row", "width", "max-content");
  });

  it("parent-left: horizontal sticky left:0 with opaque background", () => {
    expectDecl(".task-gantt-parent-left", "position", "sticky");
    expectDecl(".task-gantt-parent-left", "left", "0");
    expectDecl(".task-gantt-parent-left", "background", "var(--background-primary)");
  });

  it("parent reorder drag-over: accent outline highlights the drop target", () => {
    expectDecl(".task-gantt-parent-left.is-drag-over", "outline", "2px solid var(--interactive-accent)");
    expectDecl(".task-gantt-parent-left.is-drag-over", "background", "hsla(var(--interactive-accent-hsl), 0.12)");
  });

  it("parent timeline is positioned and clips overflow", () => {
    expectDecl(".task-gantt-parent-timeline", "position", "relative");
    expectDecl(".task-gantt-parent-timeline", "overflow", "hidden");
  });

  it("bg: absolute top:0 bottom:0 z-index:0", () => {
    expectDecl(".task-gantt-bg", "position", "absolute");
    expectDecl(".task-gantt-bg", "top", "0");
    expectDecl(".task-gantt-bg", "bottom", "0");
    expectDecl(".task-gantt-bg", "z-index", "0");
  });

  it("bar: absolute + z-index:2", () => {
    expectDecl(".task-gantt-bar", "position", "absolute");
    expectDecl(".task-gantt-bar", "z-index", "2");
  });


  it("marker: absolute + z-index:2 + left edge at layoutMarkers()'s day-center anchor", () => {
    expectDecl(".task-gantt-marker", "position", "absolute");
    expectDecl(".task-gantt-marker", "z-index", "2");
    expect(declsFor(".task-gantt-marker").has("transform")).toBe(false);
  });


  it("marker presentation has no hover date selector", () => {
    expectDecl(".task-gantt-marker", "font-size", "11px");
    expectDecl(".task-gantt-marker", "cursor", "grab");
    expectDecl(".task-gantt-marker:active", "cursor", "grabbing");
    expectDecl(".task-gantt-marker-pin", "color", "var(--text-warning)");
    expectDecl(
      ".task-gantt-marker",
      "text-shadow",
      "0 1px 2px var(--background-primary)"
    );
    expectDecl(".task-gantt-marker-label", "padding", "0 3px");
    expectDecl(".task-gantt-marker-label", "border-radius", "4px");
    expectDecl(
      ".task-gantt-marker-label",
      "background",
      "var(--background-primary)"
    );
    expectDecl(".task-gantt-marker-label", "cursor", "text");
    expect(rulesFor(".task-gantt-marker-date")).toHaveLength(0);
    expect(rulesFor(".task-gantt-marker:hover .task-gantt-marker-date")).toHaveLength(0);
  });

  it("bar move and resize drag affordances", () => {
    expectDecl(".task-gantt-bar", "cursor", "grab");
    expectDecl(".task-gantt-bar:active", "cursor", "grabbing");
    expectDecl(".task-gantt-resize-start", "position", "absolute");
    expectDecl(".task-gantt-resize-start", "top", "0");
    expectDecl(".task-gantt-resize-start", "height", "100%");
    expectDecl(".task-gantt-resize-start", "width", "6px");
    expectDecl(".task-gantt-resize-start", "left", "0");
    expectDecl(".task-gantt-resize-start", "cursor", "ew-resize");
    expectDecl(".task-gantt-resize-end", "position", "absolute");
    expectDecl(".task-gantt-resize-end", "top", "0");
    expectDecl(".task-gantt-resize-end", "height", "100%");
    expectDecl(".task-gantt-resize-end", "width", "6px");
    expectDecl(".task-gantt-resize-end", "right", "0");
    expectDecl(".task-gantt-resize-end", "cursor", "ew-resize");
  });

  it("bulk-move anchor and follower bars have distinct style declarations", () => {
    expectDecl(
      ".task-gantt-bar.is-bulk-move-anchor",
      "outline",
      "2px solid var(--interactive-accent)"
    );
    expectDecl(".task-gantt-bar.is-bulk-move-follower", "opacity", "0.72");
  });

  it("bar tag badge is a shared tag chip and muted completion opacity", () => {
    // The shared .vg-chip.is-tag supplies the pill, currentColor border and an
    // opaque neutral backdrop (not the bar's own accent background), keeping
    // the tag colour legible regardless of the tag's colour.
    expectDecl(".vg-chip", "border", "1px solid var(--background-modifier-border)");
    expectDecl(".vg-chip", "border-radius", "999px");
    expectDecl(".vg-chip", "background", "var(--background-primary)");
    expectDecl(".vg-chip.is-tag", "border-color", "currentColor");
    expectDecl(".vg-chip.is-tag", "color", "var(--vg-chip-color, var(--text-muted))");
    expectDecl(".task-gantt-bar-tag-badge", "pointer-events", "none");
    expectDecl(".task-gantt-bar.has-tag-badge", "display", "flex");
    expectDecl(".task-gantt-bar.is-completed .task-gantt-bar-tag-badge", "opacity", ".86");
    expectDecl(".task-gantt-bar.is-tag-colored-completed", "opacity", ".48");
    expectDecl(".task-gantt-bar.is-tag-colored-completed", "filter", "saturate(.35) brightness(.96)");
  });

  it("external-label: absolute + z-index:1", () => {
    expectDecl(".task-gantt-external-label", "position", "absolute");
    expectDecl(".task-gantt-external-label", "z-index", "1");
  });

  it("deadline-marker: absolute + z-index:2", () => {
    expectDecl(".task-gantt-deadline-marker", "position", "absolute");
    expectDecl(".task-gantt-deadline-marker", "z-index", "2");
    expectDecl(".task-gantt-deadline-marker", "display", "inline-flex");
    expectDecl(".task-gantt-deadline-marker", "align-items", "center");
    expectDecl(".task-gantt-deadline-marker", "padding", "1px 6px");
    expectDecl(
      ".task-gantt-deadline-marker",
      "border",
      "1px solid rgba(var(--color-red-rgb), 0.4)"
    );
    expectDecl(".task-gantt-deadline-marker", "border-radius", "999px");
    expectDecl(
      ".task-gantt-deadline-marker",
      "background",
      "rgba(var(--color-red-rgb), 0.12)"
    );
    expectDecl(".task-gantt-deadline-marker", "color", "var(--text-error)");
    expectDecl(".task-gantt-deadline-marker", "pointer-events", "auto");
    expectDecl(".task-gantt-deadline-marker", "cursor", "grab");
  });

  it("drag-tooltip: absolute + display:none + pointer-events:none, shown via .is-visible", () => {
    expectDecl(".task-gantt-drag-tooltip", "position", "absolute");
    expectDecl(".task-gantt-drag-tooltip", "display", "none");
    expectDecl(".task-gantt-drag-tooltip", "pointer-events", "none");
    // showDragTooltip/hideDragTooltip (task-gantt-view.ts) only ever
    // toggle the is-visible class, never style.display directly — without
    // this rule the tooltip can never actually become visible.
    expectDecl(".task-gantt-drag-tooltip.is-visible", "display", "block");
  });

  it("add-parent row: flex row, sticky cell, pointer button, transparent timeline", () => {
    expectDecl(".task-gantt-parent-add-row", "display", "flex");
    expectDecl(".task-gantt-parent-add-cell", "position", "sticky");
    expectDecl(".task-gantt-parent-add-cell", "left", "0");
    expectDecl(".task-gantt-parent-add-cell", "background", "var(--background-primary)");
    expectDecl(".task-gantt-parent-add-button", "cursor", "pointer");
    expectDecl(".task-gantt-parent-add-timeline", "background", "transparent");
  });

  it("parent-row/add-row flex children keep their natural width", () => {

    // display:flex with no explicit width (shrink-to-fit block). Their

    // silently compressed below their JS-assigned widths once the row
    // overflows.task-gantt-wrap's viewport — which desyncs the
    // auto-scroll-to-today math and scrolls whole rows out of view (500
    // mock-task real-Obsidian repro). flex-shrink:0 pins them at their
    // inline widths; it does not touch width/height/left/top so

    for (const selector of [
      ".task-gantt-parent-left",
      ".task-gantt-parent-timeline",
      ".task-gantt-parent-add-cell",
      ".task-gantt-parent-add-timeline",
    ]) {
      const decls = declsFor(selector);
      // Accept either the longhand `flex-shrink: 0` or a `flex` shorthand
      // whose shrink term is 0 (e.g. `flex: 0 0 auto`).
      const shrinkDecl = decls.get("flex-shrink");
      const flexDecl = decls.get("flex");
      const shrinkIsZero = shrinkDecl === "0";
      const flexShrinkIsZero =
        flexDecl !== undefined && /^\S+\s+0(\s|$)/.test(flexDecl);
      expect(
        shrinkIsZero || flexShrinkIsZero,
        `${selector} must declare flex-shrink:0 (directly or via flex shorthand), got flex-shrink="${shrinkDecl}" flex="${flexDecl}"`
      ).toBe(true);
    }
  });

  it("parent and add rows grow to their full content width", () => {

    // Width:auto uses shrink-to-fit sizing, so the row can remain as narrow as
    // the viewport while its flex-shrink:0 children overflow. Sticky position
    // is then clamped to that row box. max-content makes the row span its full
    // content width and keeps the sticky columns visible.
    for (const selector of [".task-gantt-parent-row", ".task-gantt-parent-add-row"]) {
      expectDecl(selector, "width", "max-content");
    }
  });
});




describe("part 5 — Gantt readability", () => {
  it("weekend compound gets a hue-neutral gray tint", () => {
    const decls = declsFor(".task-gantt-bg.is-weekend");
    expect(decls.get("background"), "weekend background").toBe(
      "color-mix(in srgb, var(--text-muted) 6%, transparent)"
    );
    // Header-cell compounds must share this rule so they have equal specificity.
    const rule = rulesFor(".task-gantt-bg.is-weekend")[0];
    for (const cell of ["month-cell", "day-cell", "dow-cell"]) {
      expect(
        rule.selectors,
        `weekend rule must also cover .task-gantt-${cell}.is-weekend`
      ).toContain(`.task-gantt-${cell}.is-weekend`);
    }
  });

  it("workload popover weekend cells have a tinted background", () => {
    // background-color (not the background shorthand) so the tint layers
    // underneath.is-non-working's striping instead of being clobbered by
    // it when a cell has both classes (a weekend that's also non-working).
    expectDecl(
      ".task-gantt-workload-popover-cell.is-weekend",
      "background-color",
      "rgba(var(--color-yellow-rgb), 0.12)"
    );
  });

  it("holiday compound gets a red tint", () => {
    expectDecl(
      ".task-gantt-bg.is-holiday",
      "background",
      "rgba(var(--color-red-rgb), 0.12)"
    );
  });

  it("today backgrounds paint a 2px center line, not a full-cell wash", () => {
    for (const selector of [
      ".task-gantt-bg.is-today",
      ".task-gantt-fixed-bg.is-today",
    ]) {
      const decls = declsFor(selector);
      const background = decls.get("background") ?? "";
      expect(background, `${selector} background`).toContain("linear-gradient");
      expect(background, `${selector} background`).toContain("var(--text-error)");
      // must not use a solid accent background that would obscure the striping.
      expect(background).not.toContain("--interactive-accent-hsl");
    }
  });

  it("today header cells use text color and bold weight, not a background fill", () => {
    for (const selector of [
      ".task-gantt-month-cell.is-today",
      ".task-gantt-day-cell.is-today",
      ".task-gantt-dow-cell.is-today",
    ]) {
      const decls = declsFor(selector);
      expect(decls.get("color"), `${selector} color`).toBe("var(--text-error)");
      expect(decls.get("font-weight"), `${selector} font-weight`).toBe("600");
      expect(decls.has("background"), `${selector} must not set background`).toBe(
        false
      );
    }
  });

  it("holiday and today header styles preserve the holiday background", () => {
    // The today header rule omits `background`, so its bold text and color
    // layer on top of the existing holiday or weekend background. This test
    // prevents a future background declaration from reintroducing an override
    // that erases the holiday tint.
    for (const selector of [
      ".task-gantt-month-cell.is-holiday",
      ".task-gantt-day-cell.is-holiday",
      ".task-gantt-dow-cell.is-holiday",
    ]) {
      expect(
        declsFor(selector).get("background"),
        `${selector} background`
      ).toBe("rgba(var(--color-red-rgb), 0.12)");
    }
    for (const selector of [
      ".task-gantt-month-cell.is-today",
      ".task-gantt-day-cell.is-today",
      ".task-gantt-dow-cell.is-today",
    ]) {
      expect(
        declsFor(selector).has("background"),
        `${selector} must not declare background (would override holiday's)`
      ).toBe(false);
    }
  });

  it("source order weekend -> holiday -> today (weak -> strong)", () => {
    expect(offsetOf(".task-gantt-bg.is-weekend")).toBeLessThan(
      offsetOf(".task-gantt-bg.is-holiday")
    );
    expect(offsetOf(".task-gantt-bg.is-holiday")).toBeLessThan(
      offsetOf(".task-gantt-bg.is-today")
    );
  });

  it("dow-cell: cursor:pointer + user-select:none", () => {
    expectDecl(".task-gantt-dow-cell", "cursor", "pointer");
    expectDecl(".task-gantt-dow-cell", "user-select", "none");
  });

  // The today style for day and weekday cells is now handled by the shared
  // header-cell rule, so source ordering against the tint rule is irrelevant.

  it("bar: accent background + border-radius", () => {
    expectDecl(".task-gantt-bar", "background", "var(--interactive-accent)");
    expectDecl(".task-gantt-bar", "border-radius", "8px");
  });


  it("external connector: bent blue polyline, muted for completed labels", () => {
    expectDecl(".task-gantt-external-connector", "position", "absolute");
    expectDecl(".task-gantt-external-connector", "overflow", "visible");
    expectDecl(".task-gantt-external-connector", "pointer-events", "none");
    expectDecl(".task-gantt-external-connector polyline", "fill", "none");
    expectDecl(
      ".task-gantt-external-connector polyline",
      "stroke",
      "rgba(var(--color-blue-rgb), 0.85)"
    );
    expectDecl(".task-gantt-external-connector polyline", "stroke-width", "1.6");
    expectDecl(".task-gantt-external-connector polyline", "stroke-linecap", "round");
    expectDecl(".task-gantt-external-connector polyline", "stroke-linejoin", "round");
    expectDecl(
      ".task-gantt-external-connector:has(+ .task-gantt-external-label.is-completed) polyline",
      "stroke",
      "var(--text-muted)"
    );
  });


  it("parent-title: nowrap + ellipsis + bold", () => {
    expectDecl(".task-gantt-parent-title", "white-space", "nowrap");
    expectDecl(".task-gantt-parent-title", "overflow", "hidden");
    expectDecl(".task-gantt-parent-title", "text-overflow", "ellipsis");
    expectDecl(".task-gantt-parent-title", "font-weight", "600");
  });

  it("tag chips: flex-wrap container; the chip colour comes only from --vg-chip-color", () => {
    expectDecl(".task-gantt-parent-tags", "display", "flex");
    expectDecl(".task-gantt-parent-tags", "flex-wrap");
    // Shape/border come from the shared .vg-chip; the tag colour is a variable
    // set by the renderer, never a literal colour on the parent-tag rule.
    expectDecl(".vg-chip", "border");
    expectDecl(".vg-chip", "border-radius", "999px");
    expectDecl(".vg-chip", "padding", "0 6px");
    expectDecl(".vg-chip", "height", "18px");

    const chip = declsFor(".task-gantt-parent-tag");
    expect(chip.has("color")).toBe(false);
    expect(chip.has("border-color")).toBe(false);
  });

  it("parent-left colour band follows --vg-tag-accent", () => {
    expectDecl(".task-gantt-parent-left.has-tag-accent", "border-left", "4px solid var(--vg-tag-accent)");
  });

  it("external-label: display:flex + height:22px + nowrap + overflow:hidden", () => {
    expectDecl(".task-gantt-external-label", "display", "flex");
    expectDecl(".task-gantt-external-label", "height", "22px");
    expectDecl(".task-gantt-external-label", "padding", "0 4px 0 7px");
    expectDecl(".task-gantt-external-label", "border", "1px solid transparent");
    expectDecl(".task-gantt-external-label", "border-radius", "8px");
    expectDecl(".task-gantt-external-label", "background", "var(--background-primary)");

    expectDecl(
      ".task-gantt-external-label",
      "box-shadow",
      "0 1px 2px var(--background-modifier-box-shadow)"
    );
    expectDecl(".task-gantt-external-label", "font-weight", "600");

    expectDecl(".task-gantt-external-label", "white-space", "nowrap");
    expectDecl(".task-gantt-external-label", "overflow", "hidden");
    expectDecl(".task-gantt-external-label", "text-overflow", "clip");

    // as a duplicate of EXTERNAL_LABEL_ROW_HEIGHT.
    expect(rawCss).toContain(
      "/* must match EXTERNAL_LABEL_ROW_HEIGHT (src/app/gantt-constants.ts) */"
    );
  });

  it("label-text ellipsis + label-badge is a tag chip", () => {
    expectDecl(".task-gantt-label-text", "overflow", "hidden");
    expectDecl(".task-gantt-label-text", "text-overflow", "ellipsis");
    expectDecl(".vg-chip.is-tag", "border-color", "currentColor");
    expectDecl(".task-gantt-label-badge", "flex", "0 0 auto");
  });

  it("event-label has padding and muted color", () => {
    expectDecl(".task-gantt-event-label", "padding", "0 2px");
    expectDecl(".task-gantt-event-label", "color", "var(--text-muted)");
  });

  it("gantt empty: padding + centered + muted", () => {
    expectDecl(".task-gantt-empty", "padding");
    expectDecl(".task-gantt-empty", "text-align", "center");
    expectDecl(".task-gantt-empty", "color", "var(--text-muted)");
  });

  it("floating-month bold; zoom-label min-width+centered", () => {
    expectDecl(".task-gantt-floating-month", "font-weight", "600");
    expectDecl(".task-gantt-floating-month", "white-space", "nowrap");
    expectDecl(".task-gantt-floating-month", "flex-shrink", "0");
    expectDecl(".task-gantt-zoom-label", "min-width");
    expectDecl(".task-gantt-zoom-label", "text-align", "center");
  });

  it("tag-filter-menu: fixed, overlay z-index:20, secondary bg, overflow:auto", () => {
    expectDecl(".task-gantt-tag-filter-menu", "position", "fixed");
    expectDecl(".task-gantt-tag-filter-menu", "z-index", "20");
    expectDecl(".task-gantt-tag-filter-menu", "box-shadow", "var(--shadow-s)");
    expectDecl(".task-gantt-tag-filter-footer", "display", "flex");
    expectDecl(".task-gantt-tag-filter-footer", "justify-content", "flex-end");
    expectDecl(".task-gantt-tag-filter-menu", "background", "var(--background-secondary)");
    expectDecl(".task-gantt-tag-filter-menu", "overflow", "auto");
  });

  it("tag-filter button: pushed to the right edge of header-left", () => {
    expectDecl(".task-gantt-tag-filter", "margin-left", "auto");
  });

  it("tag-filter-item: flex + centered + nowrap", () => {
    expectDecl(".task-gantt-tag-filter-item", "display", "flex");
    expectDecl(".task-gantt-tag-filter-item", "align-items", "center");
    expectDecl(".task-gantt-tag-filter-item", "white-space", "nowrap");
    expectDecl(".task-gantt-tag-filter-swatch", "width", "12px");
    expectDecl(".task-gantt-tag-filter-swatch", "height", "12px");
    expectDecl(".task-gantt-tag-filter-swatch", "border-radius", "50%");
    expectDecl(
      ".task-gantt-tag-filter-swatch",
      "border",
      "1px solid var(--background-modifier-border)"
    );
    expectDecl(".task-gantt-tag-filter-swatch", "flex", "0 0 auto");
  });

  it("rich popover controls use themed, usable controls and actions", () => {
    expectDecl(".task-gantt-popover-actions", "display", "flex");
    expectDecl(".task-gantt-popover-actions", "justify-content", "flex-end");
    expectDecl(".task-gantt-popover-actions", "gap", "8px");
    expectDecl(
      ".task-gantt-popover-actions",
      "border-top",
      "1px solid var(--background-modifier-border)"
    );

    for (const selector of [
      ".task-gantt-popover-open-note",
      ".task-gantt-popover-toggle-completed",
    ]) {
      expectDecl(selector, "display", "inline-flex");
      expectDecl(selector, "min-height", "28px");
      expectDecl(selector, "font", "inherit");
      expectDecl(selector, "border", "1px solid var(--background-modifier-border)");
      expectDecl(selector, "cursor", "pointer");
    }
    expectDecl(
      ".task-gantt-popover-toggle-completed",
      "background",
      "var(--interactive-accent)"
    );

    for (const selector of [
      ".task-gantt-popover-status-select",
      ".task-gantt-popover-due-input",
      ".task-gantt-popover-current-status",
    ]) {
      expectDecl(selector, "display", "block");
      expectDecl(selector, "width", "100%");
      expectDecl(selector, "font", "inherit");
      expectDecl(selector, "color", "var(--text-normal)");
      expectDecl(selector, "background", "var(--background-secondary)");
      expectDecl(selector, "border", "1px solid var(--background-modifier-border)");
      expectDecl(selector, "border-radius", "4px");
    }
    expectDecl(".task-gantt-popover-status-select", "min-height", "28px");
    expectDecl(".task-gantt-popover-due-input", "min-height", "28px");
    expectDecl(".task-gantt-popover-current-status", "min-height", "6em");
    expectDecl(".task-gantt-popover-current-status", "resize", "vertical");
  });
});




describe("part 6 — Modal minimum", () => {
  it("finder-title bold+larger; finder-meta muted+smaller", () => {
    expectDecl(".task-workbench-finder-title", "font-weight", "600");
    const titleSize = declsFor(".task-workbench-finder-title").get("font-size");
    expect(titleSize, "finder-title font-size enlarged").toMatch(/em$/);
    expect(parseFloat(titleSize ?? "0")).toBeGreaterThan(1);
    expectDecl(".task-workbench-finder-meta", "color", "var(--text-muted)");
    const metaSize = declsFor(".task-workbench-finder-meta").get("font-size");
    expect(metaSize, "finder-meta font-size shrunk").toMatch(/em$/);
    expect(parseFloat(metaSize ?? "10")).toBeLessThan(1);
  });

  it("selected list row background + has()-scoped search input width", () => {
    expectDecl(
      ".vg-list-row.is-selected",
      "background",
      "hsla(var(--interactive-accent-hsl), 0.15)"
    );
    expectDecl(
      '.modal:has(.vg-finder-list) input[type="search"]',
      "width",
      "100%"
    );
    expectDecl(".vg-modal-list.vg-finder-list", "max-height", "60vh");
  });

  it("DailyTodoModal: desc/list/row/text/source/buttons rules", () => {
    expectDecl(".task-workbench-modal-desc", "color", "var(--text-muted)");
    expectDecl(".task-workbench-daily-todo-list", "display", "flex");
    expectDecl(".task-workbench-daily-todo-list", "flex-direction", "column");
    expectDecl(".task-workbench-daily-todo-list", "max-height");
    expectDecl(".task-workbench-daily-todo-row", "display", "flex");
    expectDecl(".task-workbench-daily-todo-row", "align-items", "center");
    expectDecl(".task-workbench-daily-todo-text", "flex", "1 1 auto");
    expectDecl(".task-workbench-daily-todo-source", "color", "var(--text-faint)");
    expectDecl(".task-workbench-modal-buttons", "display", "flex");
    expectDecl(".task-workbench-modal-buttons", "justify-content", "flex-end");
  });
});




describe("part 7 — z-index registry", () => {
  it("z-index values follow the registered stacking order", () => {
    // Registry selectors and their expected values. The two local z-index
    // values belong to separate stacking contexts and are excluded from the
    // shared chain.
    const REGISTRY: ReadonlyArray<readonly [string, number]> = [
      [".task-gantt-bg", 0],
      [".task-gantt-fixed-bg", 0],
      [".task-gantt-external-label", 1],
      [".task-gantt-bar", 2],
      [".task-gantt-marker", 2],
      [".task-gantt-deadline-marker", 2],
      [".task-gantt-parent-left", 3],
      [".task-gantt-parent-add-cell", 3],
      [".task-gantt-workload-row", 4],
      [".task-gantt-event-row", 4],
      [".task-gantt-daily-row", 4],
      [".task-gantt-fixed-left", 5],
      [".task-gantt-header", 5],
      [".task-gantt-bar.is-bulk-move-follower", 7],
      [".task-gantt-bar.is-bulk-move-anchor", 8],
      [".task-gantt-drag-tooltip", 10],
      [".task-gantt-tag-filter-menu", 20],
    ];
    const actual = new Map<string, number>();
    for (const [selector, expected] of REGISTRY) {
      const values: string[] = [];
      for (const rule of rulesFor(selector)) {
        for (const decl of rule.decls) {
          if (decl.prop === "z-index") values.push(resolveVgTokens(decl.value));
        }
      }
      expect(values.length, `${selector} must declare z-index`).toBeGreaterThan(0);
      for (const value of values) {
        expect(value, `${selector} z-index`).toBe(String(expected));
      }
      actual.set(selector, Number(values[0]));
    }
    // Strict chain: bg < label < bar/marker/deadline < parent-left/add-cell
    // < fixed rows < fixed-left/header < bulk-move follower < anchor
    // < tooltip < overlay menu.
    const chain: ReadonlyArray<readonly [string, string]> = [
      [".task-gantt-bg", ".task-gantt-external-label"],
      [".task-gantt-external-label", ".task-gantt-bar"],
      [".task-gantt-bar", ".task-gantt-parent-left"],
      [".task-gantt-parent-left", ".task-gantt-workload-row"],
      [".task-gantt-workload-row", ".task-gantt-fixed-left"],
      [".task-gantt-header", ".task-gantt-bar.is-bulk-move-follower"],
      [".task-gantt-bar.is-bulk-move-follower", ".task-gantt-bar.is-bulk-move-anchor"],
      [".task-gantt-bar.is-bulk-move-anchor", ".task-gantt-drag-tooltip"],
      [".task-gantt-drag-tooltip", ".task-gantt-tag-filter-menu"],
    ];
    for (const [lower, higher] of chain) {
      const low = actual.get(lower);
      const high = actual.get(higher);
      expect(low !== undefined && high !== undefined).toBe(true);
      expect(
        (low ?? 0) < (high ?? 0),
        `z-index chain violated: ${lower}(${low}) must be < ${higher}(${high})`
      ).toBe(true);
    }
    // bar/marker/deadline share one level; fixed rows share one level;
    // fixed-left ties with header (both sit above the fixed rows' own
    // z-index, and the tie is safe because fixed-left never paints over
    // header content in practice — they occupy disjoint screen regions).
    expect(actual.get(".task-gantt-marker")).toBe(actual.get(".task-gantt-bar"));
    expect(actual.get(".task-gantt-deadline-marker")).toBe(actual.get(".task-gantt-bar"));
    expect(actual.get(".task-gantt-event-row")).toBe(actual.get(".task-gantt-workload-row"));
    expect(actual.get(".task-gantt-daily-row")).toBe(actual.get(".task-gantt-workload-row"));
    expect(actual.get(".task-gantt-parent-add-cell")).toBe(actual.get(".task-gantt-parent-left"));
    expect(actual.get(".task-gantt-fixed-left")).toBe(actual.get(".task-gantt-header"));
    // These local values belong to separate stacking contexts and are
    // excluded from the shared chain.
    expectDecl(".task-workbench-table thead th", "z-index", "1");
    expectDecl(".task-gantt-header-left", "z-index", "1");
  });
});

describe("design tokens (--vg-*)", () => {
  const bodyRules = getRules().filter((r) => r.selectors.includes("body"));
  const tokenDecls = bodyRules.flatMap((r) => r.decls);
  const tokenNames = tokenDecls.map((d) => d.prop);

  it("are defined once on body and hold only theme-following values", () => {
    expect(bodyRules.length, "exactly one body rule").toBe(1);
    expect(tokenDecls.length).toBeGreaterThan(0);
    // Allowed literals: pill radius, alpha numbers, the focus ring width, z-index.
    const allowedLiteral = /^(999px|0?\.\d+|2px solid var\(--interactive-accent\)|\d+)$/;
    for (const decl of tokenDecls) {
      expect(decl.prop, `${decl.prop} must be a --vg-* property`).toMatch(/^--vg-/);
      const value = decl.value;
      const ok =
        allowedLiteral.test(value) ||
        value.includes("var(--") ||
        /^calc\(var\(--/.test(value);
      expect(ok, `${decl.prop}: ${value} must reference an Obsidian/--vg variable`).toBe(true);
      expect(value, `${decl.prop} must not hardcode a color`).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    }
  });

  it("every var(--vg-*) reference is defined in the token block", () => {
    // Properties the renderer sets inline per element (not theme tokens).
    const RUNTIME_VARS = ["--vg-chip-color", "--vg-tag-accent", "--vg-bar-text"];
    const defined = new Set([...tokenNames, ...RUNTIME_VARS]);
    const used = new Set<string>();
    for (const m of noComments.matchAll(/var\((--vg-[a-z0-9-]+)/g)) used.add(m[1]);
    const missing = [...used].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it("VG_TOKEN_REFERENCE has exactly the tokens of the block", () => {
    expect([...Object.keys(VG_TOKEN_REFERENCE)].sort()).toEqual([...tokenNames].sort());
  });
});
