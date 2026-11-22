import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasValidCheckDigit, unrealPersonalNumber } from "@/lib/__fixtures__/skola24-read";
import { hasPersonalNumber } from "@/lib/personal-number";

/**
 * The fixtures and the tests of the Skola24 reader hold no personnummer that a person can have (a number with the right check digit may be
 * somebody's, whatever its year): every personnummer-shaped string in them fails the check digit.
 */
const DIR = join(__dirname, "__fixtures__", "skola24");
const SHAPE = /\b(?:\d{2}|\d{4})\d{4}-\d{4}\b/g;

describe("synthetic personnummer", () => {
  it("every one in a fixture has a wrong check digit", () => {
    const found = readdirSync(DIR)
      .filter((name) => name !== "README.md")
      .flatMap((name) => (readFileSync(join(DIR, name), "latin1").match(SHAPE) ?? []).map((value) => `${name} ${value}`));
    expect(found.length).toBeGreaterThan(10);
    expect(found.filter((entry) => hasValidCheckDigit(entry.split(" ")[1]!))).toEqual([]);
  });

  it("every one a test of the reader writes as a literal has a wrong check digit", () => {
    for (const name of ["skola24-format.test.ts", "skola24-formats.test.ts"]) {
      const text = readFileSync(join(__dirname, name), "utf8");
      const valid = (text.match(SHAPE) ?? []).filter((value) => hasValidCheckDigit(value));
      expect(valid, name).toEqual([]);
    }
  });

  it("the generated ones have the shape of one and a wrong check digit, whatever the counter", () => {
    for (let at = 0; at < 3000; at += 1) {
      const value = unrealPersonalNumber(at);
      expect(hasPersonalNumber(value), value).toBe(true);
      expect(hasValidCheckDigit(value), value).toBe(false);
    }
    expect(new Set(Array.from({ length: 200 }, (_, at) => unrealPersonalNumber(at))).size).toBe(200);
  });

  it("the check is the real one: a number with the right digit passes it", () => {
    // 811218-9876 is the example of a personnummer that Skatteverket and every textbook print.
    expect(hasValidCheckDigit("811218-9876")).toBe(true);
    expect(hasValidCheckDigit("811218-9877")).toBe(false);
  });
});
