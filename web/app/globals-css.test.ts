import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * jsdom applies no media queries and runs no animations, so the reduced-motion
 * block can only be pinned as text: the rule exists, it outranks the class
 * utilities, and the spinner keeps turning. Whether it reads right on screen is
 * a browser check (DevTools › Rendering › prefers-reduced-motion).
 */
const css = readFileSync(resolve(__dirname, "globals.css"), "utf8");

function reducedMotionBlock() {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
  expect(start).toBeGreaterThan(-1);
  // The block ends at the first closing brace on a line of its own.
  const end = css.indexOf("\n}", start);
  return css.slice(start, end + 2);
}

describe("globals.css under prefers-reduced-motion", () => {
  it("finishes every animation and transition at once, over the class utilities", () => {
    const block = reducedMotionBlock();
    // 0.01ms rather than none: animationend still fires, and Radix waits for it
    // before it unmounts a closing dialog.
    expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important;/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important;/);
    expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important;/);
    expect(block).toMatch(/scroll-behavior:\s*auto\s*!important;/);
    expect(block).toMatch(/::before/);
    expect(block).toMatch(/::after/);
  });

  it("leaves a spinner turning", () => {
    expect(reducedMotionBlock()).toMatch(/\*:not\(\.animate-spin\)/);
  });
});

/*
 * Contrast is the other thing jsdom cannot see: it resolves no CSS variables,
 * so a ratio written in a comment beside a token is never checked by a
 * component test. These compute it from the tokens themselves, rounded to
 * 8-bit the way a browser paints them, so moving a token under its floor
 * fails here instead of in a reader's eyes.
 */
type Rgb = [number, number, number];

function tokens(selector: ":root" | ".dark"): Record<string, Rgb> {
  // The first block of each is the theme in @layer base; the print block
  // further down redefines a few for paper and is not a screen theme.
  const start = css.indexOf(`  ${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const block = css.slice(start, css.indexOf("\n  }", start));
  const found: Record<string, Rgb> = {};
  for (const [, name, h, s, l] of block.matchAll(
    /--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%;/g,
  )) {
    found[name!] = hslToRgb(Number(h), Number(s) / 100, Number(l) / 100);
  }
  return found;
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokens(":root");
// .dark overrides :root; a token it leaves out keeps its light value.
const dark = { ...light, ...tokens(".dark") };

describe.each([
  ["light", light],
  ["dark", dark],
])("globals.css contrast, %s theme", (_theme, t) => {
  it("parses the tokens it measures", () => {
    for (const name of ["background", "input-strong", "primary", "primary-hover", "primary-foreground"]) {
      expect(t[name], name).toBeDefined();
    }
  });

  // SC 1.4.11: the edge that says a field is there, against every surface a
  // field sits on. The hairline --input stays below it, which is why fields
  // do not use it.
  it.each(["background", "card", "popover", "muted", "sidebar"])(
    "gives a field's edge 3:1 against %s",
    (surface) => {
      expect(contrast(t["input-strong"]!, t[surface]!)).toBeGreaterThanOrEqual(3);
    },
  );

  // SC 1.4.11 for the Switch: the track says a switch is there and the side
  // its thumb sits on says whether it is on. Unchecked (input-strong) and
  // checked (primary), the track holds 3:1 against every surface a switch
  // sits on, and the thumb, painted in background, 3:1 against both tracks.
  it.each(["background", "card", "popover", "muted", "sidebar"])(
    "gives a switch's track 3:1 against %s, on or off",
    (surface) => {
      expect(contrast(t["input-strong"]!, t[surface]!)).toBeGreaterThanOrEqual(3);
      expect(contrast(t["primary"]!, t[surface]!)).toBeGreaterThanOrEqual(3);
    },
  );

  it("keeps a switch's thumb 3:1 against its track, on or off", () => {
    expect(contrast(t["background"]!, t["input-strong"]!)).toBeGreaterThanOrEqual(3);
    expect(contrast(t["background"]!, t["primary"]!)).toBeGreaterThanOrEqual(3);
  });

  // SC 1.4.3: the default Button's label, at rest and under the pointer.
  it("keeps the primary label at 4.5:1 at rest and on hover", () => {
    expect(contrast(t["primary-foreground"]!, t["primary"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["primary-foreground"]!, t["primary-hover"]!)).toBeGreaterThanOrEqual(4.5);
  });

  // SC 1.4.3: muted ink on every surface it is written on — muted itself
  // too, which an inactive tab and a table's group header are (axe found
  // 4.40:1 there in light on the signed-in pages).
  it.each(["background", "card", "popover", "muted", "sidebar", "accent"])(
    "keeps muted text at 4.5:1 on %s",
    (surface) => {
      expect(contrast(t["muted-foreground"]!, t[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  // SC 1.4.3: a destructive Button's and Badge's label on its fill, at rest
  // and under the pointer.
  it("keeps the destructive label at 4.5:1 on its fill, at rest and on hover", () => {
    expect(contrast(t["destructive-foreground"]!, t["destructive"]!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["destructive-foreground"]!, t["destructive-hover"]!)).toBeGreaterThanOrEqual(4.5);
  });
});

// The ratios written beside the tokens, so a comment cannot drift from its token.
describe("globals.css contrast, as its comments state it", () => {
  const at = (t: Record<string, Rgb>, a: string, b: string) => contrast(t[a]!, t[b]!).toFixed(2);

  it("light", () => {
    expect(at(light, "input", "background")).toBe("1.27");
    expect(at(light, "input-strong", "background")).toBe("3.49");
    expect(at(light, "input-strong", "sidebar")).toBe("3.35");
    expect(at(light, "input-strong", "muted")).toBe("3.18");
    expect(at(light, "background", "primary")).toBe("6.18");
    expect(at(light, "primary-foreground", "primary")).toBe("6.18");
    expect(at(light, "primary-foreground", "primary-hover")).toBe("5.09");
    expect(at(light, "muted-foreground", "muted")).toBe("4.94");
    expect(at(light, "muted-foreground", "background")).toBe("5.43");
    expect(at(light, "muted-foreground", "accent")).toBe("4.70");
    expect(at(light, "destructive-foreground", "destructive-hover")).toBe("5.83");
  });

  it("dark", () => {
    expect(at(dark, "input", "background")).toBe("1.40");
    expect(at(dark, "input", "card")).toBe("1.32");
    expect(at(dark, "input-strong", "background")).toBe("3.80");
    expect(at(dark, "input-strong", "card")).toBe("3.59");
    expect(at(dark, "input-strong", "sidebar")).toBe("3.68");
    expect(at(dark, "input-strong", "muted")).toBe("3.07");
    expect(at(dark, "background", "primary")).toBe("5.12");
    expect(at(dark, "primary-foreground", "primary")).toBe("5.12");
    expect(at(dark, "primary-foreground", "primary-hover")).toBe("6.27");
    expect(at(dark, "destructive-foreground", "destructive")).toBe("4.88");
    expect(at(dark, "destructive-foreground", "destructive-hover")).toBe("5.84");
  });
});
