// Floating memo prototype (design study only; not part of the plugin).
// Injected into the web preview after app.js. It reads the real Gantt DOM to find anchors and draws memos in one
// overlay layer inside the scroll content, so they scroll natively with the chart and sit under the sticky header/column.
(() => {
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>';
  const MINUS = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/></svg>';
  const STORE = "vg-memo-proto-v1";

  const seed = () => [
    { id: "m-a1", anchor: { kind: "subtask", bar: "実装", dayOffset: 3 }, open: true, dx: 110, dy: 30, w: 236,
      text: "API仕様が11/2までに確定しないと結合テストが後ろ倒し。\n→ 木曜の定例で確認する" },
    { id: "m-a2", anchor: { kind: "subtask", bar: "トップページ実装", dayOffset: 5 }, open: false, dx: 20, dy: -60, w: 200,
      text: "デザイン差し替え版が届いたら着手" },
    { id: "m-a3", anchor: { kind: "parent", parent: "月次レポート作成", date: "2026-11-13" }, open: true, dx: 28, dy: 16, w: 210,
      text: "先方の締め日が20日→15日に変わるかも" },
    { id: "m-a4", anchor: { kind: "row", row: ".task-gantt-event-row", date: "2026-11-10" }, open: true, dx: 22, dy: -20, w: 200,
      text: "11/10 全社休業日の可能性（総務に確認中）" },
    { id: "m-ai", ai: "追加", anchor: { kind: "subtask", bar: "ヒアリング実施", dayOffset: 7 }, open: true, dx: 30, dy: 26, w: 230,
      text: "5社中2社は日程未確定。11/10までに再打診する" },
  ];
  let memos;
  try { memos = JSON.parse(localStorage.getItem(STORE) || "null") || seed(); } catch { memos = seed(); }
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(memos)); } catch { /* preview only */ } };
  window.vgMemoProtoReset = () => { memos = seed(); save(); draw(); };
  window.vgMemoProto = { get memos() { return memos; }, draw: () => draw() };

  let wrap, layer, visible = true, frame = 0, editing = null;

  const dayWidth = () => wrap.querySelector(".task-gantt-day-cell")?.getBoundingClientRect().width || 28;
  const toContent = (rect) => {
    const w = wrap.getBoundingClientRect();
    return { x: rect.left - w.left + wrap.scrollLeft, y: rect.top - w.top + wrap.scrollTop, w: rect.width, h: rect.height };
  };
  const dateX = (date) => {
    const cell = wrap.querySelector(`.task-gantt-workload-row [data-date="${date}"]`);
    return cell ? toContent(cell.getBoundingClientRect()).x + cell.getBoundingClientRect().width / 2 : null;
  };
  const findBar = (name) => [...wrap.querySelectorAll(".task-gantt-bar")].find((b) => (b.firstChild?.textContent || b.textContent).trim().startsWith(name));

  // Anchor point in scroll-content coordinates, plus a short "where" label for the memo header.
  function anchorOf(memo) {
    const a = memo.anchor;
    if (a.kind === "subtask") {
      const bar = findBar(a.bar); if (!bar) return null;
      const r = toContent(bar.getBoundingClientRect()), dw = dayWidth();
      const x = Math.min(r.x + r.w - 4, r.x + a.dayOffset * dw + dw / 2);
      return { x, y: r.y + r.h / 2, where: a.bar };
    }
    const x = dateX(a.date); if (x === null) return null;
    const [, m, d] = a.date.split("-").map(Number);
    if (a.kind === "parent") {
      const row = [...wrap.querySelectorAll(".task-gantt-parent-row")].find((r) => r.querySelector(".task-gantt-parent-title")?.textContent.trim() === a.parent);
      const tl = row?.querySelector(".task-gantt-parent-timeline"); if (!tl) return null;
      const r = toContent(tl.getBoundingClientRect());
      return { x, y: r.y + 10, where: `${a.parent} · ${m}/${d}` };
    }
    const rowEl = wrap.querySelector(a.row); if (!rowEl) return null;
    const r = toContent(rowEl.getBoundingClientRect());
    return { x, y: r.y + r.h / 2, where: `その他 · ${m}/${d}` };
  }

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

  function tail(ax, ay, box, ai) {
    // Straight tail from the anchor to the nearest point of the bubble's frame.
    const tx = Math.max(box.x, Math.min(ax, box.x + box.w)), ty = Math.max(box.y, Math.min(ay, box.y + box.h));
    const minX = Math.min(ax, tx) - 3, minY = Math.min(ay, ty) - 3;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("vg-memo-tail"); if (ai) svg.classList.add("is-ai");
    svg.setAttribute("width", String(Math.abs(tx - ax) + 6)); svg.setAttribute("height", String(Math.abs(ty - ay) + 6));
    svg.style.left = `${minX}px`; svg.style.top = `${minY}px`;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", `${ax - minX},${ay - minY} ${tx - minX},${ty - minY}`);
    svg.appendChild(line);
    return svg;
  }

  function startDrag(evt, memo, box, a) {
    if (evt.button !== 0 || evt.target.closest("button")) return;
    evt.preventDefault();
    const sx = evt.clientX, sy = evt.clientY, ox = memo.dx, oy = memo.dy;
    box.classList.add("is-dragging");
    const tailEl = box.previousSibling;
    const move = (e) => {
      memo.dx = ox + e.clientX - sx; memo.dy = oy + e.clientY - sy;
      box.style.left = `${a.x + memo.dx}px`; box.style.top = `${a.y + memo.dy}px`;
      const fresh = tail(a.x, a.y, { x: a.x + memo.dx, y: a.y + memo.dy, w: box.offsetWidth, h: box.offsetHeight }, !!memo.ai);
      tailEl.replaceWith(fresh);
      tailEl_ = fresh;
    };
    let tailEl_ = tailEl;
    const up = () => { box.classList.remove("is-dragging"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); save(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  function startEdit(memo, textEl) {
    editing = memo.id;
    const area = el("textarea", "vg-memo-edit"); area.value = memo.text;
    const grow = () => { area.style.height = "auto"; area.style.height = `${area.scrollHeight + 2}px`; };
    area.addEventListener("input", grow);
    textEl.replaceWith(area); grow(); area.focus(); area.setSelectionRange(area.value.length, area.value.length);
    let done = false;
    const finish = (commit) => { if (done) return; done = true; editing = null; if (commit) { memo.text = area.value.trim() || memo.text; save(); } draw(); };
    area.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
      // Enter confirms (Shift+Enter = new line); Enter while the IME is composing only commits the conversion.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); finish(true); }
    });
    area.addEventListener("blur", () => finish(true));
  }

  function drawMemo(memo) {
    const a = anchorOf(memo); if (!a) return;
    if (!memo.open) {
      const pin = el("div", "vg-memo-pin", ICON);
      pin.style.left = `${a.x}px`; pin.style.top = `${a.y - 12}px`;
      pin.title = memo.text;
      pin.addEventListener("click", () => { memo.open = true; save(); draw(); });
      layer.appendChild(pin);
      return;
    }
    const box = el("div", "vg-memo" + (memo.ai ? " is-ai" : ""));
    box.dataset.memoId = memo.id;
    box.style.left = `${a.x + memo.dx}px`; box.style.top = `${a.y + memo.dy}px`; box.style.width = `${memo.w}px`;
    const head = el("div", "vg-memo-head");
    if (memo.ai) head.appendChild(el("span", "vg-memo-mark")).textContent = `AI提案 · ${memo.ai}`;
    else head.insertAdjacentHTML("beforeend", ICON);
    head.appendChild(el("span", "vg-memo-where")).textContent = a.where;
    const close = el("button", "vg-memo-btn", MINUS); close.title = "閉じる（アンカーにピンだけ残す）"; close.setAttribute("aria-label", "メモを閉じる");
    close.addEventListener("click", () => { memo.open = false; save(); draw(); });
    head.appendChild(close);
    head.addEventListener("pointerdown", (e) => startDrag(e, memo, box, a));
    const text = el("div", "vg-memo-text"); text.textContent = memo.text;
    text.addEventListener("dblclick", () => startEdit(memo, text));
    box.append(head, text);
    if (memo.ai) {
      const actions = el("div", "vg-memo-actions");
      const ok = el("button", "mod-cta"); ok.textContent = "適用";
      ok.addEventListener("click", () => { delete memo.ai; save(); draw(); });
      const no = el("button"); no.textContent = "却下";
      no.addEventListener("click", () => { memos = memos.filter((m) => m !== memo); save(); draw(); });
      actions.append(no, ok); box.appendChild(actions);
    }
    // Width set by the user's resize handle is kept.
    new ResizeObserver(() => { if (box.isConnected && Math.abs(box.offsetWidth - memo.w) > 2) { memo.w = box.offsetWidth; save(); } }).observe(box);
    const dot = el("div", "vg-memo-dot" + (memo.ai ? " is-ai" : ""));
    dot.style.left = `${a.x}px`; dot.style.top = `${a.y}px`;
    layer.append(dot, el("span"), box);
    // Tail needs the bubble's real height.
    const t = tail(a.x, a.y, { x: a.x + memo.dx, y: a.y + memo.dy, w: box.offsetWidth, h: box.offsetHeight }, !!memo.ai);
    box.previousSibling.replaceWith(t);
  }

  function draw() {
    if (!wrap?.isConnected) return;
    if (editing) return;
    if (!layer?.isConnected) {
      layer = el("div", "vg-memo-layer"); wrap.appendChild(layer);
      // Memo gestures must not reach the chart's own handlers (background pan, bar hover, context menu).
      for (const type of ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "mouseover"]) layer.addEventListener(type, (e) => e.stopPropagation());
    }
    else if (layer !== wrap.lastElementChild) wrap.appendChild(layer); // keep it last so it paints above bars/markers
    layer.classList.toggle("is-hidden", !visible);
    layer.style.width = `${wrap.scrollWidth}px`; layer.style.height = `${wrap.scrollHeight}px`;
    clip();
    layer.replaceChildren();
    for (const memo of memos) drawMemo(memo);
    updateToolbar();
  }
  // Parent rows use content-visibility (own stacking context), so their sticky name column cannot paint over the layer.
  // The layer clips itself at the column's right edge instead: one style write per scroll; the memos still scroll natively.
  function clip() {
    if (!layer) return;
    const left = wrap.querySelector(".task-gantt-parent-left")?.getBoundingClientRect().width ?? 0;
    layer.style.clipPath = `inset(0 0 0 ${wrap.scrollLeft + left}px)`;
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); };

  function updateToolbar() {
    let btn = document.querySelector(".vg-memo-toolbar-btn");
    const anchorBtn = [...document.querySelectorAll(".task-gantt-toolbar button, .task-gantt-header-actions button, button")].find((b) => b.textContent.trim() === "AI" && b.closest(".workspace-leaf, .view-content"));
    if (!btn && anchorBtn) {
      btn = el("button", "vg-memo-toolbar-btn");
      btn.title = "メモの表示/非表示";
      btn.addEventListener("click", () => { visible = !visible; draw(); });
      anchorBtn.after(btn);
    }
    if (btn) { btn.textContent = `メモ ${memos.length}`; btn.classList.toggle("is-on", visible); }
  }

  function attach() {
    const w = document.querySelector(".task-gantt-wrap");
    if (!w || !w.querySelector(".task-gantt-bar")) return false;
    if (w !== wrap) {
      wrap = w; wrap.style.position = "relative";
      new MutationObserver((records) => { if (records.some((r) => !(r.target === layer || layer?.contains(r.target)) && [...r.addedNodes, ...r.removedNodes].some((n) => n !== layer))) schedule(); })
        .observe(wrap, { childList: true, subtree: true });
      new ResizeObserver(schedule).observe(wrap);
      wrap.addEventListener("scroll", clip, { passive: true });
    }
    draw();
    return true;
  }
  const boot = setInterval(() => { if (attach()) clearInterval(boot); }, 300);
  // Re-attach when the Gantt view is rebuilt (e.g. tab switch).
  setInterval(() => { const w = document.querySelector(".task-gantt-wrap"); if (w && w !== wrap) attach(); }, 1000);
})();
