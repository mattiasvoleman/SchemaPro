"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { useAckActions, useAckDetail } from "@/lib/ack-queries";
import {
  ACK_NOT_FOUND,
  ACK_NOT_STAFF,
  metIn,
  pupilStanding,
  pupilsNotMet,
  reminderOf,
  type AckGuardianRow,
  type AckPupilRow,
} from "@/lib/ack";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAckText } from "./use-ack-text";

const STANDING_BADGE = { MET: "success", WAITING: "warning", NOBODY: "secondary" } as const;
const STANDING_KEY = { MET: "pupilMet", WAITING: "pupilWaiting", NOBODY: "pupilNobody" } as const;

/**
 * One request as its sender reads it: the text, the rule and the reminder, and
 * for each pupil whether they are done and, for each guardian, whether they
 * confirmed (and when), still can, or no longer are a guardian of the pupil.
 *
 * The gateway answers this per reader and records the reading in the läslogg, so
 * it is read when the request is opened and not kept. Only the staff reach it:
 * the guardian's own page never asks, and has no field for another guardian.
 *
 * The reminder line is the gateway's state (reminderOf), never worked out from
 * whether a moment is set. A reminder still to go can be stopped by the one who
 * wrote the request or by an administrator (`mayStopReminder`, the gateway's
 * say): a button that asks once, on the page and not in a dialog (see AckStaff),
 * since the answer cannot be taken back. A 403 or a 404 to it says the page is
 * out of date, and the request is read again.
 */
export function AckDetailView({
  id,
  title,
  onBack,
}: {
  id: string;
  /** The title the list already showed: the heading while the rest is read. */
  title: string;
  onBack: () => void;
}) {
  const { t, moment } = useAckText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const query = useAckDetail(id);
  const { stopReminder } = useAckActions();
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [stopped, setStopped] = useState<"STOPPED" | "ALREADY" | null>(null);
  const [problem, setProblem] = useState<"failed" | "stale" | null>(null);
  // Focus follows the button that was pressed: the question takes it, and the button gets it back (a count, so
  // that asking twice for one place moves it twice).
  const [giveBack, setGiveBack] = useState(0);
  const detail = query.data;
  const cancelButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (asking) cancelButton.current?.focus();
  }, [asking]);
  useEffect(() => {
    if (giveBack > 0) stopButton.current?.focus();
  }, [giveBack]);
  useEffect(() => {
    if (stopped) result.current?.focus();
  }, [stopped]);

  const stop = async () => {
    if (stopReminder.isPending) return;
    setProblem(null);
    try {
      const answer = await stopReminder.mutateAsync(id);
      setStopped(answer.reminder === "STOPPED" ? "STOPPED" : "ALREADY");
      setAsking(false);
    } catch (error) {
      setProblem(error instanceof ApiError && (error.code === ACK_NOT_FOUND || error.code === ACK_NOT_STAFF) ? "stale" : "failed");
      setAsking(false);
      setGiveBack((count) => count + 1);
    }
  };

  const guardianState = (guardian: AckGuardianRow): string => {
    if (guardian.state === "CONFIRMED") {
      return t("detail.guardianConfirmed", { moment: guardian.ackedAt ? moment(guardian.ackedAt) : "" });
    }
    return t(guardian.state === "WAITING" ? "detail.guardianWaiting" : "detail.guardianEnded");
  };

  const reminder = (): string => {
    if (!detail) return "";
    const kind = reminderOf(detail);
    // The moment a reminder went, or the one it is due: the other states have none to say.
    const at = kind === "SENT" ? detail.reminderSentAt : kind === "SCHEDULED" ? detail.remindAt : null;
    return t(`detail.reminderState.${kind}`, { moment: at ? moment(at) : "" });
  };

  const stopControls = () => {
    if (!detail) return null;
    if (stopped) {
      return (
        <p ref={result} tabIndex={-1} role="status" className="outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t(stopped === "STOPPED" ? "detail.stop.done" : "detail.stop.already")}
        </p>
      );
    }
    const may = detail.mayStopReminder && !readOnly;
    return (
      <>
        {may && asking ? (
          <div role="group" aria-labelledby="ack-stop-question" className="space-y-2 rounded-md border p-3">
            <p id="ack-stop-question" className="font-medium">
              {t("detail.stop.ask")}
            </p>
            <p className="text-muted-foreground">{t("detail.stop.askHint")}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="destructive" disabled={stopReminder.isPending} onClick={() => void stop()}>
                {stopReminder.isPending ? t("detail.stop.stopping") : t("detail.stop.confirm")}
              </Button>
              <Button
                ref={cancelButton}
                type="button"
                size="sm"
                variant="outline"
                disabled={stopReminder.isPending}
                onClick={() => {
                  setAsking(false);
                  setGiveBack((count) => count + 1);
                }}
              >
                {tCommon("cancel")}
              </Button>
            </div>
          </div>
        ) : may ? (
          <div>
            <Button
              ref={stopButton}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setProblem(null);
                setAsking(true);
              }}
              data-writes="DRIFT"
            >
              {t("detail.stop.button")}
            </Button>
          </div>
        ) : null}
        {problem ? (
          <Notice tone={problem === "stale" ? "warning" : "destructive"} role="alert" title={t(`detail.stop.${problem}Title`)}>
            {t(`detail.stop.${problem}`)}
          </Notice>
        ) : null}
      </>
    );
  };

  const row = (pupil: AckPupilRow) => {
    const standing = pupilStanding(pupil);
    return (
      <li key={pupil.id} className="rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {pupil.name}
            {pupil.className ? <span className="font-normal text-muted-foreground"> · {pupil.className}</span> : null}
          </p>
          <Badge variant={STANDING_BADGE[standing]}>{t(`detail.${STANDING_KEY[standing]}`)}</Badge>
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {pupil.guardians.map((guardian) => (
            <li key={guardian.id} className="flex flex-wrap justify-between gap-x-4">
              <span>{guardian.name}</span>
              <span className="text-muted-foreground">
                {guardianState(guardian)}
                {guardian.remindedAt ? ` · ${t("detail.guardianReminded", { moment: moment(guardian.remindedAt) })}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </li>
    );
  };

  const body = () => {
    if (query.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      );
    }
    if (query.error instanceof ApiError && query.error.code === ACK_NOT_FOUND) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          headingLevel={3}
          title={t("detail.notFoundTitle")}
          description={t("detail.notFound")}
        />
      );
    }
    if (query.isError || !detail) {
      return <LoadError variant="inline" title={t("detail.loadFailed")} hint={t("detail.loadFailedHint")} />;
    }
    const shown = onlyWaiting ? pupilsNotMet(detail.pupils) : detail.pupils;
    return (
      <>
        <p className="whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-sm">{detail.body}</p>
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t("detail.rule")}</dt>
          <dd>{t(`rule.${detail.rule}.label`)}</dd>
          <dt className="text-muted-foreground">{t("detail.sent")}</dt>
          <dd>{t("detail.sentValue", { moment: moment(detail.createdAt), author: detail.authorName })}</dd>
          <dt className="text-muted-foreground">{t("detail.reminder")}</dt>
          <dd className="space-y-2">
            <p>{reminder()}</p>
            {stopControls()}
          </dd>
        </dl>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div className="space-y-0.5">
            <h3 className="text-sm font-semibold">{t("detail.pupilsTitle")}</h3>
            <p className="text-sm text-muted-foreground">
              {t("detail.summary", { met: metIn(detail), pupils: detail.pupils.length })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="ack-only-waiting" checked={onlyWaiting} onCheckedChange={setOnlyWaiting} />
            <Label htmlFor="ack-only-waiting">{t("detail.onlyWaiting")}</Label>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("detail.allMet")}
          </p>
        ) : (
          <ul className="space-y-2">{shown.map(row)}</ul>
        )}
      </>
    );
  };

  return (
    <SectionCard
      id="ack-detail"
      title={title}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t("detail.back")}
        </Button>
      }
    >
      {body()}
    </SectionCard>
  );
}
