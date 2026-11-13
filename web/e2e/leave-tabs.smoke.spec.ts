import { expect, test, type Page } from "@playwright/test";
import { freezeClock, settle, signIn } from "./signed-in";
import { STUB_ORIGIN } from "./stub/sessions";

/**
 * Ledighetsansökningar: the row of tabs, and the bell's link to one of them.
 *
 * jsdom lays nothing out and has no router, so what is asked here is what only
 * a browser can say: four tabs are wider than a phone, and the row scrolls
 * where the page used to (from its first tab, not from its middle), and a link
 * to a tab, followed while the page is open, moves the tab, also a second time
 * after the tab was changed by hand. The page's own tests say what each tab
 * asks the inbox for.
 */

const LEAVE = "/sv/admin/leave";
const WIDTHS = [320, 375, 1280];

/** The bell has one notice, a guardian's no, whose link is the tab of the requests that ended. */
async function aGuardianSaidNo(page: Page) {
  await page.route(`${STUB_ORIGIN}/rest/v1/Notifications**`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-0000000000d1",
          type: "LEAVE_CONSENT_REFUSED",
          meta: { leaveRequestId: "x", studentName: "Ada Berg", startDate: "2027-03-01", endDate: "2027-03-05" },
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
  });
}

async function signedIn(page: Page, baseURL: string, width: number) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await page.setViewportSize({ width, height: 800 });
}

for (const width of WIDTHS) {
  test(`the tabs of the leave requests at ${width} px: the row scrolls and the page does not`, async ({ page, baseURL }) => {
    await signedIn(page, baseURL!, width);
    await page.goto(`${LEAVE}?filter=GUARDIAN_DECLINED`);
    await settle(page);

    const list = page.getByRole("tablist", { name: "Visa ansökningar" });
    await expect(list.getByRole("tab", { name: "Avslutade av vårdnadshavare", selected: true })).toBeVisible();

    const facts = await list.evaluate((element) => {
      const tabs = [...element.querySelectorAll("[role=tab]")].map((tab) => tab.getBoundingClientRect());
      const box = element.getBoundingClientRect();
      return {
        pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
        listRight: box.right,
        listLeft: box.left,
        scrollLeft: element.scrollLeft,
        firstLeft: tabs[0]!.left,
        viewport: window.innerWidth,
      };
    });
    expect(facts.pageScrollsSideways, "the page does not scroll sideways").toBe(false);
    expect(facts.listRight, "the row ends inside the screen").toBeLessThanOrEqual(facts.viewport + 0.5);
    expect(facts.scrollLeft, "the row starts at its first tab").toBe(0);
    expect(facts.firstLeft, "the first tab is not cut off at the left").toBeGreaterThanOrEqual(facts.listLeft - 0.5);

    // The last tab is reachable: scrolled to, it stands inside the row and the screen.
    const last = list.getByRole("tab", { name: "Avslutade av vårdnadshavare" });
    await last.scrollIntoViewIfNeeded();
    const box = await last.evaluate((tab) => {
      const { left, right } = tab.getBoundingClientRect();
      const row = tab.parentElement!.getBoundingClientRect();
      return { left, right, rowLeft: row.left, rowRight: row.right, viewport: window.innerWidth };
    });
    expect(box.right, "the last tab ends inside the row").toBeLessThanOrEqual(box.rowRight + 0.5);
    expect(box.left, "and starts inside it").toBeGreaterThanOrEqual(box.rowLeft - 0.5);
    expect(box.right, "and inside the screen").toBeLessThanOrEqual(box.viewport + 0.5);

    // A tab pressed is written to the address, and the first tab (Väntar) takes the query away.
    await list.getByRole("tab", { name: "Avslagen" }).click();
    await expect.poll(() => page.evaluate(() => window.location.search)).toBe("?filter=REJECTED");
    await list.getByRole("tab", { name: "Väntar" }).click();
    await expect.poll(() => page.evaluate(() => window.location.search)).toBe("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  });
}

test("the bell's link to the ended requests moves the tab while the page is open, and again after the tab was changed by hand", async ({
  page,
  baseURL,
}) => {
  await signedIn(page, baseURL!, 1280);
  await aGuardianSaidNo(page);
  await page.goto(LEAVE);
  await settle(page);
  const list = page.getByRole("tablist", { name: "Visa ansökningar" });
  await expect(list.getByRole("tab", { name: "Väntar", selected: true })).toBeVisible();

  const followTheNotice = async () => {
    await page.getByRole("button", { name: /Notiser|Aviseringar|notis/i }).first().click();
    await page.getByText(/har avslutats/).click();
    await expect(list.getByRole("tab", { name: "Avslutade av vårdnadshavare", selected: true })).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/leave\?filter=GUARDIAN_DECLINED$/);
  };

  // Standing on the page: nothing mounts again, and the tab moves.
  await followTheNotice();
  // The tab changed by hand, then the same link again.
  await list.getByRole("tab", { name: "Väntar" }).click();
  await expect(list.getByRole("tab", { name: "Väntar", selected: true })).toBeVisible();
  await followTheNotice();
});
