import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";

/*
 * Manuset för skärmläsartestet (docs/skarmlasartest.md) lovar vad raden över Grundschemat säger. Raden är katalogens
 * `timetable.dragHint`, och när den ändras ska manuset ändras med den: den som följer manuset och hör en annan rad skriver annars upp en
 * avvikelse som är manusets, inte sidans.
 */
const manus = readFileSync(join(process.cwd(), "..", "docs", "skarmlasartest.md"), "utf8");
const hint = (sv as unknown as { timetable: { dragHint: string } }).timetable.dragHint;

describe("manuset för skärmläsartestet, Grundschema", () => {
  it("lovar inte det som raden över Grundschemat har slutat säga", () => {
    for (const promise of ["piltangenterna flyttar en lektion"]) {
      expect(hint, `raden säger inte längre "${promise}"`).not.toContain(promise);
      expect(manus, `manuset lovar "${promise}"`).not.toContain(promise);
    }
  });

  it("lovar det raden säger om pilarna och om Mellanslag", () => {
    for (const phrase of ["pilarna flyttar fokus mellan lektionerna", "Mellanslag tar upp en lektion"]) {
      expect(hint, `raden säger "${phrase}"`).toContain(phrase);
    }
    expect(manus).toContain("pilarna flyttar fokus mellan lektionerna");
    expect(manus).toContain("Mellanslag tar upp en lektion");
  });
});
