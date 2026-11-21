import { describe, expect, it } from "vitest";
import { KnownNames, runningWords } from "@/lib/pseudonym-names";

const spans = (names: KnownNames, text: string, running: boolean) => names.find(text, running).map((hit) => text.slice(hit.start, hit.end));

describe("known names found again in running text", () => {
  const names = new KnownNames();
  names.addCell("Anna Svensson", "namn");
  names.addCell("Lindström", "efternamn");

  it("finds a name from a column as a whole word, whatever its case, with the genitive -s", () => {
    expect(spans(names, "Anna ringde och SVENSSON svarade, Annas lektion", true)).toEqual(["Anna", "SVENSSON", "Annas"]);
  });

  it("does not find a name inside a longer word, or a different name that begins the same", () => {
    expect(spans(names, "Annabelle och Svenssons", true)).toEqual(["Svenssons"]);
    expect(spans(names, "Lind bor i Lindberg", true)).toEqual([]);
  });

  it("looks for a name from a column only in running text, and says which kind its marker is", () => {
    expect(spans(names, "Svensson", false)).toEqual([]);
    const [hit] = names.find("hej Lindström", true);
    expect(hit?.kind).toBe("efternamn");
    expect(hit?.key).toBe("lindström");
  });

  it("splits a hyphenated name at the hyphen, and keeps an apostrophe inside a word", () => {
    const more = new KnownNames();
    more.addCell("Anna-Lena D'Angelo", "namn");
    expect(spans(more, "Lena och Anna sa D'Angelo", true)).toEqual(["Lena", "Anna", "D'Angelo"]);
  });

  it("does not look for a name of fewer than three letters taken from a column", () => {
    const short = new KnownNames();
    short.addCell("Bo Ek", "namn");
    expect(short.size).toBe(0);
    expect(spans(short, "Bo och Ek", true)).toEqual([]);
  });
});

describe("the user's own words", () => {
  const names = new KnownNames();
  names.addLine("Bo Ek");
  names.addLine("Gunnar Åkesson");
  names.addLine("J");

  it("are looked for everywhere, in a cell of one word too, from two letters, and a single letter is no word", () => {
    expect(spans(names, "Bo", false)).toEqual(["Bo"]);
    expect(spans(names, "Ek bor hos Gunnar Åkesson, J", false)).toEqual(["Ek", "Gunnar", "Åkesson"]);
  });

  it("have the kind namn", () => {
    expect(names.find("Bo", false)[0]?.kind).toBe("namn");
  });
});

describe("nothing is looked for when nothing is known", () => {
  it("finds nothing and has no size", () => {
    const names = new KnownNames();
    expect(names.size).toBe(0);
    expect(names.find("Anna Svensson", true)).toEqual([]);
  });
});

describe("a cell of a hundred thousand markers and words", () => {
  it("is searched in seconds: every word looked through every marker took minutes (found in the review of #377)", () => {
    const names = new KnownNames();
    names.addCell("Anna Svensson", "namn");
    const text = Array.from({ length: 100_000 }, (_, i) => `NAMN-${String(i + 1).padStart(4, "0")} ordet Anna`).join(" ");
    const started = Date.now();
    const hits = names.find(text, true);
    expect(Date.now() - started).toBeLessThan(20_000);
    // The name in each "ordet Anna" is found, and the words a marker is made of are not.
    expect(hits).toHaveLength(100_000);
    expect(hits.every((hit) => text.slice(hit.start, hit.end) === "Anna")).toBe(true);
  }, 60_000);
});

describe("runningWords", () => {
  it.each([
    ["", 0],
    ["Hall", 1],
    ["Sal 12", 1],
    ["Anna ringde", 2],
    ["7A Svenska Anna", 2],
    ["Svenska Anna Svensson", 3],
    ["a b c", 0],
    ["Anna-Lena", 2],
  ])("%j has %i words of two letters or more", (text, n) => {
    expect(runningWords(text)).toBe(n);
  });
});
