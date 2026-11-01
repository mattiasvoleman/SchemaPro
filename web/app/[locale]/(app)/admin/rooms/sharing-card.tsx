"use client";

/*
 * Delade lokaler och lärare (migration 20261217090000): what the school
 * shares with the other schools of its huvudman. The minutes between the
 * schools, the teachers both schools have marked as shared, and the rooms
 * one school lends another for weekly times.
 *
 * Shown only to a school whose huvudman owns another school: every other
 * school reads one empty answer and sees nothing here. On Salar beside the
 * sites, because a loan is a room and the travel is the sites' across
 * schools; the dialog that asks for a room is fetched when it opens.
 *
 * What the other school hands out is its name, its rooms' names, the
 * answer to a loan, and whether it has marked a teacher back: never a
 * person of its own. A school's mark is its own word about its own row; a
 * teacher is shared only once both schools have marked theirs.
 */

import { Suspense, lazy, useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { useReadOnly } from "@/components/profile-context";
import { ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { FormField } from "@/components/ui/form-field";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { minutesFromField } from "./sites-card";
import {
  byStatus,
  useMarkTeacher,
  useRoomLoanAction,
  useRoomLoans,
  useSaveSchoolTravel,
  useSharing,
  type RoomLoan,
  type RoomLoanAction,
} from "./use-sharing";

const RoomLoanDialog = lazy(() => import("./room-loan-dialog").then((module) => ({ default: module.RoomLoanDialog })));

const STATUS_VARIANT = {
  PENDING: "warning",
  APPROVED: "success",
  DECLINED: "outline",
  WITHDRAWN: "outline",
  REVOKED: "outline",
} as const;

export function SharingCard() {
  const t = useTranslations("sharing");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  // Läsbehörighet: everything is read, nothing written. The buttons that
  // write carry data-writes; the minutes stay readable and save nothing.
  const readOnly = useReadOnly();
  const sharing = useSharing();
  const schools = sharing.data?.schools ?? [];
  const loans = useRoomLoans(schools.length > 0);
  const saveTravel = useSaveSchoolTravel();
  const loanAction = useRoomLoanAction();
  const markTeacher = useMarkTeacher();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [markWho, setMarkWho] = useState("");
  const [markWhere, setMarkWhere] = useState("");
  const [asking, setAsking] = useState(false);
  const [askedOnce, setAskedOnce] = useState(false);
  const [confirming, setConfirming] = useState<{ loan: RoomLoan; action: RoomLoanAction } | null>(null);
  const [renewing, setRenewing] = useState<{ roomId: string; windows: { dayOfWeek: number; startTime: string; endTime: string }[] } | null>(null);

  // The saved figures fill the fields; one the admin has typed in keeps it.
  useEffect(() => {
    setTyped((current) => {
      const next: Record<string, string> = {};
      for (const school of sharing.data?.schools ?? []) {
        next[school.id] = current[school.id] ?? (school.travelMinutes === null ? "" : String(school.travelMinutes));
      }
      return next;
    });
  }, [sharing.data]);

  if (sharing.isError && !sharing.data) {
    return (
      <SectionCard id="sharing" title={t("title")}>
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      </SectionCard>
    );
  }
  // A school without another school of its huvudman has nothing to share.
  if (!sharing.data || schools.length === 0) return null;

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.code && t.has(`errors.${error.code}`)
      ? t(`errors.${error.code}`)
      : error instanceof Error
        ? error.message
        : tCommon("error");

  const changed = schools.filter((school) => {
    const minutes = minutesFromField(typed[school.id] ?? "");
    return minutes !== undefined && minutes !== school.travelMinutes;
  });
  const invalid = schools.some((school) => minutesFromField(typed[school.id] ?? "") === undefined);

  const saveAll = async (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || invalid || changed.length === 0) return;
    try {
      for (const school of changed) {
        await saveTravel.mutateAsync({ schoolId: school.id, minutes: minutesFromField(typed[school.id] ?? "") ?? null });
      }
      setTyped({});
      toast.success(t("travelSaved"));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  // A school that has left the huvudman has no name the school may read.
  const schoolName = (loan: RoomLoan) => loan.school.name ?? t("leftSchool");

  const act = async (loan: RoomLoan, action: RoomLoanAction) => {
    try {
      await loanAction.mutateAsync({ id: loan.id, action });
      toast.success(t(`done.${action}`, { room: loan.room.name, school: schoolName(loan) }));
      setConfirming(null);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const teachers = sharing.data.teachers;
  const staff = sharing.data.staff;
  const marked = new Set(teachers.flatMap((teacher) => teacher.schools.map((school) => `${teacher.teacherId} ${school.id}`)));
  const canMark = markWho !== "" && markWhere !== "" && !marked.has(`${markWho} ${markWhere}`);

  const mark = async (teacherId: string, schoolId: string, shared: boolean) => {
    const person = [...teachers, ...staff.map((member) => ({ ...member, teacherId: member.id }))].find(
      (candidate) => candidate.teacherId === teacherId,
    );
    const values = {
      name: person ? `${person.firstName} ${person.lastName}` : "",
      school: schools.find((school) => school.id === schoolId)?.name ?? "",
    };
    try {
      await markTeacher.mutateAsync({ teacherId, schoolId, shared });
      toast.success(t(shared ? "teacherMarked" : "teacherUnmarked", values));
      if (shared) setMarkWho("");
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const submitMark = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly || !canMark) return;
    void mark(markWho, markWhere, true);
  };

  // Begär igen: the room and every time the school borrows it by, the next
  // läsår's dates for the planner to choose. Loans are not rolled over.
  const askAgain = (loan: RoomLoan) => {
    const same = (loans.data?.borrowed ?? []).filter(
      (other) => other.ownerRoomId === loan.ownerRoomId && (other.status === "APPROVED" || other.id === loan.id),
    );
    const seen = new Set<string>();
    const windows = same
      .map((other) => ({ dayOfWeek: other.dayOfWeek, startTime: other.startTime, endTime: other.endTime }))
      .filter((window) => {
        const key = `${window.dayOfWeek} ${window.startTime} ${window.endTime}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    setRenewing({ roomId: loan.ownerRoomId!, windows });
    setAskedOnce(true);
    setAsking(true);
  };

  const when = (loan: RoomLoan) =>
    t("window", { day: tDays(String(loan.dayOfWeek)), start: loan.startTime, end: loan.endTime });
  const period = (loan: RoomLoan) => t("period", { from: loan.startDate, to: loan.endDate });
  const lent = [...(loans.data?.lent ?? [])].sort(byStatus);
  const borrowed = [...(loans.data?.borrowed ?? [])].sort(byStatus);

  return (
    <SectionCard id="sharing" title={t("title")} description={t("description")}>
      <div className="space-y-6">
        <form aria-labelledby="sharing-schools-title" className="space-y-3" onSubmit={saveAll} noValidate>
          <h3 id="sharing-schools-title" className="text-sm font-semibold">
            {t("schoolsTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("schoolsHint")}</p>
          <TableCard caption={t("schoolsCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.school")}</TableHead>
                <TableHead className="w-40">{t("columns.travel")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schools.map((school) => {
                const value = typed[school.id] ?? "";
                const wrong = minutesFromField(value) === undefined;
                return (
                  <TableRow key={school.id}>
                    <TableCell className="font-medium">{school.name}</TableCell>
                    <TableCell>
                      <Input
                        aria-label={t("travelLabel", { school: school.name })}
                        aria-invalid={wrong || undefined}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={3}
                        readOnly={readOnly}
                        value={value}
                        placeholder={t("minutesPlaceholder")}
                        onChange={(event) => setTyped((current) => ({ ...current, [school.id]: event.target.value }))}
                      />
                      {wrong ? <p className="mt-1 text-xs text-destructive">{t("minutesInvalid")}</p> : null}
                      {school.travelSetByUs === false ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t("setByThem", { school: school.name })}</p>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </TableCard>
          <div className="flex justify-end">
            <Button data-writes="PLANERING" type="submit" disabled={invalid || changed.length === 0 || saveTravel.isPending}>
              {t("saveTravel")}
            </Button>
          </div>
        </form>

        <section aria-labelledby="sharing-teachers-title" className="space-y-3">
          <h3 id="sharing-teachers-title" className="text-sm font-semibold">
            {t("teachersTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("teachersHint")}</p>
          {teachers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("teachersEmpty")}</p>
          ) : (
            <TableCard caption={t("teachersCaption")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.teacher")}</TableHead>
                  <TableHead>{t("columns.sharedWith")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{tCommon("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teachers.flatMap((teacher) =>
                  teacher.schools.map((school) => {
                    const name = `${teacher.firstName} ${teacher.lastName}`;
                    return (
                      <TableRow key={`${teacher.teacherId} ${school.id}`}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell>{school.name}</TableCell>
                        <TableCell>
                          {school.shared ? (
                            <Badge variant="success">{t("teacherShared")}</Badge>
                          ) : (
                            <Badge variant="warning">{t("teacherWaiting", { school: school.name })}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div data-writes="PLANERING" className="flex justify-end">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={t("unmarkTeacher", { name, school: school.name })}
                              disabled={markTeacher.isPending}
                              onClick={() => void mark(teacher.teacherId, school.id, false)}
                            >
                              <X aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  }),
                )}
              </TableBody>
            </TableCard>
          )}
          <form
            aria-label={t("markTitle")}
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            onSubmit={submitMark}
            noValidate
          >
            <FormField id="sharing-mark-teacher" label={t("fields.teacher")}>
              <NativeSelect value={markWho} onChange={(event) => setMarkWho(event.target.value)}>
                <option value="">{t("fields.teacherPlaceholder")}</option>
                {staff.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.firstName} {member.lastName}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField id="sharing-mark-school" label={t("fields.school")}>
              <NativeSelect value={markWhere} onChange={(event) => setMarkWhere(event.target.value)}>
                <option value="">{t("fields.schoolPlaceholder")}</option>
                {schools.map((school) => (
                  <option key={school.id} value={school.id}>
                    {school.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <Button data-writes="PLANERING" type="submit" variant="outline" disabled={!canMark || markTeacher.isPending}>
              {t("markTeacher")}
            </Button>
          </form>
        </section>

        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{t("loansTitle")}</h3>
              <p className="text-sm text-muted-foreground">{t("loansHint")}</p>
            </div>
            <Button
              data-writes="PLANERING"
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRenewing(null);
                setAskedOnce(true);
                setAsking(true);
              }}
            >
              <Plus aria-hidden="true" />
              {t("borrow")}
            </Button>
          </div>
          {loans.isError ? <LoadError variant="inline" title={t("loansLoadFailed")} hint={tCommon("refetchFailedHint")} /> : null}

          <h4 className="text-sm font-medium">{t("lentTitle")}</h4>
          {lent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("lentEmpty")}</p>
          ) : (
            <TableCard caption={t("lentCaption")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.room")}</TableHead>
                  <TableHead>{t("columns.borrower")}</TableHead>
                  <TableHead>{t("columns.when")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{tCommon("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lent.map((loan) => (
                  <TableRow key={loan.id}>
                    <TableCell className="font-medium">{loan.room.name}</TableCell>
                    <TableCell>
                      {schoolName(loan)}
                      {loan.note ? <p className="text-xs text-muted-foreground">{loan.note}</p> : null}
                    </TableCell>
                    <TableCell className="text-sm">
                      {when(loan)}
                      <p className="text-xs text-muted-foreground">{period(loan)}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[loan.status]}>{t(`status.${loan.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div data-writes="PLANERING" className="flex justify-end gap-2">
                        {loan.status === "PENDING" ? (
                          <>
                            <Button type="button" size="sm" onClick={() => void act(loan, "approve")} disabled={loanAction.isPending}>
                              {t("actions.approve")}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void act(loan, "decline")}
                              disabled={loanAction.isPending}
                            >
                              {t("actions.decline")}
                            </Button>
                          </>
                        ) : loan.status === "APPROVED" ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming({ loan, action: "revoke" })}>
                            {t("actions.revoke")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableCard>
          )}

          <h4 className="text-sm font-medium">{t("borrowedTitle")}</h4>
          {borrowed.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("borrowedEmpty")}</p>
          ) : (
            <TableCard caption={t("borrowedCaption")}>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.localRoom")}</TableHead>
                  <TableHead>{t("columns.owner")}</TableHead>
                  <TableHead>{t("columns.when")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{tCommon("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {borrowed.map((loan) => (
                  <TableRow key={loan.id}>
                    <TableCell className="font-medium">
                      {loan.room.id ? loan.room.name : t("roomAtApproval", { room: loan.room.name })}
                    </TableCell>
                    <TableCell>
                      {loan.ownerRoomName ? t("ownerRoom", { room: loan.ownerRoomName, school: schoolName(loan) }) : schoolName(loan)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {when(loan)}
                      <p className="text-xs text-muted-foreground">{period(loan)}</p>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[loan.status]}>{t(`status.${loan.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div data-writes="PLANERING" className="flex justify-end gap-2">
                        {loan.status === "PENDING" || loan.status === "APPROVED" ? (
                          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming({ loan, action: "withdraw" })}>
                            {t("actions.withdraw")}
                          </Button>
                        ) : null}
                        {loan.status !== "PENDING" && loan.ownerRoomId ? (
                          <Button type="button" size="sm" variant="ghost" onClick={() => askAgain(loan)}>
                            {t("actions.renew")}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableCard>
          )}
        </div>
      </div>

      {askedOnce ? (
        <Suspense fallback={null}>
          <RoomLoanDialog open={asking} onOpenChange={setAsking} initial={renewing} />
        </Suspense>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => !next && setConfirming(null)}
        title={confirming ? t(`confirm.${confirming.action}.title`, { room: confirming.loan.room.name }) : ""}
        description={confirming ? t(`confirm.${confirming.action}.body`, { school: schoolName(confirming.loan) }) : ""}
        confirmLabel={confirming ? t(`actions.${confirming.action}`) : ""}
        loading={loanAction.isPending}
        onConfirm={() => (confirming ? act(confirming.loan, confirming.action) : undefined)}
      />
    </SectionCard>
  );
}
