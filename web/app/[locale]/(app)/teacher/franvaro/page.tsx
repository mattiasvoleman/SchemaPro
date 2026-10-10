"use client";

// /teacher/franvaro — Vikariepass och frånvaro, the teacher's own side of
// Vikarieplanering.
//
// MINA VIKARIEPASS: the lessons this teacher covers in the coming four weeks,
// read as the teacher reads their week (CalendarLessonTeachers, role
// SUBSTITUTE) — nothing new is read, and nothing says whom they replace or
// why: the substitute's own day, as the notice and the e-mail say it.
//
// MIN FRÅNVARO: the teacher's own absences, with their reason (RLS lets the
// admin and the absent teacher read it, nobody else) and how far the school
// has come covering them. "Anmäl frånvaro", "Avsluta i förtid" and
// "Återkalla" are offered only when the school allows self-report
// (CoverSettings.teacherSelfReport, off by default); the gateway and the
// database guard decide again.
//
// MIN TILLGÄNGLIGHET: for a member of the substitute pool, the windows they
// can work — the only times a pool member without a post is ever suggested.
//
// Bundle: core tier (170KB). The absence form and the end dialog are
// React.lazy and mounted on the first click, and the hours editor only for a
// pool member: Radix Select and the dialogs are not in this tier's shared
// chunks, and most teachers open this page to read.

import { Suspense, lazy, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarPlus } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { useGroups, useRooms, useSubjects, useTeacherLessons } from "@/lib/queries";
import { useAbsenceReasons, useAbsences, useCoverSettings, usePoolMembership } from "@/lib/cover-queries";
import type { Absence } from "@/lib/cover-types";
import { absencePeriodText, shiftDate } from "@/lib/cover-absence-form";
import { reasonName } from "@/lib/cover-view";
import { formatTime, toDateString } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** A pool member's hours: only a pool member downloads the editor. */
const AvailabilityEditor = lazy(() =>
  import("@/components/cover/availability-editor").then((module) => ({ default: module.AvailabilityEditor })),
);
const AbsenceDialog = lazy(() =>
  import("@/components/cover/absence-dialog").then((module) => ({ default: module.AbsenceDialog })),
);
const AbsenceEndDialog = lazy(() =>
  import("@/components/cover/absence-end-dialog").then((module) => ({ default: module.AbsenceEndDialog })),
);
const AbsenceWithdrawDialog = lazy(() =>
  import("@/components/cover/absence-end-dialog").then((module) => ({ default: module.AbsenceWithdrawDialog })),
);

const WEEKS_AHEAD = 4;
/** A teacher may withdraw an absence this long after reporting it, if nothing is decided on it. */
const WITHDRAW_WINDOW_MS = 60 * 60_000;

/** Whether "Återkalla" is worth offering: before it starts, or within the hour of reporting. */
export function mayWithdraw(absence: Absence, now: number): boolean {
  if (absence.status !== "ACTIVE") return false;
  if (new Date(absence.startsAt).getTime() > now) return true;
  const decided = absence.counts.covered + absence.counts.cancelled + absence.counts.handled;
  return decided === 0 && now - new Date(absence.createdAt).getTime() < WITHDRAW_WINDOW_MS;
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function TeacherCoverPage() {
  const t = useTranslations("teacherCover");
  const tReasons = useTranslations("absenceReasons");
  const locale = useLocale();
  const { profile } = useProfile();
  const today = toDateString(new Date());
  const until = shiftDate(today, WEEKS_AHEAD * 7);
  const now = Date.now();

  const { data: lessons, isLoading: lessonsLoading } = useTeacherLessons(profile.id, today, until);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: settings } = useCoverSettings();
  const { data: absences, isLoading: absencesLoading } = useAbsences({ userId: profile.id });
  const { data: reasons } = useAbsenceReasons();
  const { data: isPoolMember } = usePoolMembership(profile.id);

  const [reporting, setReporting] = useState(false);
  const [ending, setEnding] = useState<Absence | null>(null);
  const [withdrawing, setWithdrawing] = useState<Absence | null>(null);
  const [dialogs, setDialogs] = useState(false);

  const selfReport = settings?.teacherSelfReport === true;
  const subjectName = useMemo(() => new Map((subjects ?? []).map((s) => [s.id, s.name])), [subjects]);
  const groupName = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g.name])), [groups]);
  const roomName = useMemo(() => new Map((rooms ?? []).map((r) => [r.id, r.name])), [rooms]);
  const reasonOf = useMemo(() => new Map((reasons ?? []).map((reason) => [reason.id, reason])), [reasons]);

  const covers = (lessons ?? []).filter(
    (lesson) => lesson.assignmentRole === "SUBSTITUTE" && lesson.status !== "CANCELLED" && new Date(lesson.endsAt).getTime() > now,
  );
  const dayText = (date: string) =>
    new Date(`${date}T12:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });

  const open = (action: () => void) => {
    setDialogs(true);
    action();
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <Section title={t("coversTitle")}>
        {lessonsLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : covers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("coversEmpty", { weeks: WEEKS_AHEAD })}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {covers.map((lesson) => (
              <li key={lesson.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="w-28 capitalize">{dayText(lesson.date)}</span>
                <span className="w-24 tabular-nums">
                  {formatTime(lesson.startsAt)}–{formatTime(lesson.endsAt)}
                </span>
                <span className="font-medium">{subjectName.get(lesson.subjectId) ?? "—"}</span>
                <span>{groupName.get(lesson.studentGroupId) ?? "—"}</span>
                <span className="text-muted-foreground">
                  {lesson.roomId ? (roomName.get(lesson.roomId) ?? "—") : t("noRoom")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t("absencesTitle")}
        action={
          selfReport ? (
            <Button size="sm" onClick={() => open(() => setReporting(true))}>
              <CalendarPlus />
              {t("report")}
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">{selfReport ? t("selfReportOn") : t("selfReportOff")}</p>
        {absencesLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (absences ?? []).length === 0 ? (
          <p className="text-sm italic text-muted-foreground">{t("absencesEmpty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {(absences ?? []).map((absence) => (
              <li key={absence.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="tabular-nums">{absencePeriodText(absence, locale)}</span>
                <span className="text-muted-foreground">
                  {absence.reasonId ? reasonName(tReasons, reasonOf.get(absence.reasonId)) : tReasons("NONE")}
                </span>
                <span className="flex flex-wrap gap-1">
                  {absence.counts.covered > 0 ? (
                    <Badge variant="success">{t("covered", { count: absence.counts.covered })}</Badge>
                  ) : null}
                  {absence.counts.open > 0 ? (
                    <Badge variant="warning">{t("open", { count: absence.counts.open })}</Badge>
                  ) : null}
                  {absence.counts.cancelled + absence.counts.handled > 0 ? (
                    <Badge variant="secondary">
                      {t("otherwise", { count: absence.counts.cancelled + absence.counts.handled })}
                    </Badge>
                  ) : null}
                </span>
                {selfReport ? (
                  <span className="ml-auto flex gap-2">
                    {absence.phase === "ONGOING" ? (
                      <Button size="sm" variant="outline" onClick={() => open(() => setEnding(absence))}>
                        {t("end")}
                      </Button>
                    ) : null}
                    {mayWithdraw(absence, now) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        onClick={() => open(() => setWithdrawing(absence))}
                      >
                        {t("withdraw")}
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("privacy")}</p>
      </Section>

      {isPoolMember ? (
        <Section title={t("availabilityTitle")}>
          <Suspense fallback={<Skeleton className="h-16 w-full" />}>
            <AvailabilityEditor own />
          </Suspense>
        </Section>
      ) : null}

      {dialogs ? (
        <Suspense fallback={null}>
          <AbsenceDialog
            open={reporting}
            onOpenChange={setReporting}
            mode="TEACHER"
            initial={{ userId: profile.id }}
          />
          <AbsenceEndDialog absence={ending} mode="TEACHER" onOpenChange={(next) => !next && setEnding(null)} />
          <AbsenceWithdrawDialog absence={withdrawing} mode="TEACHER" onOpenChange={(next) => !next && setWithdrawing(null)} />
        </Suspense>
      ) : null}
    </div>
  );
}
