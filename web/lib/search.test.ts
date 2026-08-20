import { describe, expect, it } from "vitest";
import { filterByQuery, matchesQuery } from "@/lib/search";

describe("matchesQuery", () => {
  it("matches a substring, ignoring case", () => {
    expect(matchesQuery(["Alma Berg"], "berg")).toBe(true);
    expect(matchesQuery(["Alma Berg"], "BERG")).toBe(true);
  });

  it("requires every term, in any order and across fields", () => {
    const person = ["Alma Berg", "alma@skolan.se", "7A"];

    expect(matchesQuery(person, "alma 7a")).toBe(true);
    expect(matchesQuery(person, "7a alma")).toBe(true);
    expect(matchesQuery(person, "alma 8b")).toBe(false);
  });

  it("keeps å, ä and ö distinct from a and o", () => {
    // They are separate letters in Swedish. Folding them together would make
    // a search for "Ostberg" return Östberg — a different person.
    expect(matchesQuery(["Östberg"], "ostberg")).toBe(false);
    expect(matchesQuery(["Östberg"], "östberg")).toBe(true);
    expect(matchesQuery(["Sjöqvist"], "sjöq")).toBe(true);
  });

  it("treats an empty or whitespace query as no filter at all", () => {
    expect(matchesQuery(["anything"], "")).toBe(true);
    expect(matchesQuery(["anything"], "   ")).toBe(true);
  });

  it("ignores fields that are missing rather than crashing on them", () => {
    expect(matchesQuery(["Alma", null, undefined, ""], "alma")).toBe(true);
    expect(matchesQuery([null, undefined], "alma")).toBe(false);
  });

  it("does not let a field boundary create a false match", () => {
    // "berga" must not be found by gluing "Berg" and "Alma" together.
    expect(matchesQuery(["Berg", "Alma"], "berga")).toBe(false);
  });
});

describe("filterByQuery", () => {
  const people = [
    { name: "Alma Berg", email: "alma@skolan.se", group: "7A" },
    { name: "Nils Ek", email: "nils@skolan.se", group: "7B" },
    { name: "Åsa Öberg", email: "asa@skolan.se", group: "7A" },
  ];
  const fields = (p: (typeof people)[number]) => [p.name, p.email, p.group];

  it("returns the original list untouched for an empty query", () => {
    expect(filterByQuery(people, "  ", fields)).toBe(people);
  });

  it("filters on any of the searchable fields", () => {
    expect(filterByQuery(people, "nils@", fields).map((p) => p.name)).toEqual([
      "Nils Ek",
    ]);
    expect(filterByQuery(people, "7a", fields).map((p) => p.name)).toEqual([
      "Alma Berg",
      "Åsa Öberg",
    ]);
  });

  it("returns nothing when a term matches nobody", () => {
    expect(filterByQuery(people, "karin", fields)).toEqual([]);
  });
});
