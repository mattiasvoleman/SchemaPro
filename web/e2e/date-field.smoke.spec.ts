import { expect, test, type Locator, type Page } from "@playwright/test";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

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
      const trigger = dialog.getByRole("button", { name: `Öppna kalender för ${field}` });
      await trigger.click();
      const calendar = page.getByRole("dialog", { name: "Välj datum" });
      await expect(calendar).toBeVisible();

      expect(await visibility(calendar), `${field}: the calendar is inside the window and nothing clips it`).toEqual({
        insideWindow: true,
        cornersOnTop: [true, true, true, true],
      });

      const next = calendar.getByRole("button", { name: "Nästa månad" });
      const previous = calendar.getByRole("button", { name: "Föregående månad" });
      expect(await onTop(next), `${field}: Nästa månad is reachable`).toBe(true);
      expect(await onTop(previous), `${field}: Föregående månad is reachable`).toBe(true);

      const month = calendar.locator("[aria-live]");
      const opened = (await month.textContent())!;
      const chevron = await next.boundingBox();

      // By pointer, forward and back again. The next month has another number
      // of weeks, and the chevron stays under the pointer regardless.
      await next.click({ timeout: 2_000 });
      await expect(month).not.toHaveText(opened);
      expect(await next.boundingBox(), `${field}: Nästa månad did not move`).toEqual(chevron);
      const stepped = (await month.textContent())!;
      await previous.click({ timeout: 2_000 });
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
