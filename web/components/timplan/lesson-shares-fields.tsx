"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { lengthPartsOf, weeklyMinutesOf } from "@/lib/lesson-lengths";
import { shapeFromDraft, type DraftPart } from "@/lib/lesson-lengths-text";
import { sharesProblem, teacherPartsOf, type LessonShare } from "@/lib/lesson-shares";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Delade lektioner in the cell dialog: which of the post's lessons other
 * teachers take.
 *
 * A POST NOBODY SHARES STAYS AS SIMPLE AS IT WAS. The page draws one quiet
 * button, "Dela lektionerna mellan lärare", and this module is fetched only
 * when it is pressed or a post that already has shares is opened — the
 * route's budget is 190 KB and it has none of it to spare. Saving a post that
 * never opened it sends no `shares` at all, so the stored ones are left as
 * they are.
 *
 * Each row is a teacher and a number of lessons (and, on a post of two or
 * three lengths, which length): "Bo · 1 lektion". The lead teacher above takes
 * every lesson no row takes, and the summary under the rows says so in each
 * teacher's own minutes and share of the week — the faktor a tjänst is filled
 * by. A teacher whose user was deleted keeps the share with nobody in it, "Ej
 * tilldelad", until somebody is chosen or the row is removed.
 *
 * The rules are the gateway's (lib/lesson-shares.ts mirrors them): a share's
 * teacher is neither the lead nor the medlärare, a length the post has, no
 * more of a length than it has, and the lead keeps at least one lesson. The
 * one broken is said under the rows in a polite live region, and the page's
 * save button waits on `onValidity`. The add and remove buttons are
 * planering's (data-writes), so the läsare reads the shares without them.
 */

/** One row as the form holds it: text, as every number in the dialog is. */
export interface ShareDraft {
  /** A teacher's id, or the page's "nobody" sentinel. */
  teacherId: string;
  lessons: string;
  /** "" on a uniform post, whose lessons are all one length. */
  minutes: string;
  /**
   * A share stored with no teacher (theirs was deleted), shown as "Ej
   * tilldelad" and saved back as it is. A row added here needs a teacher.
   */
  kept?: boolean;
}

interface Person {
  id: string;
  firstName: string;
  lastName: string;
}

export function LessonSharesFields({
  value,
  onChange,
  first,
  extra,
  teacherId,
  coTeacherId,
  noTeacher,
  teachers,
  teacherLine,
  personName,
  onValidity,
}: {
  value: ShareDraft[];
  onChange: (next: ShareDraft[]) => void;
  /** The post's lessons as the dialog's length fields hold them. */
  first: DraftPart;
  extra: DraftPart[];
  /** The lead and the medlärare as chosen above, or `noTeacher`. */
  teacherId: string;
  coTeacherId: string;
  noTeacher: string;
  teachers: Person[];
  /** How a teacher reads in a picker: the page's name and candidate badge. */
  teacherLine: (teacher: Person) => ReactNode;
  /**
   * Anybody's name, active or not: a stored share may name a teacher who has
   * left, who is not among `teachers` and is shown as they are, marked.
   */
  personName: (id: string) => string | null;
  /** Whether the shares can be saved as they stand. */
  onValidity: (ok: boolean) => void;
}) {
  const t = useTranslations("requirements.shares");
  const tCommon = useTranslations("common");
  const idPrefix = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const [focusAdd, setFocusAdd] = useState(false);
  useEffect(() => {
    if (!focusAdd) return;
    addRef.current?.focus();
    setFocusAdd(false);
  }, [focusAdd, value.length]);

  const resolved = shapeFromDraft([first, ...extra]);
  const shape = resolved.shape;
  const lengths = shape ? lengthPartsOf(shape) : [];
  const mixed = lengths.length > 1;
  const lead = teacherId === noTeacher ? null : teacherId;
  const co = coTeacherId === noTeacher || coTeacherId === teacherId ? null : coTeacherId;
  const shares: LessonShare[] = value.map((draft) => ({
    teacherId: draft.teacherId === noTeacher ? null : draft.teacherId,
    lessons: draft.lessons.trim() === "" ? Number.NaN : Number(draft.lessons),
    minutes: mixed ? (draft.minutes.trim() === "" ? Number.NaN : Number(draft.minutes)) : (shape?.minutesPerLesson ?? Number.NaN),
  }));
  const row = shape ? { ...shape, teacherId: lead, coTeacherId: co } : null;
  // A row added here names a teacher: a share nobody teaches is only ever
  // one whose teacher was deleted, kept until somebody is chosen.
  const problem = row
    ? value.some((draft) => draft.teacherId === noTeacher && !draft.kept)
      ? "NO_TEACHER"
      : sharesProblem(row, shares)
    : null;
  const ok = row !== null && problem === null;
  useEffect(() => {
    onValidity(ok);
  }, [ok, onValidity]);

  const nameOf = (id: string | null) => {
    if (id === null) return tCommon("notAssigned");
    const person = teachers.find((teacher) => teacher.id === id);
    if (person) return `${person.firstName} ${person.lastName}`;
    const left = personName(id);
    return left ? t("inactiveTeacher", { name: left }) : tCommon("notAssigned");
  };
  const update = (index: number, patch: Partial<ShareDraft>) =>
    onChange(value.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  // A share's teacher is anybody but the lead and the medlärare; a teacher
  // another row names already is offered again only on a post of two
  // lengths, where one teacher may take one of each.
  const candidates = (index: number) =>
    teachers.filter(
      (teacher) =>
        teacher.id !== lead &&
        teacher.id !== co &&
        (mixed || !value.some((draft, i) => i !== index && draft.teacherId === teacher.id)),
    );
  const week = row ? weeklyMinutesOf(row) : 0;
  const parts = ok && row ? teacherPartsOf({ ...row, shares }) : [];

  return (
    <fieldset className="col-span-2 space-y-3 rounded-md border p-3" aria-describedby={`${idPrefix}-hint`}>
      <legend className="px-1 text-sm font-medium">{t("title")}</legend>
      <p id={`${idPrefix}-hint`} className="text-xs text-muted-foreground">
        {t("hint")}
      </p>
      {value.map((draft, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,1fr)_5rem_auto] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_5rem_6rem_auto]">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-teacher-${index}`}>{t("teacher")}</Label>
            <Select value={draft.teacherId} onValueChange={(next) => update(index, { teacherId: next })}>
              <SelectTrigger id={`${idPrefix}-teacher-${index}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={noTeacher}>{tCommon("notAssigned")}</SelectItem>
                {/* A stored teacher no longer among the active ones, kept as stored. */}
                {draft.teacherId !== noTeacher && !teachers.some((teacher) => teacher.id === draft.teacherId) ? (
                  <SelectItem value={draft.teacherId}>{nameOf(draft.teacherId)}</SelectItem>
                ) : null}
                {candidates(index).map((teacher) => (
                  <SelectItem key={teacher.id} value={teacher.id}>
                    {teacherLine(teacher)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-lessons-${index}`}>{t("lessons")}</Label>
            <Input
              id={`${idPrefix}-lessons-${index}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, (shape?.lessonsPerWeek ?? 2) - 1)}
              value={draft.lessons}
              onChange={(event) => update(index, { lessons: event.target.value })}
            />
          </div>
          {mixed ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${idPrefix}-minutes-${index}`}>{t("length")}</Label>
              <Select value={draft.minutes} onValueChange={(next) => update(index, { minutes: next })}>
                <SelectTrigger id={`${idPrefix}-minutes-${index}`}>
                  <SelectValue placeholder={t("lengthPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {lengths.map((part) => (
                    <SelectItem key={part.minutes} value={String(part.minutes)}>
                      {t("minutes", { minutes: part.minutes })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <Button
            data-writes="PLANERING"
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("remove", { teacher: nameOf(shares[index]!.teacherId) })}
            onClick={() => {
              onChange(value.filter((_, i) => i !== index));
              setFocusAdd(true);
            }}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        ref={addRef}
        data-writes="PLANERING"
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { teacherId: noTeacher, lessons: "1", minutes: "" }])}
      >
        <Plus className="mr-1 size-4" aria-hidden />
        {t("add")}
      </Button>
      <div aria-live="polite" className="text-xs">
        {!shape ? null : problem ? (
          <p className="text-destructive">{t(`problem.${problem}`)}</p>
        ) : parts.length > 1 ? (
          <ul className="space-y-0.5 text-muted-foreground">
            {parts.map((part) => (
              <li key={`${part.role}:${part.teacherId ?? "-"}`}>
                {t("part", {
                  teacher: nameOf(part.teacherId),
                  lessons: part.lessons,
                  of: shape.lessonsPerWeek,
                  minutes: part.minutes,
                  percent: week > 0 ? Math.round((100 * part.minutes) / week) : 0,
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </fieldset>
  );
}
