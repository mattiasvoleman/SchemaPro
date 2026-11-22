import { describe, expect, it } from "vitest";
import { findPersonalData } from "@/lib/pseudonym-detect";
import { parseText } from "@/lib/pseudonym-input";
import { pseudonymise } from "@/lib/pseudonym-run";

/*
 * LESSON TIMES ARE NOT TELEPHONE NUMBERS (review of #377).
 *
 * A time range written 0800-0845 is two groups of four digits, eight digits that begin with 0: the length of a national number, and it was replaced
 * by TEL-n, so that the Tid column of a timetable in that form was gone and the structure with it.
 */

const kinds = (text: string): string[] => findPersonalData(text).map((found) => `${found.kind}:${text.slice(found.start, found.end)}`);

describe("a time range", () => {
  it.each(["0800-0845", "0800 0845", "0830-0915", "0800-1600", "0000-2359", "0800/0845", "1000-1045"])("%s is no telephone number", (range) => {
    expect(kinds(`Lektion ${range} sal 12`)).toEqual([]);
  });

  it("is kept in a column of times, which a run does not touch", () => {
    const input = parseText("Dag;Tid;Klass\nMån;0800-0845;7A\nMån;0850-0935;7B\n", "file", "UTF-8", false)!;
    const result = pseudonymise([input], { files: [{}] });
    if (!result.ok) throw new Error("undecided");
    expect(result.files[0]!.text).toBe("Dag;Tid;Klass\nMån;0800-0845;7A\nMån;0850-0935;7B\n");
  });

  it("does not take a telephone number for one: a number has nine or ten digits, or a time that no clock shows", () => {
    expect(kinds("0701234567").map((k) => k.split(":")[0])).toEqual(["tel"]);
    expect(kinds("08-123 456 78").map((k) => k.split(":")[0])).toEqual(["tel"]);
    expect(kinds("0800-123 456").map((k) => k.split(":")[0])).toEqual(["tel"]);
    expect(kinds("0123-4567").map((k) => k.split(":")[0])).toEqual(["tel"]);
  });
});
