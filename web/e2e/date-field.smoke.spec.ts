import { expect, test, type Locator, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { addDays } from "./stub/fixtures/calendar";
import { YEAR } from "./stub/fixtures/world";

/**
 * The date field's calendar, where it opens: inside a dialog, in the right
 * column of a two-column form.
 *
 * Reported on Lov och studiedagar: the calendar for Sista dagen did not fit in
 * "Lägg till lov", so its Nästa månad button could not be reached and the
 * months could not be stepped through. The calendar hung under its field as an
 * absolutely positioned box, and the dialog clips sideways (overflow-x-hidden,
 * components/ui/dialog.tsx), so the right third of it, chevron included, was
 * cut off. jsdom has no layout, so only a browser can say whether a box is
 * where a pointer can reach it; that is what this file is for.
 *
 * "Fully visible" is asked of the page the way a pointer would: what is on top
 * at each corner of the calendar, and at the centre of each chevron. A clipped
 * box still has a bounding box inside the window, so the bounding box alone
 * would have passed the bug.
 */

const BREAKS = "/sv/admin/breaks";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";

const VIEWPORTS = [
  { name: "1280×800", width: 1280, height: 800 },
  { name: "1280×650", width: 1280, height: 650 },
  { name: "375×812", width: 375, height: 812 },
  // A phone with the browser's own bars showing. Sista dagen sits too low for
  // the calendar to fit under it, so it opens over the field instead.
  { name: "375×600", width: 375, height: 600 },
  // Lower than the calendar itself: it takes the window's height less its
  // edges and scrolls, with the chevrons' row held at its top.
  { name: "1280×200", width: 1280, height: 200, scrolls: true },
];

async function openBreakDialog(page: Page, baseURL: string, size: { width: number; height: number }) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  await page.setViewportSize(size);
  await page.goto(BREAKS);
  await settle(page);
  await page.getByRole("button", { name: "Lägg till lov" }).click();
  const dialog = page.getByRole("dialog", { name: "Lägg till lov" });
  await expect(dialog).toBeVisible();
  // The dialog zooms in; a box measured mid-animation is 95 % of itself.
  await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  return { dialog, misses };
}

/** The calendar's box, whether it is inside the window, and whether a pointer at each corner would land on it. */
function visibility(calendar: Locator) {
  return calendar.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = document.documentElement;
    // Past the rounded corner: hit-testing honours border-radius, and a point
    // 2 px in from an 8 px corner is outside the curve, on whatever is beneath.
    const inset = parseFloat(getComputedStyle(element).borderTopLeftRadius) + 2;
    const corners = [
      [box.left + inset, box.top + inset],
      [box.right - inset, box.top + inset],
      [box.left + inset, box.bottom - inset],
      [box.right - inset, box.bottom - inset],
    ] as const;
    return {
      insideWindow:
        box.left >= 0 && box.top >= 0 && box.right <= view.clientWidth && box.bottom <= view.clientHeight,
      cornersOnTop: corners.map(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      }),
    };
  });
}

/**
 * A real pointer press at the centre of the element. Not `locator.click()`:
 * that scrolls the element into view first, and on main it scrolled the
 * clipped dialog sideways to reach Nästa månad, which no person can do. A
 * person's click there landed on the overlay and closed the dialog.
 */
async function press(page: Page, element: Locator) {
  const box = (await element.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

/** Whether a pointer at the centre of the element lands on it, and not on whatever clips or covers it. */
function onTop(element: Locator) {
  return element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit !== null && node.contains(hit);
  });
}

for (const size of VIEWPORTS) {
  test(`Lägg till lov at ${size.name}: both calendars open whole, and their months step by pointer and keyboard`, async ({
    page,
    baseURL,
  }) => {
    const { dialog, misses } = await openBreakDialog(page, baseURL!, size);

    for (const field of ["Första dagen", "Sista dagen"]) {
      // A day two months into the fixture läsår, so the calendar opens there
      // and the month after it is the läsår's too, whatever day the suite runs.
      // Opened on today, a run in June would step into July, past the läsår's
      // last day: every day disabled, and nothing for the keyboard to land on.
      await dialog.getByRole("textbox", { name: field }).fill(addDays(YEAR.startDate, 60));
      const trigger = dialog.getByRole("button", { name: `Öppna kalender för ${field}` });
      await trigger.click();
      const calendar = page.getByRole("dialog", { name: "Välj datum" });
      await expect(calendar).toBeVisible();

      expect(await visibility(calendar), `${field}: the calendar is inside the window and nothing clips it`).toEqual({
        insideWindow: true,
        cornersOnTop: [true, true, true, true],
      });
      expect(
        await calendar.evaluate((element) => element.scrollHeight > element.clientHeight),
        `${field}: the calendar scrolls only in a window lower than itself`,
      ).toBe(size.scrolls ?? false);

      const next = calendar.getByRole("button", { name: "Nästa månad" });
      const previous = calendar.getByRole("button", { name: "Föregående månad" });
      expect(await onTop(next), `${field}: Nästa månad is reachable`).toBe(true);
      expect(await onTop(previous), `${field}: Föregående månad is reachable`).toBe(true);

      const month = calendar.locator("[aria-live]");
      const opened = (await month.textContent())!;
      const chevron = await next.boundingBox();

      if (size.scrolls) {
        // Scrolled to its last week, the calendar keeps its chevrons where
        // they were: their row is sticky and stands at the box's top edge.
        await calendar.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
        expect(await calendar.evaluate((element) => element.scrollTop), `${field}: the calendar scrolled`).toBeGreaterThan(8);
        expect(await next.boundingBox(), `${field}: Nästa månad stayed put while the calendar scrolled`).toEqual(chevron);
        expect(await onTop(next), `${field}: Nästa månad is reachable scrolled`).toBe(true);
        expect(
          await calendar.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return document.elementFromPoint(box.left + box.width / 2, box.top + 4)?.closest("table") ?? null;
          }),
          `${field}: no week shows above the chevrons`,
        ).toBeNull();
        await calendar.evaluate((element) => element.scrollTo({ top: 0 }));
      }

      // By pointer, forward and back again. The next month has another number
      // of weeks, and the chevron stays under the pointer regardless.
      await press(page, next);
      await expect(month).not.toHaveText(opened);
      expect(await next.boundingBox(), `${field}: Nästa månad did not move`).toEqual(chevron);
      const stepped = (await month.textContent())!;
      await press(page, previous);
      await expect(month).toHaveText(opened);

      // By keyboard. Stepping hands focus to the grid, and the chevrons sit
      // before it in the tab order: one Shift+Tab back is Nästa månad, two
      // is Föregående månad.
      await expect(calendar.getByRole("grid")).toContainText(/\d/);
      await page.keyboard.press("Shift+Tab");
      await expect(next).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(month).toHaveText(stepped);
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(previous).toBeFocused();
      await page.keyboard.press("Space");
      await expect(month).toHaveText(opened);

      expect(await visibility(calendar), `${field}: still whole after stepping`).toEqual({
        insideWindow: true,
        cornersOnTop: [true, true, true, true],
      });

      // Escape closes the calendar and leaves the half-filled form open.
      await page.keyboard.press("Escape");
      await expect(calendar).toBeHidden();
      await expect(dialog).toBeVisible();
      await expect(trigger).toBeFocused();
    }

    expect(misses, MISSES).toEqual([]);
  });
}

test("Lägg till lov: an open calendar follows its field when the window changes size", async ({ page, baseURL }) => {
  // From two columns to one and back with the calendar open: Sista dagen
  // moves from the right column to under Första dagen, and the calendar has
  // to be placed again each time, not left where the first window put it.
  const { dialog, misses } = await openBreakDialog(page, baseURL!, { width: 1280, height: 800 });
  await dialog.getByRole("textbox", { name: "Sista dagen" }).fill(addDays(YEAR.startDate, 60));
  await dialog.getByRole("button", { name: "Öppna kalender för Sista dagen" }).click();
  const calendar = page.getByRole("dialog", { name: "Välj datum" });
  await expect(calendar).toBeVisible();

  for (const size of [
    { width: 375, height: 812 },
    { width: 1024, height: 600 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(size);
    await expect
      .poll(() => visibility(calendar), { message: `${size.width}×${size.height}: whole after the resize` })
      .toEqual({ insideWindow: true, cornersOnTop: [true, true, true, true] });
    expect(await onTop(calendar.getByRole("button", { name: "Nästa månad" }))).toBe(true);
  }

  expect(misses, MISSES).toEqual([]);
});
