import { describe, expect, it } from "vitest";
import {
  crossesARast,
  rastsFor,
  rastWindows,
  teacherRastBands,
  type Rast,
} from "./rasts";

// ---------------------------------------------------------------------------
// A school with the ordinary Swedish day: three rasts for the middle stage, and
// a Friday that differs in the morning only. That last row is the whole reason
// this module does not reuse the sittings' shadowing rule.
// ---------------------------------------------------------------------------

let seq = 0;
function rast(overrides: Partial<Rast> = {}): Rast {
  seq += 1;
  return {
    id: `r${seq}`,
    name: `Rast ${seq}`,
    minGradeLevel: 4,
    maxGradeLevel: 6,
    dayOfWeek: null,
    startTime: "09:40:00",
    endTime: "10:00:00",
    ...overrides,
  };
}

const SPAN_46 = { min: 4, max: 6 };

describe("rastsFor", () => {
  it("binds a stage whose years touch the span, not only one it contains", () => {
    // A 6-7 group has year-6 children in it. Containment would leave them
    // taught through their own stage's rast — the same test frames and servings
    // make, for the same reason.
    const morning = rast({ minGradeLevel: 4, maxGradeLevel: 6 });
    expect(rastsFor([morning], { min: 6, max: 7 }, 1)).toEqual([morning]);
  });

  it("leaves a stage the rast does not reach alone", () => {
    expect(rastsFor([rast({ minGradeLevel: 4, maxGradeLevel: 6 })], { min: 7, max: 9 }, 1))
      .toEqual([]);
  });

  it("applies every matching row, because several rasts a day is the norm", () => {
    const morning = rast({ startTime: "09:40:00", endTime: "10:00:00" });
    const afternoon = rast({ startTime: "13:00:00", endTime: "13:15:00" });
    expect(rastsFor([afternoon, morning], SPAN_46, 1).map((r) => r.id)).toEqual([
      morning.id,
      afternoon.id,
    ]);
  });

  it("lets a Friday row replace the every-day row it overlaps", () => {
    const morning = rast({ startTime: "09:40:00", endTime: "10:00:00" });
    const friday = rast({ dayOfWeek: 5, startTime: "09:30:00", endTime: "09:50:00" });

    expect(rastsFor([morning, friday], SPAN_46, 5).map((r) => r.id)).toEqual([friday.id]);
    expect(rastsFor([morning, friday], SPAN_46, 1).map((r) => r.id)).toEqual([morning.id]);
  });

  it("keeps both when the Friday row only ABUTS the every-day one", () => {
    /*
     * Half-open, like every other window comparison in this codebase: 09:20-
     * 09:40 does not overlap 09:40-10:00, so both stand and Friday reads as one
     * forty-minute break.
     *
     * A school writing that probably meant "on Friday the morning rast is
     * earlier", and this rule does not guess at that. The alternative —
     * shadowing rows that merely touch — guesses in the other direction and is
     * worse: a school adding a LATER Friday rast at 10:00-10:20 would silently
     * lose its 09:40 one. So the rule stays predictable and the admin page
     * prints the resulting Friday, where 09:20-10:00 is visible and a school
     * that meant something else can say so.
     */
    const morning = rast({ startTime: "09:40:00", endTime: "10:00:00" });
    const friday = rast({ dayOfWeek: 5, startTime: "09:20:00", endTime: "09:40:00" });

    expect(rastsFor([morning, friday], SPAN_46, 5).map((r) => r.id)).toEqual([
      friday.id,
      morning.id,
    ]);
    expect(rastWindows([morning, friday], SPAN_46, 5)).toEqual([
      { id: friday.id, name: friday.name, startMinutes: 560, endMinutes: 600 },
    ]);
  });

  it("KEEPS the Friday rasts the Friday row does not overlap", () => {
    /*
     * The case this module exists for, and the one the sittings' rule gets
     * wrong. servings.py replaces EVERY every-day row on a day that has a
     * day-specific one, which is safe where one sitting per stage is the norm.
     * Here a school with three rasts that adds "fredag 09:20-09:40" would lose
     * the other two every Friday — silently, and the engine would teach
     * straight through them while publish wrote a one-rast Friday to every
     * pupil in the stage.
     */
    const morning = rast({ startTime: "09:40:00", endTime: "10:00:00" });
    const midday = rast({ startTime: "11:30:00", endTime: "11:45:00" });
    const afternoon = rast({ startTime: "13:00:00", endTime: "13:15:00" });
    const friday = rast({ dayOfWeek: 5, startTime: "09:30:00", endTime: "09:50:00" });

    expect(rastsFor([morning, midday, afternoon, friday], SPAN_46, 5).map((r) => r.id))
      .toEqual([friday.id, midday.id, afternoon.id]);
  });

  it("says nothing about a group with no years", () => {
    // A teaching group whose members' classes carry no gradeLevel matches no
    // rast — the same answer frames, servings and the engine already give.
    expect(rastsFor([rast()], undefined, 1)).toEqual([]);
  });
});

describe("rastWindows", () => {
  it("merges two rows that touch into the one break a reader sees", () => {
    const first = rast({ startTime: "09:40:00", endTime: "10:00:00", name: "Förmiddag" });
    const second = rast({ startTime: "10:00:00", endTime: "10:10:00" });

    expect(rastWindows([first, second], SPAN_46, 1)).toEqual([
      { id: first.id, name: "Förmiddag", startMinutes: 580, endMinutes: 610 },
    ]);
  });

  it("keeps two rows that do not touch apart", () => {
    const morning = rast({ startTime: "09:40:00", endTime: "10:00:00" });
    const afternoon = rast({ startTime: "13:00:00", endTime: "13:15:00" });

    expect(rastWindows([morning, afternoon], SPAN_46, 1)).toHaveLength(2);
  });

  it("takes the wider end when one row swallows another", () => {
    const long = rast({ startTime: "09:40:00", endTime: "10:20:00" });
    const short = rast({ startTime: "09:50:00", endTime: "10:00:00" });

    expect(rastWindows([long, short], SPAN_46, 1)).toEqual([
      { id: long.id, name: long.name, startMinutes: 580, endMinutes: 620 },
    ]);
  });
});

describe("crossesARast", () => {
  const windows = rastWindows([rast({ startTime: "09:40:00", endTime: "10:00:00" })], SPAN_46, 1);

  it("finds a lesson laid across one", () => {
    expect(crossesARast(windows, 9 * 60 + 30, 10 * 60 + 30)?.startMinutes).toBe(580);
  });

  it("leaves a lesson that ends exactly when the rast begins", () => {
    // Half-open on both sides, the same rule every other clash in
    // lib/conflicts.ts uses. A rast that refused the lesson before it would
    // refuse the ordinary case it exists to create.
    expect(crossesARast(windows, 9 * 60, 9 * 60 + 40)).toBeNull();
    expect(crossesARast(windows, 10 * 60, 11 * 60)).toBeNull();
  });

  it("finds a lesson wholly inside one", () => {
    expect(crossesARast(windows, 9 * 60 + 45, 9 * 60 + 50)).not.toBeNull();
  });
});

describe("teacherRastBands", () => {
  const MONDAY = "2026-09-07";
  const published = (
    id: string,
    studentGroupId: string,
    name: string,
    start: string,
    end: string,
  ) => ({
    id,
    studentGroupId,
    name,
    date: MONDAY,
    startsAt: `${MONDAY}T${start}:00.000Z`,
    endsAt: `${MONDAY}T${end}:00.000Z`,
  });

  const toBand = (row: {
    id: string;
    studentGroupId: string;
    name: string;
    date: string;
    startsAt: string;
    endsAt: string;
  }) => ({
    id: row.id,
    dayOfWeek: 1,
    startMinutes: Number(row.startsAt.slice(11, 13)) * 60 + Number(row.startsAt.slice(14, 16)),
    endMinutes: Number(row.endsAt.slice(11, 13)) * 60 + Number(row.endsAt.slice(14, 16)),
    label: row.name,
  });

  const NAMES = new Map([
    ["g-41", "4.1"],
    ["g-42", "4.2"],
    ["g-81", "8.1"],
  ]);

  it("draws every window, not only the ones the stages agree on", () => {
    // The teacher who takes åk 4 in the morning and åk 8 in the afternoon. An
    // intersection would give them no band at all — and they are the person who
    // most needs to see two different breaks.
    const bands = teacherRastBands(
      [
        published("a", "g-41", "Förmiddagsrast", "09:40", "10:00"),
        published("b", "g-81", "Eftermiddagsrast", "13:00", "13:15"),
      ],
      NAMES,
      toBand,
    );

    expect(bands).toHaveLength(2);
  });

  it("merges classes that share a window into one band", () => {
    // Three classes of the same stage publish the same 09:40 rast. Three
    // identical stripes on one column would read as three breaks.
    const bands = teacherRastBands(
      [
        published("a", "g-41", "Förmiddagsrast", "09:40", "10:00"),
        published("b", "g-42", "Förmiddagsrast", "09:40", "10:00"),
      ],
      NAMES,
      toBand,
    );

    expect(bands).toHaveLength(1);
    expect(bands[0].label).toBe("Förmiddagsrast");
  });

  it("names the classes when one name covers two different windows", () => {
    // A bare "Förmiddagsrast" twice on one column says less than nothing.
    const bands = teacherRastBands(
      [
        published("a", "g-41", "Förmiddagsrast", "09:40", "10:00"),
        published("b", "g-81", "Förmiddagsrast", "10:00", "10:20"),
      ],
      NAMES,
      toBand,
    );

    expect(bands.map((b) => b.label).sort()).toEqual([
      "Förmiddagsrast · 4.1",
      "Förmiddagsrast · 8.1",
    ]);
  });

  it("says nothing when the teacher takes no class with a rast", () => {
    expect(teacherRastBands([], NAMES, toBand)).toEqual([]);
  });
});
