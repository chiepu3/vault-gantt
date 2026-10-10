/** Text colour used on top of a coloured bar. */
export const BAR_TEXT_DARK = "#000000";
export const BAR_TEXT_LIGHT = "#ffffff";

function parseHexColor(value: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  let hex = match[1];
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Picks black or white, whichever has the higher WCAG contrast ratio against
 * the given #rgb / #rrggbb background. The better of the two is always at
 * least 4.5:1 (AA for normal text). Returns undefined for colours that are not
 * hex (the caller then keeps the theme default).
 */
export function readableTextColor(background: string): string | undefined {
  const rgb = parseHexColor(background);
  if (!rgb) return undefined;
  const luminance = relativeLuminance(rgb);
  // contrast(white) = 1.05 / (L + 0.05); contrast(black) = (L + 0.05) / 0.05
  const withWhite = 1.05 / (luminance + 0.05);
  const withBlack = (luminance + 0.05) / 0.05;
  return withBlack >= withWhite ? BAR_TEXT_DARK : BAR_TEXT_LIGHT;
}
