import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/grade-numbering-cases.json";
import {
  fromNioarig,
  gradeOfPlanRow,
  lydelseIsTioarig,
  planRowOf,
  toNioarig,
  type GradeNumbering,
} from "@/lib/grade-numbering";

/**
 * One numbering, implemented twice — the web half of
 * src/common/grade-numbering.contract.spec.ts, replaying the same fixture.
 */
const { spans, planRows, lydelser } = fixture as {
  spans: { numbering: GradeNumbering; gradeLevel: number | null; toNioarig: number | null; fromNioarig: number | null }[];
  planRows: { planTioarig: boolean; numbering: GradeNumbering; grade: number; planRowOf: number | null; gradeOfPlanRow: number | null }[];
  lydelser: { term: string; tioarig: boolean }[];
};

describe("the numbering agrees with the shared fixture", () => {
  it("covers every årskurs 0..12 in both numberings", () => {
    expect(spans).toHaveLength(28);
    expect(planRows).toHaveLength(52);
  });

  it.each(spans.map((row) => [`${row.numbering} ${row.gradeLevel}`, row] as const))("span %s", (_name, row) => {
    expect(toNioarig(row.gradeLevel, row.numbering)).toBe(row.toNioarig);
    expect(fromNioarig(row.gradeLevel, row.numbering)).toBe(row.fromNioarig);
  });

  it.each(planRows.map((row) => [`${row.planTioarig ? "TIOARIG" : "NIOARIG"} plan, ${row.numbering} ${row.grade}`, row] as const))(
    "plan row %s",
    (_name, row) => {
      expect(planRowOf(row.planTioarig, row.numbering, row.grade)).toBe(row.planRowOf);
      expect(gradeOfPlanRow(row.planTioarig, row.numbering, row.grade)).toBe(row.gradeOfPlanRow);
    },
  );

  it("reads the lydelser", () => {
    for (const row of lydelser) expect(lydelseIsTioarig(row.term)).toBe(row.tioarig);
  });
});
