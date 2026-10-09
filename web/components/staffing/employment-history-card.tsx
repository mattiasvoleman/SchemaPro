"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { useEmploymentHistory } from "@/lib/staffing-history-queries";
import {
  actorLabel,
  dutyLabelOf,
  formatStamp,
  historyLines,
  type HistoryLabels,
} from "@/lib/employment-history-view";
import { Button } from "@/components/ui/button";

export interface EmploymentHistoryCardProps {
  userId: string;
  academicYearId: string;
  /** A person's name from the admin's people list, or null when it has none. */
  personName: (userId: string) => string | null;
  subjectName: (subjectId: string) => string | null;
  groupName: (groupId: string) => string | null;
  /** Today's label of an uppdrag, for an UPDATE whose version does not carry it. */
  dutyLabel?: (dutyId: string) => string | null;
}

/**
 * Historik (staffing Fas 3): the teacher's tjänst for the läsår, version by
 * version, as TeacherEmploymentLogs recorded it — every write to the post or
 * an uppdrag, by whoever and through whichever door (this page, an import,
 * the rollover, PostgREST), in the same transaction as the write.
 *
 * So a samverkan protokoll can cite one: each entry says "Version 7", the
 * school-local time, who did it and what changed. The numbers are per teacher
 * and year and never reused (the log is append-only), so "Version 7" names
 * the same thing next year.
 *
 * OPENS COLLAPSED, and the read happens on the first unfold: the drawer is
 * opened for the bar and the post, and a history nobody looked at is a query
 * nobody needed. Admin-only in the UI (it lives in the drawer); a teacher's
 * own history is the uppdragsbeskrivning's version stamp.
 */
export function EmploymentHistoryCard({
  userId,
  academicYearId,
  personName,
  subjectName,
  groupName,
  dutyLabel,
}: EmploymentHistoryCardProps) {
  const t = useTranslations("staffing.history");
  const tStaffing = useTranslations("staffing");
  const { school } = useProfile();
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const [open, setOpen] = useState(false);
  const history = useEmploymentHistory(userId, academicYearId, open);

  const labels: HistoryLabels = {
    field: (_entity, field) => (t.has(`field.${field}`) ? t(`field.${field}`) : null),
    contract: (kind) => (tStaffing.has(`contract${kind}`) ? tStaffing(`contract${kind}`) : kind),
    dutyKind: (kind) => (tStaffing.has(`dutyKind${kind}`) ? tStaffing(`dutyKind${kind}`) : kind),
    subject: subjectName,
    group: groupName,
    minutes: (minutes) => t("minutes", { minutes }),
    percent: (percent) => t("percent", { percent }),
    yes: t("yes"),
    no: t("no"),
    empty: "—",
    removed: t("removed"),
    blocked: t("blocked"),
    noteChanged: t("noteChanged"),
  };

  const entries = history.data?.entries ?? [];

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="history-title">
      <div className="flex items-center justify-between gap-2">
        <h3 id="history-title" className="flex items-center gap-2 font-semibold">
          <History className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("title")}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="history-body"
        >
          {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          {open ? t("hide") : t("show")}
        </Button>
      </div>
      {open ? (
        <div id="history-body" className="mt-2 text-sm">
          {history.isLoading ? (
            <p className="text-muted-foreground">{t("loading")}</p>
          ) : history.isError ? (
            <p className="text-destructive">{t("loadFailed")}</p>
          ) : entries.length === 0 ? (
            <p>{t("empty")}</p>
          ) : (
            <ol className="divide-y">
              {entries.map((entry) => {
                const label =
                  dutyLabelOf(entry) ?? (entry.entity === "DUTY" ? (dutyLabel?.(entry.entityId) ?? null) : null);
                const title = t(`action.${entry.entity}_${entry.action}`);
                return (
                  <li key={entry.id} className="space-y-0.5 py-2">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{t("version", { version: entry.version })}</span>
                      <span className="text-muted-foreground">
                        {formatStamp(entry.createdAt, timeZone)} ·{" "}
                        {actorLabel(entry.actorId, personName, {
                          system: t("system"),
                          deleted: t("deletedUser"),
                        })}
                      </span>
                    </p>
                    <p>{label ? `${title}: ${label}` : title}</p>
                    <ul className="text-muted-foreground">
                      {historyLines(entry, labels).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ol>
          )}
          {history.data?.truncated ? (
            <p className="mt-2 text-xs text-muted-foreground">{t("truncated")}</p>
          ) : null}
          <p className="mt-2 text-xs text-muted-foreground">{t("caption")}</p>
        </div>
      ) : null}
    </section>
  );
}
