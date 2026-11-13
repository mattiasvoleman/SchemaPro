import { expect, test, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * Timplansposter's matrix at a phone's width, in a browser.
 *
 * The matrix pins the group's name to the left and the two totals (Max / vecka,
 * Timmar / läsår) to the right, and scrolls the subjects between them. The
 * totals are 159 px and the name 115, so at 320 px the matrix's 286 px left a
 * window of 12 px for the subjects: every cell was under a pinned column at
 * every scroll position, and no post could be opened. At 375 px nine of the
 * 81 cells were out of reach for the same reason. jsdom has no layout, so the
 * question is put to a browser: can each cell button be scrolled to a place
 * where a pointer at both its ends and its middle lands on it, and does a
 * press there open the post.
 *
 * The totals are pinned from `sm` (640 px) up, where the window beside them
 * is wide; under it they scroll with the table, to be read at its end.
 */

const REQUIREMENTS = "/sv/admin/requirements";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const WIDTHS = [320, 375, 1280];

async function open(page: Page, baseURL: string, width: number) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize({ width, height: 800 });
  await page.goto(REQUIREMENTS);
  await settle(page);
  await expect(page.getByRole("table")).toBeVisible();
  return misses;
}

/**
 * Where, in window coordinates, to press the cell button with this index so
 * that it is hit: the row into the middle of the screen as a reader would
 * scroll to it, then the matrix scrolled sideways in steps until both ends
 * and the middle of the button are on top. Null when no scroll position does.
 */
function clearSpot(page: Page, index: number) {
  return page.evaluate((which) => {
    const table = document.querySelector("table")!;
    const scroller = table.parentElement!;
    const button = [...table.querySelectorAll("tbody td button")][which]!;
    button.scrollIntoView({ block: "center", inline: "nearest" });
    for (let x = 0; x <= scroller.scrollWidth; x += 8) {
      scroller.scrollLeft = x;
      const { left, right, top, bottom } = button.getBoundingClientRect();
      const y = (top + bottom) / 2;
      const middle = (left + right) / 2;
      const clear = [left + 3, middle, right - 3].every((at) => {
        const hit = document.elementFromPoint(at, y);
        return !!hit && button.contains(hit);
      });
      if (clear) return { x: middle, y };
    }
    return null;
  }, index);
}

for (const width of WIDTHS) {
  test(`the matrix at ${width} px: every cell can be scrolled to a place where it is pressed and not covered`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, width);
    const cells = await page.getByRole("table").locator("tbody td button").count();
    expect(cells, "the fixture school's matrix has cells").toBeGreaterThan(0);

    const covered: number[] = [];
    for (let index = 0; index < cells; index++) if ((await clearSpot(page, index)) === null) covered.push(index);
    expect(covered, `${width} px: cell buttons that no scroll position uncovers (index in the matrix)`).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  test(`the matrix at ${width} px: a cell, pressed where it is clear, opens its post`, async ({ page, baseURL }) => {
    const misses = await open(page, baseURL!, width);
    const cells = await page.getByRole("table").locator("tbody td button").count();
    // One from the middle of the matrix: neither the first column beside the pinned name nor the last beside the totals.
    const spot = await clearSpot(page, Math.floor(cells / 2));
    expect(spot, `${width} px: the middle cell has a place where a pointer reaches it`).not.toBeNull();
    await page.mouse.click(spot!.x, spot!.y);
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(misses, MISSES).toEqual([]);
  });
}

test("the totals stay pinned to the right of the matrix from 640 px, and scroll with it under that", async ({ page, baseURL }) => {
  const facts = async (width: number) => {
    await page.setViewportSize({ width, height: 800 });
    await settle(page);
    return page.evaluate(() => {
      const headers = [...document.querySelectorAll("table thead th")];
      return headers.slice(-2).map((header) => {
        const style = getComputedStyle(header);
        // Pinned sideways is a sticky box with a right offset; the header row is always pinned from above.
        return { position: style.position, top: style.top, right: style.right };
      });
    });
  };
  const misses = await open(page, baseURL!, 1280);
  expect(await facts(1280), "from 640 px: Max / vecka and Timmar / läsår pinned from above and from the right").toEqual([
    { position: "sticky", top: "0px", right: "96px" },
    { position: "sticky", top: "0px", right: "0px" },
  ]);
  expect(await facts(639), "under 640 px: still pinned from above, not from the right").toEqual([
    { position: "sticky", top: "0px", right: "auto" },
    { position: "sticky", top: "0px", right: "auto" },
  ]);
  expect(misses, MISSES).toEqual([]);
});
