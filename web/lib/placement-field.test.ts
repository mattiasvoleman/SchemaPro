import { describe, expect, it } from "vitest";
import { minutesOfField } from "./placement-field";

/*
 * What the fields of a lesson to be laid read (review of #341, LÅG-7). The module had no test of its own: it was provided for by the lazy
 * fields' tests, which type a time through an <input type="time"> that gives HH:MM and nothing else, so a field read wider than it says
 * (the mutant `\d{1,2}:\d{1,2}` took "9:5" for 09:05) was never asked.
 */
describe("minutesOfField", () => {
  it("is the minutes since midnight of an HH:MM", () => {
    expect(minutesOfField("00:00")).toBe(0);
    expect(minutesOfField("08:05")).toBe(8 * 60 + 5);
    expect(minutesOfField("18:00")).toBe(18 * 60);
    expect(minutesOfField("23:59")).toBe(23 * 60 + 59);
  });

  it("reads an hour without its leading zero, as a typed field may give it", () => {
    expect(minutesOfField("9:30")).toBe(9 * 60 + 30);
  });

  it("is null for an empty field, which is no time yet", () => {
    expect(minutesOfField("")).toBeNull();
  });

  it("is null for minutes that are not two digits: 9:5 is not 09:05", () => {
    for (const value of ["9:5", "09:5", "09:", "9:555"]) expect(minutesOfField(value), value).toBeNull();
  });

  it("is null for anything that is not exactly an HH:MM: seconds, a space, a letter, a missing colon, a third hour digit", () => {
    for (const value of ["09:30:00", " 09:30", "09:30 ", "x09:30", "09:30x", "0930", ":30", "123:45", "ab:cd", "09.30", "09-30"]) {
      expect(minutesOfField(value), JSON.stringify(value)).toBeNull();
    }
  });
});
