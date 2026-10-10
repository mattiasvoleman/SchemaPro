"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useCoverCandidates } from "@/lib/cover-queries";
import type { BoardItem, Candidate } from "@/lib/cover-types";
import { otherTeacherOptions, reasonText } from "@/lib/cover-view";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const NATIVE_SELECT =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export interface CandidatesDialogProps {
  item: BoardItem | null;
  /** "Matematik, 7A, 08:00–09:00" — the lesson in the board's own words. */
  lessonText: string;
  nameOf: (userId: string) => string;
  /** Every active teacher, for a pick outside the suggestions (warned, never refused). */
  teachers: { id: string; name: string }[];
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onAssign: (item: BoardItem, substituteId: string) => void;
}

/** One candidate's line under their name: the week's and term's covers, and the week's load. */
function CandidateFacts({ candidate }: { candidate: Candidate }) {
  const t = useTranslations("coverCandidates");
  const load =
    candidate.load.targetMinutes !== null
      ? t("loadTarget", { minutes: candidate.load.weekMinutes, target: candidate.load.targetMinutes })
      : t("load", { minutes: candidate.load.weekMinutes });
  return (
    <p className="text-xs text-muted-foreground">
      {t("counter", { week: candidate.counter.weekLessons, term: candidate.counter.termLessons })} · {load}
    </p>
  );
}

/**
 * "Tillsätt vikarie": the ranked candidates for one pair (GET
 * cover/lessons/:id/candidates), each with the reasons its score is made of
 * in plain language, and — admin only, the reason never said — who could not
 * and why.
 *
 * Every suggestion keeps every hard rule (free then, lunch and daily rest
 * kept, not absent, inside a pool member's declared hours). A pick outside
 * them is still possible under "Annan lärare": the gateway warns, as it does
 * for behörighet — except for somebody with a lesson of their own then or
 * away themself, whom it refuses and who is therefore not offered.
 */
export function CandidatesDialog({
  item,
  lessonText,
  nameOf,
  teachers,
  pending,
  onOpenChange,
  onAssign,
}: CandidatesDialogProps) {
  const t = useTranslations("coverCandidates");
  const tReasons = useTranslations("coverReasons") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { data, isLoading } = useCoverCandidates(item?.lessonId ?? null);
  const [chosen, setChosen] = useState("");
  const [other, setOther] = useState("");

  useEffect(() => {
    setChosen("");
    setOther("");
  }, [item?.lessonId, item?.absenceId]);

  const others = otherTeacherOptions(teachers, item, data);
  const pick = chosen || other;

  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { lesson: lessonText })}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (data?.candidates ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="space-y-2" aria-label={t("listLabel")}>
            {(data?.candidates ?? []).map((candidate) => {
              const selected = chosen === candidate.userId;
              return (
                <li key={candidate.userId}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setChosen(candidate.userId);
                      setOther("");
                    }}
                    className={cn(
                      "w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-accent/50",
                      selected && "border-primary ring-1 ring-primary",
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{nameOf(candidate.userId)}</span>
                      {candidate.kind === "POOL" ? <Badge variant="secondary">{t("pool")}</Badge> : null}
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {t("score", { score: candidate.score })}
                      </span>
                    </span>
                    <ul className="mt-1 space-y-0.5">
                      {candidate.reasons.map((reason) => (
                        <li key={reason.code} className="flex justify-between gap-2">
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
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {(data?.excluded ?? []).length > 0 ? (
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">
              {t("excludedTitle", { count: data!.excluded.length })}
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

        <div className="space-y-1">
          <Label htmlFor="cover-other">{t("other")}</Label>
          <select
            id="cover-other"
            className={NATIVE_SELECT}
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
          </select>
          <p className="text-xs text-muted-foreground">{t("otherHint")}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => item && pick && onAssign(item, pick)} disabled={!pick || pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {t("assign")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
