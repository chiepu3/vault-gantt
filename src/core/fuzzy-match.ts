/** Lenient name matching for agent searches: width/case/space/punctuation-insensitive, token-wise. */
export function compactForMatch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s\u3000_\-‐‑–—―・、。,.:：;；/／\\|()（）[\]「」『』【】"'`]+/g, "");
}
function tokens(query: string): string[] {
  // Digit runs are their own tokens so "モック146" finds "モックサブタスク 146".
  return query.normalize("NFKC").toLowerCase().split(/[\s\u3000,、]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/).map(compactForMatch).filter(Boolean);
}
/** 0 = no match, 3 = contiguous match, 2 = every token matches, 1 = some tokens match (near miss). */
export function matchScore(query: string, haystacks: readonly string[]): number {
  const compactQuery = compactForMatch(query);
  if (!compactQuery) return 3;
  const compacted = haystacks.map(compactForMatch), joined = compacted.join("");
  if (compacted.some((text) => text.includes(compactQuery))) return 3;
  const words = tokens(query);
  if (words.length > 1 && words.every((word) => joined.includes(word))) return 2;
  if (words.some((word) => joined.includes(word))) return 1;
  return 0;
}
