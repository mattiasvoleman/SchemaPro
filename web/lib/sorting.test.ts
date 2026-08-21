import { describe, expect, it } from "vitest";
import { compareSwedish, sortByName } from "@/lib/sorting";

const order = (names: string[]) =>
  sortByName(
    names.map((name) => ({ name })),
    (item) => item.name,
  ).map((item) => item.name);

describe("compareSwedish", () => {
  it("puts å, ä and ö last, where the Swedish alphabet has them", () => {
    // The defect this exists for: the database returns them before B under a
    // C collation, and folded into A and O under en_US. Neither is Swedish.
    expect(order(["Övrigt", "Ämnesval", "Bild", "Slöjd", "Ångström"])).toEqual([
      "Bild",
      "Slöjd",
      "Ångström",
      "Ämnesval",
      "Övrigt",
    ]);
  });

  it("keeps å, ä and ö apart from each other", () => {
    expect(order(["Övrigt", "Ämne", "År"])).toEqual(["År", "Ämne", "Övrigt"]);
  });

  it("does not treat ö as a decorated o", () => {
    // "Öl" must not land next to "Ost": they are different letters.
    expect(compareSwedish("Öl", "Ost")).toBeGreaterThan(0);
  });

  it("orders numbers by value, not by digit", () => {
    // Course-style names are common: Matematik 1, 2, 3 … 10.
    expect(order(["Matematik 10", "Matematik 2", "Matematik 1"])).toEqual([
      "Matematik 1",
      "Matematik 2",
      "Matematik 10",
    ]);
  });

  it("keeps different casings of a name together", () => {
    const sorted = order(["bild", "Bild", "Astronomi"]);

    expect(sorted[0]).toBe("Astronomi");
    expect(sorted.slice(1).sort()).toEqual(["Bild", "bild"]);
  });

  it("sorts the plain latin letters the obvious way", () => {
    expect(order(["Teknik", "Bild", "Matematik"])).toEqual([
      "Bild",
      "Matematik",
      "Teknik",
    ]);
  });
});

describe("sortByName", () => {
  it("leaves the caller's array alone", () => {
    const input = [{ name: "Övrigt" }, { name: "Bild" }];
    const sorted = sortByName(input, (item) => item.name);

    expect(input.map((i) => i.name)).toEqual(["Övrigt", "Bild"]);
    expect(sorted.map((i) => i.name)).toEqual(["Bild", "Övrigt"]);
  });

  it("handles an empty list", () => {
    expect(sortByName([], (item: { name: string }) => item.name)).toEqual([]);
  });
});
