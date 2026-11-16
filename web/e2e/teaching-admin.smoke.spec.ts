import { expect, test, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, signInAs, watchStubMisses } from "./signed-in";
import { EXPEDITION, READER, TEACHING_ADMIN, type SignedInPerson } from "./stub/sessions";

/**
 * Administratör som lärare: the group "Min undervisning" in the administrator's
 * menu, for the one who carries Users.teaches and for nobody else.
 *
 * The menu is the server's (components/layout/role-nav.tsx): this is the
 * browser's own answer to who is shown it, on the page every role has, and to
 * where its rows lead. What each page of the group shows is read by the pages'
 * own tests and by teaching-admin.a11y.spec.ts.
 */

/** The shell's main menu, by its accessible name. */
const menuOf = (page: Page) => page.getByRole("navigation", { name: "Huvudmeny" });

async function open(page: Page, who: SignedInPerson | "admin" | "teacher", baseURL: string, width = 1280) {
  if (typeof who === "string") await signIn(page.context(), who, baseURL);
  else await signInAs(page.context(), who, baseURL);
  await freezeClock(page);
  await page.setViewportSize({ width, height: 800 });
  const misses = watchStubMisses(page);
  await page.goto("/sv/notifications");
  await settle(page);
  return misses;
}

/** The names of the groups in the menu, in order, the unlabelled first one as "". */
async function groupsOf(page: Page): Promise<string[]> {
  return menuOf(page).locator("ul").evaluateAll((lists) =>
    lists.map((list) => {
      const labelId = list.getAttribute("aria-labelledby");
      return labelId ? (document.getElementById(labelId)?.textContent ?? "").trim() : "";
    }),
  );
}

test("the administrator who teaches has the group Min undervisning second, with the seven pages of her own", async ({ page, baseURL }) => {
  await open(page, TEACHING_ADMIN, baseURL!);
  const groups = await groupsOf(page);
  expect(groups[0], "the unlabelled group with Översikt is first").toBe("");
  expect(groups[1], "and the group is second").toBe("Min undervisning");

  const group = menuOf(page).getByRole("list", { name: "Min undervisning" });
  await expect(group.getByRole("link")).toHaveText(["Mitt schema", "Larm", "Närvaro", "Min tjänst", "Min frånvaro", "Ledighet", "Min rapportering"]);
  const hrefs = await group.getByRole("link").evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(hrefs).toEqual([
    "/sv/teacher",
    "/sv/teacher/crisis",
    "/sv/teacher/attendance",
    "/sv/teacher/tjanst",
    "/sv/teacher/franvaro",
    "/sv/teacher/ledighet",
    "/sv/teacher/reporting-rate",
  ]);
  // Not the pool's "Vikariepass" and not the class teacher's schedule.
  await expect(menuOf(page).getByRole("link", { name: /Vikariepass/ })).toHaveCount(0);
  await expect(menuOf(page).getByRole("link", { name: "Klassens schema" })).toHaveCount(0);
});

for (const [name, who] of [
  ["the administrator without the mark", "admin"],
  ["the läsare", READER],
  ["the expedition", EXPEDITION],
  ["the teacher", "teacher"],
] as const) {
  test(`${name} is not shown the group, and the menu is the one it always was`, async ({ page, baseURL }) => {
    await open(page, who, baseURL!);
    expect(await groupsOf(page)).not.toContain("Min undervisning");
    await expect(menuOf(page).getByRole("link", { name: "Min frånvaro" })).toHaveCount(0);
    if (who === "teacher") {
      // The teacher's menu keeps its own cover row.
      await expect(menuOf(page).getByRole("link", { name: "Vikariepass och frånvaro" })).toBeVisible();
    } else {
      // The administrator's: Översikt first, then Grunddata.
      expect((await groupsOf(page)).slice(0, 2)).toEqual(["", "Grunddata"]);
    }
  });
}

test("the group is in the phone's drawer too, second, in reach without scrolling the menu", async ({ page, baseURL }) => {
  await open(page, TEACHING_ADMIN, baseURL!, 390);
  await page.getByRole("button", { name: "Öppna meny" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  const group = drawer.getByRole("list", { name: "Min undervisning" });
  await expect(group.getByRole("link", { name: "Larm" })).toBeVisible();
  // It sits above Grunddata: its first row is in the drawer's first screenful.
  const box = await group.getByRole("link", { name: "Mitt schema" }).boundingBox();
  expect(box!.y, "the first row is on the first screen of a 800 px drawer").toBeLessThan(400);
});
