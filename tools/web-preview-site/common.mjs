// Shared helpers for the preview-pages tooling (no npm dependencies).
import { createHash } from "node:crypto";

export function parseArgs(argv, defaults = {}) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/** Branch name -> URL/path safe slug ("/" -> "-", unsafe chars removed). */
export function slugify(branch) {
  const s = branch.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "").replace(/^\.+/, "");
  return s || "branch";
}

/** Assign unique slugs; on collision append a short hash of the branch name. */
export function assignSlugs(targets) {
  const seen = new Set();
  for (const t of targets) {
    let slug = slugify(t.branch);
    if (seen.has(slug)) slug += "-" + createHash("sha1").update(t.branch).digest("hex").slice(0, 6);
    seen.add(slug);
    t.slug = slug;
  }
  return targets;
}

export function pagesBase(repository) {
  const [owner, repo] = repository.split("/");
  return `https://${owner.toLowerCase()}.github.io/${repo}`;
}

export function previewUrl(repository, slug) {
  return `${pagesBase(repository)}/b/${slug}/`;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
