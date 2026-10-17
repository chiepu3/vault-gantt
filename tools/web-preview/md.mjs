// Tiny, safe Markdown -> HTML for untrusted PR bodies. Everything is HTML-escaped first; only a fixed tag set is ever emitted,
// and links are limited to http(s). Supports headings, lists (with task boxes), fenced code, quotes, rules, **bold**, *em*, `code`, [t](url).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function safeUrl(u) {
  try { const x = new URL(String(u).trim()); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}

function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
    const url = safeUrl(u.replace(/&amp;/g, "&"));
    return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t}</a>` : m;
  });
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, u) => {
    const url = safeUrl(u.replace(/&amp;/g, "&"));
    return url ? `${pre}<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${u}</a>` : m;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*\w])\*([^*\s][^*\n]*)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_\n]*)_(?![\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

export function renderMarkdown(md, { max = 8000 } = {}) {
  let text = String(md ?? "").replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  if (text.length > max) text = text.slice(0, max) + "\n\n…(長いため省略)";
  const lines = text.split("\n");
  const out = [];
  let para = [], list = null; // list: { tag, items: [] }
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = /^\s*(```|~~~)/.exec(line))) {
      flushPara(); flushList();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (!line.trim()) { flushPara(); flushList(); }
    else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { flushPara(); flushList(); const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${inline(m[2])}</h${n}>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); flushList(); out.push("<hr>"); }
    else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /\d/.test(m[2]) ? "ol" : "ul";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      const t = /^\[([ xX])\]\s+(.*)$/.exec(m[3]);
      const nested = m[1].length >= 2 && list.items.length ? "  " : "";
      const body = t ? `<span class="chk">${t[1] === " " ? "☐" : "☑"}</span> ${inline(t[2])}` : inline(m[3]);
      list.items.push(nested ? `<span class="sub">${body}</span>` : body);
    } else if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); }
    else if (list && /^\s+\S/.test(line)) list.items[list.items.length - 1] += "<br>" + inline(line.trim());
    else { flushList(); para.push(line.trim()); }
  }
  flushPara(); flushList();
  return out.join("\n");
}
