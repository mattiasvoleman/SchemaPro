import { expect, test } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes, setScheme } from "./axe";
import { askForScenario, freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { OPEN_SCENARIO } from "./stub/fixtures/gateway-crisis";

/**
 * Krisläge with an alarm going, which the signed-in scan of the routes
 * (a11y-app.spec.ts) never sees: it opens each page as the menu does, with no
 * alarm. Here a live evacuation is going (the stub's "crisis-open" scenario),
 * and axe reads what a person in the middle of it reads, at desktop and
 * phone width, in both schemes: the large red button and its confirmation, the
 * counters and the tables of the live view with a group opened (the group of
 * pupils on no lesson is the first, and the sentence about them is above the
 * groups), the question "Ingen av de oprickade är i huset" with its
 * confirmation, a pupil marked "Inte i huset", and the teacher's list with its
 * 44 px targets, a pupil marked, one marked missing and one absent
 * beforehand, a pupil found who is on another list (with "Ta tillbaka"), and
 * the search for finding one.
 */

const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

test("admin Krisläge: a live alarm, a group opened, and the end dialog", async ({ page, context, baseURL }) => {
  test.slow();
  await signIn(context, "admin", baseURL!);
  await freezeClock(page);
  await askForScenario(page, OPEN_SCENARIO);
  const misses = watchStubMisses(page);

  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  await page.goto("/sv/admin/crisis");
  await settle(page);
  await expect(page.getByRole("heading", { level: 2, name: /Utrymning · pågår/ })).toBeVisible();
  await expect(page.getByText("2 elever är inte i lektion just nu. Ledningen svarar för dem.")).toBeVisible();
  // The group of pupils on no lesson: no "Alla finns" there, one question behind a confirmation.
  await page.getByRole("button", { name: "Ej i lektion just nu" }).click();
  await expect(page.getByRole("button", { name: "Alla finns (1)" })).toHaveCount(0);
  await page.getByRole("button", { name: "Den oprickade eleven är inte i huset" }).click();
  const away = page.getByRole("dialog", { name: "Är den oprickade eleven inte i huset?" });
  await expect(away).toBeVisible();
  await expect(away).toContainText("jag har inte sett eleven");
  await settle(page);
  const confirm = await scanBothSchemes(page, "away dialog", true);
  expect(confirm.join("\n"), "WCAG 2.1 AA violations").toBe("");
  await away.getByRole("button", { name: "Avbryt" }).click();
  await expect(away).toBeHidden();
  await page.getByRole("button", { name: "9C" }).click();
  await expect(page.getByRole("list", { name: "Eleverna i 9C" })).toBeVisible();
  await settle(page);
  expect.soft(misses, MISSES).toEqual([]);

  const results = await scanBothSchemes(page, "desktop", true);
  await page.setViewportSize(PHONE);
  await settle(page);
  results.push(...(await scanBothSchemes(page, "phone", true)));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page scrolls sideways on a phone").toBeLessThanOrEqual(0);

  // The end dialog, with its warning that not everyone is ticked off.
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Avsluta larmet" }).click();
  await expect(page.getByRole("dialog", { name: "Avsluta det skarpa larmet?" })).toBeVisible();
  await settle(page);
  expect((await scanBothSchemes(page, "end dialog", true)).join("\n"), "WCAG 2.1 AA violations").toBe("");
});

test("admin Krisläge: the start panel and the question before a live alarm", async ({ page, context, baseURL }) => {
  test.slow();
  await signIn(context, "admin", baseURL!);
  await freezeClock(page);
  const misses = watchStubMisses(page);

  await page.setViewportSize(DESKTOP);
  await setScheme(page, "light", false);
  await page.goto("/sv/admin/crisis");
  await settle(page);
  await page.getByRole("button", { name: "Starta skarpt larm: utrymning" }).click();
  await expect(page.getByRole("button", { name: "Ja, starta skarpt larm" })).toBeVisible();
  await settle(page);
  expect.soft(misses, MISSES).toEqual([]);

  const results = await scanBothSchemes(page, "desktop", true);
  await page.setViewportSize(PHONE);
  await settle(page);
  results.push(...(await scanBothSchemes(page, "phone", true)));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
});

test("teacher Larm: the groups of a live alarm, with pupils marked, missing and absent beforehand", async ({ page, context, baseURL }) => {
  test.slow();
  await signIn(context, "teacher", baseURL!);
  await freezeClock(page);
  await askForScenario(page, OPEN_SCENARIO);
  const misses = watchStubMisses(page);

  await page.setViewportSize(PHONE);
  await setScheme(page, "light", false);
  await page.goto("/sv/teacher/crisis");
  await settle(page);
  await expect(page.getByRole("region", { name: "7A" })).toBeVisible();
  expect.soft(misses, MISSES).toEqual([]);

  // Every mark button is a 44 px target.
  const boxes = await page.getByRole("button", { name: /^(Finns|Saknas): / }).evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().height),
  );
  expect(boxes.length).toBeGreaterThan(0);
  for (const height of boxes) expect(height).toBeGreaterThanOrEqual(44);

  await expect(page.getByRole("list", { name: "Hittade hos dig som inte står på listan" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Ta tillbaka: Vera Sund" })).toBeVisible();

  const results = await scanBothSchemes(page, "phone", true);
  await page.setViewportSize(DESKTOP);
  await settle(page);
  results.push(...(await scanBothSchemes(page, "desktop", true)));
  expect(results.join("\n"), "WCAG 2.1 AA violations").toBe("");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "the page scrolls sideways").toBeLessThanOrEqual(0);

  // The picker for a pupil found who is not on the list, open with results, at phone width where it is used.
  await page.setViewportSize(PHONE);
  await page.getByRole("button", { name: "Hittat en elev som inte står på listan" }).click();
  await page.getByRole("searchbox", { name: "Namn eller klass" }).fill("ek");
  // Searched for on the gateway, after a pause in the typing.
  await expect(page.getByRole("list", { name: "Träffar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Finns: Wilmer Ek (9A)" })).toBeVisible();
  await settle(page);
  const picker = await scanBothSchemes(page, "picker", true);
  expect(picker.join("\n"), "WCAG 2.1 AA violations").toBe("");
  const pickerOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(pickerOverflow, "the picker scrolls the page sideways on a phone").toBeLessThanOrEqual(0);
});
