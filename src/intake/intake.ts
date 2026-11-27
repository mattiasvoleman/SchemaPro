import { toNioarig, type GradeNumbering } from '../common/grade-numbering';

/**
 * Vad kom in: what the school's base data holds, and what is missing from it, counted against what Generera and the
 * steps after it ask for (P1 Pilotkit, part 2).
 *
 * PURE. The service reads the school's rows and hands this the facts; nothing here reads a row or says a word a
 * person reads. A gap is a CODE and a number, and the web gives it its words and the page that owns it, as it does
 * for the engine's sentences (a code in, the words out).
 *
 * THREE LEVELS, and each rests on something the code does, never on a guess:
 *
 *   HARD  Generera cannot run without it. Either the engine refuses the request by name (INPUT_NO_REQUIREMENTS,
 *         INPUT_NO_ROOMS, ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT: each raised before the search in optimization-engine/app/solver/scheduler_solver.py as an
 *         InvalidScheduleInputError; the label of an infeasibility core is only a sentence, and no refusal), or the
 *         Generera page's own Förutsättningar hold the button (a läsår, a teacher, the staffed posts under Vägra), or
 *         a post, which Generera needs, cannot exist without it (a subject). A class is not one of them: a post belongs to a class OR to
 *         a teaching group, and nothing in the gateway or the engine asks for a class (NO_CLASSES is SOFT).
 *   SOFT  Generera runs, and the result is worse or a warning follows: a class with no årskurs is bound by no frame
 *         or rast (handboken 5.2), a year with no frame time is laid in the engine's standard day, a class with no
 *         post gets no lessons.
 *   INFO  Something another step reads and Generera does not: the lokal timplan (a shortfall is *under mål*, never a
 *         refusal), the signatures a schedule file is read by, the teachers who have no post.
 *
 * AND WHAT IS OFF (P5, Förvalen en ny skola möter). A school that has not set up its lov, its lunch, its rastvakt or the
 * switches that reach families (bevakning, kvittens, Schemavisaren, sjukanmälan) has not got them wrong: it has not turned them
 * on, and nothing tells it that they are there. Each is an INFO row that says it is not there (or "av") and links to where it is
 * turned on; none stops Generera, and none is a recommendation. A school that does not want kvittens reads "Kvittens är av" and is
 * right.
 *
 * This page counts. It does not say that a week can be laid, and it never says "klart": that is what the engine's
 * Kontrollera veckan answers, and only sometimes. A green page here is the absence of the gaps below and nothing more.
 */

export type IntakeLevel = 'HARD' | 'SOFT' | 'INFO';

/** The areas in the order the page shows them: the order the manual works through them (3.7). */
export const INTAKE_AREAS = [
  'YEAR',
  'SUBJECTS',
  'ROOMS',
  'FRAME_TIMES',
  'RASTS',
  'BREAKS',
  'LUNCH',
  'SUPERVISION',
  'CLASSES',
  'TEACHING_GROUPS',
  'PEOPLE',
  'TIMPLAN',
  'REQUIREMENTS',
  'STAFFING',
  'SWITCHES',
] as const;
export type IntakeArea = (typeof INTAKE_AREAS)[number];

/**
 * The areas whose rows belong to a läsår: with none active they have nothing to count, and the page says it waits for the year
 * instead of "nothing is missing" (a school with no year has not got no classes: it has not got a year to have them in).
 */
export const YEAR_BOUND_AREAS: readonly IntakeArea[] = ['BREAKS', 'SUPERVISION', 'CLASSES', 'TEACHING_GROUPS', 'TIMPLAN', 'REQUIREMENTS', 'STAFFING'];

/** What an area has found: a fixed set of counts, so that the answer has one shape whatever the school holds. */
export const INTAKE_FOUND: Readonly<Record<IntakeArea, readonly string[]>> = {
  YEAR: ['years'],
  SUBJECTS: ['subjects'],
  ROOMS: ['rooms', 'roomTypes'],
  FRAME_TIMES: ['frameTimes'],
  RASTS: ['rasts'],
  BREAKS: ['breaks'],
  LUNCH: ['lunchServings'],
  SUPERVISION: ['supervisionAreas', 'supervisionShifts'],
  CLASSES: ['classes'],
  TEACHING_GROUPS: ['teachingGroups'],
  PEOPLE: ['teachers', 'students'],
  TIMPLAN: ['gradesWithTimplan'],
  REQUIREMENTS: ['requirements'],
  STAFFING: ['posts'],
  SWITCHES: ['switchesOn'],
};

/**
 * Every gap there is, in the order a page lists them within an area, one line each so that the manual's table and its
 * test can read the levels from here (web/lib/manual-pilotkit.test.ts). UNSTAFFED_POSTS is SOFT here and HARD when the
 * school has chosen Generering utan lärare: Vägra (see `assess`).
 */
export const GAP_DEFINITIONS = [
  { code: 'NO_YEAR', area: 'YEAR', level: 'HARD' },
  { code: 'NO_SUBJECTS', area: 'SUBJECTS', level: 'HARD' },
  { code: 'SUBJECTS_WITHOUT_POSTS', area: 'SUBJECTS', level: 'INFO' },
  { code: 'ROOM_TYPE_WITHOUT_ROOM', area: 'SUBJECTS', level: 'HARD' },
  { code: 'NO_ROOMS', area: 'ROOMS', level: 'HARD' },
  { code: 'NO_ROOM_TYPES', area: 'ROOMS', level: 'INFO' },
  { code: 'FRAME_TIMES_MISSING', area: 'FRAME_TIMES', level: 'SOFT' },
  { code: 'NO_RASTS', area: 'RASTS', level: 'INFO' },
  { code: 'NO_BREAKS', area: 'BREAKS', level: 'INFO' },
  { code: 'LUNCH_OFF', area: 'LUNCH', level: 'INFO' },
  { code: 'NO_SUPERVISION', area: 'SUPERVISION', level: 'INFO' },
  { code: 'NO_CLASSES', area: 'CLASSES', level: 'SOFT' },
  { code: 'CLASSES_WITHOUT_GRADE', area: 'CLASSES', level: 'SOFT' },
  { code: 'CLASSES_WITHOUT_POSTS', area: 'CLASSES', level: 'SOFT' },
  { code: 'TEACHING_GROUPS_WITHOUT_MEMBERS', area: 'TEACHING_GROUPS', level: 'SOFT' },
  { code: 'NO_TEACHERS', area: 'PEOPLE', level: 'HARD' },
  { code: 'NO_STUDENTS', area: 'PEOPLE', level: 'SOFT' },
  { code: 'STUDENTS_WITHOUT_CLASS', area: 'PEOPLE', level: 'INFO' },
  { code: 'TIMPLAN_MISSING', area: 'TIMPLAN', level: 'INFO' },
  { code: 'TIMPLAN_NOT_DECIDED', area: 'TIMPLAN', level: 'INFO' },
  { code: 'NO_REQUIREMENTS', area: 'REQUIREMENTS', level: 'HARD' },
  { code: 'UNSTAFFED_POSTS', area: 'STAFFING', level: 'SOFT' },
  { code: 'TEACHERS_WITHOUT_POST', area: 'STAFFING', level: 'INFO' },
  { code: 'POSTS_WITHOUT_SIGNATURE', area: 'STAFFING', level: 'INFO' },
  { code: 'ABSENCE_WATCH_OFF', area: 'SWITCHES', level: 'INFO' },
  { code: 'ACK_OFF', area: 'SWITCHES', level: 'INFO' },
  { code: 'VIEWER_OFF', area: 'SWITCHES', level: 'INFO' },
  { code: 'SICK_REPORT_OFF', area: 'SWITCHES', level: 'INFO' },
] as const;

export type IntakeGapCode = (typeof GAP_DEFINITIONS)[number]['code'];

/** The most names a gap lists. A school of thirty classes does not get thirty lines in a card; `more` says how many were left out. */
export const ITEM_CAP = 8;

/** A count and ALL the names, in any order: `assess` sorts them and lists the first ITEM_CAP (the count is not the length of what is listed). */
export interface Named {
  count: number;
  names: readonly string[];
}

/** What the service reads of the school, and nothing it would have to name a person by. */
export interface IntakeFacts {
  /** The läsår the answer is for: the one asked for, else the active one; null when the school has none to read. */
  year: { id: string; name: string; isActive: boolean; gradeNumbering: GradeNumbering } | null;
  /** All the school's läsår. */
  years: number;
  subjects: number;
  /** Subjects with no post in the year. */
  subjectsWithoutPost: Named;
  /** Subjects with a post in the year that need a room type no room has. */
  subjectsNeedingMissingRoomType: Named;
  rooms: number;
  /** The school's room types (Gymnastiksal, Slöjdsal …): a subject that asks for a kind of room names one, and a school made by hand starts with none. */
  roomTypes: number;
  /** The school's frame times, as the years each spans (stated in NIOARIG, like every school-wide span). */
  frameTimes: readonly { minGradeLevel: number; maxGradeLevel: number }[];
  rasts: number;
  /** The year's lov and studiedagar (SchoolBreaks): publish skips their days. 0 for a school with no year. */
  breaks: number;
  /** Whether the school has turned lunch on (LunchSettings.lunchEnabled; no row is off), and how many serving rows it has. */
  lunchOn: boolean;
  lunchServings: number;
  /** The school's rastvakt areas, and the year's passes in them. */
  supervisionAreas: number;
  supervisionShifts: number;
  classes: number;
  /** The årskurs of each class of the year, in the year's own numbering; null for a class with none. One entry per class. */
  classGrades: readonly (number | null)[];
  classesWithoutGrade: Named;
  classesWithoutPost: Named;
  teachingGroups: number;
  /** The teaching groups with a post in the year whose årskurs cannot be derived (no pupil in a graded class, none of their own): see the service. */
  teachingGroupsWithoutMembers: Named;
  teachers: number;
  students: number;
  studentsWithoutClass: number;
  /** The årskurser the year has a lokal timplan for, and whether that plan is decided. */
  timplanGrades: readonly { gradeLevel: number; decided: boolean }[];
  requirements: number;
  unstaffedRequirements: number;
  unstaffedMode: 'ALLOW' | 'REFUSE';
  /** The teachers' posts of the year (the row's existence only: never a percentage). */
  posts: number;
  postsWithoutSignature: number;
  teachersWithoutPost: number;
  /** The four switches that reach families or staff, each off until the school turns it on (no settings row is off): the page says which are. */
  switches: { absenceWatch: boolean; ack: boolean; viewer: boolean; sickReport: boolean };
}

export interface IntakeGapView {
  code: IntakeGapCode;
  level: IntakeLevel;
  /** How many there are; 0 when the gap is not there. A presence gap (no rooms) is 1 or 0. */
  count: number;
  /** The first of them by name (a class, a subject, an årskurs as a number), at most ITEM_CAP. */
  items: string[];
  /** How many more than `items` lists. */
  more: number;
}

export interface IntakeAreaView {
  area: IntakeArea;
  found: Record<string, number>;
  /** True for a year-bound area of a school with no active läsår: nothing is counted for it, and none of its gaps is there. */
  waitsForYear: boolean;
  gaps: IntakeGapView[];
}

export interface IntakeView {
  year: { id: string; name: string; isActive: boolean } | null;
  areas: IntakeAreaView[];
  /** How many gaps of each level are there (count above 0). `hard` is what stops Generera. */
  hard: number;
  soft: number;
  info: number;
}

const swedish = new Intl.Collator('sv', { numeric: true });

function named(source: Named): { count: number; items: string[]; more: number } {
  const items = [...source.names].sort(swedish.compare).slice(0, ITEM_CAP);
  return { count: source.count, items, more: Math.max(0, source.count - items.length) };
}

const presence = (missing: boolean) => ({ count: missing ? 1 : 0, items: [] as string[], more: 0 });
const none = { count: 0, items: [] as string[], more: 0 };

/** The årskurser with a class, as numbers in the year's own numbering, each once, in order. */
function gradesOf(facts: IntakeFacts): number[] {
  return [...new Set(facts.classGrades.filter((grade): grade is number => grade !== null))].sort((a, b) => a - b);
}

function asItems(grades: readonly number[]): { count: number; items: string[]; more: number } {
  const items = grades.slice(0, ITEM_CAP).map(String);
  return { count: grades.length, items, more: Math.max(0, grades.length - items.length) };
}

/**
 * The gaps of a school, by area. A year-bound gap of a school with no year to read is 0: NO_YEAR is the one gap the
 * page shows, and the rest wait for it, as Kom igång makes the läsår its first step.
 */
export function assess(facts: IntakeFacts): IntakeView {
  const hasYear = facts.year !== null;
  const yearBound = <T extends { count: number; items: string[]; more: number }>(value: T): T | typeof none => (hasYear ? value : none);

  const grades = gradesOf(facts);
  // A school-wide span is stated in NIOARIG: a TIOARIG läsår's årskurs is read in NIOARIG before it is held against a frame.
  const numbering = facts.year?.gradeNumbering ?? 'NIOARIG';
  const uncovered = grades.filter((grade) => {
    const nioarig = toNioarig(grade, numbering);
    return !facts.frameTimes.some((frame) => nioarig !== null && frame.minGradeLevel <= nioarig && nioarig <= frame.maxGradeLevel);
  });
  const withTimplan = new Map(facts.timplanGrades.map((entry) => [entry.gradeLevel, entry.decided]));
  const withoutTimplan = grades.filter((grade) => !withTimplan.has(grade));
  const notDecided = grades.filter((grade) => withTimplan.get(grade) === false);

  const gaps: Record<IntakeGapCode, { count: number; items: string[]; more: number }> = {
    NO_YEAR: presence(!hasYear),
    NO_SUBJECTS: presence(facts.subjects === 0),
    SUBJECTS_WITHOUT_POSTS: yearBound(named(facts.subjectsWithoutPost)),
    ROOM_TYPE_WITHOUT_ROOM: yearBound(named(facts.subjectsNeedingMissingRoomType)),
    NO_ROOMS: presence(facts.rooms === 0),
    NO_ROOM_TYPES: presence(facts.roomTypes === 0),
    FRAME_TIMES_MISSING: yearBound(asItems(uncovered)),
    NO_RASTS: presence(facts.rasts === 0),
    NO_BREAKS: yearBound(presence(facts.breaks === 0)),
    LUNCH_OFF: presence(!facts.lunchOn),
    NO_SUPERVISION: yearBound(presence(facts.supervisionShifts === 0)),
    NO_CLASSES: yearBound(presence(facts.classes === 0)),
    CLASSES_WITHOUT_GRADE: yearBound(named(facts.classesWithoutGrade)),
    // With no post at all every class lacks one, and NO_REQUIREMENTS says it once instead of once per class.
    CLASSES_WITHOUT_POSTS: yearBound(facts.requirements > 0 ? named(facts.classesWithoutPost) : none),
    TEACHING_GROUPS_WITHOUT_MEMBERS: yearBound(named(facts.teachingGroupsWithoutMembers)),
    NO_TEACHERS: presence(facts.teachers === 0),
    NO_STUDENTS: presence(facts.students === 0),
    STUDENTS_WITHOUT_CLASS: { count: facts.studentsWithoutClass, items: [], more: 0 },
    TIMPLAN_MISSING: yearBound(asItems(withoutTimplan)),
    TIMPLAN_NOT_DECIDED: yearBound(asItems(notDecided)),
    NO_REQUIREMENTS: yearBound(presence(facts.requirements === 0)),
    UNSTAFFED_POSTS: yearBound({ count: facts.unstaffedRequirements, items: [], more: 0 }),
    TEACHERS_WITHOUT_POST: yearBound({ count: facts.teachersWithoutPost, items: [], more: 0 }),
    POSTS_WITHOUT_SIGNATURE: yearBound({ count: facts.postsWithoutSignature, items: [], more: 0 }),
    ABSENCE_WATCH_OFF: presence(!facts.switches.absenceWatch),
    ACK_OFF: presence(!facts.switches.ack),
    VIEWER_OFF: presence(!facts.switches.viewer),
    SICK_REPORT_OFF: presence(!facts.switches.sickReport),
  };

  const levelOf = (definition: (typeof GAP_DEFINITIONS)[number]): IntakeLevel =>
    definition.code === 'UNSTAFFED_POSTS' && facts.unstaffedMode === 'REFUSE' ? 'HARD' : definition.level;

  const found: Record<IntakeArea, Record<string, number>> = {
    YEAR: { years: facts.years },
    SUBJECTS: { subjects: facts.subjects },
    ROOMS: { rooms: facts.rooms, roomTypes: facts.roomTypes },
    FRAME_TIMES: { frameTimes: facts.frameTimes.length },
    RASTS: { rasts: facts.rasts },
    BREAKS: { breaks: hasYear ? facts.breaks : 0 },
    LUNCH: { lunchServings: facts.lunchServings },
    SUPERVISION: { supervisionAreas: facts.supervisionAreas, supervisionShifts: hasYear ? facts.supervisionShifts : 0 },
    CLASSES: { classes: hasYear ? facts.classes : 0 },
    TEACHING_GROUPS: { teachingGroups: hasYear ? facts.teachingGroups : 0 },
    PEOPLE: { teachers: facts.teachers, students: facts.students },
    TIMPLAN: { gradesWithTimplan: hasYear ? grades.filter((grade) => withTimplan.has(grade)).length : 0 },
    REQUIREMENTS: { requirements: hasYear ? facts.requirements : 0 },
    STAFFING: { posts: hasYear ? facts.posts : 0 },
    SWITCHES: { switchesOn: Object.values(facts.switches).filter(Boolean).length },
  };

  const areas = INTAKE_AREAS.map(
    (area): IntakeAreaView => ({
      area,
      found: found[area],
      waitsForYear: !hasYear && YEAR_BOUND_AREAS.includes(area),
      gaps: GAP_DEFINITIONS.filter((definition) => definition.area === area).map(
        (definition): IntakeGapView => ({ code: definition.code, level: levelOf(definition), ...gaps[definition.code] }),
      ),
    }),
  );

  const there = areas.flatMap((area) => area.gaps).filter((gap) => gap.count > 0);
  return {
    year: facts.year === null ? null : { id: facts.year.id, name: facts.year.name, isActive: facts.year.isActive },
    areas,
    hard: there.filter((gap) => gap.level === 'HARD').length,
    soft: there.filter((gap) => gap.level === 'SOFT').length,
    info: there.filter((gap) => gap.level === 'INFO').length,
  };
}
