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
