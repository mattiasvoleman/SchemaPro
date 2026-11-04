"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { BulkDeleteDialog, BulkEditDialog, BulkSelectField, type DeleteLines } from "@/components/bulk/bulk-dialogs";
import { useBulkActions, type BulkResult, type BulkUpdateBody, type StudentRemovalConsequences } from "@/lib/bulk-api";
import type { AcademicYear, Person, StudentGroup } from "@/lib/types";
import { homeClassOptions } from "@/lib/year-scope";

/*
 * Massåtgärder on Personer, for pupils: the shared dialogs
 * (components/bulk/bulk-dialogs.tsx) with the pupils' calls, fields and
 * consequences. Fetched on the first click of Redigera or Ta bort.
 *
 * THE FIELDS. The class, for a group of pupils moving at once (a new
 * pupil intake, a class split across two), from the active läsår's classes as
 * the person form offers them; and the status, for the pupils who have left:
 * an inactive pupil keeps their history where a deleted one takes it along.
 * A pupil's årskurs is their class's, so it is no field of the pupil. Names,
 * e-mail and phone are each pupil's own.
 */

export type BulkMode = "edit" | "delete";

/** Body of POST /users/students/bulk-update: each field only when chosen. */
export interface StudentChanges {
  studentGroupId?: string | null;
  isActive?: boolean;
}

/** What a bulk pupil write makes stale: as a pupil's edit or delete one at a time, and the guardian links a delete takes. */
export const STUDENT_BULK_KEYS = [
  ["people"],
  ["groupMemberships"],
  ["groupMembers"],
  ["lessonRoster"],
  ["studentGuardians"],
] as const;

const NONE = "__none__";
const ACTIVE = "active";
const INACTIVE = "inactive";

function sharedOf<T>(rows: T[], valueOf: (row: T) => string): string | null {
  const values = new Set(rows.map(valueOf));
  return values.size === 1 ? [...values][0]! : null;
}

export function StudentsBulkDialogs({
  mode,
  ids,
  people,
  groups,
  years,
  activeYearId,
  onClose,
  onDeleted,
}: {
  mode: BulkMode;
  /** The ticked pupils. */
  ids: string[];
  people: Person[];
  groups: StudentGroup[];
  years: AcademicYear[];
  activeYearId: string | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("bulk");
  const { remove, update } = useBulkActions<StudentChanges, StudentRemovalConsequences>(
    "/api/v1/users/students",
    STUDENT_BULK_KEYS,
  );
  const byId = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const nameOf = (id: string) => {
    const person = byId.get(id);
    return person ? `${person.firstName} ${person.lastName}` : "…";
  };

  if (mode === "delete") {
    return (
      <BulkDeleteDialog
        entity="students"
        ids={ids}
        nameOf={nameOf}
        remove={remove.mutateAsync}
        describe={(consequences) => describeStudentRemoval(t, consequences)}
        onClose={onClose}
        onDeleted={(count) => {
          toast.success(t("deleted", { count }));
          onDeleted();
        }}
      />
    );
  }
  return (
    <StudentsEditDialog
      ids={ids}
      rows={ids.map((id) => byId.get(id)).filter((person): person is Person => person !== undefined)}
      groups={groups}
      years={years}
      activeYearId={activeYearId}
      nameOf={nameOf}
      update={update.mutateAsync}
      onClose={onClose}
    />
  );
}

/**
 * The lines the delete dialog shows for the pupils' consequences; a count of
 * 0 says nothing. What an administrator reads is counted, by name or in
 * otherRows and otherLinks (STUDENT_KEYS in src/common/removal-inventory.ts).
 * The pupils' own accounts (notices, settings, devices, calendar feeds) are
 * read by no administrator, so they are named without a number, always, and
 * the list is never said to be all there is.
 */
export function describeStudentRemoval(
  t: (key: string, values?: Record<string, number>) => string,
  consequences: StudentRemovalConsequences,
): DeleteLines {
  const lines = (keys: (keyof StudentRemovalConsequences)[]) =>
    keys.filter((key) => consequences[key] > 0).map((key) => t(`studentConsequences.${key}`, { count: consequences[key] }));
  return {
    goes: [
      ...lines([
        "memberships",
        "enrolments",
        "lessonParticipations",
        "guardianLinks",
        "absenceReports",
        "leaveRequests",
        "attendanceMarks",
        "teachingTimeStatements",
        "logins",
        "otherRows",
      ]),
      t("studentConsequences.accounts"),
    ],
    loses: lines(["otherLinks"]),
    notes: [
      ...(consequences.fromSource > 0 ? [t("fromSource", { count: consequences.fromSource })] : []),
      t("studentConsequences.deactivateInstead"),
    ],
    exhaustive: false,
  };
}

function StudentsEditDialog({
  ids,
  rows,
  groups,
  years,
  activeYearId,
  nameOf,
  update,
  onClose,
}: {
  ids: string[];
  rows: Person[];
  groups: StudentGroup[];
  years: AcademicYear[];
  activeYearId: string | null;
  nameOf: (id: string) => string;
  update: (body: BulkUpdateBody<StudentChanges>) => Promise<BulkResult<never>>;
  onClose: () => void;
}) {
  const t = useTranslations("bulk");
  const [studentGroup, setStudentGroup] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const sharedClass = sharedOf(rows, (person) => person.studentGroupId ?? NONE);
  // The active year's classes, as the person form offers them, and the class
  // every ticked pupil is in now when it is another year's: shown as it is.
  const classes = homeClassOptions(groups, years, activeYearId, sharedClass === NONE ? null : sharedClass);
  const changes: StudentChanges | null =
    studentGroup === null && status === null
      ? null
      : {
          ...(studentGroup !== null ? { studentGroupId: studentGroup === NONE ? null : studentGroup } : {}),
          ...(status !== null ? { isActive: status === ACTIVE } : {}),
        };

  return (
    <BulkEditDialog
      entity="students"
      ids={ids}
      nameOf={nameOf}
      update={update}
      changes={changes}
      onClose={onClose}
      onSaved={(count) => {
        toast.success(t("saved", { count }));
        onClose();
      }}
    >
      <BulkSelectField
        id="bulk-student-class"
        label={t("studentFields.class")}
        hint={t("studentFields.classHint")}
        options={[
          { value: NONE, label: t("studentFields.classNone") },
          ...classes.map((option) => ({ value: option.id, label: option.label })),
        ]}
        shared={sharedClass}
        value={studentGroup}
        onChange={setStudentGroup}
        count={ids.length}
      />
      <BulkSelectField
        id="bulk-student-status"
        label={t("studentFields.status")}
        hint={t("studentFields.statusHint")}
        options={[
          { value: ACTIVE, label: t("studentFields.active") },
          { value: INACTIVE, label: t("studentFields.inactive") },
        ]}
        shared={sharedOf(rows, (person) => (person.isActive ? ACTIVE : INACTIVE))}
        value={status}
        onChange={setStatus}
        count={ids.length}
      />
    </BulkEditDialog>
  );
}
