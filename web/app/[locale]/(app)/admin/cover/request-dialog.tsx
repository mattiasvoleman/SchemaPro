"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { useCoverRequestActions, useLessonsCandidates } from "@/lib/cover-request-queries";
import { requestErrorText } from "@/lib/cover-request-errors";
import {
  MAX_REQUEST_RECIPIENTS,
  defaultExpiry,
  expiryChoices,
  rankColleagues,
} from "@/lib/cover-request-view";
import type { BoardItem, Candidates } from "@/lib/cover-types";
import { chainLookup, errorCode, pairKey, reasonText } from "@/lib/cover-view";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface RequestDialogProps {
  /** The pairs asked about (open, askable); null while closed. */
  items: BoardItem[] | null;
  /** "tis 14 okt 08:00–09:00 · Matematik · 7A": a pair's lesson in the board's own words. */
  describe: (item: BoardItem) => string;
  nameOf: (userId: string) => string;
  /** The board's minute clock: the lengths offered follow the first lesson's start. */
  now: number;
  onOpenChange: (open: boolean) => void;
  /** The question went out: the board drops the selection it was made from. */
  onSent?: () => void;
}

/**
 * Refusals that mean the lessons are no longer ones to ask about: the board
 * has been read again (the write settles it), so the dialog has nothing left
 * to send. A refused colleague (COVER_REQUEST_RECIPIENT_RULE) keeps it open:
 * choose somebody else.
 */
const LESSONS_MOVED = new Set([
  "COVER_REQUEST_EXISTS",
  "COVER_REQUEST_LESSON_COVERED",
  "COVER_REQUEST_LESSON_CANCELLED",
  "COVER_REQUEST_LESSON_STARTED",
  "COVER_NOT_AFFECTED",
]);

/**
 * "Fråga kollegor": ask chosen colleagues to cover one or more lessons. The
 * first who says yes gets ALL of them, so a colleague is offered only if the
 * ranking (the same one "Tillsätt vikarie" shows, with the same reasons) holds
 * them for every lesson; the gateway judges each colleague against each lesson
 * again when the question is sent. The question stands until the length the
 * administrator picks, never past the first lesson's start. No free text goes
 * with it: no reason for the absence, no message.
 */
export function RequestDialog({ items, describe, nameOf, now, onOpenChange, onSent }: RequestDialogProps) {
  const t = useTranslations("coverRequests");
  const tCandidates = useTranslations("coverCandidates");
  const tReasons = useTranslations("coverReasons") as unknown as MessageLookup;
  const tRequestErrors = useTranslations("coverRequests.errors") as unknown as MessageLookup;
  const tCoverErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { create } = useCoverRequestActions();

  const pairs = useMemo(() => items ?? [], [items]);
  const lessonIds = useMemo(() => [...new Set(pairs.map((item) => item.lessonId))], [pairs]);
  const results = useLessonsCandidates(lessonIds);
  const loading = lessonIds.length > 0 && results.some((result) => result.isLoading);
  const failed = results.some((result) => result.isError);
  const lists = results.map((result) => result.data).filter((data): data is Candidates => data !== undefined);
  const { ranked, cannot } = lists.length === lessonIds.length ? rankColleagues(lists) : { ranked: [], cannot: [] };

  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [expiryId, setExpiryId] = useState("");
  const signature = pairs.map(pairKey).join("|");
  useEffect(() => {
    setChosen(new Set());
    setExpiryId("");
  }, [signature]);

  const earliest = pairs.length > 0 ? Math.min(...pairs.map((item) => new Date(item.startsAt).getTime())) : now;
  const choices = expiryChoices(earliest, now);
  const expiry = choices.find((choice) => choice.id === expiryId) ?? defaultExpiry(choices);

  // Whoever was ticked and is still offered after the lists were read again.
  const recipients = ranked.filter((colleague) => chosen.has(colleague.userId)).map((colleague) => colleague.userId);
  const full = recipients.length >= MAX_REQUEST_RECIPIENTS;
  const tLookup = chainLookup(tRequestErrors, tCoverErrors);

  const toggle = (userId: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(userId);
      else next.delete(userId);
      return next;
    });

  const send = async () => {
    if (recipients.length === 0) return;
    try {
      await create.mutateAsync({
        lessons: pairs.map((item) => ({ lessonId: item.lessonId, absenceId: item.absenceId })),
        recipientIds: recipients,
        expiresInMinutes: expiry.minutes,
      });
      toast.success(t("sent", { count: recipients.length }));
      onSent?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(requestErrorText(tLookup, error, tCommon("error")));
      const code = errorCode(error);
      if (code && LESSONS_MOVED.has(code)) onOpenChange(false);
    }
  };

  return (
    <Dialog open={items !== null} onOpenChange={(open) => !create.isPending && onOpenChange(open)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { count: pairs.length })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <p className="text-sm font-medium">{t("lessonsLabel", { count: pairs.length })}</p>
          <ul className="space-y-0.5 text-sm text-muted-foreground">
            {pairs.map((item) => (
              <li key={pairKey(item)}>{describe(item)}</li>
            ))}
          </ul>
        </div>

        {/* A list that could not be read is said as such, never as "nobody is free". */}
        {loading ? (
          <div aria-busy="true">
            <Skeleton className="h-40 w-full" />
          </div>
        ) : failed ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : ranked.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty", { count: pairs.length })}</p>
        ) : (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("colleaguesLabel")}</legend>
            <p className="text-xs text-muted-foreground">{t("chooseHint")}</p>
            <ul className="space-y-2">
              {ranked.map((colleague) => {
                const checked = chosen.has(colleague.userId);
                const why = `cover-ask-${colleague.userId}-why`;
                return (
                  <li
                    key={colleague.userId}
                    className={cn("rounded-md border p-3 text-sm", checked && "border-primary ring-1 ring-primary")}
                  >
                    <label className="flex cursor-pointer flex-wrap items-center gap-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={checked}
                        disabled={!checked && full}
                        aria-describedby={why}
                        onChange={(event) => toggle(colleague.userId, event.target.checked)}
                      />
                      <span className="font-medium">{nameOf(colleague.userId)}</span>
                      {colleague.kind === "POOL" ? <Badge variant="secondary">{tCandidates("pool")}</Badge> : null}
                      <span className="ml-auto tabular-nums text-muted-foreground">
                        {tCandidates("score", { score: colleague.score })}
                      </span>
                    </label>
                    <div id={why}>
                      <ul className="mt-1 space-y-0.5">
                        {colleague.reasons.map((reason) => (
                          <li key={`${reason.code}-${JSON.stringify(reason.params)}`} className="flex justify-between gap-2">
                            <span>{reasonText(tReasons, reason)}</span>
                            <span className={cn("tabular-nums", reason.points < 0 ? "text-destructive" : "text-muted-foreground")}>
                              {reason.points > 0 ? `+${reason.points}` : reason.points}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        {tCandidates("counter", { week: colleague.counter.weekLessons, term: colleague.counter.termLessons })}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
            {full ? <p className="text-xs text-muted-foreground">{t("limit", { max: MAX_REQUEST_RECIPIENTS })}</p> : null}
          </fieldset>
        )}

        {!loading && !failed && cannot.length > 0 ? (
          <details className="rounded-md border px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium">{tCandidates("excludedTitle", { count: cannot.length })}</summary>
            <ul className="mt-2 space-y-1">
              {cannot.map((entry) => (
                <li key={entry.userId}>
                  <span className="font-medium">{nameOf(entry.userId)}</span>
                  {": "}
                  <span className="text-muted-foreground">
                    {entry.partial
                      ? t("notAll")
                      : entry.codes.map((code) => reasonText(tReasons, code)).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">{t("expiryLabel")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {choices.map((choice) => (
              <label key={choice.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="cover-request-expiry"
                  className="size-4"
                  checked={expiry.id === choice.id}
                  onChange={() => setExpiryId(choice.id)}
                />
                {t(`expiry.${choice.id}`, { count: pairs.length })}
              </label>
            ))}
          </div>
        </fieldset>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={() => void send()}
            disabled={recipients.length === 0 || create.isPending}
            data-writes="DRIFT"
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            {recipients.length > 0 ? t("sendCount", { count: recipients.length }) : t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
