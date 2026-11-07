"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { BulkDeleteDialog, BulkEditDialog, BulkSelectField, type DeleteLines } from "@/components/bulk/bulk-dialogs";
import { useBulkActions, type BulkResult, type BulkUpdateBody, type GroupRemovalConsequences } from "@/lib/bulk-api";
import type { StudentGroup, Subject } from "@/lib/types";

/*
 * Massåtgärder on Klasser: the shared dialogs (components/bulk/bulk-dialogs.tsx)
 * with the groups' calls, fields and consequences. Fetched on the first click
 * of Redigera or Ta bort, so none of it is in the page's first load.
 *
 * THE FIELDS. The årskurs, which classes created without one, or a whole
 * stadium of groups, most often share; a class's halves follow it, and its
 * skolenhet follows the årskurs (the units' spans), so a skolenhet is not a
 * field of its own. "Ersätter ämne", for the SvA groups of every årskurs at
 * once; only a teaching group that is not a half may replace a subject, so
 * the field is offered when every ticked row is one. Not the name (one per
 * läsår), the kind (a class's pupils are its home pupils, a teaching group's
 * its members) or the läsår (where a group's timplan, lessons and class
 * history live; Läsårsrullning moves years). A group's teacher is no field
 * of the group: it is each timplanspost's, on Timplansposter.
 */

export type BulkMode = "edit" | "delete";

/** Body of POST /student-groups/bulk-update: each field only when chosen. */
export interface GroupChanges {
  gradeLevel?: number | null;
  replacesSubjectId?: string | null;
}

/**
 * What a bulk group write makes stale. A group's delete takes its
 * timplansposter, lessons and memberships with it and leaves its pupils
 * without a class, so those lists too; ["people"] covers next year's
 * rosters (GROUP_WRITE_KEYS).
 */
export const GROUP_BULK_KEYS = [
  ["groups"],
  ["people"],
  ["groupMemberships"],
  ["groupMembers"],
  ["requirements"],
  ["masterLessons"],
  ["calendarLessons"],
  ["lessonRoster"],
] as const;

/** A select's "none" (no årskurs, no subject): a radix item cannot carry "". */
const NONE = "__none__";
/** Årskurs 0 (förskoleklass) to 12, as the group form takes it. */
const GRADES = Array.from({ length: 13 }, (_, grade) => grade);

/** The value every row holds, encoded for a select, or null when they differ. */
function sharedOf<T>(rows: T[], valueOf: (row: T) => string): string | null {
  const values = new Set(rows.map(valueOf));
  return values.size === 1 ? [...values][0]! : null;
}

export function GroupsBulkDialogs({
  mode,
  ids,
  groups,
  subjects,
  onClose,
  onDeleted,
}: {
  mode: BulkMode;
  /** The ticked groups. */
  ids: string[];
  groups: StudentGroup[];
  subjects: Subject[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations("bulk");
  const { remove, update } = useBulkActions<GroupChanges, GroupRemovalConsequences>(
    "/api/v1/student-groups",
    GROUP_BULK_KEYS,
  );
  const byId = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const nameOf = (id: string) => byId.get(id)?.name ?? "…";

  if (mode === "delete") {
    return (
      <BulkDeleteDialog
        entity="groups"
        ids={ids}
        nameOf={nameOf}
        remove={remove.mutateAsync}
        describe={(consequences) => describeGroupRemoval(t, consequences)}
        onClose={onClose}
        onDeleted={(count) => {
          toast.success(t("deleted", { count }));
          onDeleted();
        }}
      />
    );
  }
  return (
    <GroupsEditDialog
      ids={ids}
      rows={ids.map((id) => byId.get(id)).filter((group): group is StudentGroup => group !== undefined)}
      subjects={subjects}
      nameOf={nameOf}
      update={update.mutateAsync}
      onClose={onClose}
    />
  );
}

/**
 * The kinds whose rows have rows of their own below them (GROUP_BELOW_PARENTS
 * in src/common/removal-inventory.ts, which its spec holds to this list): the
 * lessons' participants, teachers and substitute assignments, other groups'
 * places on them, a requirement's shared teacher time, a credit's
 * cancellations, a rule's duty slots. Said as one line, without a number,
 * whenever one of these is counted.
 */
export const GROUP_BELOW_PARENTS = [
  "calendarLessons",
  "masterLessons",
  "requirements",
  "timplanCredits",
  "availabilityConstraints",
] as const;

/**
 * The lines the delete dialog shows for a group's consequences; a count of 0
 * says nothing. Every key to a group is counted (GROUP_KEYS in
 * src/common/removal-inventory.ts, held to the catalogue), and what hangs a
 * level down is counted or said by the line below (GROUP_BELOW), so the
 * list is exhaustive and "nothing else depends on them" may be said when it
 * is empty.
 */
export function describeGroupRemoval(
  t: (key: string, values: Record<string, number>) => string,
  consequences: GroupRemovalConsequences,
): DeleteLines {
  const lines = (keys: (keyof GroupRemovalConsequences)[]) =>
    keys.filter((key) => consequences[key] > 0).map((key) => t(`groupConsequences.${key}`, { count: consequences[key] }));
  return {
    goes: [
      ...lines([
        "halves",
        "memberships",
        "requirements",
        "masterLessons",
        "calendarLessons",
        "attendanceMarks",
        "lessonLogs",
        "lunchSittings",
        "calendarBreaks",
        "availabilityConstraints",
        "timplanCredits",
        "publicLinks",
        "classTeacher",
      ]),
      ...(GROUP_BELOW_PARENTS.some((key) => consequences[key] > 0) ? [t("groupConsequences.below", {})] : []),
    ],
    loses: lines(["homePupils", "enrolments", "mentorDuties", "sharedLessons", "successors"]),
    notes: consequences.fromSource > 0 ? [t("fromSource", { count: consequences.fromSource })] : [],
    exhaustive: true,
  };
}

function GroupsEditDialog({
  ids,
  rows,
  subjects,
  nameOf,
  update,
  onClose,
}: {
  ids: string[];
  rows: StudentGroup[];
  subjects: Subject[];
  nameOf: (id: string) => string;
  update: (body: BulkUpdateBody<GroupChanges>) => Promise<BulkResult<never>>;
  onClose: () => void;
}) {
  const t = useTranslations("bulk");
  const tYears = useTranslations("years");
  const [grade, setGrade] = useState<string | null>(null);
  const [replaces, setReplaces] = useState<string | null>(null);

  // Ersättande grupper: only a teaching group that is not a half replaces a subject.
  const mayReplace = rows.length > 0 && rows.every((group) => group.kind === "TEACHING_GROUP" && !group.halfOfId);
  const changes: GroupChanges | null =
    grade === null && (replaces === null || !mayReplace)
      ? null
      : {
          ...(grade !== null ? { gradeLevel: grade === NONE ? null : Number(grade) } : {}),
          ...(replaces !== null && mayReplace ? { replacesSubjectId: replaces === NONE ? null : replaces } : {}),
        };

  return (
    <BulkEditDialog
      entity="groups"
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
        id="bulk-group-grade"
        label={t("groupFields.gradeLevel")}
        hint={t("groupFields.gradeHint")}
        options={[
          { value: NONE, label: t("groupFields.gradeNone") },
          ...GRADES.map((value) => ({ value: String(value), label: tYears("gradeShort", { grade: value }) })),
        ]}
        shared={sharedOf(rows, (group) => (group.gradeLevel === null ? NONE : String(group.gradeLevel)))}
        value={grade}
        onChange={setGrade}
        count={ids.length}
      />
      {mayReplace ? (
        <BulkSelectField
          id="bulk-group-replaces"
          label={t("groupFields.replaces")}
          hint={t("groupFields.replacesHint")}
          options={[
            { value: NONE, label: t("groupFields.replacesNone") },
            ...subjects.map((subject) => ({ value: subject.id, label: subject.name })),
          ]}
          shared={sharedOf(rows, (group) => group.replacesSubjectId ?? NONE)}
          value={replaces}
          onChange={setReplaces}
          count={ids.length}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("groupFields.replacesUnavailable")}</p>
      )}
    </BulkEditDialog>
  );
}
