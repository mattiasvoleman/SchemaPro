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
