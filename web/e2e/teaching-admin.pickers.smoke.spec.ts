import { expect, test, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import { TEACHING_ADMIN } from "./stub/sessions";

/**
 * Administratör som lärare, the planner's pickers (the web's part 5b): the
 * administrator who carries Users.teaches is offered where a teacher is picked
 * (the timetable's teacher filter, the availability rule's person), and is not
 * offered where somebody is asked to step in (the substitute dialog on the day's
 * lessons), because she is not in the pool and is never asked (SP409).
 *
 * The stub lists her to her own session only (world.ts TEACHING_ADMIN_LISTED),
 * so the other personas' pickers are the school they have always had; the unit
 * tests of each page hold every picker, and this is the browser's answer on two
 * of them and on the one that stays.
 */

const NAME = "Tora Tjänsteman";

async function open(page: Page, url: string, who: "admin" | typeof TEACHING_ADMIN, baseURL: string) {
  if (who === "admin") await signIn(page.context(), "admin", baseURL);
  else await signInAs(page.context(), who, baseURL);
  await freezeClock(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const misses = watchStubMisses(page);
  await page.goto(url);
  await settle(page);
  return misses;
}

test("the timetable's teacher filter offers the administrator who teaches to herself", async ({ page, baseURL }) => {
  const misses = await open(page, "/sv/admin/timetable", TEACHING_ADMIN, baseURL!);
  await page.getByRole("button", { name: "Lärare", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: NAME })).toBeVisible();
  expect(misses).toEqual([]);
});

test("and not to the other administrator, whose school has always lacked her", async ({ page, baseURL }) => {
  await open(page, "/sv/admin/timetable", "admin", baseURL!);
  await page.getByRole("button", { name: "Lärare", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Karin Ek" }).or(page.getByRole("menuitemcheckbox").first())).toBeVisible();
  await expect(page.getByRole("menuitemcheckbox", { name: NAME })).toHaveCount(0);
});

test("the availability rule can be about her, as it can about a teacher", async ({ page, baseURL }) => {
  await open(page, "/sv/admin/constraints", TEACHING_ADMIN, baseURL!);
  await page.getByRole("button", { name: "Lägg till begränsning" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Gäller" }).click();
  await page.getByRole("option", { name: "Lärare" }).click();
  await dialog.getByRole("combobox", { name: "Namn" }).click();
  await expect(page.getByRole("option", { name: NAME })).toBeVisible();
});

test("the substitute dialog does not offer her: she is not in the pool and is never asked", async ({ page, baseURL }) => {
  await open(page, "/sv/admin/lessons", TEACHING_ADMIN, baseURL!);
  const assign = page.getByRole("button", { name: /^Tilldela vikarie/ }).first();
  await expect(assign).toBeVisible();
  await assign.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Vikarierande lärare" }).click();
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect(page.getByRole("option", { name: NAME })).toHaveCount(0);
});
