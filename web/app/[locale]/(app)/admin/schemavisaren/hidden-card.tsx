"use client";

/*
 * "Dolda scheman": the schedules Schemavisaren never shows, one by one — a
 * teacher, a class or a group, a room, a pupil. A hidden schedule has no page
 * of its own, is in no list and (a teacher) is on no lesson; the codes and
 * links that already name it stop answering within a minute.
 *
 * Meant for what the school does not want shown, and for skyddad identitet
 * where the school wants to be sure: a person the school has marked as having
 * a protected identity is never shown whatever is set here (the database
 * holds that, and so does a pupil whose guardian is marked), so this list is a
 * second lock and not the only one.
 *
 * TEACHERS: TeacherPublicLabels.hidden, as before the lägen. The others:
 * PublicTimetableHidden. Pupils are not a list to switch through (a school has
 * hundreds): the hidden ones are listed, and one is hidden by picking the class
 * and then the pupil.
 *
 * If a list could not be read, no switch is drawn at all: every switch would
 * read "shown" whatever the school decided, and one press could expose a
 * schedule that was hidden.
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { HiddenKind } from "@/lib/publication-types";
import type { Person, Room, StudentGroup } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useReadOnly } from "@/components/profile-context";
import { useSetTargetHidden, useSetTeacherHidden } from "./use-public-links";

const fullName = (person: Person) => `${person.firstName} ${person.lastName}`;

export interface HiddenCardProps {
  teachers: readonly Person[];
  /** The year's classes and groups. */
  groups: readonly StudentGroup[];
  rooms: readonly Room[];
  /** Every pupil of the school. */
  students: readonly Person[];
  hiddenTeachers: ReadonlySet<string>;
  hiddenGroups: ReadonlySet<string>;
  hiddenRooms: ReadonlySet<string>;
  hiddenStudents: ReadonlySet<string>;
  /** Something still on its way. */
  loading?: boolean;
  /** Something failed: no switch is drawn (see above). */
  failed?: boolean;
}

export function HiddenCard({
  teachers,
  groups,
  rooms,
  students,
  hiddenTeachers,
  hiddenGroups,
  hiddenRooms,
  hiddenStudents,
  loading = false,
  failed = false,
}: HiddenCardProps) {
  const t = useTranslations("schemavisaren");
  const tErrors = useTranslations("schemavisaren.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const setTeacher = useSetTeacherHidden();
  const setTarget = useSetTargetHidden();
  // A press saves: a reader (Läsbehörighet) sees who is hidden, the switches not pressable.
  const readOnly = useReadOnly();
  const [classId, setClassId] = useState("");
  const [studentId, setStudentId] = useState("");

  const classes = useMemo(() => groups.filter((group) => group.kind === "CLASS" && !group.halfOfId), [groups]);
  const inClass = useMemo(
    () => students.filter((student) => student.studentGroupId === classId && !hiddenStudents.has(student.id)),
    [students, classId, hiddenStudents],
  );
  const hiddenPupils = useMemo(
    () => students.filter((student) => hiddenStudents.has(student.id)),
    [students, hiddenStudents],
  );
  // A hidden pupil the people list no longer has (removed since): still listed, so that it can be shown again.
  const unknown = [...hiddenStudents].filter((id) => !students.some((student) => student.id === id));

  const fail = (error: unknown) => toast.error(publicationErrorText(tErrors, error, tCommon("error")));
  const toggleTeacher = async (userId: string, hidden: boolean) => {
    try {
      await setTeacher.mutateAsync({ userId, hidden });
    } catch (error) {
      fail(error);
    }
  };
  const toggle = async (kind: HiddenKind, id: string, hidden: boolean) => {
    try {
      await setTarget.mutateAsync({ kind, id, hidden });
    } catch (error) {
      fail(error);
    }
  };
  const hideStudent = async () => {
    await toggle("student", studentId, true);
    setStudentId("");
  };

  const busy = setTeacher.isPending || setTarget.isPending;
  const section = (id: string, title: string, hidden: ReadonlySet<string>, body: React.ReactNode, intro?: string) => (
    <section aria-labelledby={`hidden-${id}-title`} className="space-y-2">
      <h3 id={`hidden-${id}-title`} className="text-sm font-medium">
        {title}{" "}
        <span className="font-normal text-muted-foreground">({t("hiddenCount", { count: hidden.size })})</span>
      </h3>
      {intro ? <p className="max-w-prose text-xs text-muted-foreground">{intro}</p> : null}
      {body}
    </section>
  );
  const switches = (
    items: readonly { id: string; name: string }[],
    hidden: ReadonlySet<string>,
    prefix: string,
    onToggle: (id: string, next: boolean) => void,
    none: string,
  ) =>
    items.length === 0 ? (
      <p className="text-sm text-muted-foreground">{none}</p>
    ) : (
      <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          // The whole row: the name is the switch's label, and pressing it would save.
          <li key={item.id} className="flex items-center gap-3" data-writes-inert="PUBLICERING">
            <Switch
              id={`hidden-${prefix}-${item.id}`}
              checked={hidden.has(item.id)}
              disabled={readOnly || busy}
              onCheckedChange={(checked) => onToggle(item.id, checked)}
              aria-label={t("hiddenToggle", { name: item.name })}
            />
            <label htmlFor={`hidden-${prefix}-${item.id}`}>{item.name}</label>
          </li>
        ))}
      </ul>
    );

  return (
    <SectionCard id="viewer-hidden" title={t("hiddenTitle")} description={t("hiddenBody")} descriptionClassName="max-w-prose">
      {loading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : failed ? (
        <LoadError variant="inline" title={t("hiddenLoadFailed")} hint={t("hiddenLoadFailedHint")} />
      ) : (
        <div className="space-y-5">
          {section(
            "teachers",
            t("hiddenKinds.TEACHER"),
            hiddenTeachers,
            switches(
              teachers.map((teacher) => ({ id: teacher.id, name: fullName(teacher) })),
              hiddenTeachers,
              "teacher",
              (id, next) => void toggleTeacher(id, next),
              t("hiddenNone.TEACHER"),
            ),
            t("hiddenTeachersBody"),
          )}
          {section(
            "groups",
            t("hiddenKinds.GROUP"),
            hiddenGroups,
            switches(
              groups.map((group) => ({ id: group.id, name: group.name })),
              hiddenGroups,
              "group",
              (id, next) => void toggle("group", id, next),
              t("hiddenNone.GROUP"),
            ),
          )}
          {section(
            "rooms",
            t("hiddenKinds.ROOM"),
            hiddenRooms,
            switches(
              rooms.map((room) => ({ id: room.id, name: room.name })),
              hiddenRooms,
              "room",
              (id, next) => void toggle("room", id, next),
              t("hiddenNone.ROOM"),
            ),
          )}
          {section(
            "students",
            t("hiddenKinds.STUDENT"),
            hiddenStudents,
            <div className="space-y-3">
              {hiddenPupils.length === 0 && unknown.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("hiddenNone.STUDENT")}</p>
              ) : (
                <ul className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {[
                    ...hiddenPupils.map((student) => ({ id: student.id, name: fullName(student) })),
                    ...unknown.map((id) => ({ id, name: t("hiddenStudentUnknown") })),
                  ].map((item) => (
                    <li key={item.id} className="flex items-center gap-3" data-writes-inert="PUBLICERING">
                      <Switch
                        id={`hidden-student-${item.id}`}
                        checked
                        disabled={readOnly || busy}
                        onCheckedChange={() => void toggle("student", item.id, false)}
                        aria-label={t("hiddenToggle", { name: item.name })}
                      />
                      <label htmlFor={`hidden-student-${item.id}`}>{item.name}</label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid max-w-xl items-end gap-3 sm:grid-cols-[1fr_1fr_auto] [&>*]:min-w-0" data-writes-inert="PUBLICERING">
                <div className="space-y-1.5">
                  <Label htmlFor="hide-student-class">{t("hiddenStudentClass")}</Label>
                  <NativeSelect
                    id="hide-student-class"
                    value={classId}
                    onChange={(event) => {
                      setClassId(event.target.value);
                      setStudentId("");
                    }}
                  >
                    <option value="">{t("hiddenPickClass")}</option>
                    {classes.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="hide-student-pupil">{t("hiddenStudentPupil")}</Label>
                  <NativeSelect
                    id="hide-student-pupil"
                    value={studentId}
                    disabled={classId === ""}
                    onChange={(event) => setStudentId(event.target.value)}
                  >
                    <option value="">{t("hiddenPickStudent")}</option>
                    {inClass.map((student) => (
                      <option key={student.id} value={student.id}>
                        {fullName(student)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
                <Button
                  variant="outline"
                  onClick={() => void hideStudent()}
                  disabled={studentId === "" || busy}
                  data-writes="PUBLICERING"
                >
                  {t("hiddenStudentAdd")}
                </Button>
              </div>
            </div>,
            t("hiddenStudentsBody"),
          )}
        </div>
      )}
    </SectionCard>
  );
}
