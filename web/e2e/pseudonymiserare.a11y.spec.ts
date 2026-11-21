import { expect, test, type Page } from "@playwright/test";
import { DESKTOP, PHONE, scanBothSchemes, setScheme } from "./axe";

/**
 * WCAG 2.1 AA on the pseudonymiser's page (Pseudonymiseraren, X1), as the tillgänglighetsredogörelse says it is checked: both languages, at desktop
 * and phone width, in the light and the dark theme, and not only on the empty page: with a file added and its columns waiting for a choice, and with a result
 * on the screen, where the tables and the notices are.
 */

const FILE = [
  "Lärare;Ämne;Klass;Notis",
  "Anna Svensson;Svenska;7A;Anna är sjuk, ring 070-123 45 67",
  "Bo Ek;Matte;7B;Se anna.svensson@skola.se",
  "Cia Lind;Engelska;8A;Prov på fredag",
].join("\n") + "\n";

type Stage = "empty" | "columns" | "result";

async function reach(page: Page, path: string, stage: Stage): Promise<void> {
  await page.goto(path);
  if (stage === "empty") return;
  await page.locator("#file-input").setInputFiles({ name: "lektioner.csv", mimeType: "text/csv", buffer: Buffer.from(FILE, "utf8") });
  await expect(page.getByRole("table").first()).toBeVisible();
  if (stage === "columns") return;
  await page.getByLabel(/^(Vad ska hända med kolumn 4\?|What should happen to column 4\?)$/).selectOption("keep");
  await page.getByRole("button", { name: /^(Ta bort personuppgifter|Remove personal data)$/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^(5\. Resultat|5\. Result)$/ })).toBeVisible();
}

const CASES: { path: string; stage: Stage; name: string }[] = [
  { path: "/sv/pseudonymisera", stage: "empty", name: "empty (sv)" },
  { path: "/en/pseudonymisera", stage: "empty", name: "empty (en)" },
  { path: "/sv/pseudonymisera", stage: "columns", name: "with a file and columns to choose (sv)" },
  { path: "/en/pseudonymisera", stage: "columns", name: "with a file and columns to choose (en)" },
  { path: "/sv/pseudonymisera", stage: "result", name: "with a result (sv)" },
  { path: "/en/pseudonymisera", stage: "result", name: "with a result (en)" },
];

for (const { path, stage, name } of CASES) {
  test(`${name} has no WCAG 2.1 AA violations`, async ({ page }) => {
    const reports: string[] = [];
    await page.setViewportSize(DESKTOP);
    await setScheme(page, "light", false);
    await reach(page, path, stage);
    await page.waitForLoadState("networkidle");
    reports.push(...(await scanBothSchemes(page, "desktop", true)));
    await page.setViewportSize(PHONE);
    await page.reload();
    await reach(page, path, stage);
    reports.push(...(await scanBothSchemes(page, "mobile", true)));
    expect(reports.join("\n"), "WCAG 2.1 AA violations").toBe("");
  });
}
