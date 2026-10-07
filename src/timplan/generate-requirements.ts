import { BadRequestException } from '@nestjs/common';
import { TIMPLAN_ALTERNATIVE_CODES } from '../common/timplan-coverage';

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
 * ALTERNATIVES ARE ONE LINE, AS THE COVERAGE READS THEM. The national codes
 * P1 hard-codes as alternatives (TIMPLAN_ALTERNATIVE_CODES) hold subjects a
 * pupil reads INSTEAD of each other, and a plan lists each of them; posting
 * them all on the class would put Svenska and SvA, Spanska and Tyska and
 * Franska on every pupil of 7A, which the coverage then reads as OVER. So:
 *   M2 (språkval)  never on a class: språkval is read in teaching groups
 *                  across classes, and which pupil reads which language is
 *                  exactly the decision the plan cannot make. Every M2 entry
 *                  is skipped as ALTERNATIVE; until the språkval groups
 *                  exist, the coverage reads the line as unplanned.
 *   SV_SVA         one subject on the class: the one with the HIGHEST target
 *                  (the line's target, so the class meets it), on a tie the
 *                  first by name — Svenska before Svenska som andraspråk. The
 *                  other is skipped as ALTERNATIVE, naming the one the class
 *                  gets; SvA is then a teaching group for its readers. If the
 *                  class already has either subject, the line is the
 *                  class's already: nothing more is proposed in it.
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
  /** Subject.nationalCode per subject: what makes a subject an alternative. */
  nationalCodes: ReadonlyMap<string, string | null>;
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

/** EXISTS: the class has the pair already. ALTERNATIVE: see the header. */
export type SkipReason = 'EXISTS' | 'ALTERNATIVE';

export interface SkippedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  reason: SkipReason;
  /** SV_SVA or M2 when the subject belongs to an alternative line, else null. */
  alternativeCode: string | null;
  /** ALTERNATIVE in SV_SVA: the subject of the line the class has or gets. */
  alternativeTo: string | null;
}

export interface Proposal {
  rows: ProposedRow[];
  skipped: SkippedRow[];
}

const pairKey = (groupId: string, subjectId: string): string => `${groupId}:${subjectId}`;

/** The alternative line a national code belongs to (SV_SVA, M2), or null. */
export const alternativeLineOf = (nationalCode: string | null | undefined): string | null =>
  nationalCode != null && TIMPLAN_ALTERNATIVE_CODES.includes(nationalCode) ? nationalCode : null;
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
  const alternativeOf = (id: string): string | null => alternativeLineOf(input.nationalCodes.get(id));
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
    // Per alternative line of this class: the subject it has or gets, or
    // null for a line never posted on a class (M2).
    const lineSubject = new Map<string, string | null>();
    for (const entry of entries) {
      const code = alternativeOf(entry.subjectId);
      if (code === null || lineSubject.has(code)) continue;
      if (code === 'M2') {
        lineSubject.set(code, null);
        continue;
      }
      const line = entries.filter((other) => alternativeOf(other.subjectId) === code);
      const held = line.find((other) => existing.has(pairKey(group.id, other.subjectId)));
      // entries are in name order, so the first of the highest is the tie-break.
      const highest = line.reduce((best, other) =>
        other.minutesPerWeek > best.minutesPerWeek ? other : best,
      );
      lineSubject.set(code, (held ?? highest).subjectId);
    }
    for (const entry of entries) {
      const key = pairKey(group.id, entry.subjectId);
      known.add(key);
      const alternativeCode = alternativeOf(entry.subjectId);
      const where = {
        studentGroupId: group.id,
        groupName: group.name,
        subjectId: entry.subjectId,
        subjectName: subjectName(entry.subjectId),
        gradeLevel: entry.gradeLevel,
      };
      if (existing.has(key)) {
        skipped.push({ ...where, reason: 'EXISTS', alternativeCode, alternativeTo: null });
        continue;
      }
      if (alternativeCode !== null) {
        const chosen = lineSubject.get(alternativeCode) ?? null;
        if (chosen !== entry.subjectId) {
          skipped.push({
            ...where,
            reason: 'ALTERNATIVE',
            alternativeCode,
            alternativeTo: chosen === null ? null : subjectName(chosen),
          });
          continue;
        }
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

