import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, format, PHONE, setScheme, WCAG_AA_TAGS } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * axe over the opened class's section alone, in both schemes. The matrix above
 * it is the route's own, scanned by a11y-app.spec.ts with no class open; an
 * open class row is not what this spec is about.
 */
async function scanDrillDown(page: Page, label: string): Promise<string[]> {
  const reports: string[] = [];
  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme, true);
    await page.waitForFunction(() =>
      document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity),
    );
    const { violations } = await new AxeBuilder({ page }).withTags(WCAG_AA_TAGS).include("#tackning-class").analyze();
    if (violations.length > 0) reports.push(`--- ${label} ${scheme}\n${format(violations)}`);
  }
  return reports;
}

/**
 * Täckning → Planerat → "Visa alla elever": the opened class's drill-down with
 * every pupil and every line, the part of the page a signed-in scan of the
 * route (a11y-app.spec.ts) never opens. The tables, the amber under-target
 * text, the hidden sentences and the name filter, at desktop and phone width,
 * in both schemes — over the stub's own class and the pupils it names.
 */
test("admin Täckning: every pupil of an opened class", async ({ page, context, baseURL }) => {
  test.slow();
  await signIn(context, "admin", baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);

  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  await page.goto("/sv/admin/timplan/tackning");
  await settle(page);

  const classes = page.locator("tbody th[scope='row'] button");
  await expect(classes.first()).toBeVisible();
  await classes.first().click();
  await page.getByRole("button", { name: "Visa alla elever" }).click();
  const search = page.getByRole("searchbox", { name: "Sök elev i klassen" });
  await expect(search).toBeVisible();
  await settle(page);
  expect.soft(misses, "the backend stub could not answer these reads; each says which file to add it to or fix").toEqual([]);

  // The panel lists pupils: a table per pupil, each under a name.
  await expect(page.getByRole("table", { name: /^Planerad tid för / }).first()).toBeVisible();

  const results = await scanDrillDown(page, "desktop");
  await page.setViewportSize(PHONE);
  await settle(page);
  results.push(...(await scanDrillDown(page, "mobile")));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
  // Not wider than the phone: the tables scroll in their boxes, the page does not.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page scrolls sideways on a phone").toBeLessThanOrEqual(0);
});
