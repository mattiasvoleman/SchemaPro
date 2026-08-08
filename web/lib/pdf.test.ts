import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportTimetablePdf, type PdfLesson } from "./pdf";

// jspdf and jspdf-autotable are imported dynamically inside exportTimetablePdf;
// vi.mock intercepts those dynamic imports through the module registry.
const { state, autoTableMock, FakeJsPdf } = vi.hoisted(() => {
  interface AutoTableOptions {
    startY: number;
    head: string[][];
    body: string[][];
  }
  class FakeJsPdf {
    text = vi.fn();
    setFontSize = vi.fn();
    setTextColor = vi.fn();
    addPage = vi.fn();
    save = vi.fn();
    lastAutoTable?: { finalY: number };
    constructor() {
      state.instances.push(this);
    }
  }
  const state = {
    instances: [] as InstanceType<typeof FakeJsPdf>[],
    // Height the fake table adds below its startY; tests override to force
    // the page-break branch.
    tableHeight: 20,
  };
  const autoTableMock = vi.fn((doc: FakeJsPdf, options: AutoTableOptions) => {
    doc.lastAutoTable = { finalY: options.startY + state.tableHeight };
  });
  return { state, autoTableMock, FakeJsPdf };
});

vi.mock("jspdf", () => ({ jsPDF: FakeJsPdf }));
vi.mock("jspdf-autotable", () => ({ default: autoTableMock }));

const COLUMN_LABELS = {
  time: "Time",
  subject: "Subject",
  group: "Group",
  teacher: "Teacher",
  room: "Room",
};
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const lesson = (overrides: Partial<PdfLesson> = {}): PdfLesson => ({
  dayOfWeek: 1,
  startTime: "08:15",
  endTime: "09:00",
  subject: "Math",
  group: "9A",
  teacher: "Ada",
  room: "R12",
  ...overrides,
});

const doc = () => state.instances[0]!;

describe("exportTimetablePdf", () => {
  beforeEach(() => {
    state.instances.length = 0;
    state.tableHeight = 20;
    autoTableMock.mockClear();
  });

  it("renders the title and saves under the default filename", async () => {
    await exportTimetablePdf({
      title: "Weekly timetable",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [lesson()],
    });

    expect(doc().text).toHaveBeenCalledWith("Weekly timetable", 14, 16);
    expect(doc().setFontSize).toHaveBeenNthCalledWith(1, 16);
    expect(doc().save).toHaveBeenCalledWith("timetable.pdf");
  });

  it("uses the provided filename when given", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [],
      filename: "week-33.pdf",
    });
    expect(doc().save).toHaveBeenCalledWith("week-33.pdf");
  });

  it("renders the subtitle muted and pushes the first table down", async () => {
    await exportTimetablePdf({
      title: "T",
      subtitle: "Week 33",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [lesson()],
    });

    expect(doc().text).toHaveBeenCalledWith("Week 33", 14, 22);
    expect(doc().setTextColor).toHaveBeenNthCalledWith(1, 120);
    expect(doc().setTextColor).toHaveBeenNthCalledWith(2, 0);
    // cursorY starts at 30 with a subtitle: day header at 30, table at 32.
    expect(doc().text).toHaveBeenCalledWith("Mon", 14, 30);
    expect(autoTableMock.mock.calls[0]![1]).toMatchObject({ startY: 32 });
  });

  it("without a subtitle the first day starts at y=24", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [lesson()],
    });
    expect(doc().text).toHaveBeenCalledWith("Mon", 14, 24);
    expect(autoTableMock.mock.calls[0]![1]).toMatchObject({ startY: 26 });
  });

  it("emits one table per day that has lessons, skipping empty days", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [lesson({ dayOfWeek: 2 }), lesson({ dayOfWeek: 4 })],
    });

    expect(autoTableMock).toHaveBeenCalledTimes(2);
    const textCalls = doc().text.mock.calls.map((call) => call[0]);
    expect(textCalls).toEqual(["T", "Tue", "Thu"]);
  });

  it("sorts a day's rows by start time and joins times with an en dash", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [
        lesson({ startTime: "13:00", endTime: "13:45", subject: "PE" }),
        lesson({ startTime: "08:15", endTime: "09:00", subject: "Math" }),
      ],
    });

    const options = autoTableMock.mock.calls[0]![1];
    expect(options.head).toEqual([["Time", "Subject", "Group", "Teacher", "Room"]]);
    expect(options.body).toEqual([
      ["08:15–09:00", "Math", "9A", "Ada", "R12"],
      ["13:00–13:45", "PE", "9A", "Ada", "R12"],
    ]);
  });

  it("adds a page and resets the cursor when a day would start below y=250", async () => {
    // First table ends at 26 + 230 = 256, so cursorY becomes 266 (> 250) and
    // the second day must go on a fresh page starting at y=16.
    state.tableHeight = 230;
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [lesson({ dayOfWeek: 1 }), lesson({ dayOfWeek: 2 })],
    });

    expect(doc().addPage).toHaveBeenCalledTimes(1);
    expect(doc().text).toHaveBeenCalledWith("Tue", 14, 16);
    expect(autoTableMock.mock.calls[1]![1]).toMatchObject({ startY: 18 });
  });

  it("falls back to the numeric weekday when dayNames is too short", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: ["Mon"],
      columnLabels: COLUMN_LABELS,
      lessons: [lesson({ dayOfWeek: 7 })],
    });
    expect(doc().text).toHaveBeenCalledWith("7", 14, 24);
  });

  it("renders no tables but still saves for an empty lesson list", async () => {
    await exportTimetablePdf({
      title: "T",
      dayNames: DAY_NAMES,
      columnLabels: COLUMN_LABELS,
      lessons: [],
    });
    expect(autoTableMock).not.toHaveBeenCalled();
    expect(doc().addPage).not.toHaveBeenCalled();
    expect(doc().save).toHaveBeenCalledWith("timetable.pdf");
  });
});
