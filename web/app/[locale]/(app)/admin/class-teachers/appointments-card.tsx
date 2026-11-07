"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Trash2 } from "lucide-react";
import { useAppointments, useClassTeacherAdminActions } from "@/lib/class-teacher-queries";
import { problemOf, type AppointmentView } from "@/lib/class-teacher";
import { useGroups, usePeople } from "@/lib/queries";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useAreaGate } from "./use-area-gate";

/**
 * Who is klasslärare of which class in the läsår.
 *
 * An appointment runs as the administrator who made it: the klasslärare's
 * checks and publications are made as that person (as the cover board places a
 * vikarie as the administrator who sent the request). When that administrator
 * has left, or no longer writes what the work needs, the appointment lapses
 * ("runs" is false) and the klasslärare is told to ask for a new one. It is
 * said here in the row, with the one action that mends it: appointing the same
 * teacher again takes the appointment over.
 */
export function AppointmentsCard({ yearId }: { yearId: string }) {
  const t = useTranslations("classTeacherAdmin");
  const tCommon = useTranslations("common");
  const gate = useAreaGate();
  const may = gate.may("SCHEMALAGGNING");
  const appointments = useAppointments(yearId);
  const groups = useGroups();
  const people = usePeople();
  const { appoint, removeAppointment } = useClassTeacherAdminActions();
  const [classId, setClassId] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [removing, setRemoving] = useState<AppointmentView | null>(null);

  const classes = (groups.data ?? []).filter((group) => group.academicYearId === yearId && group.kind === "CLASS" && !group.halfOfId);
  const teachers = (people.data ?? []).filter((person) => person.role === "TEACHER" && person.isActive);
  const rows = appointments.data ?? [];

  const fail = (error: unknown) => {
    const problem = problemOf(error);
    toast.error(problem.kind === "areaNotYours" ? problem.message : error instanceof Error ? error.message : tCommon("error"));
  };

  const appointPair = async (studentGroupId: string, userId: string): Promise<boolean> => {
    if (appoint.isPending) return false;
    try {
      await appoint.mutateAsync({ yearId, studentGroupId, userId });
      toast.success(t("appointments.appointed"));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const remove = async () => {
    if (!removing || removeAppointment.isPending) return;
    try {
      await removeAppointment.mutateAsync({ yearId, id: removing.id });
      toast.success(t("appointments.removed"));
      setRemoving(null);
    } catch (error) {
      fail(error);
      setRemoving(null);
    }
  };

  return (
    <SectionCard id="class-teacher-appointments" title={t("appointments.title")} description={t("appointments.description")}>
      {appointments.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : appointments.isError || !appointments.data ? (
        <LoadError variant="inline" title={t("appointments.loadFailed")} hint={t("loadFailedHint")} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("appointments.empty")}</p>
      ) : (
        <TableCard caption={t("appointments.caption")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("appointments.class")}</TableHead>
              <TableHead>{t("appointments.teacher")}</TableHead>
              <TableHead>{t("appointments.status")}</TableHead>
              <TableHead>
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.className}</TableCell>
                <TableCell>{row.teacherName}</TableCell>
                <TableCell>
                  {row.runs ? (
                    <Badge variant="success">{t("appointments.runs")}</Badge>
                  ) : (
                    <div className="space-y-1">
                      <Badge variant="warning">{t("appointments.lapsed")}</Badge>
                      <p className="max-w-64 text-sm">{t("appointments.lapsedHint")}</p>
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap justify-end gap-2">
                    {!row.runs ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-writes="SCHEMALAGGNING"
                        disabled={!may || appoint.isPending}
                        aria-label={t("appointments.reappointNamed", { teacher: row.teacherName, class: row.className })}
                        onClick={() => void appointPair(row.studentGroupId, row.userId)}
                      >
                        {t("appointments.reappoint")}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      data-writes="SCHEMALAGGNING"
                      disabled={!may}
                      aria-label={t("appointments.removeNamed", { teacher: row.teacherName, class: row.className })}
                      onClick={() => setRemoving(row)}
                    >
                      <Trash2 aria-hidden="true" />
                      {t("appointments.remove")}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableCard>
      )}

      <form
        className="space-y-3 border-t pt-3"
        aria-labelledby="class-teacher-appoint-title"
        data-writes="SCHEMALAGGNING"
        onSubmit={(event) => {
          event.preventDefault();
          if (!classId || !teacherId) return;
          void appointPair(classId, teacherId).then((done) => {
            if (done) setTeacherId("");
          });
        }}
      >
        <h3 id="class-teacher-appoint-title" className="text-sm font-semibold">
          {t("appointments.addTitle")}
        </h3>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end [&>*]:min-w-0">
          <FormField id="class-teacher-appoint-class" label={t("appointments.class")}>
            <NativeSelect value={classId} disabled={!may} onChange={(event) => setClassId(event.target.value)}>
              <option value="">{t("appointments.pickClass")}</option>
              {classes.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="class-teacher-appoint-teacher" label={t("appointments.teacher")}>
            <NativeSelect value={teacherId} disabled={!may} onChange={(event) => setTeacherId(event.target.value)}>
              <option value="">{t("appointments.pickTeacher")}</option>
              {teachers.map((one) => (
                <option key={one.id} value={one.id}>
                  {`${one.firstName} ${one.lastName}`}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <Button type="submit" disabled={!may || !classId || !teacherId || appoint.isPending}>
            {t("appointments.appoint")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{t("appointments.addHint")}</p>
      </form>
      {/* Outside the form: the form is hidden from a profile that does not write the area, and the reason stays. */}
      {!may ? <p className="text-sm">{gate.why("SCHEMALAGGNING")}</p> : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("appointments.removeTitle")}
        description={removing ? t("appointments.removeBody", { teacher: removing.teacherName, class: removing.className }) : undefined}
        confirmLabel={t("appointments.remove")}
        loading={removeAppointment.isPending}
        onConfirm={() => void remove()}
      />
    </SectionCard>
  );
}
