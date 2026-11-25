import { afterEach, describe, expect, it } from "vitest";
import { formatDay, formatDayOf } from "./staffing-day";

/*
 * A calendar day has no time zone, and the school's day is the school's whatever zone the machine is in. The suite pins TZ=UTC (vitest.config.ts),
 * and in UTC a day built at LOCAL midnight, or written in the machine's zone, is the same day as one built and written in UTC: the tests of
 * staffing-day.test.ts say "whatever time zone the machine runs in" and cannot tell. These set the machine's zone for the call. In Stockholm
 * `new Date(2027, 4, 2)` is 22:00 UTC on the 1st; in Los Angeles a UTC midnight is the evening before.
 */
const was = process.env.TZ;
afterEach(() => {
  if (was === undefined) delete process.env.TZ;
  else process.env.TZ = was;
});

const MACHINES = ["Europe/Stockholm", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata", "UTC"];

describe.each(MACHINES)("a machine in %s", (zone) => {
  it("says a calendar day as the day it is, in both languages", () => {
    process.env.TZ = zone;
    expect(formatDay("2027-05-02", "en")).toBe("2 May 2027");
    expect(formatDay("2027-03-28", "en")).toBe("28 March 2027");
    expect(formatDay("2027-01-01", "en")).toBe("1 January 2027");
    expect(formatDay("2027-12-31", "en")).toBe("31 December 2027");
    expect(formatDay("2027-05-02", "sv")).toBe("2027-05-02");
    // Not a day, on any machine: February has no 30th.
    expect(formatDay("2027-02-30", "en")).toBe("2027-02-30");
  });

  it("says the school's day for an instant, and the machine's zone has no say in it", () => {
    process.env.TZ = zone;
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "Europe/Stockholm", "sv")).toBe("2027-03-06");
    expect(formatDayOf("2027-06-30T22:30:00.000Z", "Europe/Stockholm", "en")).toBe("1 July 2027");
    expect(formatDayOf("2027-03-05T23:30:00.000Z", "America/New_York", "sv")).toBe("2027-03-05");
  });
});
