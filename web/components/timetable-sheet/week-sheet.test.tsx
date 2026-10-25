import { render, screen, within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";
import type { SheetDocument } from "@/lib/print-sheet";
import { lessonText, WeekSheet, type Translate } from "./week-sheet";

/**
 * One printed week, wherever it is drawn: the header says the school, what
 * the sheet is of, the week and the period it is valid for; the week says
 * every state in words, so grayscale paper loses nothing; and a note is
 * drawn only where the page asked for notes.
 */

const t = createTranslator({ locale: "sv", messages: sv, namespace: "publicViewer" }) as unknown as Translate;
const tDays = createTranslator({ locale: "sv", messages: sv, namespace: "days" }) as unknown as Translate;

const WEEK: SheetDocument = {
  kind: "GROUP",
  title: "7A",
  school: "Skolan i Exempelby",
  week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" },
  validity: [
    { from: "2026-08-17", to: "2026-10-13" },
    { from: "2026-10-14", to: "2027-06-11" },
  ],
  days: [
    {
      date: "2026-10-12",
      lessons: [
        { start: "08:00", end: "08:50", subject: "Matematik", groups: ["7A"], room: "Sal 12", teachers: ["ANLI"], cancelled: false },
        { start: "09:00", end: "09:50", subject: "Svenska", groups: ["7A", null], room: null, teachers: [], cancelled: true, note: "Vikarie" },
        { start: "10:00", end: "10:50", busy: true },
      ],
      meals: [{ start: "11:00", end: "11:30" }],
    },
    ...["13", "14", "15", "16", "17", "18"].map((day) => ({ date: `2026-10-${day}`, lessons: [] })),
  ],
};

describe("WeekSheet", () => {
  it("heads the sheet with the school, what it is of, the week and its validity", () => {
    render(<WeekSheet document={WEEK} locale="sv" t={t} tDays={tDays} variant="print" headingLevel={2} />);
    expect(screen.getByText("Skolan i Exempelby · Klass eller grupp")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "7A" })).toBeInTheDocument();
    expect(screen.getByText("Vecka 42 · 12 okt. – 18 okt.")).toBeInTheDocument();
    expect(
      screen.getByText("Giltig fr.o.m. 17 aug. 2026 t.o.m. 13 okt. 2026 · Giltig fr.o.m. 14 okt. 2026 t.o.m. 11 juni 2027"),
    ).toBeInTheDocument();
  });

  it("on paper draws the grid alone, the days one level under the sheet, and every state in words", () => {
    const { container } = render(<WeekSheet document={WEEK} locale="sv" t={t} tDays={tDays} variant="print" headingLevel={2} idPrefix="s0" />);
    // Monday to Friday once: no phone list on paper.
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual([
      "Måndag 12 okt.",
      "Tisdag 13 okt.",
      "Onsdag 14 okt.",
      "Torsdag 15 okt.",
      "Fredag 16 okt.",
    ]);
    const monday = container.querySelector('ol[aria-labelledby="s0-day-2026-10-12"]') as HTMLElement;
    expect(monday).not.toBeNull();
    expect(within(monday).getByText("· Inställd")).toBeInTheDocument();
    expect(within(monday).getByText("Svenska")).toHaveClass("line-through");
    expect(within(monday).getByText("Upptagen")).toBeInTheDocument();
    expect(screen.getByText("Lunch 11:00–11:30")).toBeInTheDocument();
  });

  it("prints a rastvaktspass as one line, its time, what it is, whose it is and where, and one somebody else has dashed", () => {
    const TEACHER_WEEK: SheetDocument = {
      kind: "TEACHER",
      title: "Anna Lind",
      school: "Skolan",
      week: WEEK.week,
      days: [
        {
          date: "2026-10-12",
          lessons: [
            { start: "08:10", end: "09:10", subject: "Svenska", groups: ["7A"], room: "Sal 101", teachers: [], cancelled: false },
            {
              start: "09:10",
              end: "09:25",
              subject: "Rastvakt",
              groups: ["Vikarie tar passet · Skolgården"],
              room: "Norra",
              teachers: [],
              cancelled: false,
              duty: true,
              relieved: true,
            },
            { start: "12:00", end: "12:15", subject: "Rastvakt", groups: ["Matsalen · Vikarie"], room: null, teachers: [], cancelled: false, duty: true },
          ],
        },
        ...["13", "14", "15", "16", "17", "18"].map((day) => ({ date: `2026-10-${day}`, lessons: [] })),
      ],
    };
    const { container } = render(<WeekSheet document={TEACHER_WEEK} locale="sv" t={t} tDays={tDays} variant="print" headingLevel={2} idPrefix="s1" />);
    const monday = container.querySelector('ol[aria-labelledby="s1-day-2026-10-12"]') as HTMLElement;
    const [, handed, cover] = [...monday.querySelectorAll("li")];
    // One line each: no block of its own height for a time alone.
    expect(handed!.textContent).toBe("09:10–09:25 Rastvakt · Vikarie tar passet · Skolgården · Norra");
    expect(handed!.className).toContain("whitespace-nowrap");
    expect(handed!.className).toContain("border-dashed");
    expect(cover!.textContent).toBe("12:00–12:15 Rastvakt · Matsalen · Vikarie");
    expect(cover!.className).not.toContain("border-dashed");
  });

  it("draws a note only where the page asked for notes: a document from the gateway carries none", () => {
    const { unmount } = render(<WeekSheet document={WEEK} locale="sv" t={t} tDays={tDays} variant="print" />);
    expect(screen.queryByText(/Vikarie/)).not.toBeInTheDocument();
    unmount();
    render(<WeekSheet document={{ ...WEEK, kind: "PUPIL", title: "Alva" }} locale="sv" t={t} tDays={tDays} variant="print" notes />);
    // A pupil's sheet is of no group: its lessons name theirs.
    expect(screen.getByText("7A, Grupp · Vikarie")).toBeInTheDocument();
  });

  it("as a page and in a frame offers the phone's list beside the grid, and keeps its actions off paper", () => {
    render(
      <WeekSheet document={WEEK} locale="sv" t={t} tDays={tDays} variant="embed" actions={<a href="#next">Nästa</a>} />,
    );
    expect(screen.getAllByText("Matematik")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "Nästa" }).parentElement).toHaveClass("print:hidden");
  });

  it("says nothing of validity it was not given, and says so when no publication covers the week", () => {
    const { unmount } = render(<WeekSheet document={{ ...WEEK, validity: undefined }} locale="sv" t={t} tDays={tDays} variant="print" />);
    expect(screen.queryByText(/Giltig|giltighet/)).not.toBeInTheDocument();
    unmount();
    render(<WeekSheet document={{ ...WEEK, validity: [] }} locale="sv" t={t} tDays={tDays} variant="print" />);
    expect(screen.getByText("Ingen publicering anger giltighet för veckan")).toBeInTheDocument();
  });
});

describe("lessonText", () => {
  it("leaves out what the sheet is of", () => {
    const lesson = { start: "08:00", end: "09:00", subject: "Ma", groups: ["7A", "8B"], room: "Sal 1", teachers: ["ANLI", "BERO"] };
    expect(lessonText(lesson, t, { kind: "GROUP", title: "7A" }).detail).toBe("Sal 1 · ANLI, BERO · 8B");
    expect(lessonText(lesson, t, { kind: "ROOM", title: "Sal 1" }).detail).toBe("7A, 8B · ANLI, BERO");
    expect(lessonText(lesson, t, { kind: "TEACHER", title: "ANLI" }).detail).toBe("7A, 8B · Sal 1 · BERO");
  });
});
