import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { KEEP } from "@/lib/pseudonym-headers";
import { parseText } from "@/lib/pseudonym-input";
import { pseudonymise } from "@/lib/pseudonym-run";

/*
 * THE SPELLINGS A TELEPHONE NUMBER AND AN ADDRESS ARE WRITTEN IN (review of #377).
 *
 * personal-number.ts folds no-break and narrow spaces, every dash and the full-width digits before it looks for a personnummer, so a personnummer
 * written that way is found. The telephone search worked on the text as it stood, and a number copied from a web page or a Word file stands with
 * U+00A0 or U+202F between its groups, an en dash for its hyphen: it was left in the safe file, and the check (the same search) found nothing.
 * The same for a number in full-width digits and an address with a full-width @.
 */

const NBSP = " ";
const NARROW = " ";
const fullWidth = (digits: string): string => digits.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
const kinds = (text: string): string[] => findPersonalData(text).map((finding) => `${finding.kind}:${text.slice(finding.start, finding.end)}`);

/** One run of a file whose one column is free text the user chose to keep: nothing but the search stands between the file and the safe copy. */
function keptText(cell: string): string {
  const input = parseText(`Klass;Övrigt\n7A;${cell}\n`, "file", "UTF-8", false)!;
  const result = pseudonymise([input], { files: [{ treatments: { 1: KEEP } }] });
  if (!result.ok) throw new Error("undecided");
  return result.files[0]!.text;
}

describe("a telephone number is found however its groups and hyphens were written", () => {
  it.each([
    ["+46 70 123 45 67 with no-break spaces", `+46${NBSP}70${NBSP}123${NBSP}45${NBSP}67`],
    ["08 123 456 78 with no-break spaces", `08${NBSP}123${NBSP}456${NBSP}78`],
    ["08-123 456 78 with narrow no-break spaces", `08-123${NARROW}456${NARROW}78`],
    ["070 with an en dash", "070–123 45 67"],
    ["070 with a non-breaking hyphen", "070‑123 45 67"],
    ["070 with a figure dash and a minus", "070‒123−45 67"],
    ["full-width digits", "０７０－１２３４５６７"],
    ["+46 in full-width digits", "＋46 70 123 45 67".replace("＋", "+").replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0))],
    ["a zero-width space inside", "070​-123 45 67"],
  ])("%s", (_name, number) => {
    const found = kinds(`Ring ${number} nu`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^tel:/);
    // The whole number, and not a part of it: nothing of it is left once the span is replaced.
    const finding = findPersonalData(`Ring ${number} nu`)[0]!;
    expect(`Ring ${number} nu`.slice(finding.start, finding.end)).toBe(number);
    // Not a digit of it is left once the marker and the class (7A) are taken out.
    expect(keptText(`Ring ${number} nu`).replace(/TEL-\d+/g, "").replace(/7A/, "").replace(/\D/g, "")).toBe("");
  });

  it("gives one number one key, however it was written", () => {
    const written = ["070-123 45 67", `070${NBSP}123${NBSP}45${NBSP}67`, "070–123 45 67", "+46 70 123 45 67", `+46${NBSP}70${NBSP}123${NBSP}45${NBSP}67`, "0046701234567", "０７０１２３４５６７"];
    const keys = new Set(written.map((number) => findPersonalData(`tel ${number}`)[0]?.key));
    expect([...keys]).toEqual(["0701234567"]);
  });

  it("still takes a full stop for no separator of a national number, and a date for no number", () => {
    expect(kinds("0.1234567")).toEqual([]);
    expect(kinds("07.08.2026")).toEqual([]);
    expect(kinds("2026–08–17")).toEqual([]);
  });
});

describe("an address is found with a full-width at sign", () => {
  it.each([["＠"], ["﹫"]])("anna%s skola.se", (at) => {
    const text = `Mejla anna.svensson${at}skola.se tack`;
    expect(kinds(text)).toHaveLength(1);
    expect(findPersonalData(text)[0]).toMatchObject({ kind: "epost", key: "anna.svensson@skola.se" });
    expect(keptText(`Mejla anna.svensson${at}skola.se tack`)).not.toContain("svensson");
  });
});

// ---------------------------------------------------------------------------
// A property: a generator that writes numbers the way a school's files have them
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)]!;
  return { int, pick };
}

describe("property: every spelling of a telephone number is found and leaves nothing (seed 9377)", () => {
  it("replaces a mobile, a Stockholm and an international number with any of the blanks and dashes a program writes", () => {
    const r = rng(9377);
    const SPACES = [" ", NBSP, NARROW, " ", " "] as const;
    const DASHES = ["-", "–", "‑", "−", " ", "/"] as const;
    for (let round = 0; round < 300; round += 1) {
      const digits = (n: number): string => Array.from({ length: n }, () => String(r.int(10))).join("");
      // A Luhn-valid or date-shaped bare number is the one case where two spellings may be two kinds: leave the area code to 073/076/079 and a month the shape cannot read.
      const mobile = `07${r.pick(["3", "6", "9"])}${digits(7)}`;
      const stockholm = `08${digits(7)}`;
      const group = (): string => r.pick(SPACES);
      const dash = (): string => r.pick(DASHES);
      const spelled = r.pick([
        () => `${mobile.slice(0, 3)}${dash()}${mobile.slice(3, 6)}${group()}${mobile.slice(6, 8)}${group()}${mobile.slice(8)}`,
        () => `+46${group()}${mobile.slice(1, 3)}${group()}${mobile.slice(3, 6)}${group()}${mobile.slice(6, 8)}${group()}${mobile.slice(8)}`,
        () => `${stockholm.slice(0, 2)}${dash()}${stockholm.slice(2, 5)}${group()}${stockholm.slice(5, 8)}${group()}${stockholm.slice(8)}`,
        () => `+46${group()}8${group()}${stockholm.slice(2, 5)}${group()}${stockholm.slice(5, 8)}${group()}${stockholm.slice(8)}`,
        () => fullWidth(`${mobile.slice(0, 3)}-${mobile.slice(3)}`),
        () => `0046${mobile.slice(1)}`,
      ])();
      const around = r.pick(["Ring %s nu", "tel: %s.", "%s", "Mamma %s, pappa 08-555 123 45"]);
      const cell = around.replace("%s", spelled);
      const safe = keptText(cell);
      // Not a digit of either number is left once the markers and the class (7A) are taken out.
      const left = safe.split("\n")[1]!.replace(/^7A;/, "").replace(/TEL-\d+/g, "").replace(/\D/g, "");
      expect(left, `round ${round}: ${JSON.stringify(cell)}`).toBe("");
      expect(findPersonalData(safe.replace(/TEL-\d{4}/g, " ")), `round ${round}: ${JSON.stringify(cell)}`).toEqual([]);
    }
  });
});
