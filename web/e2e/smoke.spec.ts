import { expect, test } from "@playwright/test";

test.describe("auth gating and locale routing", () => {
  test("unauthenticated visitors are redirected to the Swedish login page", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/sv\/login$/);
  });

  test("protected admin routes redirect to login", async ({ page }) => {
    await page.goto("/sv/admin");
    await expect(page).toHaveURL(/\/sv\/login$/);
  });

  test("login page renders in Swedish by default", async ({ page }) => {
    await page.goto("/sv/login");
    await expect(page.getByRole("button", { name: /logga in/i })).toBeVisible();
    await expect(page.getByLabel(/e-post/i)).toBeVisible();
  });

  test("login page renders in English under /en", async ({ page }) => {
    await page.goto("/en/login");
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });

  test("forgot-password flow is reachable from the login page", async ({ page }) => {
    await page.goto("/sv/login");
    await page.getByRole("link", { name: /glömt lösenord/i }).click();
    await expect(page).toHaveURL(/\/sv\/forgot-password$/);
  });

  test("login form validates before submitting", async ({ page }) => {
    await page.goto("/en/login");
    const submit = page.getByRole("button", { name: /sign in/i });
    // Empty form must not navigate away (HTML5 required fields).
    await submit.click();
    await expect(page).toHaveURL(/\/en\/login$/);
  });
});
