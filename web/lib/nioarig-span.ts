// A class's span of årskurser read in NIOARIG, for the pages that compare it
// with school-wide spans: the timetable, the gaps search and the behörighet
// badge (grade-numbering.ts says why every such reader translates).
//
// Its own file, not lib/grade-numbering.ts: that module is bundled whole into
// every route that imports any of it, and the timetable and requirements
// routes sit at their budget. The same answers as the gateway's toNioarigSpan
// (src/common/grade-numbering.ts), replayed from the shared fixture by
// grade-numbering.contract.test.ts.

import type { GradeNumbering } from "@/lib/grade-numbering";

/** A TIOARIG årskurs in NIOARIG: one lower, 12 staying "and above", no TIOARIG 0. */
const nioarig = (grade: number) => (grade >= 12 ? 12 : grade > 0 ? grade - 1 : 0);

/** A span of a läsår of `numbering`, in NIOARIG. */
export function toNioarigSpan(
  span: { min: number; max: number } | null,
  numbering: GradeNumbering,
): { min: number; max: number } | null {
  return span === null || numbering === "NIOARIG" ? span : { min: nioarig(span.min), max: nioarig(span.max) };
}
