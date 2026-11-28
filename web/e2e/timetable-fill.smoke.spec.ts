import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * Grundschemat, E7a "Lägg det som går": the button in the board's toolbar, the dialog, and the proposal drawn on the board.
 *
 * What the dialog says of an answer (the sentence, the reasons, the errors, the words on both languages) is fill-dialog.test.tsx's, in jsdom. What is
 * asked here is what only a browser can say:
 *
 *   - the button opens a dialog that does not cover the board, a proposal is drawn there as a dashed box with its name and time, and discarding takes it away;
 *   - "Ta in i schemat" sends the request the gateway takes (the basis the proposal was made on, and where each lesson goes) and closes the dialog;
 *   - the dialog with a proposal passes axe in both themes, and a phone with a wide font does not scroll sideways under it, with buttons a finger's size.
 *
 * The answers are the stub gateway's (e2e/stub/fixtures/gateway-board-fill.ts): the shape the real ones have, over the fixture school. An apply changes
 * nothing there; what the gateway chooses and judges is held to the real one by scripts/test/probe-lagg-det-som-gar.ts.
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: "light" | "dark") {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  const taken: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/board-fill/apply")) taken.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  return { misses, taken };
}

const fillButton = (page: Page) => page.getByRole("button", { name: "Lägg det som går", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "Lägg det som går" });

test("Lägg det som går: the button opens a dialog that leaves the board in view, a proposal is drawn on the board, and discarding takes it away", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await expect(dialog(page)).toHaveCount(0);
  await fillButton(page).click();
  await expect(dialog(page)).toBeVisible();
  // No overlay: the board behind is still there to be looked at.
  await expect(page.locator("main").getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  await expect(dialog(page).getByRole("option", { name: "7B (1 kvar)" })).toBeAttached();
  expect(await dialog(page).getByRole("radio", { name: "Hela skolan (2 kvar)" }).count()).toBe(1);

  await dialog(page).getByRole("button", { name: "Föreslå", exact: true }).click();
  await expect(dialog(page).getByText("Lade 1 av 1. Ingenting annat flyttades.")).toBeVisible();
  await expect(dialog(page).getByText(/Påfyllningen svarade, och den bevisar ingenting/)).toBeVisible();
  const box = page.locator("[data-fill-box]");
  await expect(box).toHaveCount(1);
  await expect(box).toContainText("Engelska 7B 09:00");
  expect(await page.locator("[data-fill-layer]").first().getAttribute("aria-hidden")).toBe("true");

  await dialog(page).getByRole("button", { name: "Kasta" }).click();
  await expect(box).toHaveCount(0);
  await expect(dialog(page).getByText(/Lade 1 av 1/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("Lägg det som går: Ta in sends the proposal's basis and where each lesson goes, and closes the dialog", async ({ page, baseURL }) => {
  const { misses, taken } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await fillButton(page).click();
  await dialog(page).getByRole("radio", { name: "Hela skolan (2 kvar)" }).check();
  await dialog(page).getByRole("button", { name: "Föreslå", exact: true }).click();
  await expect(dialog(page).getByText("Lade 1 av 2. Ingenting annat flyttades.")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Ta in i schemat" }).click();
  await expect.poll(() => taken.length).toBe(1);
  expect(taken[0]).toMatchObject({
    basis: "0123456789abcdef0123456789abcdef",
    items: [{ key: expect.stringMatching(/^00000000-0000-4000-8000-0000000000a1\|[0-9a-f-]{36}\|60\|1$/), dayOfWeek: 2, startTime: "09:00" }],
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.locator("[data-fill-box]")).toHaveCount(0);
  await expect(page.getByText(/^Lade 1 lektion\. En version sparades före/)).toBeVisible();
  expect(misses, MISSES).toEqual([]);
});

test("Lägg det som går: the dialog with a proposal passes axe in both themes, and a phone with a wide font does not scroll sideways under it", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await fillButton(page).click();
  await dialog(page).getByRole("button", { name: "Föreslå", exact: true }).click();
  await expect(dialog(page).getByText(/Lade 1 av 1/)).toBeVisible();
  const desk = await scanBothSchemes(page, "timetable-fill", true);
  expect(desk, desk.join("\n")).toEqual([]);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.addStyleTag({ content: WIDE_FONT });
  await expect(dialog(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), "the page scrolls sideways on a phone").toBe(false);
  const frame = await dialog(page).boundingBox();
  expect(frame!.x, "the dialog is cut at the left edge").toBeGreaterThanOrEqual(0);
  expect(frame!.x + frame!.width, "the dialog is cut at the right edge").toBeLessThanOrEqual(375);
  for (const name of ["Ta in i schemat", "Kasta"]) {
    const target = await dialog(page).getByRole("button", { name }).boundingBox();
    expect(target!.height, `${name} is a finger's size`).toBeGreaterThanOrEqual(44);
  }
  expect(misses, MISSES).toEqual([]);
});
