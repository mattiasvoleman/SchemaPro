import { describe, expect, it } from "vitest";
import gatewayFields from "../../src/import-templates/__fixtures__/import-fields.json";
import lessonColumns from "../../src/schedule-exchange/__fixtures__/lesson-table-columns.json";
import {
  CSV_KINDS,
  FIELDS,
  FIELD_CONFLICTS,
  TEMPLATE_KINDS,
  COMBINED_OUTPUT,
  type TemplateKind,
} from "@/lib/column-fields";
import {
  mapClassRows,
  mapGuardianRows,
  mapMembershipRows,
  mapRequirementRows,
  mapRoomRows,
  mapRoomTypeRows,
  mapStudentRows,
  mapSubjectRows,
  mapTeacherDutyRows,
  mapTeacherQualificationRows,
  mapTeacherRows,
  parseCsv,
} from "@/lib/csv";
import { normalizeHeader } from "@/lib/csv-export";
import { mapTimplanRows } from "@/lib/timplan-csv";

/**
 * The catalogue of fields, held to the three things it copies: the gateway's list of the same ids (a shared fixture), the
 * flat table's columns (another), and, for the eleven CSV kinds and the timplan, the importers themselves: every field is
 * written under its header into a file whose other cells are valid, the kind's mapper is run over it, and the field is read.
 */
describe("the catalogue is the gateway's list of fields", () => {
  it("has the gateway's thirteen kinds, in its order", () => {
    expect([...TEMPLATE_KINDS]).toEqual(gatewayFields.kinds);
  });

  it.each(TEMPLATE_KINDS)("%s has the gateway's fields and no others", (kind) => {
    const ours = FIELDS[kind].map((field) => field.id).sort();
    const theirs = [...(gatewayFields.fields as Record<string, string[]>)[kind]!].sort();
    expect(ours).toEqual(theirs);
  });

  it("holds the same pairs of fields apart as the gateway does", () => {
    expect(FIELD_CONFLICTS).toEqual(gatewayFields.conflicts);
  });

  it("writes what each combined field fills in as fields the kind has", () => {
    for (const [combined, [first, second]] of Object.entries(COMBINED_OUTPUT)) {
      const ids = FIELDS.scheduleLessons.map((field) => field.id);
      expect(ids).toContain(combined);
      expect(ids).toContain(first);
      expect(ids).toContain(second);
    }
  });
});

describe("the fields of the flat timetable are its columns", () => {
  const byKey = new Map(lessonColumns.columns.map((column) => [column.key, column]));

  it.each(FIELDS.scheduleLessons.filter((field) => field.combined === undefined).map((field) => [field.id] as const))(
    "%s is a column of the table, under its Swedish header, with every spelling the reader takes",
    (id) => {
      const column = byKey.get(id);
      expect(column, `the gateway has no column ${id}`).toBeDefined();
      const field = FIELDS.scheduleLessons.find((entry) => entry.id === id)!;
      expect(field.header).toBe(column!.sv);
      expect([...field.aliases].sort()).toEqual([column!.sv, column!.en, ...column!.aliases].map(normalizeHeader).sort());
    },
  );

  it("leaves out exactly the columns Rastra's own export writes (and a reader ignores, or takes by its own header: Undantag), and nothing else", () => {
    const ours = new Set(FIELDS.scheduleLessons.filter((field) => field.combined === undefined).map((field) => field.id));
    const left = lessonColumns.columns.map((column) => column.key).filter((key) => !ours.has(key));
    expect(left.sort()).toEqual(
      ["coTeacherId", "exempt", "extraGroupIds", "groupId", "lessonId", "length", "locked", "period", "roomId", "subjectId", "teacherId"].sort(),
    );
  });

  it("needs the five the reader needs, the start and the end unless one cell holds them", () => {
    const required = FIELDS.scheduleLessons.filter((field) => field.required).map((field) => field.id);
    expect(required.sort()).toEqual(["day", "end", "group", "start", "subject"]);
    expect(FIELDS.scheduleLessons.filter((field) => field.requiredUnless !== undefined).map((field) => [field.id, field.requiredUnless])).toEqual([
      ["start", "timeRange"],
      ["end", "timeRange"],
    ]);
  });
});

/** One valid cell per field: what the kind's mapper takes without a complaint. */
const SAMPLE: Record<Exclude<TemplateKind, "scheduleLessons">, Record<string, string>> = {
  students: { firstName: "Anna", lastName: "Berg", email: "anna@skolan.se", phone: "070-123 45 67", className: "7A" },
  guardians: { firstName: "Karin", lastName: "Berg", email: "karin@skolan.se", phone: "070-765 43 21", studentEmail: "anna@skolan.se" },
  teachers: { firstName: "Bo", lastName: "Lund", email: "bo@skolan.se", phone: "070-111 22 33", employmentPercent: "80", reductionPercent: "10", contractKind: "ferie", signature: "BLU" },
  classes: { name: "7A:1", gradeLevel: "7", kind: "undervisningsgrupp", halfOf: "7A", replacesSubject: "SL" },
  teachingGroups: { groupName: "Ma7", email: "anna@skolan.se" },
  roomTypes: { name: "Slöjdsal" },
  rooms: { name: "Sal A1", code: "A1", roomType: "Klassrum", capacity: "30", minGradeLevel: "7", maxGradeLevel: "9", building: "Hus A", floor: "1" },
  subjects: { name: "Matematik", code: "MA", color: "#4f46e5", roomType: "Klassrum", nationalCode: "MA", countsTowardTimplan: "ja" },
  requirements: {
    groupName: "7A",
    subject: "MA",
    lessonsPerWeek: "2",
    minutesPerLesson: "80",
    lessonLengths: "1x80+1x40",
    minutesBefore: "10",
    minutesAfter: "20",
    teacherEmail: "karin@skolan.se",
    teacherSignature: "KBE",
    coTeacherEmail: "bo@skolan.se",
    coTeacherSignature: "BLU",
    teacherLoadPercent: "100",
    coTeacherLoadPercent: "50",
    recurrence: "udda",
    startDate: "2026-08-17",
    endDate: "2026-12-18",
  },
  teacherQualifications: { teacherEmail: "karin@skolan.se", subject: "MA", minGrade: "7", maxGrade: "9", kind: "legitimation" },
  teacherDuties: {
    teacherEmail: "karin@skolan.se",
    kind: "mentorskap",
    label: "Mentor 7A",
    minutesPerWeek: "90",
    countsAsTeaching: "ja",
    subject: "MA",
    groupName: "7A",
    validFrom: "2026-08-17",
    validTo: "2026-12-18",
    note: "Hela hösten",
  },
  timplan: { subject: "MA", gradeLevel: "7", minutesPerWeek: "120", note: "Skolans val" },
};

type Mapped = { rows: Array<Record<string, unknown>>; errors: Array<{ row: number; message: string }> };
const MAPPER: Record<Exclude<TemplateKind, "scheduleLessons">, (parsed: ReturnType<typeof parseCsv>) => Mapped> = {
  students: mapStudentRows as never,
  guardians: mapGuardianRows as never,
  teachers: mapTeacherRows as never,
  classes: mapClassRows as never,
  teachingGroups: mapMembershipRows as never,
  roomTypes: mapRoomTypeRows as never,
  rooms: mapRoomRows as never,
  subjects: mapSubjectRows as never,
  requirements: mapRequirementRows as never,
  teacherQualifications: mapTeacherQualificationRows as never,
  teacherDuties: mapTeacherDutyRows as never,
  timplan: mapTimplanRows as never,
};

const KINDS_WITH_A_MAPPER = [...CSV_KINDS, "timplan"] as const;

/** A file of the kind with the given headers for the given fields, one row of the valid samples. */
function fileOf(kind: (typeof KINDS_WITH_A_MAPPER)[number], headers: Record<string, string>): ReturnType<typeof parseCsv> {
  const ids = Object.keys(headers);
  const cells = ids.map((id) => SAMPLE[kind][id]!);
  return parseCsv([ids.map((id) => headers[id]).join(";"), cells.join(";")].join("\n"));
}

/**
 * Fields the importer will not take in one row with another: a half of a class replaces no subject, so one row of `classes`
 * cannot show halfOf and replacesSubject together, and a teacher is named by e-mail or by signature, not both. Each of the
 * second ones is read in a file of its own, without its partner.
 */
const EXCLUSIVE: Partial<Record<(typeof KINDS_WITH_A_MAPPER)[number], ReadonlyArray<readonly [keep: string, drop: string]>>> = {
  classes: [["halfOf", "replacesSubject"]],
  requirements: [
    ["teacherEmail", "teacherSignature"],
    ["coTeacherEmail", "coTeacherSignature"],
  ],
};

describe.each(KINDS_WITH_A_MAPPER)("the %s fields are what its importer reads", (kind) => {
  const all = FIELDS[kind];
  const exclusive = EXCLUSIVE[kind] ?? [];
  // The fields one file can show together; the one the importer will not take beside another is read in the second file below.
  const fields = all.filter((field) => !exclusive.some(([, drop]) => drop === field.id));

  it("has a sample for every field, and a header that is one of the field's own spellings", () => {
    for (const field of fields) {
      expect(SAMPLE[kind][field.id], `no sample for ${kind}.${field.id}`).toBeDefined();
      expect(field.aliases, `${kind}.${field.id}: the header ${field.header} is not among its spellings`).toContain(normalizeHeader(field.header));
    }
  });

  it("reads every field of the kind, written under the header the catalogue gives it", () => {
    const parsed = fileOf(kind, Object.fromEntries(fields.map((field) => [field.id, field.header])));
    const mapped = MAPPER[kind](parsed);
    expect(mapped.errors).toEqual([]);
    expect(mapped.rows).toHaveLength(1);
    for (const field of fields) {
      const value = mapped.rows[0]![field.id];
      expect(value, `${kind}.${field.id} was not read from ${field.header}`).not.toBeUndefined();
      expect(value, `${kind}.${field.id} was read as nothing`).not.toBeNull();
      expect(value).not.toBe("");
    }
  });

  it("reads each field under every spelling the catalogue lists for it", () => {
    for (const field of fields) {
      for (const alias of field.aliases) {
        const parsed = fileOf(kind, Object.fromEntries(fields.map((other) => [other.id, other.id === field.id ? alias : other.header])));
        const mapped = MAPPER[kind](parsed);
        expect(mapped.errors, `${kind}.${field.id} under "${alias}"`).toEqual([]);
        const value = mapped.rows[0]?.[field.id];
        expect(value, `${kind}.${field.id} was not read from "${alias}"`).not.toBeUndefined();
        expect(value).not.toBeNull();
      }
    }
  });

  it("is refused by the importer, naming a column, when a required field has no column", () => {
    for (const field of fields.filter((entry) => entry.required)) {
      const others = fields.filter((other) => other.id !== field.id);
      const mapped = MAPPER[kind](fileOf(kind, Object.fromEntries(others.map((other) => [other.id, other.header]))));
      expect(mapped.rows, `${kind} imported without ${field.id}`).toEqual([]);
      expect(mapped.errors.length, `${kind} said nothing of the missing ${field.id}`).toBeGreaterThan(0);
    }
  });

  it.runIf(exclusive.length > 0)("reads the fields it cannot show beside another, in a file without their partners", () => {
    const alone = all.filter((field) => !exclusive.some(([keep]) => keep === field.id));
    const mapped = MAPPER[kind](fileOf(kind, Object.fromEntries(alone.map((field) => [field.id, field.header]))));
    expect(mapped.errors).toEqual([]);
    for (const [, drop] of exclusive) expect(mapped.rows[0]![drop], `${kind}.${drop} was not read`).toBeTruthy();
    for (const [, drop] of exclusive) {
      for (const alias of all.find((field) => field.id === drop)!.aliases) {
        const renamed = MAPPER[kind](fileOf(kind, Object.fromEntries(alone.map((field) => [field.id, field.id === drop ? alias : field.header]))));
        expect(renamed.errors, `${kind}.${drop} under "${alias}"`).toEqual([]);
        expect(renamed.rows[0]![drop], `${kind}.${drop} was not read from "${alias}"`).toBeTruthy();
      }
    }
  });

  it("is imported without the fields that are not required", () => {
    const required = fields.filter((field) => field.required);
    const mapped = MAPPER[kind](fileOf(kind, Object.fromEntries(required.map((field) => [field.id, field.header]))));
    expect(mapped.errors).toEqual([]);
    expect(mapped.rows).toHaveLength(1);
  });
});
