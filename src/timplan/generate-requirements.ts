import { BadRequestException } from '@nestjs/common';
import { planRowOf, type GradeNumbering } from '../common/grade-numbering';
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
 *                  is skipped as ALTERNATIVE on the class. The språkval
 *                  groups are the school's to name — `languageGroups`, one
 *                  teaching group per language and årskurs — and then the line
 *                  is posted on THEM, as a block (below).
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
 * M2 AS A BLOCK (Parallella block). A teaching group named for a language of
 * årskurs g gets that language's row, and every row of g goes into one block,
 * "Språkval åk g", whose lessons the generator places at the same times — so
 * språkval takes one slot of 7A's week per lesson, not one per language. The
 * members of a block have the same lessons (the database refuses anything
 * else, TB409), so every row of g gets ONE shape: the line's target as the
 * coverage reads it, its highest entry, laid out by the rule the dialog
 * chose. A language whose own entry is lower gets the line's minutes, as the
 * class in SV_SVA gets the line's. These rows take no override: the preview's
 * edit is per row, and a block's rows are not. A pair the year already has is
 * skipped as EXISTS and does not join the block, since generate never changes
 * an existing row.
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

/** A teaching group named to read one språkval language in one årskurs. */
export interface GenerateLanguageGroup {
  gradeLevel: number;
  subjectId: string;
  studentGroupId: string;
  /** The group's name, which the service reads; for the preview's rows. */
  groupName: string;
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
  /** The plan's rows, in its lydelse's numbering. */
  entries: GenerateEntry[];
  /**
   * Whether the plan's lydelse numbers its rows the tioårig way, and the
   * year's numbering: a class reads the row of its own årskull (planRowOf; 8A
   * of a TIOARIG year reads row 7 of a plan on SFS 2023:945). Absent: the
   * rows are read in the year's own numbering, as before the reform.
   */
  planTioarig?: boolean;
  gradeNumbering?: GradeNumbering;
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
  /** Språkval groups to post M2 on, as one block per årskurs. */
  languageGroups?: GenerateLanguageGroup[];
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
  /** Only on a språkval row: the block it is posted in ("Språkval åk 7"). */
  blockName?: string;
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

/** A block the proposal posts rows in: one per årskurs with språkval groups. */
export interface ProposedBlock {
  name: string;
  gradeLevel: number;
}

export interface Proposal {
  rows: ProposedRow[];
  skipped: SkippedRow[];
  /** Present only when språkval groups were named. */
  blocks?: ProposedBlock[];
}

/** "Språkval åk 7": what the block of one årskurs' språkval is called. */
export const languageBlockName = (gradeLevel: number): string => `Språkval åk ${gradeLevel}`;
/** Whether "Skapa timplansposter" could upsert a block by this name: languageBlockName of some årskurs. */
export const isLanguageBlockName = (name: string): boolean => /^Språkval åk \d+$/.test(name);

const pairKey = (groupId: string, subjectId: string): string => `${groupId}:${subjectId}`;

/** The alternative line a national code belongs to (SV_SVA, M2), or null. */
export const alternativeLineOf = (nationalCode: string | null | undefined): string | null =>
  nationalCode != null && TIMPLAN_ALTERNATIVE_CODES.includes(nationalCode) ? nationalCode : null;
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');

/** The rows to create, and the ones skipped, in group then subject order. */
/** The plan row a class in `grade` reads (GenerateInput.planTioarig). */
const rowOfInput = (input: GenerateInput, grade: number): number | null =>
  input.planTioarig === undefined ? grade : planRowOf(input.planTioarig, input.gradeNumbering ?? 'NIOARIG', grade);

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
    const row = rowOfInput(input, group.gradeLevel!);
    const entries = input.entries
      .filter((entry) => entry.gradeLevel === row && entry.minutesPerWeek > 0)
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
        // The class's årskurs, in the year's numbering; the entry is its row.
        gradeLevel: group.gradeLevel!,
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

  // ---- M2 on the språkval groups, one block per årskurs
  const language = proposeLanguageBlocks(input, grades, existing, subjectName, alternativeOf);
  rows.push(...language.rows);
  skipped.push(...language.skipped);
  const inBlock = [...overrides.keys()].filter((key) => language.keys.has(key));
  if (inBlock.length > 0) {
    throw new BadRequestException(
      'overrides: språkvalets rader läggs i ett block och har samma lektioner. ' +
        'Ändra lektionslängden eller resten för hela förslaget i stället.',
    );
  }

  const strangers = [...overrides.keys()].filter((key) => !known.has(key));
  if (strangers.length > 0) {
    throw new BadRequestException(
      `overrides: ${strangers.length === 1 ? 'en rad gäller' : `${strangers.length} rader gäller`} ` +
        'en klass och ett ämne som timplanen inte ger någon post i det här läsåret.',
    );
  }
  return input.languageGroups && input.languageGroups.length > 0
    ? { rows, skipped, blocks: language.blocks }
    : { rows, skipped };
}

/**
 * The språkval rows: each named group's language at the line's one shape, in
 * its årskurs' block. Checked row by row with the row named, as overrides are:
 * a subject that is no M2 of the plan, an årskurs the year does not attach to
 * this plan or whose line has no minutes, a language or a group named twice.
 */
function proposeLanguageBlocks(
  input: GenerateInput,
  grades: ReadonlySet<number>,
  existing: ReadonlySet<string>,
  subjectName: (id: string) => string,
  alternativeOf: (id: string) => string | null,
): { rows: ProposedRow[]; skipped: SkippedRow[]; blocks: ProposedBlock[]; keys: Set<string> } {
  const choices = input.languageGroups ?? [];
  const byGrade = new Map<number, GenerateLanguageGroup[]>();
  const languages = new Set<string>();
  const groups = new Set<string>();
  for (const [index, choice] of choices.entries()) {
    const at = `languageGroups: rad ${index + 1}`;
    if (alternativeOf(choice.subjectId) !== 'M2') {
      throw new BadRequestException(`${at}: ${subjectName(choice.subjectId)} är inget språkval (M2) i timplanen.`);
    }
    if (!grades.has(choice.gradeLevel)) {
      throw new BadRequestException(`${at}: läsåret följer inte den här timplanen i åk ${choice.gradeLevel}.`);
    }
    const entry = input.entries.find(
      (candidate) =>
        candidate.gradeLevel === rowOfInput(input, choice.gradeLevel) &&
        candidate.subjectId === choice.subjectId &&
        candidate.minutesPerWeek > 0,
    );
    if (!entry) {
      throw new BadRequestException(
        `${at}: timplanen ger ${subjectName(choice.subjectId)} ingen tid i åk ${choice.gradeLevel}.`,
      );
    }
    const language = `${choice.gradeLevel}:${choice.subjectId}`;
    if (languages.has(language)) {
      throw new BadRequestException(`${at}: ${subjectName(choice.subjectId)} i åk ${choice.gradeLevel} har redan en grupp.`);
    }
    if (groups.has(choice.studentGroupId)) {
      throw new BadRequestException(`${at}: ${choice.groupName} läser redan ett annat språk.`);
    }
    languages.add(language);
    groups.add(choice.studentGroupId);
    byGrade.set(choice.gradeLevel, [...(byGrade.get(choice.gradeLevel) ?? []), choice]);
  }

  const rows: ProposedRow[] = [];
  const skipped: SkippedRow[] = [];
  const blocks: ProposedBlock[] = [];
  const keys = new Set<string>();
  for (const gradeLevel of [...byGrade.keys()].sort((a, b) => a - b)) {
    const target = Math.max(
      ...input.entries
        .filter((entry) => entry.gradeLevel === rowOfInput(input, gradeLevel) && alternativeOf(entry.subjectId) === 'M2')
        .map((entry) => entry.minutesPerWeek),
    );
    const split = splitWeeklyMinutes(target, input.minutesPerLesson, input.remainder ?? 'ROUND_UP');
    const shape = canonicalShape(split.lengths);
    const planned = weeklyMinutesOf(shape);
    const name = languageBlockName(gradeLevel);
    let posted = 0;
    const ordered = [...byGrade.get(gradeLevel)!].sort(
      (a, b) =>
        byName(subjectName(a.subjectId), subjectName(b.subjectId)) ||
        byName(a.groupName, b.groupName) ||
        (a.studentGroupId < b.studentGroupId ? -1 : 1),
    );
    for (const choice of ordered) {
      const key = pairKey(choice.studentGroupId, choice.subjectId);
      keys.add(key);
      const where = {
        studentGroupId: choice.studentGroupId,
        groupName: choice.groupName,
        subjectId: choice.subjectId,
        subjectName: subjectName(choice.subjectId),
        gradeLevel,
      };
      if (existing.has(key)) {
        skipped.push({ ...where, reason: 'EXISTS', alternativeCode: 'M2', alternativeTo: null });
        continue;
      }
      posted++;
      rows.push({
        ...where,
        targetMinutesPerWeek: target,
        lessonsPerWeek: shape.lessonsPerWeek,
        minutesPerLesson: shape.minutesPerLesson,
        ...(isMixed(shape) ? { lessonLengths: shape.lessonLengths } : {}),
        plannedMinutesPerWeek: planned,
        surplusMinutesPerWeek: planned - target,
        overridden: false,
        capped: split.capped,
        blockName: name,
      });
    }
    if (posted > 0) blocks.push({ name, gradeLevel });
  }
  return { rows, skipped, blocks, keys };
}

