#!/usr/bin/env node
/**
 * Render anvandarmanual.html to a print-ready PDF.
 *
 * Two passes, because a table of contents cannot know its own page numbers:
 *   1. render once, then read back which page each section heading landed on;
 *   2. inject those numbers into the placeholders and render again.
 *
 * Chromium comes from the web package's Playwright install, so no extra
 * browser download is needed.
 *
 * Usage:  node docs/manual/build-pdf.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "anvandarmanual.html");
const output = path.resolve(here, "..", "SchemaPro-Anvandarmanual.pdf");
const scratch = path.join(here, ".pass1.pdf");
const coverTmp = path.join(here, ".cover.pdf");
const bodyTmp = path.join(here, ".body.pdf");
const PYTHON = path.resolve(here, "..", "..", "optimization-engine", ".venv", "bin", "python3");

// Section id -> a string that appears ONLY on that section's opening page.
const ANCHORS = {
  ch1: "Om den här manualen",
  ch2: "Systemet i korthet",
  s21: "Arbetets fyra faser",
  s22: "Roller och behörigheter",
  ch3: "Fas 1 — Kom igång",
  ch4: "Fas 2 — Planering",
  s41: "4.1Timplan",
  s42: "4.2Tillgänglighet",
  ch5: "Fas 3 — Schemaläggning",
  s51: "Skolregler och optimeringsprofil",
  s52: "Kör genereringen",
  s53: "Granska och justera grundschemat",
  s54: "5.4Versioner",
  s55: "Publicera till kalender",
  ch6: "Fas 4 — Daglig drift",
  ch7: "Integrationer",
  ch8: "Årscykel",
  ch9: "Felsökning",
  ch10: "Snabbreferens",
};

const FOOTER = `
<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7.5pt;
            color:#8a8a95;padding:0 18mm;display:flex;justify-content:space-between;">
  <span>SchemaPro — Användarmanual</span>
  <span class="pageNumber"></span>
</div>`;

async function render(html, target, { footer = true, pageRanges = "" } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({
    path: target,
    format: "A4",
    printBackground: true,
    pageRanges,
    displayHeaderFooter: footer,
    headerTemplate: "<div></div>",
    footerTemplate: footer ? FOOTER : "<div></div>",
    margin: { top: "20mm", right: "18mm", bottom: "16mm", left: "18mm" },
  });
  await browser.close();
}

/** Cover printed without a footer, body with one, then joined. */
function joinCoverAndBody(coverPath, bodyPath, target) {
  const script = `
import sys
from pypdf import PdfWriter
w = PdfWriter()
for path in sys.argv[1:-1]:
    w.append(path)
with open(sys.argv[-1], "wb") as fh:
    w.write(fh)
`;
  execFileSync(PYTHON, ["-c", script, coverPath, bodyPath, target], { encoding: "utf8" });
}

// Pages before the body: 1 = cover, 2 = table of contents. The TOC lists every
// heading verbatim, so a search that includes it matches page 2 for everything.
const FRONT_MATTER_PAGES = 2;

/** Page number (1-based) each anchor string first appears on, body only. */
function locate(pdfPath) {
  const script = `
import json, sys, pdfplumber
anchors = json.loads(sys.argv[2])
skip = int(sys.argv[3])
pages = []
with pdfplumber.open(sys.argv[1]) as pdf:
    for p in pdf.pages:
        pages.append((p.extract_text() or "").replace(" ", "").replace("\\n", ""))
out = {}
for key, needle in anchors.items():
    flat = needle.replace(" ", "")
    for i, text in enumerate(pages[skip:], start=skip + 1):
        if flat in text:
            out[key] = i
            break
print(json.dumps(out))
`;
  const raw = execFileSync(
    PYTHON,
    ["-c", script, pdfPath, JSON.stringify(ANCHORS), String(FRONT_MATTER_PAGES)],
    { encoding: "utf8" },
  );
  return JSON.parse(raw);
}

/**
 * pdfplumber (measuring) and pypdf (joining) are build-time only and are
 * deliberately NOT in optimization-engine/requirements.txt — they are not
 * solver dependencies and must not reach the production image. Fail with the
 * exact install command rather than a ModuleNotFoundError stack.
 */
function preflight() {
  try {
    execFileSync(PYTHON, ["-c", "import pdfplumber, pypdf"], { stdio: "pipe" });
  } catch {
    console.error(
      "Missing build dependencies. Install them into the engine venv with:\n\n" +
        `  ${path.relative(process.cwd(), PYTHON)} -m pip install pdfplumber pypdf\n\n` +
        "(Use `python3 -m pip`, not the venv's pip script — its shebang breaks\n" +
        "if the repository has ever been moved.)",
    );
    process.exit(1);
  }
}

preflight();
const html = readFileSync(source, "utf8");

console.log("pass 1: rendering to measure page positions…");
await render(html, scratch);

const pages = locate(scratch);
const missing = Object.keys(ANCHORS).filter((k) => !(k in pages));
if (missing.length) {
  console.warn(`  warning: no page found for ${missing.join(", ")} — their TOC entries stay blank`);
}
console.log(`  located ${Object.keys(pages).length}/${Object.keys(ANCHORS).length} sections`);

const withNumbers = html.replace(
  /<span class="pg" data-pg="([^"]+)"><\/span>/g,
  (whole, key) => `<span class="pg" data-pg="${key}">${pages[key] ?? ""}</span>`,
);

console.log("pass 2: rendering final PDF…");
await render(withNumbers, coverTmp, { footer: false, pageRanges: "1" });
await render(withNumbers, bodyTmp, { footer: true, pageRanges: "2-" });
joinCoverAndBody(coverTmp, bodyTmp, output);
for (const tmp of [scratch, coverTmp, bodyTmp]) unlinkSync(tmp);

console.log(`\nWrote ${path.relative(process.cwd(), output)}`);
