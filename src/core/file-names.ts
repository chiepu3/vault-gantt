/** Note file names follow task titles. The rules here keep them valid on every OS and safe inside [[links]]. */
const REPLACEMENTS: Record<string, string> = {
  "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜",
  // Valid in file names, but they break [[wiki links]] (the subtask's `parent` is one).
  "#": "＃", "^": "＾", "[": "［", "]": "］",
};
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
export const MAX_FILE_STEM = 100;

/** Valid file stem (no extension) for a title: forbidden characters become full-width, no trailing dots/spaces, at most 100 characters. */
export function sanitizeFileStem(title: string, maxLength = MAX_FILE_STEM): string {
  // eslint-disable-next-line no-control-regex
  let stem = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[\\/:*?"<>|#^[\]]/g, (char) => REPLACEMENTS[char]);
  stem = stem.replace(/\s+/g, " ").replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
  const chars = Array.from(stem);
  if (chars.length > maxLength) stem = chars.slice(0, maxLength).join("").replace(/[\s.]+$/, "");
  if (!stem) return "無題";
  return RESERVED.test(stem) ? `${stem}_` : stem;
}

/** `stem`, or `stem 2`, `stem 3`... until `taken` says the name is free. */
export function uniqueFileStem(stem: string, taken: (candidate: string) => boolean): string {
  if (!taken(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!taken(candidate)) return candidate;
  }
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2}) /;

/** Parent note stem: optional `YYYY-MM-DD ` prefix + sanitized title. */
export function parentFileStem(title: string, dateStr: string, usesDatePrefix: boolean): string {
  const prefix = usesDatePrefix ? `${dateStr} ` : "";
  return `${prefix}${sanitizeFileStem(title, MAX_FILE_STEM - prefix.length)}`;
}

/** The date prefix a parent note already has, so a rename keeps it. */
export function datePrefixOf(stem: string): string | undefined {
  return DATE_PREFIX.exec(stem)?.[1];
}
