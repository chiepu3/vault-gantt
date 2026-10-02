
// tools/e2e/scenarios/cdp-input.mjs


// inline-edit scenarios, built on the Chrome DevTools Protocol Input domain
// (Input.dispatchMouseEvent) rather than in-page
// `element.dispatchEvent(new PointerEvent(...))`.

// This harness uses trusted CDP mouse input because the Gantt drag handlers
// call `barEl.setPointerCapture(evt.pointerId)` during pointerdown. A synthetic
// PointerEvent dispatched from page JavaScript is not registered as an active
// Chromium pointer, so setPointerCapture throws before move/up listeners are
// installed and the drag never starts. CDP input is handled as trusted browser
// input and creates an active pointer, matching real mouse behavior.


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounding rect of the first element matching `selector`, as a plain object
 * (DOMRect does not survive CDP returnByValue serialization — see the
 * obsidian-runtime.mjs CdpSession.evaluate docblock). Returns null if no
 * element matches. Always re-queries the DOM fresh — callers must NOT cache
 * the result across a render (task-gantt-view.ts may rebuild or diff-patch
 * the bar element on every save, so only the selector is stable, never a
 * specific node reference).
 */
export async function rectOf(cdp, selector) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  })()`);
}

/** Center point {x, y} of a rect object from rectOf. */
export function centerOf(rect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export async function moveMouse(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    pointerType: "mouse",
  });
}

export async function mouseDown(cdp, x, y, { button = "left", clickCount = 1 } = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: 1,
    clickCount,
    pointerType: "mouse",
  });
}

export async function mouseUp(cdp, x, y, { button = "left", clickCount = 1 } = {}) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount,
    pointerType: "mouse",
  });
}

/**
 * A real pointerdown -> N pointermoves -> pointerup gesture, via trusted CDP
 * input (see header). `settleMs` is the pause AFTER pointerup before this
 * resolves — enough for the browser's own event dispatch + the synchronous
 * body of the app's onUp handler to run before the caller issues its next
 * CDP call. The caller is still responsible for waiting for the actual save
 * side-effect (poll the saved file / DOM) — this only guarantees the
 * synchronous part of the gesture is over.
 *
 * One call performs one complete drag gesture (one pointerdown and one
 * pointerup). Do not start another gesture in the same page until the first
 * save is verified on disk and its re-render has settled. The Gantt view has
 * no exclusive drag lock, so overlapping gestures can leave multiple active
 * window listeners and cause a later pointerup to run more than one handler.
 */
export async function dragGesture(cdp, { fromX, fromY, toX, toY, steps = 5, settleMs = 150 }) {
  await moveMouse(cdp, fromX, fromY);
  await sleep(30);
  await mouseDown(cdp, fromX, fromY);
  await sleep(30);
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      buttons: 1,
      pointerType: "mouse",
    });
    await sleep(15);
  }
  await sleep(30);
  await mouseUp(cdp, toX, toY);
  await sleep(settleMs);
}

/**
 * Moves the mouse to a neutral corner first so a subsequent move onto a
 * target is a genuine outside -> inside transition (a real `mouseover`
 * requires an actual enter event, not just "the mouse happens to already be
 * there" — which a single moveMouse straight to the target cannot produce
 * reliably if the previous CDP mouse position was already inside it).
 */
export async function hoverOnto(cdp, x, y, { settleMs = 100 } = {}) {
  await moveMouse(cdp, 2, 2);
  await sleep(30);
  await moveMouse(cdp, x, y);
  await sleep(settleMs);
}

/**
 * A real double-click at a point: two full press/release pairs (clickCount 1
 * then 2), which is how CDP-driven browser automation (Puppeteer/Playwright)
 * reliably produces a native `dblclick` DOM event without depending on OS
 * double-click timing.
 *
 * NOTE: each press/release pair here is itself a real pointerdown/pointerup
 * pair on whatever element is under the cursor. On this codebase's Gantt
 * bars, pointerdown ALWAYS starts a drag session — there is no
 * separate "this is just a click" code path. With zero movement between each
 * press and its own release, `finishBarDrag` no-ops on the zero-day-delta
 * before any save is attempted, so this does not corrupt state; it
 * does mean a double-click here exercises the exact same "two full
 * drag-start/drag-end cycles in quick succession" shape the harness's
 * isolation warning is about — the difference is these two cycles are fully
 * SEQUENTIAL and each one's pointerup synchronously tears down its own
 * window listeners before the next pointerdown fires, so they never overlap.
 */
export async function dblclickAt(cdp, x, y, { settleMs = 60 } = {}) {
  await moveMouse(cdp, x, y);
  await sleep(20);
  await mouseDown(cdp, x, y, { clickCount: 1 });
  await mouseUp(cdp, x, y, { clickCount: 1 });
  await sleep(30);
  await mouseDown(cdp, x, y, { clickCount: 2 });
  await mouseUp(cdp, x, y, { clickCount: 2 });
  await sleep(settleMs);
}

/**
 * Sets a text input/textarea's value via the native property setter, mirror
 * of task-creation.mjs's established "type like a user" pattern, then fires
 * a real 'input' event.
 */
export async function setFieldValue(cdp, selector, value, { multiline = false } = {}) {
  await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const proto = ${multiline ? "HTMLTextAreaElement" : "HTMLInputElement"}.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return el.value;
  })()`);
}

/**
 * Dispatches a real keydown on the element matched by `selector` (native
 * KeyboardEvent via in-page dispatchEvent — keyboard events have no
 * pointer-capture-style "must be browser-trusted" gotcha the way pointer
 * events do, matching task-creation.mjs's existing Enter-key pattern).
 */
export async function keydownOn(cdp, selector, key, { ctrlKey = false, metaKey = false } = {}) {
  await cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true, ctrlKey: ${JSON.stringify(ctrlKey)}, metaKey: ${JSON.stringify(metaKey)} }));
    return true;
  })()`);
}

/** Sets a <select>'s value and dispatches a real 'change' event. */
export async function selectValue(cdp, selector, value) {
  return cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);
}

/**
 * Dismisses Obsidian's own "Do you trust the author of this vault?" modal
 * if present, by clicking its primary "Trust author and enable plugins"
 * button (falling back to any `.mod-cta` button inside `.modal-container`,
 * then the modal's close button).
 *
 * Discovered while validating these scenarios: on a genuinely fresh vault
 * (exactly what run-smoke.mjs's per-scenario throwaway vaults are), Obsidian
 * shows this modal on first open — REGARDLESS of enablePlugin's direct
 * `app.plugins.setEnable(true)`/`loadPlugin` calls, which bypass the
 * restricted-mode gate for the plugin's OWN JS logic (commands still
 * register and run, the chart still renders behind it) but do nothing about
 * this separate UI overlay. The existing task-creation.mjs/gantt-render.mjs
 * scenarios never needed to handle it because neither ever dispatches a
 * REAL mouse click at real screen coordinates — gantt-render.mjs drives
 * scrolling via `wrap.scrollTo` (a direct DOM API call) and
 * task-creation.mjs fills its (own plugin) modal via native-setter property
 * injection, neither of which a same-origin backdrop overlay can intercept.
 * This harness's drag/hover/dblclick scenarios are the first to dispatch
 * CDP-level trusted pointer events at real viewport coordinates, which a
 * topmost modal backdrop DOES intercept (the click lands on the backdrop,
 * never reaching the bar) — with no error and no Notice, so a blocked drag
 * looks exactly like "silently did nothing", the same failure shape as the
 * pointer-capture trap this file's header documents. Call this once, right
 * after the chart is confirmed rendered and before any coordinate-based
 * mouse interaction.
 */
export async function dismissTrustDialogIfPresent(cdp) {
  return cdp.evaluate(`(() => {
    const modal = document.querySelector(".modal-container");
    if (!modal) return "none";
    const buttons = Array.from(modal.querySelectorAll("button"));
    const trustBtn = buttons.find((b) => /trust author/i.test(b.textContent || ""));
    if (trustBtn) { trustBtn.click(); return "trusted"; }
    const cta = modal.querySelector("button.mod-cta");
    if (cta) { cta.click(); return "cta"; }
    const closeBtn = modal.querySelector(".modal-close-button");
    if (closeBtn) { closeBtn.click(); return "closed"; }
    return "present-but-no-known-button";
  })()`);
}

/** Waits two animation frames (lets rAF-coalesced preview/reposition work settle) — mirrors gantt-render.mjs's proven pattern. */
export async function nextFrames(cdp) {
  await cdp.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
  );
}

/**
 * Scrolls `.task-gantt-wrap` so the element matched by `barSelector` is
 * actually visible (and clear of the sticky `.task-gantt-parent-left` name
 * column) before any coordinate-based mouse dispatch.
 *
 * Discovered while validating these scenarios: task-gantt-view.ts positions
 * a bar via `barEl.style.left = "<N>px"`, where N is measured from the
 * chart's scrollable CONTENT origin (`diffDays(rangeStart, bar.start) *
 * dayWidth`), not the viewport. drag-fixture.mjs's fixtures deliberately
 * anchor 20-30 days out (to leave drag-delta/duration runway inside the
 * default [today-14, today+75] range — see its header), which lands well
 * past the default scrollLeft=0 viewport's clientWidth. getBoundingClientRect
 * (what rectOf reads) is viewport-relative, so an unscrolled bar reports
 * a real but off-screen rect (e.g. left=1444 against an ~1280px-wide Xvfb
 * screen) — a CDP click dispatched at those coordinates lands outside the
 * browser window and hits nothing, which looks exactly like "the drag
 * silently did nothing" (no error, no Notice, date simply never changes).
 * gantt-render.mjs never hit this because it only asserts numeric layout
 * properties, never clicks a specific bar.
 */
export async function scrollBarIntoView(cdp, barSelector, { marginPx = 40, extensionGuardPx = 320 } = {}) {
  // Discovered live while validating these scenarios, in this order:

  // 1. task-gantt-view.ts extends the date range whenever `.task-gantt-wrap`
  // scrollLeft comes within its threshold (`Math.max(240, dayWidth * 10)`,
  // or 280px at the default zoom) of either edge. Extension re-renders the
  // chart and shifts each bar's content-left by RANGE_EXTEND_DAYS * dayWidth
  // (1680px by default). A scroll target inside the 280px band can therefore
  // trigger an extension and invalidate itself.
  // 2. Native `Element.scrollIntoView` does not account for that listener or
  // its 280px threshold, so it can land inside the danger zone. This is
  // especially likely for a bar near the start of the default range and can
  // trigger range extension merely by trying to reveal the bar.
  // 3. The sticky `.task-gantt-parent-left` name column spans the row's full
  // timeline height. Its measured right edge (not its width, which omits
  // the column's left offset and Obsidian's file-explorer sidebar) can
  // extend beyond a naively centered bar. Verify that the bar's clickable
  // area sits entirely to the right of the column, not merely on screen.

  // Given (1)+(2), this deliberately does NOT use scrollIntoView at all —
  // it computes an explicit scrollLeft target BASED ON THE CURRENT
  // (possibly just-extended) bar position, clamped to stay outside the
  // danger zone on both edges, applies it directly, and then re-verifies
  // (looping — a self-triggered extension can still occur if the initial
  // read was itself mid-flight) until the bar's clickable center is both
  // stable and provably clear of the sticky column.
  const deadline = Date.now() + 8000;
  for (;;) {
    const state = await cdp.evaluate(`(() => {
      const wrap = document.querySelector(".task-gantt-wrap");
      const bar = document.querySelector(${JSON.stringify(barSelector)});
      const stickyLeft = document.querySelector(".task-gantt-parent-left");
      if (!wrap || !bar) return null;
      const wrapRect = wrap.getBoundingClientRect();
      return {
        scrollLeft: wrap.scrollLeft,
        clientWidth: wrap.clientWidth,
        scrollWidth: wrap.scrollWidth,
        wrapRight: wrapRect.right,
        barContentLeft: parseFloat(bar.style.left || "0"),
        stickyRight: stickyLeft ? stickyLeft.getBoundingClientRect().right : 0,
      };
    })()`);
    if (!state) {
      return null; // bar/wrap disappeared — let the caller's own null-check surface it
    }

    // Live measurement confirmed that `.task-gantt-parent-left` is a
    // normal-flow sibling before the scrollable timeline, not an overlay.
    // Thus a bar's viewport position is stickyRight + barContentLeft -
    // scrollLeft. stickyRight is constant while scrolling, and barContentLeft
    // is the bar's style.left relative to the timeline's content origin.
    // stickyRight therefore CANCELS OUT when solving for the scrollLeft
    // that places the bar `marginPx` past the sticky column — it must NOT
    // appear in the target formula (an earlier version of this function
    // subtracted it there too, which put the bar `stickyRight` px further
    // right than intended, all the way off the actual browser window).
    const minSafeScroll = extensionGuardPx;
    const maxSafeScroll = Math.max(
      minSafeScroll,
      state.scrollWidth - state.clientWidth - extensionGuardPx
    );
    const rawTarget = state.barContentLeft - marginPx;
    const target = Math.min(maxSafeScroll, Math.max(minSafeScroll, rawTarget));

    if (Math.abs(state.scrollLeft - target) > 1) {
      await cdp.evaluate(`(() => {
        const wrap = document.querySelector(".task-gantt-wrap");
        if (wrap) wrap.scrollTo(${JSON.stringify(target)}, 0);
        return true;
      })()`);
      // Give the scroll listener (and, if triggered, its nested
      // double-rAF extension+compensating-shift cycle) real time to fully
      // settle before re-measuring — a couple of rAFs was proven
      // insufficient in practice (the compensating shift can still be
      // in flight after 2 frames under real Xvfb rendering latency).
      await nextFrames(cdp);
      await sleep(250);
      if (Date.now() < deadline) {
        continue; // re-measure from scratch — the extension may have moved barContentLeft
      }
    }

    // Verify against ACTUAL measured rects (not assumed relationships): is
    // the bar's clickable box entirely to the right of the sticky column
    // AND entirely to the left of the wrap's own visible right edge?
    const rect = await rectOf(cdp, barSelector);
    if (
      rect &&
      rect.left >= state.stickyRight + 1 &&
      rect.right <= state.wrapRight
    ) {
      // Confirm stability: unchanged across a short re-check, so a
      // still-in-flight extension doesn't slip through.
      await sleep(150);
      const rectAgain = await rectOf(cdp, barSelector);
      if (rectAgain && rectAgain.left === rect.left && rectAgain.top === rect.top) {
        return rectAgain;
      }
    }

    if (Date.now() > deadline) {
      return rect; // best-effort — caller's own assertions will surface any remaining problem
    }
  }
}

export { sleep };
