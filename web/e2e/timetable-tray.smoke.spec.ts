import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";
import { MASTER_LESSONS } from "./stub/fixtures/world";

/**
 * Grundschemat, E4 "Att lägga": the tray's head in the board's toolbar, the panel under it, and a lay.
 *
 * What the panel is made of (the bricks, the words, the errors) is tray.test.tsx's, in jsdom. What is asked here is what only a browser can say:
 *
 *   - the head says how many lessons are laid and the button opens the panel under the toolbar, which lists the bricks in words;
 *   - a brick is laid from a possible time the gateway offers, with the room it ranks first, by keys and buttons alone, and the request is the one
 *     the gateway takes (the part, the picture it was read in, where and in which room);
 *   - the panel passes axe in both themes, and a phone with a wide font does not scroll sideways under it.
 *
 * The answers are the stub gateway's (e2e/stub/fixtures/gateway-board-tray.ts and gateway-possible-times.ts): the shape the real ones have, over the
 * fixture school. A lay changes nothing there; what the gateway counts and judges is held to the real one by scripts/test/probe-att-lagga.ts.
 */

const PAGE = "/sv/admin/timetable";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const WIDE_FONT = "body, button, input, select { font-family: 'DejaVu Sans Mono', monospace !important }";
const LESSONS = MASTER_LESSONS.length + 1;

async function open(page: Page, baseURL: string, size: { width: number; height: number }, scheme: "light" | "dark") {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  const misses = watchStubMisses(page);
  const laid: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/board-tray/lay")) laid.push(request.postDataJSON() as Record<string, unknown>);
  });
  await page.setViewportSize(size);
  await page.goto(PAGE);
  await settle(page);
  await setScheme(page, scheme, true);
  await expect(page.getByRole("heading", { level: 1, name: "Grundschema" })).toBeVisible();
  return { misses, laid };
}

const trayButton = (page: Page) => page.getByRole("button", { name: /^Att lägga/ });

test("Att lägga: the head says how many lessons are laid, the button opens the panel, and the panel lists the bricks in words", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await expect(page.getByText(`${LESSONS - 2} av ${LESSONS} lektioner lagda`)).toBeVisible();
  await expect(trayButton(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("region", { name: "Att lägga" })).toHaveCount(0);

  await trayButton(page).click();
  const panel = page.getByRole("region", { name: "Att lägga" });
  await expect(panel).toBeVisible();
  await expect(trayButton(page)).toHaveAttribute("aria-expanded", "true");
  const rows = panel.getByRole("list", { name: "2 brickor" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Bild 8A");
  await expect(rows.nth(0)).toContainText("På parkeringen");
  await expect(rows.nth(0)).toContainText("Saknar lärare");
  await expect(rows.nth(1)).toContainText("Engelska 7B");
  await expect(rows.nth(1)).toContainText("Anna Lind, 60 min, varje vecka");
  // The brick nobody teaches cannot be laid; the other can.
  await expect(panel.getByRole("button", { name: "Lägg Bild 8A" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Lägg Engelska 7B" })).toBeVisible();

  await panel.getByRole("button", { name: "Stäng Att lägga" }).click();
  await expect(panel).toHaveCount(0);
  expect(misses, MISSES).toEqual([]);
});

test("Att lägga: a brick is laid from a time the gateway offers, with the room it ranks first, and the request names the part and the picture it was read in", async ({ page, baseURL }) => {
  const { misses, laid } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await trayButton(page).click();
  const panel = page.getByRole("region", { name: "Att lägga" });
  await panel.getByRole("button", { name: "Lägg Engelska 7B" }).click();
  const form = panel.getByRole("form", { name: "Lägg Engelska 7B" });
  await expect(form).toBeVisible();

  const first = form.getByRole("button", { name: /^1\. / });
  await expect(first).toBeVisible();
  const chosen = /(\d\d:\d\d)–/.exec((await first.textContent())!)![1]!;
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(form.getByRole("textbox", { name: /Start/ })).toHaveValue(chosen);
  // The room the gateway ranks first is in the field before anybody has chosen one.
  await expect(form.getByRole("combobox", { name: "Sal" })).not.toHaveValue("");

  await form.getByRole("button", { name: "Lägg", exact: true }).click();
  await expect.poll(() => laid.length).toBe(1);
  expect(laid[0]).toMatchObject({ postId: "00000000-0000-4000-8000-0000000000a1", partKey: "0123456789abcdef", minutes: 60, startTime: chosen });
  expect(laid[0]!["roomId"]).toEqual(expect.any(String));
  await expect(page.getByText(/^Lagd och låst: Engelska 7B /)).toBeVisible();
  await expect(form).toHaveCount(0);
  // The focus is on the panel, not lost to the page.
  await expect(panel.getByRole("heading", { name: "Att lägga" })).toBeFocused();
  expect(misses, MISSES).toEqual([]);
});

test("Att lägga: the panel with a lay form open passes axe in both themes, and a phone with a wide font does not scroll sideways under it", async ({ page, baseURL }) => {
  const { misses } = await open(page, baseURL!, { width: 1280, height: 800 }, "light");
  await trayButton(page).click();
  const panel = page.getByRole("region", { name: "Att lägga" });
  await panel.getByRole("button", { name: "Lägg Engelska 7B" }).click();
  await expect(panel.getByRole("button", { name: /^1\. / })).toBeVisible();
  const desk = await scanBothSchemes(page, "timetable-tray", true);
  expect(desk, desk.join("\n")).toEqual([]);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.addStyleTag({ content: WIDE_FONT });
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), "the page scrolls sideways on a phone").toBe(false);
  const target = await panel.getByRole("button", { name: "Avbryt" }).boundingBox();
  expect(target!.height, "a button is a finger's size").toBeGreaterThanOrEqual(44);
  expect(misses, MISSES).toEqual([]);
});
