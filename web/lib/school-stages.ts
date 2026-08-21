/**
 * The Swedish school stages, as room presets.
 *
 * A room limit is stored as an inclusive year range rather than a named stage,
 * because the stages a school actually runs vary: F–3/4–6/7–9 is common, F–6
 * and 7–9 just as real, and some schools split differently again. The range
 * covers all of them; these presets are only a shortcut for the common cases,
 * with a free range always available underneath.
 */
export interface SchoolStage {
  key: string;
  minGradeLevel: number;
  maxGradeLevel: number;
}

export const SCHOOL_STAGES: SchoolStage[] = [
  { key: "lower", minGradeLevel: 0, maxGradeLevel: 3 },
  { key: "middle", minGradeLevel: 4, maxGradeLevel: 6 },
  { key: "upper", minGradeLevel: 7, maxGradeLevel: 9 },
  { key: "primary", minGradeLevel: 0, maxGradeLevel: 6 },
];

/** The preset matching a range exactly, or null for a custom or absent one. */
export function stageOf(
  minGradeLevel: number | null,
  maxGradeLevel: number | null,
): SchoolStage | null {
  if (minGradeLevel === null || maxGradeLevel === null) return null;
  return (
    SCHOOL_STAGES.find(
      (stage) =>
        stage.minGradeLevel === minGradeLevel && stage.maxGradeLevel === maxGradeLevel,
    ) ?? null
  );
}

/**
 * How a room's limit reads in a list: a stage name when it is one, the bare
 * range when it is not, and nothing at all when the room takes every year.
 *
 * Written out rather than left implicit because "no limit" and "0–9" are the
 * same thing in practice but not on screen — a school that set a range wants
 * to see that it took.
 */
export function gradeRangeLabel(
  minGradeLevel: number | null,
  maxGradeLevel: number | null,
  stageName: (key: string) => string,
): string | null {
  if (minGradeLevel === null && maxGradeLevel === null) return null;

  const stage = stageOf(minGradeLevel, maxGradeLevel);
  if (stage) return stageName(stage.key);

  const low = minGradeLevel === null ? "" : String(minGradeLevel);
  const high = maxGradeLevel === null ? "" : String(maxGradeLevel);
  if (minGradeLevel === null) return `–${high}`;
  if (maxGradeLevel === null) return `${low}–`;
  return low === high ? low : `${low}–${high}`;
}
