import { describe, expect, it } from "vitest";
import { layoutClusters, layoutDay } from "@/lib/day-lanes";

const at = (start: string, end: string, name: string) => {
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  return { name, startMinutes: minutes(start), endMinutes: minutes(end) };
};

describe("lanes", () => {
  // A normal day with a three-way språkval at 10:50.
  const day = [
    at("08:00", "08:50", "Matematik"),
    at("09:00", "09:50", "Svenska"),
    at("10:50", "11:40", "Spanska"),
    at("10:50", "11:40", "Tyska"),
    at("10:50", "11:40", "Franska"),
    at("13:00", "13:50", "Engelska"),
  ];

  it("the admin grid keeps one lane count for the whole day", () => {
    expect(new Set(layoutDay(day).map((lesson) => lesson.laneCount))).toEqual(new Set([3]));
  });

  it("the viewer splits only the lessons that overlap, and draws the rest full width", () => {
    const placed = Object.fromEntries(layoutClusters(day).map((lesson) => [lesson.name, [lesson.lane, lesson.laneCount]]));
    expect(placed).toEqual({
      Matematik: [0, 1],
      Svenska: [0, 1],
      Spanska: [0, 3],
      Tyska: [1, 3],
      Franska: [2, 3],
      Engelska: [0, 1],
    });
  });

  it("a chain of overlaps is one cluster, and a lesson ending as the next begins is not an overlap", () => {
    const chain = [at("08:00", "09:00", "A"), at("08:30", "09:30", "B"), at("09:15", "10:00", "C"), at("10:00", "10:45", "D")];
    const placed = Object.fromEntries(layoutClusters(chain).map((lesson) => [lesson.name, [lesson.lane, lesson.laneCount]]));
    expect(placed).toEqual({ A: [0, 2], B: [1, 2], C: [0, 2], D: [0, 1] });
  });
});
