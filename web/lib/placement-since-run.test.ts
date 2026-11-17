import { describe, expect, it } from "vitest";
import { changedSinceRun, lessonsOfRows, type SinceRunBoard, type SinceRunJob } from "./placement-since-run";

const T0 = "2026-11-16T08:00:00.000Z"; // rows saved
const RUN = "2026-11-16T09:00:00.000Z"; // grundschema written
const LATER = "2026-11-16T10:00:00.000Z"; // saved after the run

const job = (over: Partial<SinceRunJob> = {}): SinceRunJob => ({ status: "SUCCEEDED", solverStatus: "OPTIMAL", finishedAt: RUN, ...over });
const rows = (...changedAt: string[]) => changedAt.map((value) => ({ changedAt: value }));
const board = (over: Partial<SinceRunBoard> = {}): SinceRunBoard => ({ placements: rows(T0, T0), timetable: { placedLessons: 2, writtenAt: RUN }, ...over });

describe("lessonsOfRows", () => {
  it("is one lesson for each row of a post", () => {
    expect(lessonsOfRows({ placements: rows(T0, T0, T0) })).toBe(3);
  });

  it("is one lesson per member for each row of a block, as the run writes it", () => {
    expect(lessonsOfRows({ placements: rows(T0), blocks: [{ memberIds: ["a", "b", "c"], rows: rows(T0, T0) }, { memberIds: ["d"], rows: rows(T0) }] })).toBe(1 + 6 + 1);
  });

  it("is nothing for no rows, and a block with no member or no row stands for none", () => {
    expect(lessonsOfRows({ placements: [] })).toBe(0);
    expect(lessonsOfRows({ placements: [], blocks: [{ memberIds: [], rows: rows(T0) }, { memberIds: ["a"], rows: [] }] })).toBe(0);
  });
});

describe("changedSinceRun: with the grundschema's own account (timetable)", () => {
  it("is not changed when the rows are what the grundschema was written from", () => {
    expect(changedSinceRun(board(), [job()])).toBe(false);
  });

  it("is changed by a row laid after the run: one lesson more than the grundschema holds", () => {
    expect(changedSinceRun(board({ placements: rows(T0, T0, LATER) }), [job()])).toBe(true);
  });

  it("is changed by a row that was changed after the run: the same count, a newer changedAt", () => {
    expect(changedSinceRun(board({ placements: rows(T0, LATER) }), [job()])).toBe(true);
  });

  it("is changed by a row that was removed: no changedAt is left behind and the lesson stands, so the count is the evidence", () => {
    expect(changedSinceRun(board({ placements: rows(T0) }), [job()])).toBe(true);
  });

  it("counts a block's lessons for each member, so a block that was laid before the run is not a change", () => {
    const withBlock = board({ placements: rows(T0), blocks: [{ memberIds: ["a", "b"], rows: rows(T0) }], timetable: { placedLessons: 3, writtenAt: RUN } });
    expect(changedSinceRun(withBlock, [job()])).toBe(false);
    expect(changedSinceRun({ ...withBlock, timetable: { placedLessons: 2, writtenAt: RUN } }, [job()])).toBe(true);
  });

  it("is changed by a block's row saved after the run", () => {
    const later = board({ placements: rows(T0), blocks: [{ memberIds: ["a", "b"], rows: rows(LATER) }], timetable: { placedLessons: 3, writtenAt: RUN } });
    expect(changedSinceRun(later, [job()])).toBe(true);
  });

  it("is a schema when a schemaförslag was applied with no run of Generera in the history: the grundschema holds the lessons", () => {
    expect(changedSinceRun(board({ placements: rows(T0, T0, LATER) }), [])).toBe(true);
    expect(changedSinceRun(board(), [])).toBe(false);
    expect(changedSinceRun(board(), undefined)).toBe(false);
  });

  it("is a schema after a run that wrote no förläggning when there are rows now (laid after the run)", () => {
    expect(changedSinceRun(board({ placements: rows(LATER), timetable: { placedLessons: 0, writtenAt: null } }), [job()])).toBe(true);
  });

  it("is not changed when nothing is placed and nothing was written", () => {
    expect(changedSinceRun(board({ placements: [], timetable: { placedLessons: 0, writtenAt: null } }), [job()])).toBe(false);
  });

  it("never claims a change before the first schema: no run that laid a week and no lesson written from a förläggning", () => {
    const first = board({ placements: rows(LATER), timetable: { placedLessons: 0, writtenAt: null } });
    expect(changedSinceRun(first, [])).toBe(false);
    expect(changedSinceRun(first, undefined)).toBe(false);
  });

  it("does not take a run that laid no week, or one that failed or is still going, for a schema", () => {
    const first = board({ placements: rows(LATER), timetable: { placedLessons: 0, writtenAt: null } });
    for (const run of [job({ status: "FAILED", solverStatus: null }), job({ solverStatus: "INFEASIBLE" }), job({ solverStatus: "TIMEOUT" }), job({ status: "RUNNING", solverStatus: null }), job({ status: "PENDING", solverStatus: null })]) {
      expect(changedSinceRun(first, [run])).toBe(false);
    }
  });

  it("takes both a OPTIMAL and a FEASIBLE run for a schema", () => {
    const first = board({ placements: rows(LATER), timetable: { placedLessons: 0, writtenAt: null } });
    expect(changedSinceRun(first, [job({ solverStatus: "OPTIMAL" })])).toBe(true);
    expect(changedSinceRun(first, [job({ solverStatus: "FEASIBLE" })])).toBe(true);
  });

  it("measures against when the grundschema was written, not when the run finished (a schemaförslag moves the first and not the second)", () => {
    // The run finished before the rows were saved, but a schemaförslag wrote the grundschema after them: nothing has changed since.
    const written = board({ placements: rows("2026-11-16T09:30:00.000Z", "2026-11-16T09:30:00.000Z"), timetable: { placedLessons: 2, writtenAt: "2026-11-16T09:45:00.000Z" } });
    expect(changedSinceRun(written, [job({ finishedAt: "2026-11-16T09:00:00.000Z" })])).toBe(false);
  });

  it("is not changed by a row saved at the very moment the grundschema was written", () => {
    expect(changedSinceRun(board({ placements: rows(RUN, RUN) }), [job()])).toBe(false);
  });

  it("does not stumble on a time it cannot read", () => {
    expect(changedSinceRun(board({ placements: rows("not a time", T0) }), [job()])).toBe(false);
    expect(changedSinceRun(board({ timetable: { placedLessons: 2, writtenAt: "not a time" } }), [job()])).toBe(false);
  });
});

describe("changedSinceRun: from an older gateway with no timetable", () => {
  const older = (placements: { changedAt: string }[]): SinceRunBoard => ({ placements });

  it("measures against the newest successful run's finishedAt, and makes no count", () => {
    expect(changedSinceRun(older(rows(T0, T0)), [job()])).toBe(false);
    expect(changedSinceRun(older(rows(T0, LATER)), [job()])).toBe(true);
    // One row removed since is invisible here, as it always was: nothing says a lesson is left over.
    expect(changedSinceRun(older(rows(T0)), [job()])).toBe(false);
  });

  it("takes the newest of several runs", () => {
    const runs = [job({ finishedAt: "2026-11-16T07:00:00.000Z" }), job({ finishedAt: "2026-11-16T11:00:00.000Z" })];
    expect(changedSinceRun(older(rows(LATER)), runs)).toBe(false);
  });

  it("is nothing before the first schema, and for a run that laid no week", () => {
    expect(changedSinceRun(older(rows(LATER)), [])).toBe(false);
    expect(changedSinceRun(older(rows(LATER)), [job({ solverStatus: "INFEASIBLE" })])).toBe(false);
    expect(changedSinceRun(older(rows(LATER)), [job({ finishedAt: null })])).toBe(false);
  });
});
