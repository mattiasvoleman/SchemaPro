/**
 * Uppdrag as the file the importer reads (uppdrag.csv), the export the
 * people page had none of: its import took the file, but no button gave the
 * school its own uppdrag back to edit.
 *
 * A module of its own, loaded at the click like the timplan's builder: the
 * people page sits close to its bundle budget, and nobody pays for these
 * lines who never exports.
 *
 * Blocked times are not in the file, as the import takes none (see the
 * template): they are placed on the uppdrag in the app.
 */

import type { TeacherDuty, TeacherDutyKind } from "@/lib/types";
import { api } from "@/lib/api";
import { CSV_TEMPLATES, activeEmails, serializeCsv } from "@/lib/csv-export";

/** The word the export writes per kind, each one DUTY_KIND_BY_WORD in lib/csv.ts reads back. */
const DUTY_KIND_WORD: Record<TeacherDutyKind, string> = {
  MENTORSKAP: "mentorskap",
  AMNESANSVAR: "ämnesansvar",
  FORSTELARARE: "förstelärare",
  RASTVAKT: "rastvakt",
  PEDAGOGISK_LUNCH: "pedagogisk lunch",
  APT_KONFERENS: "apt/konferens",
  VFU_HANDLEDNING: "vfu-handledning",
  APL: "apl",
  ANNAT: "annat",
};

/**
 * One row per uppdrag, the teacher by e-mail, the subject by code (its name
 * when it has none) and the group by name. A row whose teacher, subject or
 * group the loaded lists cannot name — a deactivated teacher's among them —
 * is left out rather than written blank: a blank ämne or grupp is an
 * instruction to clear it on re-import.
 */
export function teacherDutiesToCsv(
  duties: {
    userId: string;
    kind: TeacherDutyKind;
    label: string;
    minutesPerWeek: number;
    countsAsTeaching: boolean;
    subjectId: string | null;
    studentGroupId: string | null;
    validFrom: string | null;
    validTo: string | null;
    note: string | null;
  }[],
  people: { id: string; email: string; isActive?: boolean }[],
  subjects: { id: string; name: string; code: string | null }[],
  groups: { id: string; name: string }[],
): string {
  const email = activeEmails(people);
  const subjectLabel = new Map(
    subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]),
  );
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const rows: string[][] = [];
  for (const duty of duties) {
    const teacher = email.get(duty.userId);
    const subject = duty.subjectId ? subjectLabel.get(duty.subjectId) : "";
    const group = duty.studentGroupId ? groupName.get(duty.studentGroupId) : "";
    if (!teacher || subject === undefined || group === undefined) continue;
    rows.push([
      teacher,
      DUTY_KIND_WORD[duty.kind],
      duty.label,
      String(duty.minutesPerWeek),
      duty.countsAsTeaching ? "ja" : "nej",
      subject,
      group,
      // yyyy-mm-dd as the gateway answers them; a timestamp would not import.
      duty.validFrom?.slice(0, 10) ?? "",
      duty.validTo?.slice(0, 10) ?? "",
      duty.note ?? "",
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.teacherDuties.headers, rows);
}

/**
 * The läsår's uppdrag, read at the click (the people page holds none of
 * them) and written as uppdrag.csv: the year the import writes into, its
 * groups only, since a group name means a group of that year.
 */
export async function teacherDutiesCsvFor(
  academicYearId: string,
  people: { id: string; email: string; isActive?: boolean }[],
  subjects: { id: string; name: string; code: string | null }[],
  groups: { id: string; name: string; academicYearId: string }[],
): Promise<string> {
  const duties = await api.get<TeacherDuty[]>(
    `/api/v1/teacher-duties?academicYearId=${encodeURIComponent(academicYearId)}`,
  );
  return teacherDutiesToCsv(
    duties,
    people,
    subjects,
    groups.filter((group) => group.academicYearId === academicYearId),
  );
}
