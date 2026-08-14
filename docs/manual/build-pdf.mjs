#!/usr/bin/env node
/**
 * Render the Swedish manuals to print-ready PDFs.
 *
 * Each manual is one HTML file sharing manual.css, injected at <!--STYLES-->
 * so the family stays visually identical from a single source of truth.
 *
 * Two passes, because a table of contents cannot know its own page numbers:
 *   1. render once, then read back which page each section heading landed on;
 *   2. inject those numbers into the placeholders and render again.
 * The cover is then printed separately without a footer and joined on, so it
 * carries no page number.
 *
 * Chromium comes from the web package's Playwright install, so no extra
 * browser download is needed.
 *
 * Usage:  node docs/manual/build-pdf.mjs [anvandarmanual|lararmanual]
 *         (no argument builds both)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "../../web/node_modules/playwright/index.mjs";

const DOCS = {
  anvandarmanual: { html: "anvandarmanual.html", pdf: "SchemaPro-Anvandarmanual.pdf",
                    footer: "SchemaPro — Användarmanual" },
  lararmanual:    { html: "lararmanual.html",    pdf: "SchemaPro-Lararmanual.pdf",
                    footer: "SchemaPro — Lärarmanual" },
  vardnadshavarmanual: { html: "vardnadshavarmanual.html",
                    pdf: "SchemaPro-For-vardnadshavare.pdf",
                    footer: "SchemaPro — För vårdnadshavare" },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const requested = process.argv[2];
const targets = requested ? [requested] : Object.keys(DOCS);
for (const name of targets) {
  if (!DOCS[name]) {
    console.error(`Unknown document "${name}". Known: ${Object.keys(DOCS).join(", ")}`);
    process.exit(2);
  }
}
const scratch = path.join(here, ".pass1.pdf");
const coverTmp = path.join(here, ".cover.pdf");
const bodyTmp = path.join(here, ".body.pdf");
const PYTHON = path.resolve(here, "..", "..", "optimization-engine", ".venv", "bin", "python3");


const footerFor = (label) => `
<div style="width:100%;font-family:Helvetica,Arial,sans-serif;font-size:7.5pt;
            color:#8a8a95;padding:0 18mm;display:flex;justify-content:space-between;">
  <span>${label}</span>
  <span class="pageNumber"></span>
</div>`;

/**
 * Anchors are derived from the document, not hand-maintained: every TOC entry
 * carries data-pg="<id>", and the element with that id is either a heading or
 * a section whose first heading names it. Its text is what to search the
 * rendered pages for. A renamed heading therefore cannot silently desync.
 */
function deriveAnchors(html) {
  const keys = [...html.matchAll(/data-pg="([^"]+)"/g)].map((m) => m[1]);
  const anchors = {};
  for (const key of keys) {
    const onHeading = html.match(
      new RegExp(`<h[23][^>]*\\bid="${key}"[^>]*>([\\s\\S]*?)</h[23]>`),
    );
    const inSection = onHeading
      ? null
      : html.match(
          new RegExp(`\\bid="${key}"[^>]*>[\\s\\S]*?<h2[^>]*>([\\s\\S]*?)</h2>`),
        );
    const raw = (onHeading ?? inSection)?.[1];
    if (raw) anchors[key] = raw.replace(/<[^>]+>/g, "").replace(/\\s+/g, " ").trim();
  }
  return anchors;
}

async function render(html, target, { footer = null, pageRanges = "" } = {}) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  await page.pdf({
    path: target,
    format: "A4",
    printBackground: true,
    pageRanges,
    displayHeaderFooter: Boolean(footer),
    headerTemplate: "<div></div>",
    footerTemplate: footer ?? "<div></div>",
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
function locate(pdfPath, ANCHORS) {
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
const css = readFileSync(path.join(here, "manual.css"), "utf8");

for (const name of targets) {
  const doc = DOCS[name];
  const output = path.resolve(here, "..", doc.pdf);
  const html = readFileSync(path.join(here, doc.html), "utf8")
    .replace("<!--STYLES-->", `<style>\n${css}\n</style>`);
  const anchors = deriveAnchors(html);
  const footer = footerFor(doc.footer);

  console.log(`\n${doc.html} → ${doc.pdf}`);
  console.log("  pass 1: measuring page positions…");
  await render(html, scratch, { footer });

  const pages = locate(scratch, anchors);
  const missing = Object.keys(anchors).filter((k) => !(k in pages));
  if (missing.length) {
    console.warn(`  warning: no page found for ${missing.join(", ")} — those TOC entries stay blank`);
  }
  console.log(`  located ${Object.keys(pages).length}/${Object.keys(anchors).length} sections`);

  const withNumbers = html.replace(
    /<span class="pg" data-pg="([^"]+)"><\/span>/g,
    (whole, key) => `<span class="pg" data-pg="${key}">${pages[key] ?? ""}</span>`,
  );

  console.log("  pass 2: rendering final PDF…");
  await render(withNumbers, coverTmp, { footer: null, pageRanges: "1" });
  await render(withNumbers, bodyTmp, { footer, pageRanges: "2-" });
  joinCoverAndBody(coverTmp, bodyTmp, output);
  for (const tmp of [scratch, coverTmp, bodyTmp]) unlinkSync(tmp);

  console.log(`  wrote ${path.relative(process.cwd(), output)}`);
}
