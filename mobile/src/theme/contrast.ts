/**
 * WCAG 2.1 relative luminance and contrast ratio, for the theme's own tests
 * and for the tints the theme derives (a status colour laid over a ground at
 * an alpha, painted as the phone paints it: rounded to 8 bits).
 */
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` at `alpha` over the opaque `ground`, as one opaque colour. */
export function over(top: string, alpha: number, ground: string): string {
  const t = parseHex(top);
  const g = parseHex(ground);
  return toHex([0, 1, 2].map((i) => Math.round(t[i]! * alpha + g[i]! * (1 - alpha))) as unknown as Rgb);
}
