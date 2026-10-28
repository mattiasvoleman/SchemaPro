"use client";

// "Dela i halvklass" on Timplansposter: a class's post replaced by posts on
// the class's two halves, which take turns over two periods. Slöjd for 7A:
// one half reads textilslöjd in the autumn and trä- och metallslöjd in the
// spring, the other half the other way round. Hemkunskap for 6.1: 6.1:1
// reads it the first half of the autumn and 6.1:2 the second. The gateway
// does it in one transaction (src/resources/term-halves.service.ts): it
// splits the class if it has no halves yet, writes one parallel block per
// period, the second on the first's times, writes the posts, and removes the
// class's post. Opened from the post's own dialog.
//
// LOADED ON THE FIRST PRESS, by hand, as Mål mode and the block panel are:
// /admin/requirements sits at its 190 KB budget, and the bundle gate counts
// what the route's manifest names, which this chunk is not. The page keeps
// the namespace in state (see requirements-target.tsx for why not React.lazy).
// lib/half-class-periods.ts, its arithmetic, comes with it.
//
// WHAT IT ASKS. The two periods (the terms, half a term each, or dates of the
// admin's own), which subject each half reads in the first period — the second
// half none, for hemkunskap read in turn — who teaches each subject and who
// co-teaches it, the halves' week, the names of the halves (only when the
// class has none) and of the two blocks. The class's co-teacher starts on the
// first subject: with two subjects the halves are at the same times, so
// nobody can be on both, and the gateway refuses a person on both rather than
// drop one unseen. A class that has its halves sends them in the order drawn
// here (halfIds), so the preview's first half is the one the gateway writes
// first, whatever the database's collation makes of the names. What it will
// write is drawn as a table before anything is sent. A staffing REFUSE is the
// cell dialog's notice; anything else the gateway refuses is said in the
// dialog in its own Swedish, so the admin can change a name or a subject
// without losing the rest.
//
// THE HALVES' WEEK. A dated post counts for its share of the year's teaching
// weeks, so a half reading hemkunskap in a quarter of the year at the class's
// pace would get a quarter of the class's hours, and the timplan would say
// under mål. The dialog proposes the week that keeps each pupil's hours
// (proposedLessons, by how the halves read the post's line: halvesRead) and
// shows what the halves get and what the teacher is charged; the admin can
// keep the class's pace instead, or type another.
//
// AGAINST THE TIMPLAN. Below the week, what a pupil of each half gets on each
// line the split touches, against the plan's target — the timplan's own
// figures (lib/half-class-timplan.ts), read under the keys Mål mode reads the
// year's plans by. A swap of hemkunskap with slöjd gives each pupil slöjd in
// the other period on top of the class's own slöjd post; the dialog proposes
// how far that post can come down with no half under, and changes it in the
// same save when the admin ticks it (the gateway's adjustedPost).
//
// A SWAP IS TWO SUBJECTS: a group has one post per subject, so a half cannot
// read slöjd twice. The guesses below preselect a school's "Textilslöjd" /
// "Syslöjd" and "Trä- och metallslöjd" for a slöjd post; a school with only
// "Slöjd" adds the two subjects under Ämnen first, which the dialog says when
// it finds neither. Any other post starts as its own subject, read in turn.
//
// THE NATIONAL CODE. Skapa timplansposter knows the halves read the class's
// line only by the post's subject or its national code, and the plan's
// national rows count a subject by its code. The Ämnen form leaves a new
// subject without one, so a chosen subject whose code is not the post's is
// named before the split, with the way to Ämnen; the split itself goes on
// (the gateway answers the same in codeWarnings). In a swap with another
// line (hemkunskap and slöjd) the other subject is meant to be another line:
// the sentence says its minutes count on its own code, and only one without
// a code is sent to Ämnen, its minutes being skolans val until it has one.
//
// THE TEACHERS COME AS IN THE POST'S OWN DIALOG: the strongest behörighet in
// the subject first, with the same badge beside each name (strongestFirst and
// CandidateBadge, lib/staffing-candidates.ts). Per subject, not per half: a
// subject's teacher has one half in the first period and the other in the
// second, so its lärare and medlärare pickers list one order. The span is the
// class's, which is its halves' (their pupils are the class's). The window is
// the läsår and not the period, because the gateway judges each post against
// the läsår (judgeRequirementWrite), and a subject's teacher teaches in both
// periods anyway.

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ApiError, api } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import type { GradeSpan } from "@/lib/grade-span";
import {
  halvesRead,
  halvesRow,
  lengthsOf,
  periodsProblem,
  plannedRows,
  presetPeriods,
  proposedLessons,
  readsPostLine,
  PERIOD_PRESETS,
  type HalfPeriod,
  type PeriodPreset,
  type UniformLessons,
} from "@/lib/half-class-periods";
import {
  classPostReduction,
  halvesTimplan,
  type HalfLine,
  type HalvesSplit,
  type HalvesTimplanSources,
  type StoredPost,
} from "@/lib/half-class-timplan";
import { plannedPlansOf } from "@/lib/requirements-target";
import { useLocalTimplanDetails, useYearTimplans } from "@/lib/year-timplan-queries";
import { lengthPartsOf, lengthsProblem, lessonCountOf, longestLessonOf, weeklyMinutesOf } from "@/lib/lesson-lengths";
import {
  candidateQualification,
  candidateRemaining,
  strongestFirst,
  type CandidateQualification,
} from "@/lib/staffing-candidates";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { refusalText, staffingRefusal, warningText } from "@/lib/staffing-warnings";
import { standardWeekWeight, type JudgedYear } from "@/lib/standard-week";
import { annualMinutes, formatHours, type ClosedRange } from "@/lib/teaching-hours";
import type { StaffingWarning, TeachingRequirement } from "@/lib/types";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
import { CandidateBadge } from "@/components/staffing/candidate-badge";
import { RefusalNotice } from "@/components/staffing/staffing-notices";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Link } from "@/i18n/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A block's name, as TeachingBlocks_name_is_sane holds it. */
const BLOCK_NAME_MAX = 80;
/** A group's name, as Dela klassen takes it. */
const HALF_NAME_MAX = 60;
/** Radix Select has no empty value: "no subject chosen", "no subject" and "no teacher" are this. */
const NONE = "none";

export interface TermHalvesDialogProps {
  /** The class's post to split; null: closed. */
  requirement: TeachingRequirement | null;
  /** The year's groups: the class and its halves are found among them. */
  groups: readonly { id: string; name: string; halfOfId?: string | null; gradeLevel?: number | null }[];
  subjects: readonly { id: string; name: string; nationalCode?: string | null; countsTowardTimplan?: boolean }[];
  /**
   * The year's timplansposter, for what each half gets against the timplan:
   * the class's other posts (its slöjd, when hemkunskap is swapped with
   * slöjd) and the halves' own. Absent: the split's posts alone are judged.
   */
  posts?: readonly StoredPost[];
  teachers: readonly { id: string; firstName: string; lastName: string }[];
  /**
   * The school's behörigheter, for the badge beside each teacher and the order
   * they come in. Undefined while they load: the names come as the roster
   * has them, as in the post's own dialog.
   */
  qualifications?: Parameters<typeof candidateQualification>[0];
  /** The year's groups' årskurser (lib/grade-span.ts): the class's is the one judged. */
  gradeSpans: ReadonlyMap<string, GradeSpan>;
  /** The tjänstefördelning's report, for the minutes each teacher has left. */
  loadReport?: Parameters<typeof candidateRemaining>[0];
  /** The läsår's own days, YYYY-MM-DD, and its numbering when tioårig. */
  year: JudgedYear | null;
  /**
   * The year's lov and studiedagar (admin/breaks), so a term's halves get as
   * many teaching weeks each and the hours are the matrix's. Empty: every
   * week of the year is taught, as the matrix reads it then.
   */
  closures?: readonly ClosedRange[];
  /** Cancel, and after the split too: the post the dialog was opened from is gone. */
  onClose: () => void;
}

/** What the gateway answers (TermHalvesResponse), as far as the dialog reads it. */
interface SplitAnswer {
  halves: { id: string; name: string }[];
  warnings?: (StaffingWarning & { requirementId?: string })[];
  requirements?: { id: string; studentGroupId: string; subjectId: string }[];
  /** The class's post the save changed too (adjustedPost), or null. */
  adjustedRequirement?: { id: string; studentGroupId: string; subjectId: string } | null;
}

/** Stand-ins for the halves a split makes, so the timplan can be asked before they exist. */
const NEW_HALVES = ["new-half-1", "new-half-2"] as const;
/** No posts handed in: one list for every render, so the timplan's figures are not computed again. */
const NO_POSTS: readonly StoredPost[] = [];
const NO_CLOSURES: readonly ClosedRange[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (value: string) => Date.parse(`${value}T00:00:00Z`);
const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * The spring term's first day as the dialog proposes it: the first Monday on
 * or after the 1st of January after the läsår starts, when that is a day the
 * year has after its first. Empty when it is not (a läsår that does not span
 * a new year), so the admin types the day.
 */
export function proposedSpringStart(year: { startDate: string; endDate: string } | null): string {
  if (!year) return "";
  const start = dayOf(year.startDate);
  const end = dayOf(year.endDate);
  if (Number.isNaN(start) || Number.isNaN(end)) return "";
  const january = Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1);
  const monday = january + ((8 - new Date(january).getUTCDay()) % 7) * DAY_MS;
  return monday > start && monday <= end ? isoOf(monday) : "";
}

/** Whether `spring` leaves both terms a day of the year: after the first day, by the last. */
export function springStartFits(spring: string, year: { startDate: string; endDate: string } | null): boolean {
  const day = dayOf(spring);
  if (Number.isNaN(day)) return false;
  if (!year) return true;
  return day > dayOf(year.startDate) && day <= dayOf(year.endDate);
}

/**
 * The school's two slöjd subjects, as a guess: one whose name says textil or
 * starts with "sy", and one that says trä or metall, never the same subject.
 */
export function guessTermSubjects(subjects: readonly { id: string; name: string }[]): [string, string] {
  const first = subjects.find((subject) => /textil|^sy/i.test(subject.name))?.id ?? "";
  const second = subjects.find((subject) => subject.id !== first && /trä|metall/i.test(subject.name))?.id ?? "";
  return [first, second];
}

/** Whether the post is slöjd, which the halves swap rather than read in turn. */
export function isSlojd(name: string): boolean {
  return /slöjd/i.test(name);
}

/** The block names' last word for each period of a preset, by message key. */
const BLOCK_SUFFIXES: Record<PeriodPreset, [string, string]> = {
  terms: ["autumn", "spring"],
  yearHalves: ["period1", "period2"],
  autumnHalves: ["autumn1", "autumn2"],
  springHalves: ["spring1", "spring2"],
  firstHalves: ["autumn1", "spring1"],
  custom: ["period1", "period2"],
};

export function TermHalvesDialog({ requirement, ...rest }: TermHalvesDialogProps) {
  return (
    <Dialog open={requirement !== null} onOpenChange={(open) => !open && rest.onClose()}>
      <DialogContent className="max-w-xl">
        {requirement ? <TermHalvesForm key={requirement.id} requirement={requirement} {...rest} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function TermHalvesForm({
  requirement,
  groups,
  subjects,
  teachers,
  qualifications,
  gradeSpans,
  loadReport,
  year,
  closures = NO_CLOSURES,
  posts = NO_POSTS,
  onClose,
}: Omit<TermHalvesDialogProps, "requirement"> & { requirement: TeachingRequirement }) {
  const t = useTranslations("requirements.termHalves");
  const tCommon = useTranslations("common");
  const tStaffing = useTranslations("staffing");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const locale = useLocale();
  const lengthsInWords = useLengthsInWords();
  const queryClient = useQueryClient();

  const theClass = groups.find((group) => group.id === requirement.studentGroupId);
  const className = theClass?.name ?? "";
  const subjectName = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
  const postSubject = subjectName.get(requirement.subjectId) ?? "";
  const postName = `${className} · ${postSubject}`;
  const slojd = isSlojd(postSubject);
  // In the locale's order; whichever it is, the request names it (halfIds).
  const halves = useMemo(
    () =>
      groups
        .filter((group) => group.halfOfId === requirement.studentGroupId)
        .sort((a, b) => a.name.localeCompare(b.name, locale) || (a.id < b.id ? -1 : 1)),
    [groups, requirement.studentGroupId, locale],
  );
  const sortedSubjects = useMemo(
    () => [...subjects].sort((a, b) => a.name.localeCompare(b.name, locale)),
    [subjects, locale],
  );
  const span = gradeSpans.get(requirement.studentGroupId) ?? null;
  // The lov arithmetic reads a single årskurs only (standardWeekWeight's rule).
  const grade = span !== null && span.min === span.max ? span.min : null;
  const closed = useMemo(() => [...closures], [closures]);

  // Slöjd swaps two subjects over the terms; anything else is read in turn,
  // the first half of the autumn and the second — its own subject, when the
  // list has it to show.
  const [pair, setPair] = useState<[string, string]>(() =>
    slojd ? guessTermSubjects(subjects) : [subjectName.has(requirement.subjectId) ? requirement.subjectId : "", ""],
  );
  const [preset, setPreset] = useState<PeriodPreset>(slojd ? "terms" : "autumnHalves");
  const [teacherOf, setTeacherOf] = useState<[string, string]>(["", ""]);
  // The class's co-teacher follows the first subject until the admin says
  // otherwise — when they are still an active teacher the list can show. One
  // who is not is said below and sent as none, never as an id no select shows.
  const carriedCoTeacher = teachers.find((teacher) => teacher.id === requirement.coTeacherId) ?? null;
  const [coTeacherOf, setCoTeacherOf] = useState<[string, string]>([carriedCoTeacher?.id ?? "", ""]);
  // A teacher list that arrives after the dialog opened: the class's
  // co-teacher is preselected then, once. Before it nobody could be chosen,
  // so nothing the admin did is overwritten.
  const [coTeacherSettled, setCoTeacherSettled] = useState(carriedCoTeacher !== null || teachers.length > 0);
  if (!coTeacherSettled && teachers.length > 0) {
    setCoTeacherSettled(true);
    if (carriedCoTeacher) setCoTeacherOf([carriedCoTeacher.id, coTeacherOf[1]]);
  }
  const [springStart, setSpringStart] = useState(() => proposedSpringStart(year));
  const [customPeriods, setCustomPeriods] = useState<[HalfPeriod, HalfPeriod]>([
    { startDate: "", endDate: "" },
    { startDate: "", endDate: "" },
  ]);
  // The halves' week: null follows the proposal, CLASS is the class's pace.
  const [ownLessons, setOwnLessons] = useState<UniformLessons | "CLASS" | null>(null);
  const [halfNames, setHalfNames] = useState([`${className.slice(0, 58)}:1`, `${className.slice(0, 58)}:2`]);
  // Each named after its period until the admin names it.
  const [ownBlockNames, setOwnBlockNames] = useState<[string | null, string | null]>([null, null]);
  // Whether the class's own post in the swap's other subject is brought down in the same save.
  const [adjustChosen, setAdjustChosen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const splitting = halves.length === 0;
  const halfLabels = splitting ? halfNames.map((name) => name.trim()) : halves.map((half) => half.name);
  const halfLabel = (half: number) => halfLabels[half] || t("halfFallback", { n: half + 1 });
  const terms = preset === "terms";
  const springFits = springStartFits(springStart, year);
  const drawn =
    preset === "custom" || !year ? null : presetPeriods(preset, springStart, year, closed, grade);
  const periods: [HalfPeriod, HalfPeriod] | null = preset === "custom" ? customPeriods : drawn;
  const periodsFault = periods ? periodsProblem(periods, year) : null;
  const dateText = (value: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(dayOf(value));
  /**
   * A period's block named after the post and the period, the subject cut
   * first when the whole is longer than a block's name may be, so the two
   * never lose the part that tells them apart.
   */
  const blockNameFor = (period: 0 | 1) => {
    const suffix = t(`blockSuffix.${BLOCK_SUFFIXES[preset][period]}`);
    const whole = t("blockName", { subject: postSubject, group: className, period: suffix });
    const over = whole.length - BLOCK_NAME_MAX;
    return over <= 0
      ? whole
      : t("blockName", { subject: postSubject.slice(0, Math.max(0, postSubject.length - over)), group: className, period: suffix }).slice(0, BLOCK_NAME_MAX);
  };
  const blockNames: [string, string] = [ownBlockNames[0] ?? blockNameFor(0), ownBlockNames[1] ?? blockNameFor(1)];
  const trimmedBlocks = blockNames.map((name) => name.trim());
  const subjectCount: 1 | 2 = pair[1] ? 2 : 1;
  // How the halves read the post's line: in turn, or a swap within it or with another.
  const read = halvesRead(pair, requirement.subjectId, subjects);
  /** Whether the subject at `index` of the pair is the post's line (all are, but in a swap with another). */
  const onLine = (index: number) => read !== "swapWithOther" || readsPostLine(pair[index]!, requirement.subjectId, subjects);

  // The halves' week, and what it gives each pupil and the teacher.
  const proposal =
    periods && periodsFault === null && year
      ? proposedLessons(requirement, periods, read, year, closed, grade)
      : null;
  const lessons: UniformLessons | null = ownLessons === "CLASS" ? null : (ownLessons ?? proposal);
  const shown: UniformLessons = lessons ?? { count: lessonCountOf(requirement), minutes: longestLessonOf(requirement) };
  const lessonsFault =
    lessons !== null &&
    (!Number.isInteger(lessons.count) || lessons.count < 1 || lessons.count > 40 || lengthsProblem([lessons.minutes]) !== null);
  const week = halvesRow(requirement, lessons);
  const rows = periods && periodsFault === null ? plannedRows(week, requirement.recurrence, periods, subjectCount) : [];
  const yearDays = year ? { startDate: year.startDate, endDate: year.endDate } : null;
  // On the post's line only: in a swap with another line the other subject's
  // hours are the other line's (the timplan's lines below).
  const hoursOf = (half: 0 | 1) =>
    yearDays
      ? rows
          .filter((row) => row.half === half && onLine(row.subject))
          .reduce((sum, row) => sum + annualMinutes(row, yearDays, closed, grade), 0)
      : 0;
  const classHours = yearDays ? annualMinutes(requirement, yearDays, closed, grade) : 0;
  /** A subject's standardvecka for its teacher, as the load report charges it (percent included). */
  const percent = (requirement.teacherLoadPercent ?? 100) / 100;
  const chargedOf = (subject: 0 | 1) =>
    yearDays
      ? rows
          .filter((row) => row.subject === subject)
          .reduce((sum, row) => sum + weeklyMinutesOf(row) * standardWeekWeight({ ...row, gradeSpan: span }, yearDays, closed), 0) *
        percent
      : 0;
  const classCharged = yearDays
    ? weeklyMinutesOf(requirement) * standardWeekWeight({ ...requirement, gradeSpan: span }, yearDays, closed) * percent
    : 0;

  // Against the timplan: the year's plans as Mål mode reads them, the split
  // laid over the year's posts, a pupil of each half.
  const attachments = useYearTimplans(requirement.academicYearId);
  const planIds = useMemo(
    () => [...new Set((attachments.data ?? []).map((row) => row.localTimplanId))].sort(),
    [attachments.data],
  );
  const plans = useLocalTimplanDetails(planIds, attachments.data !== undefined);
  const timplanSources = useMemo<HalvesTimplanSources | null>(
    () =>
      year && attachments.data && plans.data
        ? {
            year,
            closures: closed,
            attachments: attachments.data,
            plans: plannedPlansOf(attachments.data, plans.data),
            subjects,
          }
        : null,
    [year, closed, attachments.data, plans.data, subjects],
  );
  // The swap's subject that is not the post's line, whose class post can come down.
  const otherSubjectId = read === "swapWithOther" ? (onLine(0) ? pair[1] : pair[0]) : null;
  // The halves as the timplan is asked about them: the class's two, or stand-ins.
  const splitHalves: HalvesSplit["halves"] | null =
    splitting || halves.length === 2
      ? [
          { id: splitting ? NEW_HALVES[0] : halves[0]!.id, name: halfLabel(0) },
          { id: splitting ? NEW_HALVES[1] : halves[1]!.id, name: halfLabel(1) },
        ]
      : null;
  // Keyed on what the figures read, so a keystroke in a block name computes nothing again.
  const splitKey = JSON.stringify([rows, pair, splitHalves]);
  const { timplan, reduction } = useMemo(() => {
    if (!timplanSources || rows.length === 0 || !theClass || !splitHalves) return { timplan: null, reduction: null };
    const split: HalvesSplit = {
      theClass: { id: theClass.id, name: theClass.name, gradeLevel: theClass.gradeLevel ?? null },
      halves: splitHalves,
      posts,
      sourceId: requirement.id,
      rows,
      subjectIds: pair.slice(0, subjectCount),
    };
    const reduction = otherSubjectId ? classPostReduction(timplanSources, split, otherSubjectId) : null;
    const adjusted = adjustChosen && reduction && !reduction.inBlock ? { requirementId: reduction.requirementId, week: reduction.to } : null;
    return { timplan: halvesTimplan(timplanSources, { ...split, adjusted }, requirement.subjectId), reduction };
    // splitKey stands for rows, pair and the halves, which are new arrays every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timplanSources, splitKey, posts, theClass, requirement.id, requirement.subjectId, otherSubjectId, subjectCount, adjustChosen]);
  const adjusting = adjustChosen && reduction !== null && !reduction.inBlock ? reduction : null;

  const problems = {
    subjects: pair[0] === "" ? t("subjectsMissing") : pair[0] === pair[1] ? t("subjectsSame") : null,
    // The halves are at the same times, and the generator refuses a block
    // whose posts share a teacher.
    teachers: (() => {
      if (subjectCount === 1) return null;
      const first = new Set([teacherOf[0], coTeacherOf[0]].filter((id) => id !== ""));
      return [teacherOf[1], coTeacherOf[1]].some((id) => id !== "" && first.has(id)) ? t("teachersSame") : null;
    })(),
    coTeachers: [0, 1].some((index) => index < subjectCount && coTeacherOf[index] !== "" && coTeacherOf[index] === teacherOf[index])
      ? t("coTeacherSame")
      : null,
    // The läsår's halves read no spring start: only that they can be drawn.
    spring:
      preset === "custom"
        ? null
        : preset !== "yearHalves" && !springFits
          ? t("springOutside")
          : drawn === null
            ? t("periodsNotDrawn")
            : null,
    periods: preset === "custom" && periodsFault !== null ? t(`periodsInvalid.${periodsFault}`) : null,
    lessons: lessonsFault ? t("lessonsInvalid") : null,
    halves:
      splitting &&
      (halfLabels.some((name) => name.length === 0) || halfLabels[0]!.toLowerCase() === halfLabels[1]!.toLowerCase())
        ? t("halfNamesInvalid")
        : null,
    blocks:
      trimmedBlocks.some((name) => name.length === 0) || trimmedBlocks[0]!.toLowerCase() === trimmedBlocks[1]!.toLowerCase()
        ? t("blockNamesInvalid")
        : null,
  };
  const ready =
    !Object.values(problems).some((problem) => problem !== null) && halves.length !== 1 && periods !== null && periodsFault === null;
  // Neither slöjd subject found: the school has one "Slöjd" and adds the two first.
  const none = slojd && guessTermSubjects(subjects).every((id) => id === "");
  // The chosen subjects that do not carry the post's national code (any,
  // when the post's subject has none) — the post's own subject always counts.
  const postCode = subjects.find((subject) => subject.id === requirement.subjectId)?.nationalCode ?? null;
  const uncoded = pair
    .filter((id, index) => id !== "" && id !== requirement.subjectId && pair.indexOf(id) === index)
    .map((id) => subjects.find((subject) => subject.id === id))
    .filter((subject): subject is (typeof subjects)[number] => subject !== undefined)
    .filter((subject) => postCode === null || (subject.nationalCode ?? null) !== postCode);
  /** A sentence of the code notice, and whether it asks for Ämnen. */
  const codeLine = (subject: (typeof subjects)[number]) => {
    const code = subject.nationalCode ?? null;
    // The swap's other line: its own code is what it should have.
    if (subject.id === otherSubjectId) {
      return code === null
        ? { text: t("codeSwapMissing", { subject: subject.name, post: postSubject }), asks: true }
        : { text: t("codeSwapOwn", { subject: subject.name, post: postSubject, code }), asks: false };
    }
    return postCode === null
      ? { text: t("codeMissingOnPost", { subject: subject.name, post: postSubject }), asks: true }
      : { text: t("codeDiffers", { subject: subject.name, post: postSubject, code: postCode }), asks: true };
  };
  const codeLines = uncoded.map((subject) => ({ id: subject.id, ...codeLine(subject) }));

  /** Half h reads pair[(h + period) % 2], nothing where that is the second and there is none. */
  const subjectAt = (half: number, period: number) => subjectName.get(pair[(half + period) % 2]!) ?? "–";
  const subjectLabel = (index: number) => subjectName.get(pair[index]!) ?? t("subjectFallback", { n: index + 1 });

  /**
   * Each subject's teachers, strongest behörighet first, with the badge each
   * carries for it. A subject not yet chosen has nothing to be behörig in:
   * no badge word, and the roster's order.
   */
  const candidates = useMemo(
    () =>
      pair.map((subjectId) =>
        strongestFirst(
          teachers.map((teacher) => ({
            teacher,
            qualification:
              year && subjectId
                ? candidateQualification(qualifications ?? [], teacher.id, subjectId, span, year)
                : ({ recorded: false } satisfies CandidateQualification),
          })),
          (candidate) => candidate.qualification,
        ),
      ),
    [pair, teachers, qualifications, span, year],
  );

  const choosePreset = (next: PeriodPreset) => {
    // Egna datum starts from the periods on screen, so a nudge is one date.
    if (next === "custom" && preset !== "custom" && drawn) setCustomPeriods(drawn);
    setPreset(next);
  };
  const setCustomDate = (period: 0 | 1, field: keyof HalfPeriod, value: string) =>
    setCustomPeriods(
      customPeriods.map((old, at) => (at === period ? { ...old, [field]: value } : old)) as [HalfPeriod, HalfPeriod],
    );

  const submit = async () => {
    if (!ready || busy || !periods) return;
    setBusy(true);
    setRefused(null);
    setFailed(null);
    try {
      const answer = await api.post<SplitAnswer>(`/api/v1/teaching-requirements/${requirement.id}/term-halves`, {
        // Both always stated: an omitted co-teacher would be the class's.
        subjects: pair.slice(0, subjectCount).map((subjectId, index) => ({
          subjectId,
          teacherId: teacherOf[index] || null,
          coTeacherId: coTeacherOf[index] || null,
        })),
        ...(terms ? { springStartDate: springStart } : { periods }),
        ...(lessons ? { lessons: lengthsOf(lessons) } : {}),
        ...(adjusting ? { adjustedPost: { requirementId: adjusting.requirementId, lessons: lengthsOf(adjusting.to) } } : {}),
        ...(splitting ? { halfNames: halfLabels } : { halfIds: halves.map((half) => half.id) }),
        blockNames: trimmedBlocks,
      });
      for (const queryKey of [
        ["requirements", requirement.academicYearId],
        ["groups"],
        ["teachingBlocks", requirement.academicYearId],
        [...STAFFING_KEYS.load],
        [...STAFFING_KEYS.unstaffed],
        [...STAFFING_KEYS.suggestions],
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
      const names = answer?.halves?.map((half) => half.name) ?? halfLabels;
      const title = t("done", { post: postName, first: names[0] ?? "", second: names[1] ?? "" });
      const warnings = answer?.warnings ?? [];
      if (warnings.length === 0) toast.success(title);
      else {
        // Each sentence after the post it is about, as the block panel says them.
        const postOf = (id: string | undefined) => {
          const adjusted = answer?.adjustedRequirement;
          if (adjusted && adjusted.id === id) return `${className} · ${subjectName.get(adjusted.subjectId) ?? ""}: `;
          const row = answer?.requirements?.find((entry) => entry.id === id);
          const half = answer?.halves?.find((entry) => entry.id === row?.studentGroupId);
          return row && half ? `${subjectName.get(row.subjectId) ?? ""} · ${half.name}: ` : "";
        };
        toast.warning(title, {
          description: warnings.map((warning) => `${postOf(warning.requirementId)}${warningText(tEngine, warning)}`).join(" "),
          duration: 12_000,
        });
      }
      onClose();
    } catch (error) {
      const refusal = staffingRefusal(error);
      if (refusal) setRefused(refusalText(tEngine, refusal));
      // Delade lektioner: a shared post is refused before anything is written,
      // said in the reader's language (the gateway's sentence is Swedish).
      else if (error instanceof ApiError && error.code === "TERM_SPLIT_HAS_SHARES") setFailed(t("sharesRefused", { post: postName }));
      else setFailed(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setBusy(false);
    }
  };

  const teacherName = (teacher: { firstName: string; lastName: string }) => `${teacher.firstName} ${teacher.lastName}`;
  const periodHeader = (period: 0 | 1) => {
    if (!periods || periodsFault !== null) return t("periodN", { n: period + 1 });
    const { startDate, endDate } = periods[period];
    if (terms) {
      return period === 0 ? t("autumnUntil", { date: dateText(endDate) }) : t("springFrom", { date: dateText(startDate) });
    }
    return t("periodSpan", { n: period + 1, from: dateText(startDate), to: dateText(endDate) });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="grid gap-4"
    >
      <DialogHeader>
        <DialogTitle>{t("title", { post: postName })}</DialogTitle>
        <DialogDescription>
          {t("description", {
            post: postName,
            teacherPercent: requirement.teacherLoadPercent ?? 100,
            coTeacherPercent: requirement.coTeacherLoadPercent ?? 100,
          })}
        </DialogDescription>
      </DialogHeader>

      {none ? (
        <Notice tone="warning" role={null}>
          {t("noSubjects", { subject: postSubject })}
        </Notice>
      ) : null}
      {halves.length === 1 ? (
        <Notice tone="warning" role={null}>
          {t("oneHalf", { group: className, half: halves[0]!.name })}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField
          id="term-periods"
          label={t("periodsLabel")}
          className="sm:col-span-2"
          error={preset === "yearHalves" ? problems.spring : null}
        >
          {(control) => (
            <Select
              value={preset}
              onValueChange={(value) => {
                if (PERIOD_PRESETS.includes(value as PeriodPreset)) choosePreset(value as PeriodPreset);
              }}
            >
              <SelectTrigger {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIOD_PRESETS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {t(`preset.${option}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>
        {preset === "yearHalves" ? null : preset === "custom" ? (
          ([0, 1] as const).flatMap((period) =>
            (["startDate", "endDate"] as const).map((field) => (
              <FormField
                key={`${period}-${field}`}
                id={`term-period-${period}-${field}`}
                label={t(field === "startDate" ? "periodFrom" : "periodTo", { n: period + 1 })}
                error={period === 1 && field === "endDate" ? problems.periods : null}
              >
                <DateField
                  value={customPeriods[period][field]}
                  onChange={(value) => setCustomDate(period, field, value)}
                  min={year?.startDate}
                  max={year?.endDate}
                  label={t(field === "startDate" ? "periodFrom" : "periodTo", { n: period + 1 })}
                />
              </FormField>
            )),
          )
        ) : (
          <FormField
            id="term-spring-start"
            label={t("springStart")}
            hint={terms ? t("springStartHint") : t("springStartHalvesHint")}
            error={problems.spring}
          >
            <DateField
              value={springStart}
              onChange={setSpringStart}
              min={year ? isoOf(dayOf(year.startDate) + DAY_MS) : undefined}
              max={year?.endDate}
              label={t("springStart")}
            />
          </FormField>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        {[0, 1].map((half) => (
          <FormField
            key={half}
            id={`term-subject-${half}`}
            label={t(terms ? "autumnSubject" : "firstPeriodSubject", { half: halfLabel(half) })}
            error={half === 1 ? problems.subjects : null}
          >
            {(control) => (
              <Select
                value={pair[half] || NONE}
                onValueChange={(value) => {
                  if (value === "") return; // no item has "": see the teachers' select below
                  const id = value === NONE ? "" : value;
                  setPair(half === 0 ? [id, pair[1]] : [pair[0], id]);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* The first half reads something; the second may read nothing then (hemkunskap in turn). */}
                  <SelectItem value={NONE}>{half === 0 ? t("chooseSubject") : t("noSubject")}</SelectItem>
                  {sortedSubjects.map((subject) => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        ))}
        {(["teacher", "coTeacher"] as const).flatMap((role) =>
          [0, 1].slice(0, subjectCount).map((index) => {
            const people = role === "teacher" ? teacherOf : coTeacherOf;
            const setPeople = role === "teacher" ? setTeacherOf : setCoTeacherOf;
            return (
              <FormField
                key={`${role}-${index}`}
                id={`term-${role}-${index}`}
                label={t(role === "teacher" ? "teacherOf" : "coTeacherOf", { subject: subjectLabel(index) })}
                optional
                error={index === subjectCount - 1 ? (role === "teacher" ? problems.teachers : problems.coTeachers) : null}
              >
                {(control) => (
                  <Select
                    value={people[index] || NONE}
                    onValueChange={(value) => {
                      // Radix's hidden <select> reports "" when its value
                      // arrives in the same render as its first options (a
                      // teacher list that came after the dialog opened), and
                      // no item here has that value: it is no choice.
                      if (value === "") return;
                      const id = value === NONE ? "" : value;
                      setPeople(index === 0 ? [id, people[1]] : [people[0], id]);
                    }}
                  >
                    {/*
                      Half the post dialog's width, so the chosen line keeps
                      to one row here: what wraps past it is cut whole — the
                      minutes first, then the word — never half a badge
                      spilling out of the box. The list shows the whole line,
                      and a screen reader hears all of it in both.
                    */}
                    <SelectTrigger
                      {...control}
                      className="[&_[data-candidate-line]]:max-h-6 [&_[data-candidate-line]]:overflow-hidden"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{tCommon("notAssigned")}</SelectItem>
                      {/* The post's own dialog's line (candidateLine): the name first, so typing it still finds it. */}
                      {candidates[index]!.map(({ teacher, qualification }) => (
                        <SelectItem key={teacher.id} value={teacher.id}>
                          {year ? (
                            <span data-candidate-line className="inline-flex flex-wrap items-center gap-2">
                              <span>{teacherName(teacher)}</span>
                              {/* contents: the word and the minutes wrap one by one (see the trigger). */}
                              <CandidateBadge
                                className="contents"
                                qualification={qualification}
                                remaining={candidateRemaining(loadReport, teacher.id)}
                              />
                            </span>
                          ) : (
                            teacherName(teacher)
                          )}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            );
          }),
        )}
        {year ? <p className="text-xs text-muted-foreground sm:col-span-2">{tStaffing("candidateHint")}</p> : null}
        {requirement.coTeacherId && coTeacherSettled ? (
          <p className="text-sm text-foreground sm:col-span-2">
            {carriedCoTeacher
              ? t(subjectCount === 1 ? "coTeacherCarriedOne" : "coTeacherCarried", { name: teacherName(carriedCoTeacher) })
              : t("coTeacherInactive")}
          </p>
        ) : null}
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <legend className="mb-2 text-sm font-medium">{t("lessonsLegend")}</legend>
        <FormField id="term-lessons-count" label={t("lessonsCount")} error={problems.lessons}>
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={40}
            value={Number.isNaN(shown.count) ? "" : shown.count}
            onChange={(event) => setOwnLessons({ ...shown, count: event.target.valueAsNumber })}
          />
        </FormField>
        <FormField id="term-lessons-minutes" label={t("lessonsMinutes")}>
          <Input
            type="number"
            inputMode="numeric"
            min={15}
            max={240}
            step={5}
            value={Number.isNaN(shown.minutes) ? "" : shown.minutes}
            onChange={(event) => setOwnLessons({ ...shown, minutes: event.target.valueAsNumber })}
          />
        </FormField>
        <div className="grid gap-2 text-sm text-foreground sm:col-span-2" data-testid="term-halves-hours">
          <p>
            {lessons === null
              ? t("lessonsClass", { lessons: lengthsInWords(lengthPartsOf(requirement)) })
              : t("lessonsOwn", { lessons: lengthsInWords(lengthPartsOf(week)), classLessons: lengthsInWords(lengthPartsOf(requirement)) })}
          </p>
          {rows.length > 0 && yearDays ? (
            <>
              <p>
                {t(read === "swapWithOther" ? "hoursHalvesSubject" : "hoursHalves", {
                  first: halfLabel(0),
                  firstHours: formatHours(hoursOf(0)),
                  ...(read === "swapWithOther" ? { subject: postSubject } : {}),
                  second: halfLabel(1),
                  secondHours: formatHours(hoursOf(1)),
                  classHours: formatHours(classHours),
                })}
              </p>
              {([0, 1] as const).slice(0, subjectCount).map((subject) => (
                <p key={subject}>
                  {t("chargedLine", {
                    subject: subjectLabel(subject),
                    minutes: Math.round(chargedOf(subject)),
                    classMinutes: Math.round(classCharged),
                  })}
                </p>
              ))}
            </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {proposal !== null && (lessons === null || lessons.count !== proposal.count || lessons.minutes !== proposal.minutes) ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setOwnLessons(null)}>
                {t("lessonsUseProposal", { lessons: lengthsInWords([{ count: proposal.count, minutes: proposal.minutes }]) })}
              </Button>
            ) : null}
            {lessons !== null ? (
              <Button type="button" variant="outline" size="sm" onClick={() => setOwnLessons("CLASS")}>
                {t("lessonsUseClass")}
              </Button>
            ) : null}
          </div>
        </div>
      </fieldset>

      {rows.length > 0 && splitHalves ? (
        <TimplanLines
          state={
            attachments.isError || plans.isError
              ? { kind: "failed" }
              : timplan === null
                ? { kind: "loading" }
                : timplan
          }
          halfLabel={halfLabel}
          className={className}
          subjectName={(id) => subjectName.get(id) ?? ""}
          otherSubject={otherSubjectId ? (subjectName.get(otherSubjectId) ?? "") : ""}
          reduction={reduction}
          adjustChosen={adjustChosen}
          onAdjust={setAdjustChosen}
          lengthsInWords={lengthsInWords}
        />
      ) : null}

      {splitting ? (
        <fieldset className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <legend className="mb-2 text-sm font-medium">{t("halvesLegend", { group: className })}</legend>
          {[0, 1].map((index) => (
            <FormField
              key={index}
              id={`term-half-${index}`}
              label={t("halfName", { n: index + 1 })}
              error={index === 1 ? problems.halves : null}
            >
              <Input
                value={halfNames[index]}
                maxLength={HALF_NAME_MAX}
                onChange={(event) => setHalfNames(halfNames.map((old, at) => (at === index ? event.target.value : old)))}
              />
            </FormField>
          ))}
        </fieldset>
      ) : halves.length === 2 ? (
        <p className="text-sm text-foreground">{t("halvesExist", { first: halves[0]!.name, second: halves[1]!.name })}</p>
      ) : null}

      <fieldset className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <legend className="mb-2 text-sm font-medium">{terms ? t("blocksLegend") : t("blocksLegendPeriods")}</legend>
        {[0, 1].map((index) => (
          <FormField
            key={index}
            id={`term-block-${index}`}
            label={terms ? (index === 0 ? t("blockAutumnLabel") : t("blockSpringLabel")) : t("blockPeriodLabel", { n: index + 1 })}
            error={index === 1 ? problems.blocks : null}
          >
            <Input
              value={blockNames[index]}
              maxLength={BLOCK_NAME_MAX}
              onChange={(event) =>
                setOwnBlockNames(ownBlockNames.map((old, at) => (at === index ? event.target.value : old)) as [string | null, string | null])
              }
            />
          </FormField>
        ))}
      </fieldset>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-1 text-left font-medium">{t("planCaption")}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("halfColumn")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {periodHeader(0)}
              </th>
              <th scope="col" className="py-1 font-medium">
                {periodHeader(1)}
              </th>
            </tr>
          </thead>
          <tbody>
            {[0, 1].map((half) => (
              <tr key={half} className="border-b last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {halfLabel(half)}
                </th>
                <td className="py-1 pr-3">{subjectAt(half, 0)}</td>
                <td className="py-1">{subjectAt(half, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {codeLines.length > 0 ? (
        <Notice
          tone={codeLines.some((line) => line.asks) ? "warning" : "neutral"}
          role={null}
          title={t("codeTitle")}
          action={
            codeLines.some((line) => line.asks) ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/admin/subjects">{t("codeAction")}</Link>
              </Button>
            ) : undefined
          }
        >
          <ul className="space-y-1">
            {codeLines.map((line) => (
              <li key={line.id}>{line.text}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <p className="text-sm text-foreground">
        {subjectCount === 1 ? t("replacesOne", { post: postName }) : t("replaces", { post: postName })}
      </p>
      <Notice role={null}>
        {subjectCount === 1 ? t("generatorNoteOne", { subject: subjectLabel(0) }) : t("generatorNote")}
      </Notice>

      {refused ? <RefusalNotice text={refused} /> : null}
      {failed ? (
        <Notice tone="destructive" title={t("failedTitle")}>
          {failed}
        </Notice>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button data-writes="PLANERING" type="submit" disabled={!ready || busy}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What the timplan section draws: its lines, or why there are none yet. */
type TimplanState = { kind: "loading" } | { kind: "failed" } | NonNullable<ReturnType<typeof halvesTimplan>>;

/**
 * What a pupil of each half gets on each line the split touches, against the
 * plan's target, in the timplan's standardvecka minutes; then, in a swap with
 * another line, how far the class's own post in it can come down, with the
 * choice to change it in the same save.
 */
function TimplanLines({
  state,
  halfLabel,
  className,
  subjectName,
  otherSubject,
  reduction,
  adjustChosen,
  onAdjust,
  lengthsInWords,
}: {
  state: TimplanState;
  halfLabel: (half: number) => string;
  className: string;
  subjectName: (id: string) => string;
  /** The swap's subject that is not the post's line; empty without one. */
  otherSubject: string;
  reduction: ReturnType<typeof classPostReduction>;
  adjustChosen: boolean;
  onAdjust: (chosen: boolean) => void;
  lengthsInWords: ReturnType<typeof useLengthsInWords>;
}) {
  // Its own name: the key check (i18n/messages.test.ts) binds a name to one namespace per file.
  const tTimplan = useTranslations("requirements.termHalves.timplan");
  if (state.kind === "loading") {
    return (
      <p role="status" className="text-sm text-foreground">
        {tTimplan("loading")}
      </p>
    );
  }
  if (state.kind === "failed") {
    return (
      <Notice tone="destructive" role={null}>
        {tTimplan("failed")}
      </Notice>
    );
  }
  if (state.kind === "noGrade") return <p className="text-sm text-foreground">{tTimplan("noGrade", { group: className })}</p>;
  if (state.kind === "noPlan") return <p className="text-sm text-foreground">{tTimplan("noPlan", { grade: state.gradeLevel })}</p>;
  const nameOf = (line: HalfLine) => line.subjectIds.map(subjectName).join(" / ");
  const cell = (line: HalfLine | undefined) =>
    !line || line.target === null || line.planned === null
      ? tTimplan("noTarget")
      : line.planned < line.target
        ? tTimplan("under", { planned: line.planned, target: line.target })
        : tTimplan("met", { planned: line.planned, target: line.target });
  const doubled = state.halves[0].filter(
    (line, index) => line.doubleFrom.length > 0 || (state.halves[1][index]?.doubleFrom.length ?? 0) > 0,
  );
  const reducedPost = `${className} · ${otherSubject}`;
  return (
    <section className="grid gap-2 text-sm text-foreground" data-testid="term-halves-timplan">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-1 text-left font-medium">{tTimplan("caption", { grade: state.gradeLevel })}</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="py-1 pr-3 font-medium">
                {tTimplan("lineColumn")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {halfLabel(0)}
              </th>
              <th scope="col" className="py-1 font-medium">
                {halfLabel(1)}
              </th>
            </tr>
          </thead>
          <tbody>
            {state.halves[0].map((line, index) => (
              <tr key={line.key ?? line.subjectIds.join(",")} className="border-b last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {nameOf(line)}
                </th>
                <td className="py-1 pr-3">{cell(line)}</td>
                <td className="py-1">{cell(state.halves[1][index])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{tTimplan("hint")}</p>
      {doubled.map((line) => (
        <p key={line.key ?? nameOf(line)}>{tTimplan("double", { subject: nameOf(line), group: className })}</p>
      ))}
      {reduction ? (
        <>
          <p>
            {tTimplan("reduction", {
              subject: otherSubject,
              target: reduction.target,
              post: reducedPost,
              from: lengthsInWords([reduction.from]),
              to: lengthsInWords([reduction.to]),
              first: halfLabel(0),
              firstPlanned: reduction.planned[0],
              second: halfLabel(1),
              secondPlanned: reduction.planned[1],
            })}
          </p>
          {reduction.inBlock ? (
            <p>{tTimplan("reductionInBlock", { post: reducedPost })}</p>
          ) : (
            // Top-aligned: the sentence wraps on a phone, and the box stays by its first line.
            <label className="flex items-start gap-2 font-medium">
              <input
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 accent-primary"
                checked={adjustChosen}
                onChange={(event) => onAdjust(event.target.checked)}
              />
              {tTimplan("reductionApply", { post: reducedPost, to: lengthsInWords([reduction.to]) })}
            </label>
          )}
        </>
      ) : null}
    </section>
  );
}
