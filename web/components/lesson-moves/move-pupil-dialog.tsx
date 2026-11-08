"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { coverErrorText } from "@/lib/cover-view";
import type { MoveCandidate } from "@/lib/lesson-moves";
import { useMoveCandidates, useMovablePupils, useMovePupil } from "@/lib/lesson-moves-queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Elevens lektion för dagen: move one pupil of a lesson to a parallel lesson,
 * for the lesson's date. Opened on a lesson (the register's, the day planner's
 * or the klassbok's); the pupil is chosen from the lesson's list (the whole
 * list for an administrator and for a teacher of the lesson, the pupils they
 * mentor for a mentor), then the lesson from the ones that overlap it.
 *
 * Every lesson that does not take the pupil is listed with its reason, as a
 * named sentence, because a list that leaves them out leaves the teacher
 * wondering where Engelska went. A room that would be over its capacity is a
 * warning on the lesson and never a refusal.
 */
export function MovePupilDialog({
  lessonId,
  open,
  onOpenChange,
  studentId,
}: {
  lessonId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pupil, when the opener knows already; otherwise the dialog asks. */
  studentId?: string;
}) {
  const t = useTranslations("lessonMoves");
  const tErrors = useTranslations("lessonMoves.errors");
  const tCommon = useTranslations("common");
  const pupils = useMovablePupils(lessonId, open && studentId === undefined);
  const [pickedPupil, setPickedPupil] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const move = useMovePupil();
  const chosenPupil = studentId ?? pickedPupil;
  const candidates = useMoveCandidates(lessonId, open ? chosenPupil : null);

  const reset = () => {
    setPickedPupil(null);
    setTarget(null);
  };
  const close = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };
  const free = candidates.data?.candidates.filter((candidate) => candidate.refusal === null) ?? [];
  const chosen = free.find((candidate) => candidate.id === target) ?? null;

  const submit = async () => {
    if (!chosenPupil || !chosen || move.isPending) return;
    try {
      const result = await move.mutateAsync({ studentId: chosenPupil, fromLessonId: lessonId, toLessonId: chosen.id });
      toast.success(t("moved"));
      for (const warning of result.warnings) {
        toast.warning(t(`warning.${warning.code}`, { headcount: warning.headcount, capacity: warning.capacity }));
      }
      close(false);
    } catch (error) {
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {studentId === undefined ? (
          <FormField id="move-pupil" label={t("pupil")}>
            {(control) =>
              pupils.isError ? (
                <LoadError variant="inline" title={t("pupilsFailed")} hint={t("pupilsFailedHint")} />
              ) : pupils.isLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (pupils.data?.length ?? 0) === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noPupils")}</p>
              ) : (
                <Select
                  value={pickedPupil ?? ""}
                  onValueChange={(value) => {
                    setPickedPupil(value);
                    setTarget(null);
                  }}
                >
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={t("pupilPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {pupils.data!.map((pupil) => (
                      <SelectItem key={pupil.id} value={pupil.id}>
                        {pupil.firstName} {pupil.lastName}
                        {pupil.arrived ? ` (${t("arrived")})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          </FormField>
        ) : null}

        {chosenPupil ? (
          candidates.isError ? (
            <LoadError variant="inline" title={t("candidatesFailed")} hint={t("candidatesFailedHint")} />
          ) : !candidates.data ? (
            <div aria-busy="true">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("candidates", { subject: candidates.data.from.subject, start: candidates.data.from.start, end: candidates.data.from.end })}</legend>
              {candidates.data.candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noCandidates")}</p>
              ) : (
                <ul className="space-y-1.5">
                  {candidates.data.candidates.map((candidate) => (
                    <CandidateRow key={candidate.id} candidate={candidate} checked={target === candidate.id} onPick={() => setTarget(candidate.id)} />
                  ))}
                </ul>
              )}
            </fieldset>
          )
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            {tCommon("cancel")}
          </Button>
          <Button data-writes="DRIFT" disabled={!chosen || move.isPending} onClick={() => void submit()}>
            {move.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({ candidate, checked, onPick }: { candidate: MoveCandidate; checked: boolean; onPick: () => void }) {
  const t = useTranslations("lessonMoves");
  const refused = candidate.refusal !== null;
  const id = `move-target-${candidate.id}`;
  const detail = [
    `${candidate.start}–${candidate.end}`,
    candidate.room,
    t("headcount", { count: candidate.headcount }),
    candidate.roomCapacity !== null ? t("capacity", { count: candidate.roomCapacity }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex items-start gap-3 rounded-md border px-3 py-2 has-[:disabled]:opacity-70">
      <input
        id={id}
        type="radio"
        name="move-target"
        className="mt-1 size-4"
        checked={checked}
        disabled={refused}
        aria-describedby={`${id}-detail`}
        onChange={onPick}
      />
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={id} className="text-sm font-medium">
          {candidate.subject} · {candidate.className}
        </label>
        <p id={`${id}-detail`} className="text-sm text-muted-foreground">
          {refused ? t(`refusal.${candidate.refusal!.code}`, { side: candidate.refusal!.side ?? "TO" }) : detail}
        </p>
        {candidate.warnings.map((warning) => (
          <Badge key={warning.code} variant="warning">
            {t(`warning.${warning.code}`, { headcount: warning.headcount, capacity: warning.capacity })}
          </Badge>
        ))}
      </div>
    </li>
  );
}
