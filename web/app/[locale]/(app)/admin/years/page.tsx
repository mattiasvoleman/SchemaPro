"use client";

// Läsår: the school's years, which one is active, and the hand-over to the
// next.
//
// Every school does the same two things each year, months apart. In spring
// the active year is ROLLED (Rulla vidare, the wizard on ./rollover): next
// year is created with its classes promoted — 7A becomes 8A — and their
// timplansposter, teachers and weekly class rules carried, so next year's
// schedule can be planned while this one is still taught. In summer, once the
// old year has ended, the new one is ACTIVATED (the dialog here): the active
// flag is handed over and the pupils move into their new classes. The two are
// apart on purpose; see activation-dialog.tsx and src/year-rollover.
//
// This page is where both start, and where an admin sees which of the two is
// pending: a rolled year that is not active says how many pupils wait to move
// in and from which date it can be activated, read from the activation's own
// preview so the number is the one the dialog will show.
//
// Creating a year by hand stays on Kom igång (/admin/setup), which a school
// uses once; deleting one is here, because the undo of a rollover — before
// its activation — is deleting the year it made, and the gateway refuses the
// delete once pupils have their classes in it (YEAR_HAS_HOME_PUPILS).
//
// Only a COMING year is offered for deletion. A finished one holds the
// year's history: its classes cascade to their calendar lessons, and those to
// every närvaro record taken on them. After an activation nobody's home class
// is left in it, so the gateway's guard does not stop that delete, and one
// click would erase a year of frånvaro. A finished year that really must go
// is a job for support, not for this list.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, CalendarRange, GraduationCap, Trash2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useAcademicYears } from "@/lib/queries";
import type { MessageLookup } from "@/lib/engine-message";
import type { AcademicYear, ActivationPreview } from "@/lib/types";
import { successorOf, yearStatus, type YearStatus } from "@/lib/year-rollover-form";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActivationDialog } from "./activation-dialog";
import { useDeleteYear, usePendingActivations } from "./use-year-activation";
import { yearErrorText } from "./year-messages";

const STATUS_VARIANT: Record<YearStatus, "success" | "secondary" | "outline"> = {
  ACTIVE: "success",
  UPCOMING: "secondary",
  FINISHED: "outline",
};

/** Today in the reader's own calendar, as the dates on the page are written. */
function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Pupils the activation moves into one of the year's classes. */
const movingIn = (plan: ActivationPreview) => plan.moves.reduce((sum, move) => sum + move.count, 0);
/** Pupils it takes out of their class: graduates, and those with no class to go to. */
const leaving = (plan: ActivationPreview) => plan.graduates.count + plan.unplaced.count;
/** Every pupil whose home class the activation changes. */
const movingPupils = (plan: ActivationPreview) => movingIn(plan) + leaving(plan);

export default function YearsPage() {
  const t = useTranslations("years");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("years.errors") as unknown as MessageLookup;
  const { data: years, isLoading, isError } = useAcademicYears();
  const pending = usePendingActivations(years);
  const remove = useDeleteYear();
  const [activating, setActivating] = useState<AcademicYear | null>(null);
  const [deleting, setDeleting] = useState<AcademicYear | null>(null);

  const today = useMemo(localToday, []);
  const active = years?.find((year) => year.isActive) ?? null;
  const nameOf = (id: string | null) => years?.find((year) => year.id === id)?.name ?? null;

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      toast.success(t("deleted", { name: deleting.name }));
      setDeleting(null);
    } catch (error) {
      toast.error(yearErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Card className="mb-6">
        <CardContent className="flex gap-3 pt-6 text-sm text-muted-foreground">
          <CalendarRange className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{t("cycleHint")}</p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon("error")}
        </p>
      ) : !years || years.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title={t("emptyTitle")}
          description={t("emptyBody")}
          action={
            <Button asChild>
              <Link href="/admin/setup">{t("emptyAction")}</Link>
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("colYear")}</TableHead>
              <TableHead>{t("colPeriod")}</TableHead>
              <TableHead>{t("colStatus")}</TableHead>
              <TableHead>{t("colPupils")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {years.map((year) => {
              const status = yearStatus(year, active, today);
              const successor = successorOf(years, year.id);
              const plan = pending.get(year.id);
              const moving = plan ? movingPupils(plan) : 0;
              const tooEarly = plan?.problems.find((problem) => problem.code === "YEAR_ACTIVATION_TOO_EARLY");
              const predecessor = nameOf(year.predecessorId);
              return (
                <TableRow key={year.id}>
                  <TableCell>
                    <div className="font-medium">{year.name}</div>
                    {predecessor ? (
                      <div className="text-xs text-muted-foreground">
                        {t("rolledFrom", { name: predecessor })}
                      </div>
                    ) : null}
                    {successor ? (
                      <div className="text-xs text-muted-foreground">
                        {t("rolledTo", { name: successor.name })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {year.startDate} – {year.endDate}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[status]}>{t(`status.${status}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {plan && moving > 0 && year.isActive ? (
                      <div>{t("stragglers", { count: moving })}</div>
                    ) : plan && moving > 0 ? (
                      <>
                        {movingIn(plan) > 0 ? <div>{t("pendingMoves", { count: movingIn(plan) })}</div> : null}
                        {leaving(plan) > 0 ? (
                          <div className="text-xs text-muted-foreground">
                            {t("pendingLeaves", { count: leaving(plan) })}
                          </div>
                        ) : null}
                        {tooEarly ? (
                          <div className="text-xs text-muted-foreground">
                            {t("activatableAfter", {
                              year: String(tooEarly.params.year),
                              date: String(tooEarly.params.endDate),
                            })}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-2">
                      {status !== "FINISHED" && !successor ? (
                        moving > 0 ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled
                            title={t(year.isActive ? "rolloverNeedsStragglers" : "rolloverNeedsActivation")}
                          >
                            {t("rollover")}
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" asChild>
                            <Link href={`/admin/years/rollover?from=${year.id}`}>
                              {t("rollover")}
                              <ArrowRight />
                            </Link>
                          </Button>
                        )
                      ) : null}
                      {status === "UPCOMING" ? (
                        <Button size="sm" onClick={() => setActivating(year)}>
                          {t("activate")}
                        </Button>
                      ) : null}
                      {/* The active year's own activation, run again: it hands no
                          flag over and moves only the pupils left behind. */}
                      {year.isActive && moving > 0 ? (
                        <Button size="sm" onClick={() => setActivating(year)}>
                          {t("moveStragglers")}
                        </Button>
                      ) : null}
                      {status === "UPCOMING" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("deleteNamed", { name: year.name })}
                          onClick={() => setDeleting(year)}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <ActivationDialog
        // A fresh dialog per year: its "I understand" box starts unticked.
        key={activating?.id ?? "none"}
        year={activating}
        onOpenChange={(open) => {
          if (!open) setActivating(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("deleteTitle", { name: deleting?.name ?? "" })}
        description={t("deleteBody")}
        confirmLabel={tCommon("delete")}
        loading={remove.isPending}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
