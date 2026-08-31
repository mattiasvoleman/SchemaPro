import { describe, expect, it } from "vitest";
import { breaksFrame, frameWindow, type FrameTime } from "@/lib/frame-times";

const frame = (
  min: number,
  max: number,
  start: string,
  end: string,
  dayOfWeek: number | null = null,
): FrameTime => ({
  id: `f-${min}-${max}-${dayOfWeek ?? "all"}-${start}`,
  minGradeLevel: min,
  maxGradeLevel: max,
  dayOfWeek,
  startTime: `${start}:00`,
  endTime: `${end}:00`,
});

const at = (clock: string): number => {
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
};

const span = (min: number, max: number) => ({ min, max });

// ---------------------------------------------------------------------------
// frameWindow
// ---------------------------------------------------------------------------

describe("frameWindow", () => {
  it("leaves the whole day open when no frames exist", () => {
    expect(frameWindow([], span(4, 4), 1)).toEqual({
      startMinutes: 0,
      endMinutes: 24 * 60,
    });
  });

  it("ignores a frame written for another stage", () => {
    expect(frameWindow([frame(7, 9, "08:00", "16:00")], span(4, 4), 1)).toEqual({
      startMinutes: 0,
      endMinutes: 24 * 60,
    });
  });

  it("leaves the day open for a group whose years are unknown", () => {
    /*
     * Overlap has no answer against nothing, and answering yes would sweep
     * every group with no member years into a frame meant for one stage — the
     * ordinary state of a school that has not entered its pupils yet.
     */
    expect(frameWindow([frame(0, 12, "08:00", "12:00")], undefined, 1)).toEqual({
      startMinutes: 0,
      endMinutes: 24 * 60,
    });
  });

  it("applies an every-day frame to every weekday", () => {
    const frames = [frame(4, 6, "08:00", "15:00")];
    for (const day of [1, 2, 3, 4, 5]) {
      expect(frameWindow(frames, span(4, 4), day)).toEqual({
        startMinutes: at("08:00"),
        endMinutes: at("15:00"),
      });
    }
  });

  it("applies a weekday frame to that weekday only", () => {
    const frames = [frame(4, 6, "08:00", "13:00", 5)];

    expect(frameWindow(frames, span(4, 4), 5)?.endMinutes).toBe(at("13:00"));
    expect(frameWindow(frames, span(4, 4), 1)?.endMinutes).toBe(24 * 60);
  });

  it("narrows the every-day frame with the weekday one, without a precedence rule", () => {
    const frames = [frame(4, 6, "08:00", "15:00"), frame(4, 6, "08:00", "13:00", 5)];

    expect(frameWindow(frames, span(4, 4), 1)?.endMinutes).toBe(at("15:00"));
    expect(frameWindow(frames, span(4, 4), 5)?.endMinutes).toBe(at("13:00"));
  });

  it("gives a group straddling two stages the tighter window", () => {
    /*
     * The alternative readings — take the wider, or take neither — put the
     * year-6 pupils of a 6-7 group in a classroom during an afternoon their own
     * stage has closed. This one costs the timetable room instead.
     */
    const frames = [frame(4, 6, "08:00", "15:00"), frame(7, 9, "08:00", "16:00")];

    expect(frameWindow(frames, span(6, 7), 1)).toEqual({
      startMinutes: at("08:00"),
      endMinutes: at("15:00"),
    });
  });

  it("narrows from both ends at once", () => {
    const frames = [frame(4, 6, "09:00", "16:00"), frame(4, 6, "08:00", "15:00", 1)];

    expect(frameWindow(frames, span(4, 4), 1)).toEqual({
      startMinutes: at("09:00"),
      endMinutes: at("15:00"),
    });
  });

  it("reports a day two frames cannot both hold as closed, not as empty", () => {
    const frames = [frame(4, 6, "08:00", "10:00"), frame(4, 6, "14:00", "16:00")];
    expect(frameWindow(frames, span(4, 4), 1)).toBeNull();
  });

  it("matches on overlap, not containment", () => {
    // A 3-4 group overlaps a 4-6 frame at exactly one year, and that is enough:
    // its year-4 pupils are the ones the frame is about.
    expect(frameWindow([frame(4, 6, "08:00", "15:00")], span(3, 4), 1)?.endMinutes).toBe(
      at("15:00"),
    );
    // ...and a 2-3 group touches it nowhere.
    expect(frameWindow([frame(4, 6, "08:00", "15:00")], span(2, 3), 1)?.endMinutes).toBe(
      24 * 60,
    );
  });
});

// ---------------------------------------------------------------------------
// breaksFrame
// ---------------------------------------------------------------------------

describe("breaksFrame", () => {
  const spans = (entries: Record<string, { min: number; max: number }>) =>
    new Map(Object.entries(entries));

  const FRAMES = [frame(4, 6, "08:00", "15:00")];
  const YEAR_4 = spans({ gA: span(4, 4) });

  it("says nothing when the school has no frames", () => {
    expect(breaksFrame([], ["gA"], YEAR_4, 1, at("16:00"), at("17:00"))).toBe(false);
  });

  it("flags a lesson that runs past the frame's close", () => {
    expect(breaksFrame(FRAMES, ["gA"], YEAR_4, 1, at("14:30"), at("15:30"))).toBe(true);
  });

  it("flags a lesson that starts before the frame opens", () => {
    expect(breaksFrame(FRAMES, ["gA"], YEAR_4, 1, at("07:00"), at("08:30"))).toBe(true);
  });

  it("leaves a lesson exactly filling the frame alone", () => {
    // Both bounds inclusive: a lesson may end at the moment the frame closes.
    expect(breaksFrame(FRAMES, ["gA"], YEAR_4, 1, at("08:00"), at("15:00"))).toBe(false);
  });

  it("flags a shared lesson when only one of its groups is outside", () => {
    /*
     * A lesson for 6A and 7A has pupils of both in the room. Requiring every
     * group to be outside would let 16:00 pass because the year-7 half may be
     * there — while the year-6 half sits in a lesson their school closed.
     */
    const frames = [frame(4, 6, "08:00", "15:00"), frame(7, 9, "08:00", "17:00")];
    const both = spans({ six: span(6, 6), seven: span(7, 7) });

    expect(breaksFrame(frames, ["six", "seven"], both, 1, at("15:30"), at("16:30"))).toBe(
      true,
    );
    expect(breaksFrame(frames, ["seven"], both, 1, at("15:30"), at("16:30"))).toBe(false);
  });

  it("says nothing about a group whose years are unknown", () => {
    expect(breaksFrame(FRAMES, ["gA"], spans({}), 1, at("16:00"), at("17:00"))).toBe(
      false,
    );
  });

  it("says nothing when the spans were never supplied", () => {
    expect(breaksFrame(FRAMES, ["gA"], undefined, 1, at("16:00"), at("17:00"))).toBe(
      false,
    );
  });

  it("flags every lesson on a day the frames close entirely", () => {
    const frames = [frame(4, 6, "08:00", "10:00"), frame(4, 6, "14:00", "16:00")];
    expect(breaksFrame(frames, ["gA"], YEAR_4, 1, at("09:00"), at("09:30"))).toBe(true);
  });

  it("looks at the lesson's own weekday", () => {
    const frames = [frame(4, 6, "08:00", "13:00", 5)];

    expect(breaksFrame(frames, ["gA"], YEAR_4, 5, at("14:00"), at("15:00"))).toBe(true);
    expect(breaksFrame(frames, ["gA"], YEAR_4, 1, at("14:00"), at("15:00"))).toBe(false);
  });
});
