const TAG_PALETTE = [
  '#4da3ff', '#e64980', '#51cf66', '#ffa94d',
  '#cc5de8', '#20c997', '#f06595', '#74c0fc',
];

export function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) & 0x7fffffff;
  }
  return TAG_PALETTE[hash % TAG_PALETTE.length];
}
