import { describe, expect, it } from "vitest";
import { lunchFlow, peakSeated } from "@/lib/lunch-flow";
import type { LunchSitting } from "@/lib/types";

const sitting = (
  id: string,
  groupId: string,
  dayOfWeek: number,
  start: string,
  end: string,
  headcount: number,
): LunchSitting => ({
  id,
  studentGroupId: groupId,
  dayOfWeek,
  startTime: `${start}:00`,
  endTime: `${end}:00`,
  headcount,
});

const at = (clock: string) => {
  const [h, m] = clock.split(":").map(Number);
  return h * 60 + m;
};

describe("lunchFlow", () => {
  it("is empty for a day nobody eats on", () => {
    expect(lunchFlow([sitting("a", "g1", 1, "11:00", "11:30", 30)], 2)).toEqual([]);
  });

  it("puts the waves in clock order, whatever order the rows arrive in", () => {
    const rows = [
      sitting("b", "g2", 1, "12:00", "12:30", 30),
      sitting("a", "g1", 1, "11:00", "11:30", 30),
    ];

    expect(lunchFlow(rows, 1).map((wave) => wave.startMinutes)).toEqual([
      at("11:00"),
      at("12:00"),
    ]);
  });

  it("merges classes that sit down at the same minute into one wave", () => {
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 30),
      sitting("b", "g2", 1, "11:00", "11:30", 28),
    ];

    expect(lunchFlow(rows, 1)).toEqual([
      {
        startMinutes: at("11:00"),
        endMinutes: at("11:30"),
        studentGroupIds: ["g1", "g2"],
        seated: 58,
      },
    ]);
  });

  it("keeps merely overlapping sittings apart", () => {
    /*
     * 11:00-11:30 and 11:15-11:45 share a quarter of an hour but are two
     * servings. A kitchen reading them as one would set out half the trays at
     * the wrong time.
     */
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 30),
      sitting("b", "g2", 1, "11:15", "11:45", 30),
    ];

    expect(lunchFlow(rows, 1)).toHaveLength(2);
  });

  it("gives a wave the length of its longest member", () => {
    // Two classes sitting down together need not be given the same minutes.
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 30),
      sitting("b", "g2", 1, "11:00", "11:45", 30),
    ];

    expect(lunchFlow(rows, 1)[0]?.endMinutes).toBe(at("11:45"));
  });
});

describe("peakSeated", () => {
  it("is zero on a day nobody eats", () => {
    expect(peakSeated([sitting("a", "g1", 1, "11:00", "11:30", 30)], 2)).toBe(0);
  });

  it("counts one wave as itself", () => {
    expect(peakSeated([sitting("a", "g1", 1, "11:00", "11:30", 30)], 1)).toBe(30);
  });

  it("does not add up waves that never meet", () => {
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 30),
      sitting("b", "g2", 1, "11:30", "12:00", 30),
    ];

    // 11:30 is when the first ends, so they are never in the hall together.
    expect(peakSeated(rows, 1)).toBe(30);
  });

  it("adds up waves that overlap, which is the whole question", () => {
    /*
     * Summing the WAVES would under-count exactly here: two staggered
     * servings are in the hall together for fifteen minutes, and whether the
     * hall is big enough is a question about that moment.
     */
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 30),
      sitting("b", "g2", 1, "11:15", "11:45", 28),
    ];

    expect(peakSeated(rows, 1)).toBe(58);
  });

  it("finds the peak in the middle of a longer day", () => {
    const rows = [
      sitting("a", "g1", 1, "11:00", "11:30", 20),
      sitting("b", "g2", 1, "11:15", "11:45", 20),
      sitting("c", "g3", 1, "11:20", "11:50", 20),
      sitting("d", "g4", 1, "12:30", "13:00", 90),
    ];

    // 11:20 holds all three of the first group; the lone 90 later is bigger.
    expect(peakSeated(rows, 1)).toBe(90);
  });
});
