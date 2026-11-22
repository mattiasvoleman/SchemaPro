import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";

/*
 * P1 Pilotkit: the ORDER of the first-week checklist (3.7) is one a school with nothing in it can follow.
 *
 * Each step of the checklist is done by someone who has only what the steps before it made. Three things the checklist
 * asked for before they could be done, found by following it on a school made as docs/DEPLOYMENT.md §7 makes one (a
 * school row and an administrator, nothing else):
 *
 *   - Step 2 asked to choose "Timplan per årskurs" for the year. The school has no local timplan until step 7 makes
 *     one, and the dialog says so ("Skolan har ingen lokal timplan ännu"). A year follows a plan only when it is
 *     chosen for it (nothing attaches a plan to a year that already exists), so step 7 has to say to choose it, or
 *     "Skapa timplansposter" answers "Ingen årskurs följer planen".
 *   - Step 3 listed the subjects' room type before it said the room types come first, and a school made as §7 makes it
 *     has none: no migration, trigger or service writes the default list for a school (only the seeds do).
 */

const ROOT = join(__dirname, "..", "..");
const MANUAL = readFileSync(join(ROOT, "docs", "manual", "anvandarmanual.html"), "utf8");

const decode = (text: string): string => text.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const flat = (markup: string): string => decode(markup.replace(/<[^>]+>/g, " "));

/** One row of 3.7's table, by its step number. */
function stepRow(step: number): string {
  const start = MANUAL.indexOf('<h3 id="s37"');
  const end = MANUAL.indexOf('<h3 id="s38"');
  const section = MANUAL.slice(start, end);
  const row = new RegExp(`<tr><td class="k">${step}</td>[\\s\\S]*?</tr>`).exec(section);
  return row === null ? "" : flat(row[0]);
}

/** Every .ts file under a directory, as text, except the named one. */
function sourcesUnder(dir: string, except: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourcesUnder(path, except));
    else if (name.endsWith(".ts") && name !== except) found.push(readFileSync(path, "utf8"));
  }
  return found;
}

describe("the first-week checklist can be followed from an empty school", () => {
  it("does not ask, at the year step, for a plan the school cannot have yet", () => {
    // The app says there is none ...
    expect(sv.timplan.yearTimplans.noPlans).toContain("ingen lokal timplan");
    // ... and the year step is step 2, before any plan is made.
    expect(stepRow(2)).toContain("Läsår");
    expect(stepRow(2)).not.toContain("Timplan per årskurs");
  });

  it("says, where the plan is made, that the year follows it only when it is chosen", () => {
    // The app says it too: a plan nobody chose for the year creates nothing.
    expect(sv.timplan.generate.noGrades).toContain("Välj planen under Timplan per årskurs först");
    const planning = stepRow(7);
    expect(planning).toContain("Timplan (4.1)");
    expect(planning).toContain("Timplan per årskurs");
    expect(planning.indexOf("Timplan per årskurs")).toBeLessThan(planning.indexOf("Skapa timplansposter"));
  });

  it("puts the room types before the subjects, and says a new school has none", () => {
    // Nothing but the seeds writes the default room types for a school.
    const readers = sourcesUnder(join(ROOT, "src"), "default-room-types.ts").filter((text) => text.includes("default-room-types"));
    expect(readers).toEqual([]);
    const row = stepRow(3);
    expect(row).toContain("en ny skola har inga");
    expect(row.indexOf("Salstyperna först")).toBeGreaterThanOrEqual(0);
    expect(row.indexOf("Salstyperna först")).toBeLessThan(row.indexOf("Sedan ämnena"));
  });
});
