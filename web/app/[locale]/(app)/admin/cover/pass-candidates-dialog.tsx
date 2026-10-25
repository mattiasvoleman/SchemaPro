"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { usePassCandidates } from "@/lib/cover-queries";
import type { PassBoardItem, PassCandidate } from "@/lib/cover-types";
import { reasonText } from "@/lib/cover-view";
import { otherPassTeacherOptions } from "@/lib/pass-view";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PassCandidatesDialogProps {
  item: PassBoardItem | null;
  /** "Skolgården, 10:00–10:20" — the pass in the board's own words. */
  passText: string;
  nameOf: (userId: string) => string;
  /** Every active teacher, for a pick outside the suggestions (warned, never refused). */
  teachers: { id: string; name: string }[];
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (item: PassBoardItem, substituteId: string) => void;
}

/** One candidate's line under their name: the week's and term's covers, lessons and passes. */
function CandidateFacts({ candidate }: { candidate: PassCandidate }) {
  const t = useTranslations("coverPasses");
  return (
    <p className="text-xs text-muted-foreground">
      {t("counter", {
        week: candidate.counter.weekLessons + candidate.counter.weekPasses,
        term: candidate.counter.termLessons + candidate.counter.termPasses,
      })}
    </p>
  );
}

/**
 * "Tillsätt vikarie" for an absent rastvakt's pass (GET
 * cover/supervision/:shiftId/:date/candidates): the ranked candidates, each
 * with the reasons its score is made of, and — the reason of an absence never
 * said — who could not and why. As the lesson's dialog (candidates-dialog.tsx),
 * with no behörighet or load: a pass has no subject and is not teaching.
 *
 * A pick outside the suggestions is warned, as for a lesson, except for
 * somebody busy with a lesson or another pass then, or away themself: the
 * gateway refuses them, and they are not offered.
 */
export function PassCandidatesDialog({
  item,
  passText,
  nameOf,
  teachers,
  pending,
  onOpenChange,
  onAssign,
}: PassCandidatesDialogProps) {
  const t = useTranslations("coverPasses");
  const tCandidates = useTranslations("coverCandidates");
  const tReasons = useTranslations("coverReasons") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { data, isLoading, isError } = usePassCandidates(item ? { shiftId: item.shiftId, date: item.date } : null);
  const [chosen, setChosen] = useState("");
  const [other, setOther] = useState("");

  useEffect(() => {
    setChosen("");
    setOther("");
  }, [item?.shiftId, item?.date]);

  const others = otherPassTeacherOptions(teachers, item, data);
  const pick = chosen || other;

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("candidatesTitle")}</DialogTitle>
          <DialogDescription>{t("candidatesBody", { pass: passText })}</DialogDescription>
        </DialogHeader>

        {/* A list that could not be read is said as such, never as "nobody is free". */}
        {isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : isError ? (
          <LoadError variant="inline" title={tCandidates("loadFailed")} hint={t("candidatesLoadFailedHint")} />
        ) : (data?.candidates ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("candidatesEmpty")}</p>
        ) : (
          <ul className="space-y-2" aria-label={tCandidates("listLabel")}>
            {(data?.candidates ?? []).map((candidate) => {
              const selected = chosen === candidate.userId;
              const choose = () => {
                setChosen(candidate.userId);
                setOther("");
              };
              const why = `pass-candidate-${candidate.userId}-why`;
              return (
                <li
                  key={candidate.userId}
                  onClick={choose}
                  className={cn(
                    "cursor-pointer rounded-md border p-3 text-sm transition-colors hover:bg-accent/50",
                    selected && "border-primary ring-1 ring-primary",
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    aria-label={[
                      nameOf(candidate.userId),
                      candidate.kind === "POOL" ? tCandidates("pool") : null,
                      tCandidates("score", { score: candidate.score }),
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-describedby={why}
                    onClick={(event) => {
                      event.stopPropagation();
                      choose();
                    }}
                    className="flex w-full flex-wrap items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="font-medium">{nameOf(candidate.userId)}</span>
                    {candidate.kind === "POOL" ? <Badge variant="secondary">{tCandidates("pool")}</Badge> : null}
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {tCandidates("score", { score: candidate.score })}
                    </span>
                  </button>
                  <div id={why}>
                    <ul className="mt-1 space-y-0.5">
                      {candidate.reasons.map((reason) => (
                        <li key={`${reason.code}:${JSON.stringify(reason.params)}`} className="flex justify-between gap-2">
                          <span>{reasonText(tReasons, reason)}</span>
                          <span
                            className={cn(
                              "tabular-nums",
                              reason.points < 0 ? "text-destructive" : "text-muted-foreground",
                            )}
                          >
                            {reason.points > 0 ? `+${reason.points}` : reason.points}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <CandidateFacts candidate={candidate} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {(data?.excluded ?? []).length > 0 ? (
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              {tCandidates("excludedTitle", { count: data!.excluded.length })}
            </summary>
            <ul className="mt-2 space-y-1">
              {data!.excluded.map((entry) => (
                <li key={entry.userId}>
                  <span className="font-medium">{nameOf(entry.userId)}</span>
                  {": "}
                  <span className="text-muted-foreground">
                    {entry.codes.map((code) => reasonText(tReasons, code)).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="pass-other">{tCandidates("other")}</Label>
          <NativeSelect
            id="pass-other"
            aria-describedby="pass-other-hint"
            value={other}
            onChange={(event) => {
              setOther(event.target.value);
              if (event.target.value) setChosen("");
            }}
          >
            <option value="">{tCommon("select")}</option>
            {others.map((teacher) => (
              <option key={teacher.id} value={teacher.id}>
                {teacher.name}
              </option>
            ))}
          </NativeSelect>
          <p id="pass-other-hint" className="text-xs text-muted-foreground">
            {t("otherHint")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => item && pick && onAssign(item, pick)} disabled={!pick || pending} data-writes="DRIFT">
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {tCandidates("assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
