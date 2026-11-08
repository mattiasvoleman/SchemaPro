import type {
  ConsentDetail,
  ConsentEntryView,
  ConsentListItem,
  ConsentRow,
  GroupChoice,
  Instructor,
  ProofRoster,
  ProofRow,
  ProofView,
  PupilCard,
  TemplateView,
} from "../../../lib/checklists";
import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { KIND, uid } from "../sessions";
import { addDays, THIS_MONDAY } from "./calendar";
import { DUTIES } from "./staffing-rows";
import { ADMIN, GROUPS, GROUP_LIST, STUDENT_LIST, SUBJECTS, TEACHERS, TEACHER_LIST } from "./world";

/**
 * Checklistor as the gateway answers it (src/checklists/): the school's
 * instruction templates, a group's roster with what each pupil has had, a
 * pupil's card, and the consent lists of a class with where each pupil stands.
 *
 *  - Templates: Laborationssäkerhet (Biologi), Simkunnighet (Idrott och hälsa),
 *    Brandövning (no subject), and Skärverktyg (Bild), which is retired.
 *  - An administrator sees every group of the year and ticks and writes in all.
 *    Anna (teacher) ticks in 7A and Ma7 fördjupning, which she teaches, mentors
 *    7A (so she may make a list for it) and only looks at 7B.
 *  - Rosters: the pupils of a class; in 7A Ella has had Laborationssäkerhet
 *    (by Anna, and once before), Ines has not, Jamal has had it from another
 *    teacher (Bo: Anna may not void that tick).
 *  - Consent lists: "Fotografering HT 2026" in 7A (Ella consented on paper, Ines's
 *    consent was taken back, Jamal has not answered) and the ended "Utflykt till
 *    Skansen" in 7B. Kvittens is on.
 * The pages are read only here: a write is answered with an empty object, and
 * nothing is kept, so the next read is the same.
 */

const at = (days: number, time: string) => `${addDays(THIS_MONDAY, days)}T${time}:00.000Z`;
const day = (days: number) => addDays(THIS_MONDAY, days);
const nameOf = (pupil: (typeof STUDENT_LIST)[number]) => `${pupil.firstName} ${pupil.lastName}`;
const nameOfStaff = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`;

const staffOnly = (context: GatewayContext): Reply | null => {
  if (!context.person) return new Reply(401, { message: "Not authenticated." });
  return context.person.persona === "admin" || context.person.persona === "teacher" ? null : new Reply(403, { message: "Forbidden." });
};

const notFound = () => new Reply(404, { message: "Det finns inte, eller är inte ditt att se.", code: "CHECKLIST_NOT_FOUND" });

const TEMPLATES: TemplateView[] = [
  {
    id: uid(KIND.misc, 8501),
    subjectId: SUBJECTS.no.id,
    subjectName: SUBJECTS.no.name,
    title: "Laborationssäkerhet",
    description: "Skyddsglasögon, dragskåp och vad man gör vid spill.",
    active: true,
  },
  { id: uid(KIND.misc, 8502), subjectId: SUBJECTS.idh.id, subjectName: SUBJECTS.idh.name, title: "Simkunnighet", description: null, active: true },
  { id: uid(KIND.misc, 8503), subjectId: null, subjectName: null, title: "Brandövning", description: "Utrymning och samlingsplats.", active: true },
  { id: uid(KIND.misc, 8504), subjectId: SUBJECTS.bl.id, subjectName: SUBJECTS.bl.name, title: "Skärverktyg", description: null, active: false },
];

/** The classes a teacher holds MENTORSKAP for. */
function mentored(userId: string): Set<string> {
  return new Set(DUTIES.filter((duty) => duty.kind === "MENTORSKAP" && duty.userId === userId).map((duty) => duty.studentGroupId ?? ""));
}

/** Anna teaches 7A and Ma7 fördjupning, mentors 7A (her MENTORSKAP duty) and only looks at 7B. */
function groupsFor(context: GatewayContext): GroupChoice[] {
  const person = context.person!;
  if (person.persona === "admin") {
    return GROUP_LIST.map((one) => ({ id: one.id, name: one.name, kind: one.kind, subjects: [], canTick: true, canMakeList: one.kind === "CLASS" }));
  }
  const mine = mentored(person.userId);
  return [
    { id: GROUPS.g7A.id, name: GROUPS.g7A.name, kind: "CLASS", subjects: [SUBJECTS.no.name], canTick: true, canMakeList: mine.has(GROUPS.g7A.id) },
    { id: GROUPS.ma7.id, name: GROUPS.ma7.name, kind: "TEACHING_GROUP", subjects: [SUBJECTS.ma.name], canTick: true, canMakeList: false },
    { id: GROUPS.g7B.id, name: GROUPS.g7B.name, kind: "CLASS", subjects: [], canTick: false, canMakeList: mine.has(GROUPS.g7B.id) },
  ];
}

const INSTRUCTORS: Instructor[] = [ADMIN, ...TEACHER_LIST.filter((one) => one.isActive)].map((one) => ({ id: one.id, name: nameOfStaff(one) }));

const proof = (id: number, days: number, by: (typeof TEACHERS)[keyof typeof TEACHERS], canVoid: boolean, note: string | null = null): ProofView => ({
  id: uid(KIND.misc, id),
  instructedOn: day(days),
  instructorId: by.id,
  instructorName: nameOfStaff(by),
  recordedByName: nameOfStaff(by),
  recordedAt: at(days, "09:15"),
  note,
  canVoid,
});

/** What each pupil has had in Laborationssäkerhet. */
const PROOFS_OF: Record<string, ProofView[]> = {
  [STUDENT_LIST[0]!.id]: [proof(8601, -3, TEACHERS.anna, true, "Tillsammans med Biologi 7"), proof(8602, -150, TEACHERS.anna, true)],
  [STUDENT_LIST[3]!.id]: [proof(8603, -20, TEACHERS.bo, false)],
};

function rosterOf(context: GatewayContext): ProofRoster | Reply {
  const template = TEMPLATES.find((one) => one.id === context.params.id);
  const group = groupsFor(context).find((one) => one.id === context.query.get("groupId"));
  if (!template || !group) return notFound();
  const members = STUDENT_LIST.filter((pupil) => pupil.studentGroupId === group.id || (group.kind === "TEACHING_GROUP" && pupil.studentGroupId === GROUPS.g7A.id));
  const rows: ProofRow[] = members.map((pupil) => ({
    studentId: pupil.id,
    name: nameOf(pupil),
    className: GROUP_LIST.find((one) => one.id === pupil.studentGroupId)?.name ?? null,
    canTick: group.canTick,
    proofs: template.title === "Laborationssäkerhet" ? (PROOFS_OF[pupil.id] ?? []) : [],
  }));
  return {
    template,
    group: { id: group.id, name: group.name, kind: group.kind },
    rows,
    done: rows.filter((one) => one.proofs.length > 0).length,
    pupils: rows.length,
    heldOut: 0,
  };
}

const entry = (id: number, kind: ConsentEntryView["kind"], days: number, over: Partial<ConsentEntryView> = {}): ConsentEntryView => ({
  id: uid(KIND.misc, id),
  kind,
  source: "REGISTERED",
  givenOn: day(days),
  givenBy: "Vårdnadshavare",
  note: null,
  recordedByName: nameOfStaff(TEACHERS.anna),
  recordedAt: at(days + 1, "10:00"),
  ...over,
});

const LIST_OPEN = uid(KIND.misc, 8701);
const LIST_CLOSED = uid(KIND.misc, 8702);

function rowsOfOpenList(canWrite: boolean): ConsentRow[] {
  const [ella, , ines, jamal] = STUDENT_LIST;
  const granted = entry(8801, "GRANTED", -5, { givenBy: "Ellas mamma" });
  const grantedFirst = entry(8802, "GRANTED", -12, { givenBy: "Ines pappa" });
  const withdrawn = entry(8803, "WITHDRAWN", -2, { givenBy: "Ines pappa" });
  return [
    { studentId: ella!.id, name: nameOf(ella!), className: "7A", inClass: true, state: "GRANTED", entry: granted, history: [granted], ask: null, canWrite },
    { studentId: ines!.id, name: nameOf(ines!), className: "7A", inClass: true, state: "WITHDRAWN", entry: withdrawn, history: [withdrawn, grantedFirst], ask: null, canWrite },
    { studentId: jamal!.id, name: nameOf(jamal!), className: "7A", inClass: true, state: "MISSING", entry: null, history: [], ask: null, canWrite },
  ];
}

const countsOf = (rows: ConsentRow[]) => ({
  pupils: rows.length,
  granted: rows.filter((one) => one.state === "GRANTED").length,
  declined: rows.filter((one) => one.state === "DECLINED").length,
  withdrawn: rows.filter((one) => one.state === "WITHDRAWN").length,
  asked: rows.filter((one) => one.state === "ASKED").length,
  missing: rows.filter((one) => one.state === "MISSING").length,
});

/** The two lists, as the reader reads them: a teacher writes for the class she mentors (7A) and reads 7B. */
function detailsFor(context: GatewayContext): ConsentDetail[] {
  const person = context.person!;
  const writes = person.persona === "admin" || mentored(person.userId).has(GROUPS.g7A.id);
  const open = rowsOfOpenList(writes);
  const [klara, leo] = STUDENT_LIST.filter((pupil) => pupil.studentGroupId === GROUPS.g7B.id);
  const closedRows: ConsentRow[] = [klara!, leo!].map((pupil, index) => {
    const answer = entry(8810 + index, "GRANTED", -40, { source: index === 0 ? "KVITTENS" : "REGISTERED", recordedByName: index === 0 ? null : nameOfStaff(TEACHERS.bo) });
    return { studentId: pupil.id, name: nameOf(pupil), className: "7B", inClass: true, state: "GRANTED", entry: answer, history: [answer], ask: null, canWrite: false };
  });
  const base = { createdByName: nameOfStaff(TEACHERS.anna) };
  const item = (id: string, title: string, classId: string, className: string, createdDays: number, rows: ConsentRow[], closedAt: string | null): ConsentListItem => ({
    id,
    title,
    classId,
    className,
    createdAt: at(createdDays, "08:00"),
    closedAt,
    counts: countsOf(rows),
    ...base,
  });
  return [
    {
      list: {
        ...item(LIST_OPEN, "Fotografering HT 2026", GROUPS.g7A.id, "7A", -14, open, null),
        body: "Skolan får fotografera eleven vid skolfotograferingen.\nBilderna används i skolans eget register.",
      },
      kvittens: true,
      canClose: true,
      rows: open,
      heldOut: 0,
    },
    {
      list: {
        ...item(LIST_CLOSED, "Utflykt till Skansen", GROUPS.g7B.id, "7B", -45, closedRows, at(-30, "12:00")),
        body: "Eleven får följa med på utflykten till Skansen och åka kollektivt dit.",
      },
      kvittens: true,
      canClose: false,
      rows: closedRows,
      heldOut: 0,
    },
  ];
}

function cardOf(context: GatewayContext): PupilCard | Reply {
  const pupil = STUDENT_LIST.find((one) => one.id === context.params.id);
  if (!pupil) return notFound();
  const voided = { ...proof(8604, -90, TEACHERS.bo, false), voidedAt: at(-89, "08:00"), voidedByName: nameOfStaff(TEACHERS.bo), voidReason: "Fel elev" };
  const make = (one: ProofView, template: TemplateView, over: Partial<PupilCard["proofs"][number]> = {}): PupilCard["proofs"][number] => ({
    ...one,
    templateId: template.id,
    templateTitle: template.title,
    subjectName: template.subjectName,
    voidedAt: null,
    voidedByName: null,
    voidReason: null,
    ...over,
  });
  const own = (PROOFS_OF[pupil.id] ?? []).map((one) => make(one, TEMPLATES[0]!));
  const detail = detailsFor(context)[0]!;
  const row = detail.rows.find((one) => one.studentId === pupil.id);
  return {
    student: { id: pupil.id, name: nameOf(pupil), className: GROUP_LIST.find((one) => one.id === pupil.studentGroupId)?.name ?? null },
    proofs: [...own, ...(own.length > 0 ? [make(voided, TEMPLATES[2]!, { ...voided })] : [])],
    consents: row ? [{ listId: LIST_OPEN, title: detail.list.title, className: "7A", closed: false, state: row.state, entry: row.entry }] : [],
  };
}

export const checklistsRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/checklists/settings", (context) => staffOnly(context) ?? { kvittens: true }),
  route("GET", "/api/v1/checklists/templates", (context) =>
    staffOnly(context) ?? (context.query.get("includeRetired") === "true" ? TEMPLATES : TEMPLATES.filter((one) => one.active)),
  ),
  route("GET", "/api/v1/checklists/groups", (context) => staffOnly(context) ?? groupsFor(context)),
  route("GET", "/api/v1/checklists/instructors", (context) => staffOnly(context) ?? INSTRUCTORS),
  route("GET", "/api/v1/checklists/templates/:id/roster", (context) => staffOnly(context) ?? rosterOf(context)),
  route("GET", "/api/v1/checklists/templates/:id/roster/print", (context) => staffOnly(context) ?? rosterOf(context)),
  route("GET", "/api/v1/checklists/students/:id", (context) => staffOnly(context) ?? cardOf(context)),
  route("GET", "/api/v1/checklists/consent-lists", (context) => {
    const refused = staffOnly(context);
    if (refused) return refused;
    const classId = context.query.get("classId");
    const includeClosed = context.query.get("includeClosed") === "true";
    return detailsFor(context)
      .map((one) => one.list)
      .filter((one) => (classId ? one.classId === classId : true) && (includeClosed || one.closedAt === null))
      .map(({ id, title, classId: forClass, className, createdAt, createdByName, closedAt, counts }) => ({ id, title, classId: forClass, className, createdAt, createdByName, closedAt, counts }));
  }),
  route("GET", "/api/v1/checklists/consent-lists/:id", (context) => staffOnly(context) ?? detailsFor(context).find((one) => one.list.id === context.params.id) ?? notFound()),
  route("GET", "/api/v1/checklists/consent-lists/:id/print", (context) => staffOnly(context) ?? detailsFor(context).find((one) => one.list.id === context.params.id) ?? notFound()),
];
