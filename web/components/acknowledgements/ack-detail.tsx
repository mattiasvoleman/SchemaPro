"use client";

import { useState } from "react";
import { ArrowLeft, ClipboardCheck } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useAckDetail } from "@/lib/ack-queries";
import { ACK_NOT_FOUND, metIn, pupilStanding, pupilsNotMet, type AckGuardianRow, type AckPupilRow } from "@/lib/ack";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
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
  const query = useAckDetail(id);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const detail = query.data;

  const guardianState = (guardian: AckGuardianRow): string => {
    if (guardian.state === "CONFIRMED") {
      return t("detail.guardianConfirmed", { moment: guardian.ackedAt ? moment(guardian.ackedAt) : "" });
    }
    return t(guardian.state === "WAITING" ? "detail.guardianWaiting" : "detail.guardianEnded");
  };

  const reminder = (): string => {
    if (!detail) return "";
    if (detail.reminderSentAt) return t("detail.reminderSent", { moment: moment(detail.reminderSentAt) });
    if (detail.remindAt) return t("detail.reminderDue", { moment: moment(detail.remindAt) });
    return t("detail.reminderNone");
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
          <dd>{reminder()}</dd>
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
