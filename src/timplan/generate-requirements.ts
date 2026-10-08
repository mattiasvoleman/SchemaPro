import { BadRequestException } from '@nestjs/common';
import { TIMPLAN_ALTERNATIVE_CODES } from '../common/timplan-coverage';
import {
  LESSON_GRID_MINUTES,
  LESSON_MAX_MINUTES,
  LESSON_MIN_MINUTES,
  canonicalShape,
  isMixed,
  weeklyMinutesOf,
} from '../common/lesson-lengths';

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
 * HOW, ROUND_UP (the rule an omitted `remainder` keeps). lessonsPerWeek =
 * ceil(minutes / L) at the chosen lesson length L, so the row never falls short
 * of the plan by rounding; the surplus is reported (lessons × L − minutes: 175
 * at 60 is 3 × 60, +5). Capped at 40, the DTO's and the engine's bound; a
 * capped row says so and its "surplus" is negative.
 *
 * HOW, SPLIT (lektionslängder; splitWeeklyMinutes below). The target is met
 * without surplus wherever the grid allows: 175 at 60 is 2 × 60 + 1 × 55, and a
 * short remainder beside two or more lessons is folded into one of them rather
 * than left as a stub no school timetables — 200 at 60 is 1 × 80 + 2 × 60. Beside
 * a single lesson it stays a lesson of its own, so the subject keeps meeting
 * twice a week — 120 at 80 is 1 × 80 + 1 × 40. Never more than two different
 * lengths, every one on the grid within 15..240.
 *
 * L is on the solver's five-minute grid within 15..240 (the DTO refuses
 * anything else, assertLessonLengthFitsTheGrid's rule), and so is every length
 * SPLIT makes of it, so the engine never receives a length it refuses
 * (INPUT_*). Overrides — the preview's edited rows — replace lessons and
 * length for their (group, subject), always as a uniform row.
 */

export const MAX_LESSONS_PER_WEEK = 40;

/** What a plan's minutes become: rounded up to whole lessons, or split to meet them. */
export type RemainderMode = 'SPLIT' | 'ROUND_UP';

export interface WeeklySplit {
  /** One length per lesson, longest first. */
  lengths: number[];
  /** The 40-lesson bound was reached before the target. */
  capped: boolean;
}

/**
 * T minutes a week as lessons of about L minutes.
 *
 * ROUND_UP: ceil(T / L) × L, capped at 40 — the rule generate always had.
 *
 * SPLIT, with T' = T rounded up to the five-minute grid (a surplus of at most
 * 4, reported), q = floor(T' / L) and r = T' − q·L:
 *   1. r = 0: q × L, uniform.
 *   2. q = 0 (T' shorter than one lesson): 1 × max(T', 15) — one lesson of
 *      the target, never below the engine's 15.
 *   3. r ≥ 15 and either r > L/2 or q = 1: q × L + 1 × r. The remainder is a
 *      lesson of its own and never longer than L — closer to whole than to
 *      nothing, or the second lesson of a subject that would otherwise meet
 *      once a week: 120 at 80 is 1 × 80 + 1 × 40, as a school writes idrott,
 *      not one lesson of 120 that a frame sized for 80 refuses.
 *   4. Otherwise (r ≤ L/2 beside two or more lessons, or r under 15) the
 *      remainder is FOLDED into one lesson: (q − 1) × L + 1 × (L + r), when
 *      L + r ≤ 240. A remnant of ten or twenty minutes has no slot of its own
 *      in a school's day, and one longer lesson among several puts the
 *      minutes where a day already has the room. Under 15 the remnant cannot
 *      be a lesson at all, so it folds even beside one: 65 at 60 is 1 × 65.
 *   5. A fold past 240 (only for L above 160): q × L + 1 × max(r, 15). Under
 *      15 that is a surplus of 15 − r, at most 10 — not the round-up's
 *      (q + 1) × L, which at L = 235 would be 229 minutes over.
 *   6. More than 40 lessons: 40 × L, capped, as ROUND_UP caps. The fold is
 *      not stretched to stay under the bound — that would write a lesson of
 *      up to 2 × L, which steps 3 and 4 never do.
 * Never more than two different lengths, every one on the grid in 15..240.
 */
export function splitWeeklyMinutes(minutes: number, length: number, mode: RemainderMode): WeeklySplit {
  if (mode === 'ROUND_UP') {
    const wanted = Math.ceil(minutes / length);
    return {
      lengths: Array.from({ length: Math.min(wanted, MAX_LESSONS_PER_WEEK) }, () => length),
      capped: wanted > MAX_LESSONS_PER_WEEK,
    };
  }
  const target = Math.ceil(minutes / LESSON_GRID_MINUTES) * LESSON_GRID_MINUTES;
  const q = Math.floor(target / length);
  const r = target - q * length;
  const lessons = (count: number, of: number): number[] => Array.from({ length: count }, () => of);
  const foldable = q >= 1 && r > 0 && length + r <= LESSON_MAX_MINUTES;
  const fold = (): number[] => [length + r, ...lessons(q - 1, length)];

  let split: number[];
  if (r === 0) split = lessons(q, length);
  else if (q === 0) split = [Math.max(target, LESSON_MIN_MINUTES)];
  else if (r >= LESSON_MIN_MINUTES && (r > length / 2 || q === 1)) split = [...lessons(q, length), r];
  else if (foldable) split = fold();
  else split = [...lessons(q, length), Math.max(r, LESSON_MIN_MINUTES)];

  if (split.length > MAX_LESSONS_PER_WEEK) {
    return { lengths: lessons(MAX_LESSONS_PER_WEEK, length), capped: true };
  }
  return { lengths: split.sort((a, b) => b - a), capped: false };
}

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
  /** SPLIT or ROUND_UP; omitted is ROUND_UP, the rule generate always had. */
  remainder?: RemainderMode;
  overrides: GenerateOverride[];
}

export interface ProposedRow {
  studentGroupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  gradeLevel: number;
  targetMinutesPerWeek: number;
  /** The lessons a week; on a split row, the list's length. */
  lessonsPerWeek: number;
  /** The length; on a split row, the longest. */
  minutesPerLesson: number;
  /** Only on a split row: one length per lesson, longest first (2 × 60 + 1 × 55 is [60, 60, 55]). */
  lessonLengths?: number[];
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
      const split = override
        ? { lengths: Array.from({ length: override.lessonsPerWeek }, () => override.minutesPerLesson), capped: false }
        : splitWeeklyMinutes(entry.minutesPerWeek, input.minutesPerLesson, input.remainder ?? 'ROUND_UP');
      const shape = canonicalShape(split.lengths);
      const planned = weeklyMinutesOf(shape);
      rows.push({
        ...where,
        targetMinutesPerWeek: entry.minutesPerWeek,
        lessonsPerWeek: shape.lessonsPerWeek,
        minutesPerLesson: shape.minutesPerLesson,
        // The key only on a split row, so a ROUND_UP preview is the one it was.
        ...(isMixed(shape) ? { lessonLengths: shape.lessonLengths } : {}),
        plannedMinutesPerWeek: planned,
        surplusMinutesPerWeek: planned - entry.minutesPerWeek,
        overridden: override !== undefined,
        capped: split.capped,
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

