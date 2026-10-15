"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Send, Trash2, Users } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import {
  useAbsenceReportActions,
  useAbsenceReports,
  useLeaveRequestActions,
  useLeaveRequests,
  useMyChildren,
} from "@/lib/guardian-queries";
import { lastLeaveDay, leaveRequestError } from "@/lib/leave-errors";
import { LEAVE_STATUS_VARIANT } from "@/lib/status-variants";
import type { AbsenceReport, AbsenceReportType } from "@/lib/types";
import { toDateString } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";

const TYPES: AbsenceReportType[] = ["SICK", "APPOINTMENT", "OTHER"];

/*
 * "Undervisningstid" (timplan P4): each child's hours over their current
 * stadium, as the school published them. Fetched after the page with lazy()
 * — this route is in the core tier, and the card is not what the page is
 * for — and a chunk that does not arrive renders nothing: an optional card
 * must never take the absence report away.
 */
const TeachingTimeCard = lazy(() =>
  import("@/components/teaching-time-card").then(
    (module) => ({ default: module.TeachingTimeCard }),
    () => ({ default: () => null }),
  ),
);

/*
 * "Schema": each child's published week (elev- och vårdnadshavarytan). Lazy
 * for the same reason as the card above — the core tier's budget — and with
 * the same fallback: the absence report must not depend on a chunk arriving.
 * The card, its hook and its mappers all ride in that chunk.
 */
const ChildSchedule = lazy(() =>
  import("@/components/guardian/child-schedule").then(
    (module) => ({ default: module.ChildSchedule }),
    () => ({ default: () => null }),
  ),
);

/*
 * The confirmation before a report is taken back, fetched on its first open:
 * /guardian is the heaviest route of its tier, and Radix Dialog is in none of
 * its chunks. A chunk that does not arrive is said in a toast, and the next
 * open fetches afresh.
 */
const lazyConfirmDialog = () =>
  lazy(() => import("@/components/ui/confirm-dialog").then((module) => ({ default: module.ConfirmDialog })));
let ConfirmDialog = lazyConfirmDialog();

/** The guardian's own day: before 02:00 in Sweden UTC is still yesterday. */
function todayISO(): string {
  return toDateString(new Date());
}

export default function GuardianPage() {
  const t = useTranslations("guardian");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { profile, school } = useProfile();
  // Only a guardian is asked for children: the gateway answers the read for
  // a guardian alone, and refuses any other role that opens this page. That
  // role sees "no children", as it did when the read was PostgREST's and
  // came back empty, not a load failure.
  const { data: children, isLoading, isError } = useMyChildren(
    profile.role === "GUARDIAN" ? profile.id : null,
  );
  const reportsQuery = useAbsenceReports();
  const leavesQuery = useLeaveRequests();
  const absenceActions = useAbsenceReportActions();
  const leaveActions = useLeaveRequestActions();
  const reports = reportsQuery.data ?? [];
  const leaves = leavesQuery.data ?? [];

  const [childId, setChildId] = useState<string>("");
  const [date, setDate] = useState(todayISO());
  const [fullDay, setFullDay] = useState(true);
  const [startTime, setStartTime] = useState("08:00");
  const [endTime, setEndTime] = useState("12:00");
  const [type, setType] = useState<AbsenceReportType>("SICK");
  const [note, setNote] = useState("");

  const [leaveChildId, setLeaveChildId] = useState<string>("");
  const [leaveStart, setLeaveStart] = useState(todayISO());
  const [leaveEnd, setLeaveEnd] = useState(todayISO());
  const [leaveReason, setLeaveReason] = useState("");

  // The report a confirmation is about stays set while the dialog closes, so
  // its title does not empty under the fade.
  const [deleting, setDeleting] = useState<AbsenceReport | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);
  const [confirmLoad, setConfirmLoad] = useState(0);

  const childById = useMemo(
    () => new Map((children ?? []).map((child) => [child.id, child])),
    [children],
  );
  // The schedule's children: a pupil who has left is still a link, but the
  // gateway answers their week with 404, so the card would offer a child
  // (even by default) whose week can never load.
  const activeChildren = (children ?? []).filter((child) => child.isActive);
  const selectedChildId = childId || (children?.[0]?.id ?? "");
  const selectedLeaveChildId = leaveChildId || (children?.[0]?.id ?? "");

  const childName = (id: string) => {
    const child = childById.get(id);
    return child ? `${child.firstName} ${child.lastName}` : "—";
  };

  // A report's day and a leave's span are dates, not instants: written in the
  // reader's language, read on the UTC noon of that day so no timezone moves them.
  const dates = useMemo(() => {
    const tag = locale === "en" ? "en-GB" : "sv-SE";
    return {
      day: new Intl.DateTimeFormat(tag, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
      span: new Intl.DateTimeFormat(tag, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    };
  }, [locale]);
  const noon = (value: string) => new Date(`${value.slice(0, 10)}T12:00:00Z`);
  const dayText = (value: string) => dates.day.format(noon(value));
  const spanText = (from: string, to: string) =>
    from.slice(0, 10) === to.slice(0, 10)
      ? dates.span.format(noon(from))
      : dates.span.formatRange(noon(from), noon(to));

  const doReport = async () => {
    if (!selectedChildId) return;
    try {
      await absenceActions.report.mutateAsync({
        studentId: selectedChildId,
        date,
        ...(fullDay ? {} : { startTime, endTime }),
        type,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.success(t("reported"));
      setNote("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doRequestLeave = async () => {
    if (!selectedLeaveChildId || leaveReason.trim().length < 3) return;
    try {
      await leaveActions.request.mutateAsync({
        studentId: selectedLeaveChildId,
        startDate: leaveStart,
        endDate: leaveEnd,
        reason: leaveReason.trim(),
      });
      toast.success(t("leaveSubmitted"));
      setLeaveReason("");
    } catch (error) {
      toast.error(
        leaveRequestError(error, {
          tooLong: (days) => t("leaveTooLong", { days }),
          endsBeforeStart: t("leaveEndsBeforeStart"),
          fallback: tCommon("error"),
        }),
      );
    }
  };

  const doDeleteReport = async (id: string) => {
    try {
      await absenceActions.remove.mutateAsync(id);
      toast.success(tCommon("deleted"));
      setConfirmOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const askDelete = (report: AbsenceReport) => {
    setConfirmUsed(true);
    setDeleting(report);
    setConfirmOpen(true);
  };

  const header = <PageHeader title={t("title")} subtitle={t("subtitle")} />;

  if (isLoading) {
    return (
      <Page>
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
    );
  }

  // Never "Inga barn kopplade" for a read that failed: a guardian would call
  // the school about a link that is there.
  if (isError) {
    return (
      <Page>
        {header}
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      </Page>
    );
  }

  if ((children ?? []).length === 0) {
    return (
      <Page>
        {header}
        <EmptyState
          icon={Users}
          title={t("noChildrenTitle")}
          description={t("noChildrenBody")}
          headingLevel={2}
        />
      </Page>
    );
  }

  const childOptions = (children ?? []).map((child) => (
    <option key={child.id} value={child.id}>
      {child.firstName} {child.lastName}
    </option>
  ));

  return (
    <Page>
      {header}

      {/* The guardian's own children only: the gateway answers a guardian
          for their linked children and refuses anyone else's with the same
          404 as an unknown id. Another role opening this page asks nothing. */}
      {profile.role === "GUARDIAN" && activeChildren.length > 0 ? (
        <Suspense fallback={null}>
          <ChildSchedule childList={activeChildren} school={school?.name ?? ""} />
        </Suspense>
      ) : null}

      {/* In the manual's order — report, what was reported, ask for leave,
          what was asked — so a phone reads each form with its own list
          under it, and a wide screen sets each list beside its form.
          items-start: a short list keeps its own height instead of
          stretching to the form's beside it. */}
      <div className="grid items-start gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <SectionCard id="absence-report" title={t("reportTitle")} description={t("reportBody")}>
          <div className="space-y-4">
            <FormField id="absence-child" label={t("child")}>
              <NativeSelect value={selectedChildId} onChange={(e) => setChildId(e.target.value)}>
                {childOptions}
              </NativeSelect>
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="absence-date" label={t("date")}>
                <DateField
                  label={t("date")}
                  id="absence-date"
                  min={todayISO()}
                  value={date}
                  onChange={(value) => setDate(value)}
                />
              </FormField>
              <FormField id="absence-type" label={t("absenceType")}>
                <NativeSelect
                  value={type}
                  onChange={(e) => setType(e.target.value as AbsenceReportType)}
                >
                  {TYPES.map((value) => (
                    <option key={value} value={value}>
                      {t(`type${value}`)}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <Label htmlFor="full-day">{t("fullDay")}</Label>
              <Switch id="full-day" checked={fullDay} onCheckedChange={setFullDay} />
            </div>
            {!fullDay ? (
              <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                <FormField id="absence-start" label={t("from")}>
                  <Input
                    type="time"
                    className="tabular-nums"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </FormField>
                <FormField id="absence-end" label={t("to")}>
                  <Input
                    type="time"
                    className="tabular-nums"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </FormField>
              </div>
            ) : null}
            <FormField id="absence-note" label={t("note")} optional>
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </FormField>
            <Button
              className="w-full"
              onClick={doReport}
              disabled={absenceActions.report.isPending || !selectedChildId || !date}
            >
              {absenceActions.report.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {t("sending")}
                </>
              ) : (
                <>
                  <Send aria-hidden="true" />
                  {t("reportSubmit")}
                </>
              )}
            </Button>
          </div>
        </SectionCard>

        <SectionCard id="absence-reports" title={t("reportsTitle")}>
          {reportsQuery.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : reportsQuery.isError ? (
            <LoadError variant="inline" title={t("reportsLoadFailed")} hint={t("listsLoadFailedHint")} />
          ) : reports.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("reportsEmpty")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {reports.map((report) => {
                const name = childName(report.studentId);
                const day = dayText(report.date);
                return (
                  <li
                    key={report.id}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{name}</p>
                      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                        <span className="tabular-nums">
                          {day}
                          {report.startTime
                            ? ` · ${report.startTime.slice(0, 5)}–${report.endTime?.slice(0, 5) ?? ""}`
                            : ` · ${t("fullDay")}`}
                        </span>
                        <Badge variant="secondary">{t(`type${report.type}`)}</Badge>
                      </div>
                    </div>
                    {report.date.slice(0, 10) >= todayISO() ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => askDelete(report)}
                        disabled={absenceActions.remove.isPending}
                        aria-label={t("deleteReportNamed", { name, date: day })}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <PurgedNotice kind="ABSENCE_REPORTS" />
        </SectionCard>

        <SectionCard id="leave-request" title={t("leaveTitle")} description={t("leaveBody")}>
          <div className="space-y-4">
            <FormField id="leave-child" label={t("child")}>
              <NativeSelect
                value={selectedLeaveChildId}
                onChange={(e) => setLeaveChildId(e.target.value)}
              >
                {childOptions}
              </NativeSelect>
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="leave-start" label={t("from")}>
                <DateField
                  label={t("from")}
                  id="leave-start"
                  min={todayISO()}
                  value={leaveStart}
                  onChange={(value) => setLeaveStart(value)}
                />
              </FormField>
              <FormField id="leave-end" label={t("to")}>
                <DateField
                  label={t("to")}
                  id="leave-end"
                  min={leaveStart}
                  max={lastLeaveDay(leaveStart)}
                  value={leaveEnd}
                  onChange={(value) => setLeaveEnd(value)}
                />
              </FormField>
            </div>
            <FormField id="leave-reason" label={t("reason")}>
              <Textarea rows={3} value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} />
            </FormField>
            <Button
              className="w-full"
              onClick={doRequestLeave}
              disabled={
                leaveActions.request.isPending ||
                !selectedLeaveChildId ||
                leaveReason.trim().length < 3
              }
            >
              {leaveActions.request.isPending ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {t("sending")}
                </>
              ) : (
                <>
                  <Send aria-hidden="true" />
                  {t("leaveSubmit")}
                </>
              )}
            </Button>
          </div>
        </SectionCard>

        <SectionCard id="leave-requests" title={t("leavesTitle")}>
          {leavesQuery.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : leavesQuery.isError ? (
            <LoadError variant="inline" title={t("leavesLoadFailed")} hint={t("listsLoadFailedHint")} />
          ) : leaves.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("leavesEmpty")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {leaves.map((leave) => (
                <li key={leave.id} className="space-y-1 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{childName(leave.studentId)}</span>
                    <Badge variant={LEAVE_STATUS_VARIANT[leave.status]}>
                      {t(`status${leave.status}`)}
                    </Badge>
                  </div>
                  <p className="tabular-nums text-muted-foreground">
                    {spanText(leave.startDate, leave.endDate)}
                  </p>
                  <p className="truncate text-muted-foreground">{leave.reason}</p>
                  {leave.status !== "PENDING" && leave.decidedAs ? (
                    <p className="text-xs text-muted-foreground">
                      {t(leave.decidedAs === "MENTOR" ? "decidedByMentor" : "decidedByRektor")}
                    </p>
                  ) : null}
                  {leave.decisionNote ? (
                    <p className="text-xs text-muted-foreground">
                      {t("decisionNote")}: {leave.decisionNote}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <PurgedNotice kind="LEAVE_REQUESTS" />
        </SectionCard>
      </div>

      {/* One card per child, each read under the guardian's own RLS: the
          statement's rows exist for a guardian only for their own children,
          so a child of another family is not even asked for. */}
      {profile.role === "GUARDIAN" ? (
        <Suspense fallback={null}>
          {(children ?? []).map((child) => (
            <TeachingTimeCard key={child.id} studentId={child.id} childName={child.firstName} />
          ))}
        </Suspense>
      ) : null}

      {confirmUsed ? (
        <DialogLoadBoundary
          key={confirmLoad}
          onError={() => {
            // A chunk that failed to load says so in the reader's language;
            // the error's own text is English and technical.
            toast.error(tCommon("confirmLoadFailed"));
            ConfirmDialog = lazyConfirmDialog();
            setConfirmOpen(false);
            setConfirmUsed(false);
            setConfirmLoad((attempt) => attempt + 1);
          }}
        >
          <Suspense fallback={null}>
            <ConfirmDialog
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              title={
                deleting
                  ? t("deleteReportTitle", { name: childName(deleting.studentId), date: dayText(deleting.date) })
                  : ""
              }
              description={t("deleteReportBody")}
              confirmLabel={tCommon("delete")}
              loading={absenceActions.remove.isPending}
              onConfirm={() => {
                if (deleting) void doDeleteReport(deleting.id);
              }}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </Page>
  );
}
