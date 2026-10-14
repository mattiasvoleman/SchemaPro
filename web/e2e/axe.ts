import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * The axe scan every browser suite runs: WCAG 2.1 A and AA, which is what
 * PRODUCT.md promises and what the tillgänglighetsredogörelse says is
 * checked. axe is the automated half of that claim — contrast, names,
 * landmarks, ARIA — and a green run means "no automated violations", not
 * full conformance.
 */

export const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Waits for every finite animation to end. A menu fading in measured its
 * muted text at 4.41:1 halfway through the fade (the colour axe read was the
 * token's mixed with the surface below), and passed once it had arrived. A
 * spinner or a pulsing skeleton never ends, and is not waited for.
 */
async function stillness(page: Page) {
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
    undefined,
    { timeout: 5_000 },
  );
}

export const scan = async (page: Page) => {
  await stillness(page);
  return new AxeBuilder({ page })
    .withTags(WCAG_AA_TAGS)
    // Next's route announcer is an empty live region, not part of the UI.
    .exclude("next-route-announcer")
    .analyze();
};

export type Violation = Awaited<ReturnType<typeof scan>>["violations"][number];

/** axe's output as something a reviewer can act on without the HTML report. */
export const format = (violations: Violation[]): string =>
  violations
    .map(
      (v) =>
        `[${v.impact ?? "unknown"}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `    ${n.target.join(" ")}\n      ${n.failureSummary?.split("\n").join("\n      ")}`).join("\n"),
    )
    .join("\n");

export const DESKTOP = { width: 1280, height: 800 };
export const PHONE = { width: 390, height: 844 };

/** Puts the page in a colour scheme, and waits for next-themes to follow it on a page that has it. */
export async function setScheme(page: Page, scheme: "light" | "dark", themed: boolean) {
  await page.emulateMedia({ colorScheme: scheme });
  if (themed) {
    await expect(page.locator("html")).toHaveClass(scheme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
  }
}

/**
 * Scans the page as it stands in both colour schemes, and returns one
 * report per scheme that found something. `themed` is false for a page with
 * one look (Schemavisaren), where both scans see the same page.
 */
export async function scanBothSchemes(
  page: Page,
  label: string,
  themed: boolean,
  keep: (violations: Violation[]) => Violation[] = (violations) => violations,
): Promise<string[]> {
  const reports: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme, themed);
    const violations = keep((await scan(page)).violations);
    if (violations.length > 0) reports.push(`--- ${label} ${scheme}\n${format(violations)}`);
  }
  return reports;
}
