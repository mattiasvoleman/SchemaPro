"use client";

// "Dela terminsvis i halvklass" on Timplansposter: a class's post — slöjd for
// 7A — replaced by four posts on the class's two halves, so one half reads
// textilslöjd in the autumn and trä- och metallslöjd in the spring and the
// other half the other way round. The gateway does it in one transaction
// (src/resources/term-halves.service.ts): it splits the class if it has no
// halves yet, writes one parallel block per term so the halves are at the
// same times, writes the four posts with the class's lessons, and removes the
// class's post. Opened from the post's own dialog.
//
// LOADED ON THE FIRST PRESS, by hand, as Mål mode and the block panel are:
// /admin/requirements sits at its 190 KB budget, and the bundle gate counts
// what the route's manifest names, which this chunk is not. The page keeps
// the namespace in state (see requirements-target.tsx for why not React.lazy).
//
// WHAT IT ASKS. Which subject each half reads in the autumn (the spring is
// the swap), who teaches each subject and who co-teaches it, the day the
// spring term starts, and the names of the halves (only when the class has
// none) and of the two blocks. The class's co-teacher starts on the first
// subject: the halves are at the same times, so nobody can be on both, and
// the gateway refuses a person on both rather than drop one unseen. A class
// that has its halves sends them in the order drawn here (halfIds), so the
// preview's first half is the one the gateway writes first, whatever the
// database's collation makes of the names. What it will write is drawn as a table of the four posts before
// anything is sent. A staffing REFUSE is the cell dialog's notice; anything
// else the gateway refuses is said in the dialog in its own Swedish, so the
// admin can change a name or a subject without losing the rest.
//
// TWO SUBJECTS, NOT ONE: a group has one post per subject, so a half cannot
// read slöjd twice. The guesses below preselect a school's "Textilslöjd" /
// "Syslöjd" and "Trä- och metallslöjd"; a school with only "Slöjd" adds the
// two subjects under Ämnen first, which the dialog says when it finds neither.

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { lengthPartsOf } from "@/lib/lesson-lengths";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import { refusalText, staffingRefusal, warningText } from "@/lib/staffing-warnings";
import type { StaffingWarning, TeachingRequirement } from "@/lib/types";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A block's name, as TeachingBlocks_name_is_sane holds it. */
const BLOCK_NAME_MAX = 80;
/** A group's name, as Dela klassen takes it. */
const HALF_NAME_MAX = 60;
/** Radix Select has no empty value: "no subject chosen" and "no teacher" are this. */
const NONE = "none";

export interface TermHalvesDialogProps {
  /** The class's post to split; null: closed. */
  requirement: TeachingRequirement | null;
  /** The year's groups: the class and its halves are found among them. */
  groups: readonly { id: string; name: string; halfOfId?: string | null }[];
  subjects: readonly { id: string; name: string }[];
  teachers: readonly { id: string; firstName: string; lastName: string }[];
  /** The läsår's own days, YYYY-MM-DD. */
  year: { startDate: string; endDate: string } | null;
  /** Cancel, and after the split too: the post the dialog was opened from is gone. */
  onClose: () => void;
}

/** What the gateway answers (TermHalvesResponse), as far as the dialog reads it. */
interface SplitAnswer {
  halves: { id: string; name: string }[];
  warnings?: (StaffingWarning & { requirementId?: string })[];
  requirements?: { id: string; studentGroupId: string; subjectId: string }[];
}

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
  year,
  onClose,
}: Omit<TermHalvesDialogProps, "requirement"> & { requirement: TeachingRequirement }) {
  const t = useTranslations("requirements.termHalves");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const locale = useLocale();
  const lengthsInWords = useLengthsInWords();
  const queryClient = useQueryClient();

  const theClass = groups.find((group) => group.id === requirement.studentGroupId);
  const className = theClass?.name ?? "";
  const subjectName = useMemo(() => new Map(subjects.map((subject) => [subject.id, subject.name])), [subjects]);
  const postSubject = subjectName.get(requirement.subjectId) ?? "";
  const postName = `${className} · ${postSubject}`;
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

  const [pair, setPair] = useState<[string, string]>(() => guessTermSubjects(subjects));
  const [teacherOf, setTeacherOf] = useState<[string, string]>(["", ""]);
  // The class's co-teacher follows the first subject until the admin says
  // otherwise — when they are still an active teacher the list can show. One
  // who is not is said below and sent as none, never as an id no select shows.
  const carriedCoTeacher = teachers.find((teacher) => teacher.id === requirement.coTeacherId) ?? null;
  const [coTeacherOf, setCoTeacherOf] = useState<[string, string]>([carriedCoTeacher?.id ?? "", ""]);
  const [springStart, setSpringStart] = useState(() => proposedSpringStart(year));
  const [halfNames, setHalfNames] = useState([`${className.slice(0, 58)}:1`, `${className.slice(0, 58)}:2`]);
  const [blockNames, setBlockNames] = useState([
    t("blockAutumn", { subject: postSubject, group: className }).slice(0, BLOCK_NAME_MAX),
    t("blockSpring", { subject: postSubject, group: className }).slice(0, BLOCK_NAME_MAX),
  ]);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const splitting = halves.length === 0;
  const halfLabels = splitting ? halfNames.map((name) => name.trim()) : halves.map((half) => half.name);
  const springFits = springStartFits(springStart, year);
  const autumnEnd = springFits ? isoOf(dayOf(springStart) - DAY_MS) : "";
  const dateText = (value: string) =>
    new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(dayOf(value));
  const trimmedBlocks = blockNames.map((name) => name.trim());

  const problems = {
    subjects: pair[0] === "" || pair[1] === "" ? t("subjectsMissing") : pair[0] === pair[1] ? t("subjectsSame") : null,
    // The halves are at the same times, and the generator refuses a block
    // whose posts share a teacher.
    teachers: (() => {
      const first = new Set([teacherOf[0], coTeacherOf[0]].filter((id) => id !== ""));
      return [teacherOf[1], coTeacherOf[1]].some((id) => id !== "" && first.has(id)) ? t("teachersSame") : null;
    })(),
    coTeachers: [0, 1].some((index) => coTeacherOf[index] !== "" && coTeacherOf[index] === teacherOf[index])
      ? t("coTeacherSame")
      : null,
    spring: springFits ? null : t("springOutside"),
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
  const ready = !Object.values(problems).some((problem) => problem !== null) && halves.length !== 1;
  // Neither slöjd subject found: the school has one "Slöjd" and adds the two first.
  const none = guessTermSubjects(subjects).every((id) => id === "");

  /** Half h reads pair[(h + term) % 2]: the spring is the autumn swapped. */
  const subjectAt = (half: number, term: number) => subjectName.get(pair[(half + term) % 2]!) ?? "–";

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setRefused(null);
    setFailed(null);
    try {
      const answer = await api.post<SplitAnswer>(`/api/v1/teaching-requirements/${requirement.id}/term-halves`, {
        // Both always stated: an omitted co-teacher would be the class's.
        subjects: pair.map((subjectId, index) => ({
          subjectId,
          teacherId: teacherOf[index] || null,
          coTeacherId: coTeacherOf[index] || null,
        })),
        springStartDate: springStart,
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
      else setFailed(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setBusy(false);
    }
  };

  const teacherName = (teacher: { firstName: string; lastName: string }) => `${teacher.firstName} ${teacher.lastName}`;

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
            lessons: lengthsInWords(lengthPartsOf(requirement)),
            teacherPercent: requirement.teacherLoadPercent ?? 100,
            coTeacherPercent: requirement.coTeacherLoadPercent ?? 100,
          })}
        </DialogDescription>
      </DialogHeader>

      {none ? <Notice tone="warning" role={null}>{t("noSubjects")}</Notice> : null}
      {halves.length === 1 ? (
        <Notice tone="warning" role={null}>
          {t("oneHalf", { group: className, half: halves[0]!.name })}
        </Notice>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        {[0, 1].map((half) => (
          <FormField
            key={half}
            id={`term-subject-${half}`}
            label={t("autumnSubject", { half: halfLabels[half] || t("halfFallback", { n: half + 1 }) })}
            error={half === 1 ? problems.subjects : null}
          >
            {(control) => (
              <Select
                value={pair[half] || NONE}
                onValueChange={(value) => {
                  const id = value === NONE ? "" : value;
                  setPair(half === 0 ? [id, pair[1]] : [pair[0], id]);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("chooseSubject")}</SelectItem>
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
          [0, 1].map((index) => {
            const people = role === "teacher" ? teacherOf : coTeacherOf;
            const setPeople = role === "teacher" ? setTeacherOf : setCoTeacherOf;
            const subject = subjectName.get(pair[index]!) ?? t("subjectFallback", { n: index + 1 });
            return (
              <FormField
                key={`${role}-${index}`}
                id={`term-${role}-${index}`}
                label={t(role === "teacher" ? "teacherOf" : "coTeacherOf", { subject })}
                optional
                error={index === 1 ? (role === "teacher" ? problems.teachers : problems.coTeachers) : null}
              >
                {(control) => (
                  <Select
                    value={people[index] || NONE}
                    onValueChange={(value) => {
                      const id = value === NONE ? "" : value;
                      setPeople(index === 0 ? [id, people[1]] : [people[0], id]);
                    }}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>{tCommon("notAssigned")}</SelectItem>
                      {teachers.map((teacher) => (
                        <SelectItem key={teacher.id} value={teacher.id}>
                          {teacherName(teacher)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            );
          }),
        )}
        {requirement.coTeacherId ? (
          <p className="text-sm text-foreground sm:col-span-2">
            {carriedCoTeacher
              ? t("coTeacherCarried", { name: teacherName(carriedCoTeacher) })
              : t("coTeacherInactive")}
          </p>
        ) : null}
        <FormField id="term-spring-start" label={t("springStart")} hint={t("springStartHint")} error={problems.spring}>
          <DateField
            value={springStart}
            onChange={setSpringStart}
            min={year ? isoOf(dayOf(year.startDate) + DAY_MS) : undefined}
            max={year?.endDate}
            label={t("springStart")}
          />
        </FormField>
      </div>

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
        <legend className="mb-2 text-sm font-medium">{t("blocksLegend")}</legend>
        {[0, 1].map((index) => (
          <FormField
            key={index}
            id={`term-block-${index}`}
            label={index === 0 ? t("blockAutumnLabel") : t("blockSpringLabel")}
            error={index === 1 ? problems.blocks : null}
          >
            <Input
              value={blockNames[index]}
              maxLength={BLOCK_NAME_MAX}
              onChange={(event) => setBlockNames(blockNames.map((old, at) => (at === index ? event.target.value : old)))}
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
                {springFits ? t("autumnUntil", { date: dateText(autumnEnd) }) : t("autumn")}
              </th>
              <th scope="col" className="py-1 font-medium">
                {springFits ? t("springFrom", { date: dateText(springStart) }) : t("spring")}
              </th>
            </tr>
          </thead>
          <tbody>
            {[0, 1].map((half) => (
              <tr key={half} className="border-b last:border-0">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {halfLabels[half] || t("halfFallback", { n: half + 1 })}
                </th>
                <td className="py-1 pr-3">{subjectAt(half, 0)}</td>
                <td className="py-1">{subjectAt(half, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-sm text-foreground">{t("replaces", { post: postName })}</p>
      <Notice role={null}>{t("generatorNote")}</Notice>

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
