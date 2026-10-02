
// tools/e2e/scenarios/gantt-render.mjs

// Scenario 2: verify the rendered Gantt layout in a real browser.

// A CSS text parser cannot verify browser layout, so render the real view in
// Obsidian and assert:
// (a) the number of `.task-gantt-parent-row` elements matches the fixture;
// (b) the sticky `.task-gantt-parent-left` column stays aligned with the
//     `.task-gantt-wrap` before and after horizontal scrolling;
// (c) each row is at least as wide as the scrollable timeline; and
// (d) the scenario produces no console errors or uncaught exceptions.
// These checks verify that rows span the timeline and the sticky column
// remains visible.

// CDP returnByValue does not serialize DOMRect instances. Destructure
// {left, width, ...} into a plain object before returning measurements.


const COMMAND_ID = "vault-gantt:open-task-gantt";
const EPSILON_PX = 1; // sub-pixel rounding tolerance
const SCROLL_PX = 400;

// Single measurement snapshot. Plain-object return (no DOMRect) — see header.
const MEASURE_EXPR = `(() => {
  const wrap = document.querySelector(".task-gantt-wrap");
  const row = document.querySelector(".task-gantt-parent-row");
  if (!wrap || !row) {
    return null;
  }
  const left = row.querySelector(".task-gantt-parent-left");
  if (!left) {
    return null;
  }
  const w = wrap.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const l = left.getBoundingClientRect();
  return {
    rowCount: document.querySelectorAll(".task-gantt-parent-row").length,
    barCount: document.querySelectorAll(".task-gantt-bar").length,
    wrapLeft: w.left,
    scrollWidth: wrap.scrollWidth,
    clientWidth: wrap.clientWidth,
    scrollLeft: wrap.scrollLeft,
    rowWidth: r.width,
    leftLeft: l.left,
  };
})()`;

/**
 * @param {{ cdp: import("../obsidian-runtime.mjs").CdpSession, vaultDir: string, count: number }} ctx
 * @returns {Promise<{ ok: boolean, failures: string[], details: string }>}
 */
export async function run({ cdp, count }) {
  const failures = [];
  const details = [];

  const hasCommand = await cdp.evaluate(
    `!!app.commands.commands[${JSON.stringify(COMMAND_ID)}]`
  );
  if (!hasCommand) {
    failures.push(`command ${COMMAND_ID} not registered — plugin not loaded?`);
    return { ok: false, failures, details: "" };
  }

  cdp.resetCapturedErrors();

  // --- Open the Gantt view ------------------------------------------------
  await cdp.evaluate(
    `app.commands.executeCommandById(${JSON.stringify(COMMAND_ID)}), true`
  );
  details.push("command dispatched");

  // --- (a) Wait for exactly `count` parent rows ---------------------------
  let before;
  try {
    before = await cdp.waitForExpression(
      `(() => {
        const m = ${MEASURE_EXPR};
        return m && m.rowCount === ${count} ? m : null;
      })()`,
      { timeoutMs: 60000, intervalMs: 500, label: `${count} gantt parent rows` }
    );
  } catch (err) {
    const partial = await cdp.evaluate(MEASURE_EXPR).catch(() => null);
    failures.push(
      `row count never reached ${count}: ${err.message} ` +
        `(last measurement: ${JSON.stringify(partial)})`
    );
    return { ok: false, failures, details: details.join(" | ") };
  }
  details.push(`(a) rowCount=${before.rowCount}===${count}`);

  if (before.barCount < 1) {
    failures.push(
      `expected at least one .task-gantt-bar (subtask planned dates should ` +
        `produce bars), found ${before.barCount} — fixtures may be ineffective`
    );
  } else {
    details.push(`barCount=${before.barCount}`);
  }

  // --- Sanity: chart must be horizontally scrollable -----------------------
  const maxScroll = before.scrollWidth - before.clientWidth;
  if (maxScroll <= 0) {
    failures.push(
      `chart is not horizontally scrollable (scrollWidth=${before.scrollWidth} ` +
        `<= clientWidth=${before.clientWidth}) — cannot test sticky behavior`
    );
    return { ok: false, failures, details: details.join(" | ") };
  }

  // --- (b, pre-scroll) sticky column aligned with wrap's left edge ---------
  checkSticky(before, "pre-scroll", failures, details);
  // --- (c, pre-scroll) row box at least as wide as scroll content ----------
  checkRowWidth(before, "pre-scroll", failures, details);

  // --- Scroll horizontally --------------------------------------------------
  const scrollTarget = Math.min(SCROLL_PX, maxScroll);
  await cdp.evaluate(`(() => {
    const wrap = document.querySelector(".task-gantt-wrap");
    wrap.scrollTo(${scrollTarget}, 0);
    return true;
  })()`);

  let after;
  try {
    after = await cdp.waitForExpression(
      `(() => {
        const m = ${MEASURE_EXPR};
        return m && m.scrollLeft >= ${Math.max(1, scrollTarget - 1)} ? m : null;
      })()`,
      { timeoutMs: 10000, intervalMs: 200, label: `horizontal scroll to ~${scrollTarget}px` }
    );
  } catch (err) {
    failures.push(`horizontal scroll did not take effect: ${err.message}`);
    return { ok: false, failures, details: details.join(" | ") };
  }
  // Let any scroll-driven re-render settle (range auto-extension runs on
  // the scroll handler).
  await cdp.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
  );
  after = await cdp.evaluate(MEASURE_EXPR);
  details.push(`scrolled to scrollLeft=${after.scrollLeft}`);

  // --- (a, post-scroll) row count unchanged --------------------------------
  if (after.rowCount !== count) {
    failures.push(`post-scroll rowCount ${after.rowCount} !== ${count}`);
  }

  // --- (b, post-scroll) sticky-column alignment check ---------------------------
  checkSticky(after, "post-scroll", failures, details);
  // --- (c, post-scroll) -----------------------------------------------------
  checkRowWidth(after, "post-scroll", failures, details);

  // --- (d) zero console errors during the scenario ---------------------------
  const errors = cdp.capturedErrors();
  if (errors.length > 0) {
    failures.push(
      `${errors.length} console error(s) during scenario:\n` +
        errors.map((e) => `    [${e.source}] ${e.text}`).join("\n")
    );
  }

  return { ok: failures.length === 0, failures, details: details.join(" | ") };
}

function checkSticky(m, phase, failures, details) {
  const delta = Math.abs(m.leftLeft - m.wrapLeft);
  if (delta > EPSILON_PX) {
    failures.push(
      `(${phase}) sticky broken: .task-gantt-parent-left left=${m.leftLeft} vs ` +
        `.task-gantt-wrap left=${m.wrapLeft} (delta ${delta}px > ${EPSILON_PX}px) — ` +
        `the frozen column scrolled away from the wrap's left edge`
    );
  } else {
    details.push(`(${phase}) sticky left aligned (delta ${delta.toFixed(2)}px)`);
  }
}

function checkRowWidth(m, phase, failures, details) {
  if (m.rowWidth < m.scrollWidth) {
    failures.push(
      `(${phase}) shrink-to-fit regression: row width=${m.rowWidth} < ` +
        `.task-gantt-wrap scrollWidth=${m.scrollWidth} — .task-gantt-parent-row ` +
        `must span the full content width (width:max-content)`
    );
  } else {
    details.push(`(${phase}) row width ${m.rowWidth} >= scrollWidth ${m.scrollWidth}`);
  }
}
