import { expect, test, type Page } from "@playwright/test";
import { scanBothSchemes, setScheme } from "./axe";
import { freezeClock, settle, signIn, watchStubMisses } from "./signed-in";

/**
 * Kolumnmappning (X2), in a browser: a table pasted into /admin/schedule-exchange is mapped in a dialog, and only the mapped
 * table reaches the gateway.
 *
 * What the components do, key by key, is column-mapping-dialog.test.tsx's and the page's, in jsdom. What only a browser can say
 * is asked here:
 *
 *   - the whole flow with a keyboard-reachable control for every column: paste, open the dialog, place the columns, use the
 *     table, and the request the page makes holds the mapped CSV (the reader's own headers, UTF-8) and nothing of a column that
 *     looks like a personnummer;
 *   - at 320 px, 375 px and 1280 px, in both themes, with a wide font: the dialog's content and the page do not scroll sideways
 *     and no line of the column list reaches past its box;
 *   - axe with the dialog open, in both themes.
 *
 * The stub answers the school's templates with none, and a preview of a table with how many rows it got.
 */

const PAGE = "/sv/admin/schedule-exchange";
const MISSES = "the backend stub could not answer these reads; each says which file to add it to or fix";
const VIEWPORTS = [
  { name: "320×700", width: 320, height: 700 },
  { name: "375×812", width: 375, height: 812 },
  { name: "1280×800", width: 1280, height: 800 },
];
const WIDE_FONT = "body, button, input, select, textarea { font-family: 'DejaVu Sans Mono', monospace !important }";

/** Invented headers: they claim nothing about any program. Anna is the first name of a made-up pupil, and the number is made up. */
const TABLE = ["Kurs\tFack\tPed\tRum\tDag\tTid\tPersonnr", "7A\tMatematik\tABC\tA1\tMån\t08:10-09:00\t19800101-1234", "7B\tSvenska\tDEF, GHI\tB2\tTis\t09:20-10:10\t19900202-4321"].join("\n");

async function openDialog(page: Page, baseURL: string, size = { width: 1280, height: 800 }) {
  await signIn(page.context(), "admin", baseURL);
  await freezeClock(page);
  await page.setViewportSize(size);
  const misses = watchStubMisses(page);
  await page.goto(PAGE);
  await settle(page);
  await page.getByLabel("Klistra in tabellen här").fill(TABLE);
  await page.getByRole("button", { name: "Läs in tabellen" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Fält för kolumnen Kurs" })).toBeVisible();
  return misses;
}

async function place(page: Page) {
  const choose = (column: string, field: string) => page.getByRole("combobox", { name: `Fält för kolumnen ${column}` }).selectOption(field);
  await choose("Kurs", "group");
  await choose("Fack", "subject");
  await choose("Ped", "teacherList");
  await choose("Rum", "room");
  await choose("Dag", "day");
  await choose("Tid", "timeRange");
}

test.describe("Kolumnmappning på Schema som fil", () => {
  test("maps a pasted table, drops the personnummer column in the browser and sends only the mapped table", async ({ page, baseURL }) => {
    const misses = await openDialog(page, baseURL!);
    const dialog = page.getByRole("dialog");
    // The column that looks like personnummer is named as dropped and has no control; its numbers are nowhere in the dialog
    // (the page behind it still holds what the user pasted, until the mapped table is taken).
    await expect(dialog.getByText("Ser ut som personnummer. Kolumnen läses inte in och lämnar inte webbläsaren.")).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: /Personnr/ })).toHaveCount(0);
    await expect(dialog).not.toContainText("19800101");
    // Until the required fields are placed, the table cannot be used.
    await expect(dialog.getByRole("button", { name: "Använd tabellen" })).toBeDisabled();
    await place(page);
    await expect(dialog.getByText("2 rader läses in.")).toBeVisible();
    await expect(dialog.getByText("1 kolumn som ser ut som personnummer släpptes. Ingenting av dem lämnar webbläsaren.")).toBeVisible();

    const request = page.waitForRequest((req) => req.url().includes("/api/v1/schedule-exchange/import/preview"));
    await dialog.getByRole("button", { name: "Använd tabellen" }).click();
    const sent = (await request).postDataJSON() as { format: string; files: { name: string; contentBase64: string }[] };
    expect(sent.format).toBe("TABLE_CSV");
    const csv = Buffer.from(sent.files[0]!.contentBase64, "base64").toString("utf8");
    expect(csv).toBe("Klass/grupp;Ämne;Sal;Dag;Start;Slut;Lärare;Medlärare\r\n7A;Matematik;A1;Mån;08:10;09:00;ABC;\r\n7B;Svenska;B2;Tis;09:20;10:10;DEF;GHI\r\n");
    expect(JSON.stringify(sent)).not.toMatch(/1980|1990|Personnr/);
    await expect(page.getByText("Tabellen Inklistrad tabell är läst: 2 rader. Förhandsvisningen står nedan.")).toBeVisible();
    // Taken: the pasted original, personnummer column and all, is gone from the page too.
    await expect(page.getByLabel("Klistra in tabellen här")).toHaveValue("");
    await expect(page.locator("body")).not.toContainText("19800101");
    expect(misses, MISSES).toEqual([]);
  });

  for (const viewport of VIEWPORTS) {
    for (const scheme of ["light", "dark"] as const) {
      test(`keeps the dialog inside its box at ${viewport.name} in ${scheme}, with a wide font`, async ({ page, baseURL }) => {
        const misses = await openDialog(page, baseURL!, viewport);
        await setScheme(page, scheme, true);
        await page.addStyleTag({ content: WIDE_FONT });
        await place(page);
        const dialog = page.getByRole("dialog");
        await expect(dialog.getByText("2 rader läses in.")).toBeVisible();
        const overflow = await page.evaluate(() => {
          const box = document.querySelector<HTMLElement>("[role=dialog]")!;
          const sideways = box.scrollWidth - box.clientWidth;
          // Every line of text in the dialog, by the rectangle of its characters, against the dialog's own edges.
          const edge = box.getBoundingClientRect();
          const past: string[] = [];
          const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of Array.from(range.getClientRects())) {
              if (rect.width > 0 && (rect.right > edge.right + 1 || rect.left < edge.left - 1) && !(node.parentElement?.closest(".overflow-x-auto, .overflow-auto, .overflow-y-auto"))) past.push(node.textContent.trim().slice(0, 40));
            }
          }
          return { sideways, past, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        });
        expect(overflow.sideways, "the dialog scrolls sideways").toBeLessThanOrEqual(1);
        expect(overflow.past, "text past the dialog's edge").toEqual([]);
        expect(overflow.page, "the page scrolls sideways").toBeLessThanOrEqual(0);
        expect(misses, MISSES).toEqual([]);
      });
    }
  }

  test("passes axe with the dialog open, in both themes", async ({ page, baseURL }) => {
    const misses = await openDialog(page, baseURL!);
    await place(page);
    await expect(page.getByRole("dialog").getByText("2 rader läses in.")).toBeVisible();
    const reports = await scanBothSchemes(page, PAGE, true);
    expect(reports, reports.join("\n")).toEqual([]);
    expect(misses, MISSES).toEqual([]);
  });

  test("is closed with Escape without writing or sending anything", async ({ page, baseURL }) => {
    const misses = await openDialog(page, baseURL!);
    let previewed = false;
    page.on("request", (req) => {
      if (req.url().includes("/import/preview")) previewed = true;
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await settle(page);
    expect(previewed).toBe(false);
    expect(misses, MISSES).toEqual([]);
  });
});
