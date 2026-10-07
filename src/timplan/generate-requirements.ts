import { BadRequestException } from '@nestjs/common';

/*
 * "Skapa timplansposter": a plan's minutes per week turned into the
 * TeachingRequirements a läsår's classes are missing. Pure — the service reads
 * the rows and writes what this proposes.
 *
 * WHAT IS PROPOSED. For every CLASS group of the year whose årskurs the year
 * attaches to THIS plan, and every entry of the plan for that årskurs with
 * minutesPerWeek > 0, a row (group, subject) — unless the year already has a
 * requirement for that pair, in which case it is SKIPPED and named. Untis'
 * "Create lessons" semantics: only missing rows are created; nothing is ever
 * updated or deleted, no teacher is set (staffing is the next step, and a
 * row without a teacher meets no staffing check), and teaching groups are
 * never generated — which pupils sit in a språkval or SvA group is a decision
 * the plan cannot make.
 *
 * HOW. lessonsPerWeek = ceil(minutes / L) at the chosen lesson length L, so the
 * row never falls short of the plan by rounding; the surplus is reported
 * (lessons × L − minutes: 175 at 60 is 3 × 60, +5). Capped at 40, the DTO's
 * and the engine's bound; a capped row says so and its "surplus" is negative.
 * L is on the solver's five-minute grid within 15..240 (the DTO refuses
 * anything else, assertLessonLengthFitsTheGrid's rule), so the engine never
 * receives a length it refuses (INPUT_*). Overrides — the preview's edited
 * rows — replace lessons and length for their (group, subject).
 */

export const MAX_LESSONS_PER_WEEK = 40;

export interface GenerateEntry {
  subjectId: string;
  gradeLevel: number;
  minutesPerWeek: number;
}

export interface GenerateGroup {
  id: string;
  name: string;
  gradeLevel: number | null;
}

export interface GenerateOverride {
  studentGroupId: string;
  subjectId: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
}

export interface GenerateInput {
  /** The årskurser the year attaches to this plan. */
  gradeLevels: number[];
  entries: GenerateEntry[];
  /** The year's CLASS groups. */
  classes: GenerateGroup[];
  subjectNames: ReadonlyMap<string, string>;
  /** (group, subject) pairs the year already has a requirement for. */
  existing: { studentGroupId: string; subjectId: string }[];
  minutesPerLesson: number;
  overrides: GenerateOverride[];
}

export interface ProposedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  targetMinutesPerWeek: number;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  plannedMinutesPerWeek: number;
  /** planned − target: +5 for 175 as 3 × 60; negative only when capped. */
  surplusMinutesPerWeek: number;
  overridden: boolean;
  /** lessonsPerWeek hit the 40-lesson bound before the target was reached. */
  capped: boolean;
}

export type SkipReason = 'EXISTS';

export interface SkippedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  reason: SkipReason;
}

export interface Proposal {
  rows: ProposedRow[];
  skipped: SkippedRow[];
}

const pairKey = (groupId: string, subjectId: string): string => `${groupId}:${subjectId}`;
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');

/** The rows to create, and the ones skipped, in group then subject order. */
export function proposeRequirements(input: GenerateInput): Proposal {
  const grades = new Set(input.gradeLevels);
  const existing = new Set(input.existing.map((row) => pairKey(row.studentGroupId, row.subjectId)));
  const overrides = new Map<string, GenerateOverride>();
  for (const [index, override] of input.overrides.entries()) {
    const key = pairKey(override.studentGroupId, override.subjectId);
    if (overrides.has(key)) {
      throw new BadRequestException(
        `overrides: rad ${index + 1} gäller samma klass och ämne som en tidigare rad.`,
      );
    }
    overrides.set(key, override);
  }

  const subjectName = (id: string) => input.subjectNames.get(id) ?? id;
  const classes = input.classes
    .filter((group) => group.gradeLevel !== null && grades.has(group.gradeLevel))
    .sort((a, b) => byName(a.name, b.name) || (a.id < b.id ? -1 : 1));

  const rows: ProposedRow[] = [];
  const skipped: SkippedRow[] = [];
  const known = new Set<string>();
  for (const group of classes) {
    const entries = input.entries
      .filter((entry) => entry.gradeLevel === group.gradeLevel && entry.minutesPerWeek > 0)
      .sort((a, b) => byName(subjectName(a.subjectId), subjectName(b.subjectId)) || (a.subjectId < b.subjectId ? -1 : 1));
    for (const entry of entries) {
      const key = pairKey(group.id, entry.subjectId);
      known.add(key);
      const where = {
        studentGroupId: group.id,
        groupName: group.name,
        subjectId: entry.subjectId,
        subjectName: subjectName(entry.subjectId),
        gradeLevel: entry.gradeLevel,
      };
      if (existing.has(key)) {
        skipped.push({ ...where, reason: 'EXISTS' });
        continue;
      }
      const override = overrides.get(key);
      const length = override?.minutesPerLesson ?? input.minutesPerLesson;
      const wanted = Math.ceil(entry.minutesPerWeek / length);
      const lessons = override?.lessonsPerWeek ?? Math.min(wanted, MAX_LESSONS_PER_WEEK);
      rows.push({
        ...where,
        targetMinutesPerWeek: entry.minutesPerWeek,
        lessonsPerWeek: lessons,
        minutesPerLesson: length,
        plannedMinutesPerWeek: lessons * length,
        surplusMinutesPerWeek: lessons * length - entry.minutesPerWeek,
        overridden: override !== undefined,
        capped: override === undefined && wanted > MAX_LESSONS_PER_WEEK,
      });
    }
  }

  const strangers = [...overrides.keys()].filter((key) => !known.has(key));
  if (strangers.length > 0) {
    throw new BadRequestException(
      `overrides: ${strangers.length === 1 ? 'en rad gäller' : `${strangers.length} rader gäller`} ` +
        'en klass och ett ämne som timplanen inte ger någon post i det här läsåret.',
    );
  }
  return { rows, skipped };
}

