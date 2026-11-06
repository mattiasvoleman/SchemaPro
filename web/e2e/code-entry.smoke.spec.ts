import { expect, test } from "@playwright/test";
import { PUPIL_CODE } from "./stub/fixtures/gateway-public";
import { SCHOOL } from "./stub/fixtures/world";

/**
 * Where a code is typed (/v, Schemavisarens lägen), in a real browser against
 * the web server as CI runs it: the form is plain HTML and a GET, a code typed
 * any way a person types it opens the one link, and a typo is the viewer's one
 * not-found with a way back to the form. The gateway is the suite's stub
 * (e2e/stub/fixtures/gateway-public.ts), whose only code is a pupil's.
 */

test.describe("typing a code", () => {
  test("opens the pupil's week however the code is written, and leaves no code in the address bar's query", async ({ page }) => {
    for (const typed of [PUPIL_CODE, PUPIL_CODE.toLowerCase(), PUPIL_CODE.replace(/-/g, " ")]) {
      await page.goto("/v");
      await page.getByLabel("Kod").fill(typed);
      await page.getByRole("button", { name: "Öppna schemat" }).click();
      await expect(page).toHaveURL(new RegExp(`/v/${PUPIL_CODE}$`));
      // The title the school gave the code; no group named on any lesson.
      await expect(page.getByRole("heading", { level: 1, name: "Barn 1" })).toBeVisible();
      await expect(page.getByText(`${SCHOOL.name} · Elev`).first()).toBeVisible();
    }
  });

  test("answers what cannot be a code on the same page, in the language it was opened in, with the text kept to be mended", async ({ page }) => {
    await page.goto("/v?lang=en");
    await page.getByLabel("Code").fill("K7QM2-X9DRT");
    await page.getByRole("button", { name: "Open the timetable" }).click();
    await expect(page).toHaveURL(/\/v\?/);
    await expect(page.getByRole("alert").filter({ hasText: "The code does not look right" })).toBeVisible();
    await expect(page.getByLabel("Code")).toHaveValue("K7QM2-X9DRT");
  });

  test("lands a well-formed code that is no code of the school's on the one not-found page, which leads back to the form", async ({ page }) => {
    await page.goto("/v");
    await page.getByLabel("Kod").fill("AAAAA-AAAAA-AAAAA-AAAAA");
    await page.getByRole("button", { name: "Öppna schemat" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Schemat finns inte" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Logga in" })).toHaveAttribute("href", "/sv/login");
    await page.getByRole("link", { name: "Skriv in den här." }).click();
    await expect(page).toHaveURL(/\/v$/);
  });

  test("ships the page unframed, unindexed and without a cookie, as every viewer page", async ({ request }) => {
    const response = await request.get("/v");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(response.headers()["x-frame-options"]).toBe("DENY");
    expect(response.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    const pupil = await request.get(`/v/${PUPIL_CODE}`);
    expect(pupil.headers()["set-cookie"]).toBeUndefined();
    // A pupil is never framed: the gateway's embed door answers nothing for a code of one.
    const frame = await request.get(`/v/${PUPIL_CODE}/embed`);
    expect(frame.headers()["content-security-policy"]).toBe("frame-ancestors 'none'");
  });
});
