import { describe, expect, it } from "vitest";
import { formatDay, formatDayOf } from "./staffing-day";

describe("formatDay: a calendar day with no time of day", () => {
  it("is the ISO day in Swedish, as the Swedish pages write one", () => {
    expect(formatDay("2027-05-02", "sv")).toBe("2027-05-02");
    expect(formatDay("2027-12-31", "sv")).toBe("2027-12-31");
  });

  it("is the day written out in English", () => {
    expect(formatDay("2027-05-02", "en")).toBe("2 May 2027");
    expect(formatDay("2027-12-31", "en")).toBe("31 December 2027");
    expect(formatDay("2027-01-01", "en")).toBe("1 January 2027");
  });

  it("never moves the day, whatever time zone the machine runs in: a calendar day has none", () => {
    // The first and last day of a month are where a zone that is added to or taken from UTC shows.
    expect(formatDay("2027-03-01", "en")).toBe("1 March 2027");
    expect(formatDay("2027-02-28", "en")).toBe("28 February 2027");
    expect(formatDay("2027-03-01", "sv")).toBe("2027-03-01");
  });

  it("returns what it was given when it is not a day, rather than a date nobody wrote", () => {
    expect(formatDay("", "en")).toBe("");
    expect(formatDay("någon gång", "en")).toBe("någon gång");
    expect(formatDay("2027-13-45", "en")).toBe("2027-13-45");
    expect(formatDay("2027-02-30", "en")).toBe("2027-02-30");
  });
});

describe("formatDayOf: the day an instant falls on, in the school's own time zone", () => {
  it("is the school's day, not the UTC day, for an instant just before midnight UTC (00:30 Swedish time is the next day)", () => {
    // 2027-03-05 23:30 UTC is 2027-03-06 00:30 in Stockholm: the old `.slice(0, 10)` said the 5th.
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-03-06");
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "Europe/Stockholm", "en")).toBe("6 March 2027");
  });

  it("follows summer time: 22:30 UTC on the last of June is 00:30 on the first of July in Stockholm", () => {
    expect(formatDayOf("2027-06-30T22:30:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-07-01");
    expect(formatDayOf("2027-06-30T21:30:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-06-30");
    // And winter time, where the same instant is an hour earlier on the clock.
    expect(formatDayOf("2027-12-31T22:30:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-12-31");
    expect(formatDayOf("2027-12-31T23:00:00.000Z", "Europe/Stockholm", "sv")).toBe("2028-01-01");
  });

  it("is the school's zone and not the machine's: the same instant is another day in another zone", () => {
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "America/New_York", "sv")).toBe("2027-03-05");
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "Asia/Tokyo", "en")).toBe("6 March 2027");
  });

  it("is the day in the middle of the day, in either language", () => {
    expect(formatDayOf("2027-03-05T08:00:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-03-05");
    expect(formatDayOf("2027-03-05T08:00:00.000Z", "Europe/Stockholm", "en")).toBe("5 March 2027");
  });

  it("returns what it was given when it is not an instant, or the zone is not one", () => {
    expect(formatDayOf("", "Europe/Stockholm", "sv")).toBe("");
    expect(formatDayOf("igår", "Europe/Stockholm", "en")).toBe("igår");
    expect(formatDayOf("2027-03-05T08:00:00.000Z", "Not/AZone", "sv")).toBe("2027-03-05");
  });
});
