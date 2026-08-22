import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIcs, downloadIcs, type IcsLesson } from "./ics";

// Reference dates: 2026-08-19 is a Wednesday, 2026-08-24 the following Monday.
const YEAR = { calendarName: "Timetable 26/27", yearStart: "2026-08-19", yearEnd: "2027-06-11" };

const lesson = (overrides: Partial<IcsLesson> = {}): IcsLesson => ({
  id: "les-1",
  dayOfWeek: 1,
  startTime: "08:15",
  endTime: "09:00",
  summary: "Mathematics",
  ...overrides,
});

const yyyymmdd = (date: Date) =>
  `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}` +
  `${String(date.getDate()).padStart(2, "0")}`;

/**
 * Expand the calendar the way a subscriber's client would.
 *
 * Covers only the FREQ=WEEKLY[;INTERVAL=n];UNTIL rules buildIcs writes, and
 * deliberately re-reads them off the emitted text rather than asking the
 * module anything — asserting the rule string alone would not notice a rule
 * that is well-formed and lands on the wrong dates.
 */
function expandRrules(ics: string): string[] {
  const dates: string[] = [];
  for (const event of ics.split("BEGIN:VEVENT").slice(1)) {
    const start = /DTSTART:(\d{4})(\d{2})(\d{2})T/.exec(event)!;
    const rule = /RRULE:FREQ=WEEKLY(?:;INTERVAL=(\d+))?;UNTIL=(\d{8})T/.exec(event)!;
    const stepDays = 7 * Number(rule[1] ?? "1");
    const date = new Date(Number(start[1]), Number(start[2]) - 1, Number(start[3]));
    while (yyyymmdd(date) <= rule[2]!) {
      dates.push(yyyymmdd(date));
      date.setDate(date.getDate() + stepDays);
    }
  }
  return dates.sort();
}

describe("buildIcs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:34:56Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("wraps events in a VCALENDAR envelope joined with CRLF", () => {
    const ics = buildIcs([lesson()], YEAR);
    const lines = ics.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[1]).toBe("VERSION:2.0");
    expect(lines[2]).toBe("PRODID:-//SchemaPro//Timetable//EN");
    expect(lines[3]).toBe("X-WR-CALNAME:Timetable 26/27");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
    // CRLF is the only line separator: no bare LF remains once CRLF is removed.
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("emits a weekly VEVENT starting on the first matching weekday of the year", () => {
    const lines = buildIcs([lesson()], YEAR).split("\r\n");
    // yearStart is a Wednesday, so a Monday lesson first occurs on 2026-08-24.
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("UID:les-1@schemapro");
    expect(lines).toContain("DTSTART:20260824T081500");
    expect(lines).toContain("DTEND:20260824T090000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270611T235959");
    expect(lines).toContain("SUMMARY:Mathematics");
    expect(lines).toContain("END:VEVENT");
  });

  it("starts on yearStart itself when the weekday matches", () => {
    const lines = buildIcs([lesson({ dayOfWeek: 3 })], YEAR).split("\r\n");
    expect(lines).toContain("DTSTART:20260819T081500");
  });

  it("maps ISO weekday 7 to Sunday", () => {
    const lines = buildIcs([lesson({ dayOfWeek: 7 })], YEAR).split("\r\n");
    // First Sunday on/after Wednesday 2026-08-19 is 2026-08-23.
    expect(lines).toContain("DTSTART:20260823T081500");
  });

  it("stamps DTSTAMP with the current instant in UTC", () => {
    const lines = buildIcs([lesson()], YEAR).split("\r\n");
    expect(lines).toContain("DTSTAMP:20260807T123456Z");
  });

  it("includes LOCATION and DESCRIPTION only when provided", () => {
    const withBoth = buildIcs(
      [lesson({ location: "Room 12", description: "Bring calculators" })],
      YEAR,
    ).split("\r\n");
    expect(withBoth).toContain("LOCATION:Room 12");
    expect(withBoth).toContain("DESCRIPTION:Bring calculators");

    const bare = buildIcs([lesson()], YEAR);
    expect(bare).not.toContain("LOCATION");
    expect(bare).not.toContain("DESCRIPTION");
  });

  it("escapes backslash, semicolon, comma and newline in text values", () => {
    const lines = buildIcs(
      [lesson({ summary: "a\\b;c,d\ne", location: "x\r\ny" })],
      YEAR,
    ).split("\r\n");
    // Backslashes are doubled first, then ; and , get backslash-escaped and
    // real newlines (LF or CRLF) become the literal two characters \n.
    expect(lines).toContain("SUMMARY:a\\\\b\\;c\\,d\\ne");
    expect(lines).toContain("LOCATION:x\\ny");
  });

  it("escapes the calendar name", () => {
    const lines = buildIcs([], {
      ...YEAR,
      calendarName: "Team A, Term 1; draft",
    }).split("\r\n");
    expect(lines).toContain("X-WR-CALNAME:Team A\\, Term 1\\; draft");
  });

  it("omits a lesson whose first occurrence falls after the year end", () => {
    const shortYear = { ...YEAR, yearStart: "2026-08-19", yearEnd: "2026-08-20" };
    const ics = buildIcs(
      [lesson({ id: "skipped", dayOfWeek: 1 }), lesson({ id: "kept", dayOfWeek: 4 })],
      shortYear,
    );
    // Monday lesson first occurs 2026-08-24, past the 2026-08-20 end: dropped.
    expect(ics).not.toContain("UID:skipped@schemapro");
    // Thursday lesson first occurs exactly on yearEnd and is kept.
    expect(ics).toContain("UID:kept@schemapro");
  });

  it("produces an empty calendar for an empty lesson list", () => {
    const lines = buildIcs([], YEAR).split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines).not.toContain("BEGIN:VEVENT");
  });

  it("treats an explicit ALL_WEEKS the same as no recurrence at all", () => {
    const lines = buildIcs([lesson({ recurrence: "ALL_WEEKS" })], YEAR).split("\r\n");
    expect(lines).toContain("DTSTART:20260824T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270611T235959");
  });

  it("emits INTERVAL=2 from the first odd ISO week for an odd-week lesson", () => {
    // Autumn term only, so the run is uninterrupted. Monday 2026-08-24 is ISO
    // week 35 — the first odd week of the year — and 2026-10-19 is week 43.
    const lines = buildIcs(
      [lesson({ recurrence: "ODD_WEEKS", endDate: "2026-10-31" })],
      YEAR,
    ).split("\r\n");
    expect(lines).toContain("DTSTART:20260824T081500");
    expect(lines).toContain("DTEND:20260824T090000");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261031T235959");
  });

  it("starts an even-week lesson one week after an odd-week one", () => {
    // Same slot, opposite parity: 2026-08-24 is week 35, 2026-08-31 is week 36.
    // Getting this backwards puts every single date on the wrong week.
    const lines = buildIcs(
      [lesson({ recurrence: "EVEN_WEEKS", endDate: "2026-10-31" })],
      YEAR,
    ).split("\r\n");
    expect(lines).toContain("DTSTART:20260831T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261031T235959");
  });

  it("respects a lesson's own start and end dates", () => {
    const lines = buildIcs(
      [lesson({ startDate: "2027-01-11", endDate: "2027-02-01" })],
      YEAR,
    ).split("\r\n");
    expect(lines).toContain("DTSTART:20270111T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270201T235959");
  });

  it("clamps a lesson period that reaches outside the academic year", () => {
    const lines = buildIcs(
      [lesson({ startDate: "2026-06-01", endDate: "2027-12-31" })],
      YEAR,
    ).split("\r\n");
    // The year still bounds both ends: first Monday on/after 2026-08-19, and
    // the year's own end, not the lesson's.
    expect(lines).toContain("DTSTART:20260824T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;UNTIL=20270611T235959");
  });

  it("drops a lesson whose period holds no week it actually runs", () => {
    // The only Monday in this period is 2026-08-31, ISO week 36 — even.
    const ics = buildIcs(
      [
        lesson({
          id: "never",
          recurrence: "ODD_WEEKS",
          startDate: "2026-08-25",
          endDate: "2026-09-04",
        }),
      ],
      YEAR,
    );
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  it("splits an alternating lesson across a 53-week ISO year", () => {
    // 2026 has 53 ISO weeks, so week 53 (2026-12-28) is followed directly by
    // week 1 (2027-01-04) — two odd weeks running. INTERVAL=2 cannot step over
    // that, so the spring term becomes a second series.
    const lines = buildIcs([lesson({ recurrence: "ODD_WEEKS" })], YEAR).split("\r\n");
    expect(lines.filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(lines).toContain("UID:les-1@schemapro");
    expect(lines).toContain("DTSTART:20260824T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261228T235959");
    expect(lines).toContain("UID:les-1-2@schemapro");
    expect(lines).toContain("DTSTART:20270104T081500");
    expect(lines).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20270611T235959");
  });

  it("expands to exactly the odd ISO weeks of the year", () => {
    expect(expandRrules(buildIcs([lesson({ recurrence: "ODD_WEEKS" })], YEAR))).toEqual([
      // Weeks 35..53 of 2026, then 1..23 of 2027.
      "20260824", "20260907", "20260921", "20261005", "20261019", "20261102",
      "20261116", "20261130", "20261214", "20261228", "20270104", "20270118",
      "20270201", "20270215", "20270301", "20270315", "20270329", "20270412",
      "20270426", "20270510", "20270524", "20270607",
    ]);
  });

  it("expands to exactly the even ISO weeks of the year", () => {
    // The even-week seam is three weeks wide, not one: weeks 53 and 1 are both
    // odd, so 2026-12-21 (week 52) is followed by 2027-01-11 (week 2).
    expect(expandRrules(buildIcs([lesson({ recurrence: "EVEN_WEEKS" })], YEAR))).toEqual([
      "20260831", "20260914", "20260928", "20261012", "20261026", "20261109",
      "20261123", "20261207", "20261221", "20270111", "20270125", "20270208",
      "20270222", "20270308", "20270322", "20270405", "20270419", "20270503",
      "20270517", "20270531",
    ]);
  });

  // SUSPECTED BUG (pinned, not fixed): RFC 5545 §3.1 requires content lines
  // longer than 75 octets to be folded (CRLF + space continuation). buildIcs
  // never folds, so a long summary is emitted as one over-long line, which
  // strict parsers may reject.
  it("currently does NOT fold content lines longer than 75 octets", () => {
    const longSummary = "Advanced Placement Mathematics ".repeat(5).trim(); // 154 chars
    const lines = buildIcs([lesson({ summary: longSummary })], YEAR).split("\r\n");
    const summaryLine = lines.find((line) => line.startsWith("SUMMARY:"));
    expect(summaryLine).toBe(`SUMMARY:${longSummary}`);
    expect(summaryLine!.length).toBeGreaterThan(75);
  });
});

describe("downloadIcs", () => {
  const createObjectURL = vi.fn((_source: Blob | MediaSource) => "blob:mock-url");
  const revokeObjectURL = vi.fn((_url: string) => {});
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const createdAnchors: HTMLAnchorElement[] = [];

  beforeEach(() => {
    // jsdom has no object-URL implementation; stub the pair on URL directly.
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    createdAnchors.length = 0;
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = realCreateElement(tag);
      if (tag === "a") createdAnchors.push(element as HTMLAnchorElement);
      return element;
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    vi.restoreAllMocks();
  });

  it("wraps the content in a text/calendar blob and clicks a download anchor", () => {
    downloadIcs("timetable.ics", "BEGIN:VCALENDAR\r\nEND:VCALENDAR");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]![0] as unknown as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("text/calendar;charset=utf-8");
    // ASCII content, so byte size equals string length.
    expect(blob.size).toBe("BEGIN:VCALENDAR\r\nEND:VCALENDAR".length);

    expect(createdAnchors).toHaveLength(1);
    const anchor = createdAnchors[0]!;
    expect(anchor.href).toBe("blob:mock-url");
    expect(anchor.download).toBe("timetable.ics");
    expect(anchor.click).toHaveBeenCalledTimes(1);
  });

  it("revokes the object URL after triggering the click", () => {
    downloadIcs("x.ics", "data");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
    const clickOrder = (
      HTMLAnchorElement.prototype.click as unknown as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0]!;
    const revokeOrder = revokeObjectURL.mock.invocationCallOrder[0]!;
    expect(revokeOrder).toBeGreaterThan(clickOrder);
  });
});

/** Expand an ICS RRULE the way a calendar client would, for comparison. */
function expand(ics: string): string[] {
  const out: string[] = [];
  for (const block of ics.split("BEGIN:VEVENT").slice(1)) {
    const start = /DTSTART:(\d{8})/.exec(block)![1]!;
    const rule = /RRULE:([^\r\n]+)/.exec(block)![1]!;
    const until = /UNTIL=(\d{8})/.exec(rule)![1]!;
    const stride = rule.includes("INTERVAL=2") ? 14 : 7;
    const toDate = (s: string) =>
      new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
    const day = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    for (let d = toDate(start); day(d) <= until; d = new Date(d.getTime() + stride * 86400000)) {
      out.push(day(d));
    }
  }
  return out.sort();
}

/** The server's rule, transcribed: ISO week number, Thursday rule. */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

function truthFor(recurrence: string, weekday: number, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00`); d <= new Date(`${to}T00:00:00`); d = new Date(d.getTime() + 86400000)) {
    if ((d.getDay() || 7) !== weekday) continue;
    const odd = isoWeekNumber(d) % 2 === 1;
    if (recurrence === "ALL_WEEKS" || (recurrence === "ODD_WEEKS" ? odd : !odd)) {
      out.push(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`);
    }
  }
  return out;
}

/**
 * The whole rule, checked against itself rather than against examples.
 *
 * A parent subscribes to this file once and then trusts it for a year. The two
 * ways it can lie are symmetrical and both silent: an event on a week the class
 * does not meet, and a missing event on a week it does. INTERVAL=2 counts
 * fourteen days from DTSTART while the parity we mean is the ISO week number,
 * and an ISO year with 53 weeks puts two odd weeks side by side — so the rule
 * has a seam in it, and a seam is not something example tests find reliably.
 *
 * This expands what the file actually says the way a calendar client would,
 * and compares every date against the server's own definition, over sixteen
 * school years.
 */
describe("a broad sweep of school years, parities and weekdays", () => {
  it("never emits a date the school does not run, and never misses one", () => {
    const mismatches: string[] = [];
    for (let year = 2020; year <= 2035; year++) {
      const yearStart = `${year}-08-17`;
      const yearEnd = `${year + 1}-06-11`;
      for (const recurrence of ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"] as const) {
        for (let weekday = 1; weekday <= 5; weekday++) {
          for (const [startDate, endDate] of [
            [null, null],
            [`${year}-10-05`, `${year + 1}-02-17`],
            [null, `${year}-12-23`],
          ] as const) {
            const ics = buildIcs(
              [{ id: "l", dayOfWeek: weekday, startTime: "08:00", endTime: "09:00",
                 summary: "S", recurrence, startDate, endDate } as never],
              { calendarName: "x", yearStart, yearEnd },
            );
            const from = startDate && startDate > yearStart ? startDate : yearStart;
            const to = endDate && endDate < yearEnd ? endDate : yearEnd;
            const emitted = expand(ics).join(",");
            const truth = truthFor(recurrence, weekday, from, to).join(",");
            if (emitted !== truth) {
              mismatches.push(`${year} ${recurrence} d${weekday} ${startDate ?? "-"}..${endDate ?? "-"}`);
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
