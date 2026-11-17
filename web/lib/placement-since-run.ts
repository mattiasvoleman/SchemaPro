/*
 * "ÄNDRAT SEDAN SENASTE SCHEMAT" (A3): whether the förläggningar are no longer what the grundschema was written from.
 *
 * Read off the week's board structurally (see placed-count.ts for why), and off the year's runs.
 *
 * A SCHEMA EXISTS when a run has succeeded with a timetable (OPTIMAL or FEASIBLE) or the grundschema holds a lesson written from
 * a förläggning (`timetable.placedLessons`): a schemaförslag that was applied writes the grundschema with no run of its own.
 * With a schema, the rows are CHANGED when
 *   - the lessons they stand for are not the lessons the grundschema holds from them (a row laid after the run, and a row removed,
 *     which leaves no changedAt but leaves its lesson locked in the grundschema until the next run), or
 *   - a row was saved after the grundschema was written (`changedAt` is when its post's list was last saved).
 * The lessons a row stands for are one for a post's row and one for each member of a block's, as the run writes them.
 *
 * An older gateway has no `timetable`: the reference is then the newest successful run's finishedAt and the count is not made.
 *
 * WHAT IT CANNOT KNOW. Undoing a change saves the list again and gives it a new changedAt, so the sentence stays: it is a prompt
 * to generate again, not a proof that the week differs from the grundschema. Two clocks (the gateway's and the database's) are
 * compared, which is harmless for a change made after a run that took seconds at the least.
 */

export interface SinceRunBoard {
  placements: readonly { changedAt: string }[];
  blocks?: readonly { memberIds: readonly string[]; rows: readonly { changedAt: string }[] }[];
  timetable?: { placedLessons: number; writtenAt: string | null };
}

export interface SinceRunJob {
  status: string;
  solverStatus: string | null;
  finishedAt: string | null;
}

/** The lessons the rows stand for: one per row of a post, and per member for each row of a block. */
export function lessonsOfRows(board: Pick<SinceRunBoard, "placements" | "blocks">): number {
  return board.placements.length + (board.blocks ?? []).reduce((sum, block) => sum + block.rows.length * block.memberIds.length, 0);
}

const laid = (job: SinceRunJob): boolean => job.status === "SUCCEEDED" && (job.solverStatus === "OPTIMAL" || job.solverStatus === "FEASIBLE");

const newest = (times: readonly (string | null)[]): number | null => {
  const stamps = times.flatMap((time) => (time === null ? [] : [new Date(time).getTime()])).filter((stamp) => !Number.isNaN(stamp));
  return stamps.length === 0 ? null : Math.max(...stamps);
};

const savedAt = (board: SinceRunBoard): number | null =>
  newest([...board.placements.map((row) => row.changedAt), ...(board.blocks ?? []).flatMap((block) => block.rows.map((row) => row.changedAt))]);

export function changedSinceRun(board: SinceRunBoard, jobs: readonly SinceRunJob[] | undefined): boolean {
  const timetable = board.timetable;
  const laidRuns = (jobs ?? []).filter(laid);
  if (laidRuns.length === 0 && !(timetable && timetable.placedLessons > 0)) return false;
  const saved = savedAt(board);
  if (timetable) {
    if (lessonsOfRows(board) !== timetable.placedLessons) return true;
    const written = newest([timetable.writtenAt]);
    return saved !== null && written !== null && saved > written;
  }
  const finished = newest(laidRuns.map((job) => job.finishedAt));
  return saved !== null && finished !== null && saved > finished;
}
