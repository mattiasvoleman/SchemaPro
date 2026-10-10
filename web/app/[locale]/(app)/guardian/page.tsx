"use client";

import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarX2, Loader2, Send, Trash2, Users } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import {
  useAbsenceReportActions,
  useAbsenceReports,
  useLeaveRequestActions,
  useLeaveRequests,
  useMyChildren,
} from "@/lib/guardian-queries";
import type { AbsenceReportType } from "@/lib/types";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function GuardianPage() {
  const t = useTranslations("guardian");
  const tCommon = useTranslations("common");
  const { profile } = useProfile();
  const { data: children, isLoading } = useMyChildren(profile.id);
  const { data: reports } = useAbsenceReports();
  const { data: leaves } = useLeaveRequests();
  const absenceActions = useAbsenceReportActions();
  const leaveActions = useLeaveRequestActions();

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
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doDeleteReport = async (id: string) => {
    try {
      await absenceActions.remove.mutateAsync(id);
      toast.success(tCommon("deleted"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  if (!isLoading && (children ?? []).length === 0) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState icon={Users} title={t("noChildrenTitle")} description={t("noChildrenBody")} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/* The guardian's own children only: the gateway answers a guardian
          for their linked children and refuses anyone else's with the same
          404 as an unknown id. Another role opening this page asks nothing. */}
      {profile.role === "GUARDIAN" && activeChildren.length > 0 ? (
        <Suspense fallback={null}>
          <ChildSchedule childList={activeChildren} />
        </Suspense>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---- Report absence ---- */}
        <Card>
          <CardHeader>
            <CardTitle>{t("reportTitle")}</CardTitle>
            <CardDescription>{t("reportBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t("child")}</Label>
              <Select value={selectedChildId} onValueChange={setChildId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(children ?? []).map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.firstName} {child.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="absence-date">{t("date")}</Label>
                <DateField
                  label={t("date")}
                  id="absence-date"
                  min={todayISO()}
                  value={date}
                  onChange={(value) => setDate(value)}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("absenceType")}</Label>
                <Select
                  value={type}
                  onValueChange={(value) => setType(value as AbsenceReportType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TYPES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`type${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="full-day">{t("fullDay")}</Label>
              <Switch id="full-day" checked={fullDay} onCheckedChange={setFullDay} />
            </div>
            {!fullDay ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="absence-start">{t("from")}</Label>
                  <Input
                    id="absence-start"
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="absence-end">{t("to")}</Label>
                  <Input
                    id="absence-end"
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="absence-note">
                {t("note")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Textarea
                id="absence-note"
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
            <Button
              className="w-full"
              onClick={doReport}
              disabled={absenceActions.report.isPending || !selectedChildId || !date}
            >
              {absenceActions.report.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Send />
              )}
              {t("reportSubmit")}
            </Button>
          </CardContent>
        </Card>

        {/* ---- Request leave ---- */}
        <Card>
          <CardHeader>
            <CardTitle>{t("leaveTitle")}</CardTitle>
            <CardDescription>{t("leaveBody")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t("child")}</Label>
              <Select value={selectedLeaveChildId} onValueChange={setLeaveChildId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(children ?? []).map((child) => (
                    <SelectItem key={child.id} value={child.id}>
                      {child.firstName} {child.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="leave-start">{t("from")}</Label>
                <DateField
                  label={t("from")}
                  id="leave-start"
                  min={todayISO()}
                  value={leaveStart}
                  onChange={(value) => setLeaveStart(value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="leave-end">{t("to")}</Label>
                <DateField
                  label={t("to")}
                  id="leave-end"
                  min={leaveStart}
                  value={leaveEnd}
                  onChange={(value) => setLeaveEnd(value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="leave-reason">{t("reason")}</Label>
              <Textarea
                id="leave-reason"
                rows={3}
                value={leaveReason}
                onChange={(e) => setLeaveReason(e.target.value)}
              />
            </div>
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
                <Loader2 className="animate-spin" />
              ) : (
                <Send />
              )}
              {t("leaveSubmit")}
            </Button>
          </CardContent>
        </Card>

        {/* ---- My reports ---- */}
        <Card>
          <CardHeader>
            <CardTitle>{t("reportsTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {(reports ?? []).length === 0 ? (
              <EmptyState icon={CalendarX2} title={tCommon("noResults")} description={t("reportsEmpty")} />
            ) : (
              <ul className="space-y-2">
                {(reports ?? []).map((report) => (
                  <li
                    key={report.id}
                    className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium">{childName(report.studentId)}</span>{" "}
                      <span className="tabular-nums text-muted-foreground">
                        {report.date.slice(0, 10)}
                        {report.startTime
                          ? ` ${report.startTime.slice(0, 5)}–${report.endTime?.slice(0, 5) ?? ""}`
                          : ` · ${t("fullDay")}`}
                      </span>{" "}
                      <Badge variant="secondary">{t(`type${report.type}`)}</Badge>
                    </div>
                    {report.date.slice(0, 10) >= todayISO() ? (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => void doDeleteReport(report.id)}
                        aria-label={tCommon("delete")}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ---- My leave requests ---- */}
        <Card>
          <CardHeader>
            <CardTitle>{t("leavesTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {(leaves ?? []).length === 0 ? (
              <EmptyState icon={CalendarX2} title={tCommon("noResults")} description={t("leavesEmpty")} />
            ) : (
              <ul className="space-y-2">
                {(leaves ?? []).map((leave) => (
                  <li key={leave.id} className="rounded-md border px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{childName(leave.studentId)}</span>
                      <Badge
                        variant={
                          leave.status === "APPROVED"
                            ? "success"
                            : leave.status === "REJECTED"
                              ? "destructive"
                              : "secondary"
                        }
                      >
                        {t(`status${leave.status}`)}
                      </Badge>
                    </div>
                    <div className="tabular-nums text-muted-foreground">
                      {leave.startDate.slice(0, 10)} – {leave.endDate.slice(0, 10)}
                    </div>
                    <div className="truncate text-muted-foreground">{leave.reason}</div>
                    {leave.decisionNote ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("decisionNote")}: {leave.decisionNote}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* One card per child, each read under the guardian's own RLS: the
          statement's rows exist for a guardian only for their own children,
          so a child of another family is not even asked for. */}
      {profile.role === "GUARDIAN" && (children ?? []).length > 0 ? (
        <Suspense fallback={null}>
          {(children ?? []).map((child) => (
            <TeachingTimeCard key={child.id} studentId={child.id} childName={child.firstName} />
          ))}
        </Suspense>
      ) : null}
    </div>
  );
}
