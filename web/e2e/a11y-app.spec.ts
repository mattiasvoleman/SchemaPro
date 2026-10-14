import { expect, test } from "@playwright/test";
import { APP_ROUTES, PAGES } from "./app-routes";
import { DESKTOP, PHONE, scanBothSchemes, setScheme, type Violation } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * Violations the suite lets through, each with the reason it is not fixed
 * here. Keep it short and keep every entry in the tillgänglighetsredogörelse
 * (app/[locale]/tillganglighet/statement.ts) too: an entry here is a known
 * shortcoming, not a waiver. `page` is the route as on disk; `target` a
 * substring of the failing node's selector.
 */
const ALLOWED: Array<{ rule: string; page: string; target: string; reason: string }> = [];

/** The violations left once the allowed nodes are taken out. */
function unexplained(violations: Violation[], page: string): Violation[] {
  return violations
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) =>
          !ALLOWED.some(
            (entry) =>
              entry.rule === violation.id && entry.page === page && node.target.join(" ").includes(entry.target),
          ),
      ),
    }))
    .filter((violation) => violation.nodes.length > 0);
}

test("every signed-in page is covered", () => {
  const uncovered = PAGES.filter((entry) => entry.url === null || entry.personas.length === 0).map((entry) => entry.page);
  expect(uncovered, "add the area to AREAS, or the [param] to PARAMS, in e2e/app-routes.ts").toEqual([]);
});

for (const route of APP_ROUTES) {
  for (const persona of route.personas) {
    test(`${persona} ${route.page}`, async ({ page, context, baseURL }) => {
      // Two loads and four scans of a full page: about five seconds alone,
      // but a loaded runner has taken one past the default minute.
      test.slow();
      await signIn(context, persona, baseURL!);
      await freezeClock(page);
      const misses = watchStubMisses(page);

      await page.setViewportSize(DESKTOP);
      await setScheme(page, "light", false);
      await page.goto(`/sv${route.url}`);
      await settle(page);
      expect(page.url(), "the page sent this person somewhere else").toContain(route.url);
      // Soft, so one run names both what the stub lacks and what axe found.
      expect.soft(misses, "the stub has no fixture for these reads (e2e/stub/fixtures/)").toEqual([]);

      const keep = (violations: Violation[]) => unexplained(violations, route.page);
      const results = await scanBothSchemes(page, "desktop", true, keep);
      await page.setViewportSize(PHONE);
      await page.reload();
      await settle(page);
      results.push(...(await scanBothSchemes(page, "mobile", true, keep)));
      expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
    });
  }
}
