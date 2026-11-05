import { createHash } from 'node:crypto';
import {
  clockOfMinutes,
  minutesOfClock,
  type ExchangeLesson,
  type TeacherRef,
  type WeekPattern,
} from './exchange-model';
import { hasPersonalNumber, redactPersonalNumbers } from './file-safety';

/**
 * The import's decisions, pure (Schemat som tabell och i öppna format).
 *
 * The service reads the school into a PlanContext, the codecs turn a file into
 * ExchangeLessons, and everything between them is here: which group, subject,
 * teacher and room each name is, which lessons the school already has, whether
 * a lesson fits the frame, the raster and the lunch, and which timplansposter
 * the locked lessons imply. The clash scan is the one question this file does
 * not answer: it is MasterLessonsService.findConflicts, the rule a hand edit
 * is held to, and it needs the database.
 *
 * NO SILENT GUESS. A name that is not exactly one thing is a refusal that names
 * it. A refusal is never turned into a placement by trying something close:
 * not another spelling, not the nearest minute, not "the only teacher called
 * Anna". The whole import is refused while any row is, so what the preview
 * shows is what a later apply writes, and a school never learns from its
 * timetable which rows were dropped.
 */

/** Lessons are held to the engine's grid: whole five minutes (src/common/solver-grid.ts). */
export const GRID_MINUTES = 5;
/** The solver plans 08:00-18:00 (DAY_START_MINUTES/DAY_END_MINUTES in solver-grid.ts); outside it a lesson is allowed but warned about. */
export const SOLVER_DAY = { start: 8 * 60, end: 18 * 60 };
/** The school week: Monday to Friday, as the engine's SCHEDULE_DAYS. */
export const SCHOOL_DAYS = [1, 2, 3, 4, 5];

export type RefusalCode =
  | 'READ_PROBLEM'
  | 'UNKNOWN_GROUP'
  | 'UNKNOWN_SUBJECT'
  | 'AMBIGUOUS_SUBJECT'
  | 'UNKNOWN_TEACHER'
  | 'AMBIGUOUS_TEACHER'
  | 'TEACHER_INACTIVE'
  | 'BAD_BLOCK_NAME'
  | 'TEACHER_KEYS_DISAGREE'
  | 'SAME_TEACHER_TWICE'
  | 'UNKNOWN_ROOM'
  | 'AMBIGUOUS_ROOM'
  | 'ID_NAME_MISMATCH'
  | 'DAY_OUTSIDE_SCHOOL_WEEK'
  | 'BAD_TIME'
  | 'OFF_GRID'
  | 'PERIOD_REVERSED'
  | 'PERIOD_OUTSIDE_YEAR'
  | 'OUTSIDE_FRAME'
  | 'IN_RAST'
  | 'ON_LUNCH_SITTING'
  | 'NO_ROOM_FOR_LUNCH'
  | 'DUPLICATE_ROW'
  | 'EXISTS_DIFFERENT'
  | 'TOO_MANY_ROWS'
  | 'CLASH_TEACHER'
  | 'CLASH_ROOM'
  | 'CLASH_GROUP'
  | 'CLASH_AVAILABILITY';

/** A reason a row cannot be placed. `params` name what is wrong; `detail` is Swedish prose for logs and tests. */
export interface Refusal {
  code: RefusalCode;
  params: Record<string, string | number>;
  detail: string;
}

export type WarningCode =
  | 'OUTSIDE_SOLVER_DAY'
  | 'NO_GRADE_FOR_RULES'
  | 'REQ_WINDOWS_DIFFER'
  | 'REQ_TOO_MANY_LENGTHS'
  | 'REQ_LENGTH_OUT_OF_RANGE'
  | 'REQ_TEACHERS_DIFFER'
  | 'REQ_DIFFERS_FROM_POST'
  | 'REQ_CO_TEACHERS_DIFFER'
  | 'BLOCK_MEMBERS_DIFFER'
  | 'BLOCK_NOT_LINKED'
  | 'NO_REQUIREMENT'
  | 'TEACHER_NO_LONGER_ACTIVE';

export interface PlanWarning {
  code: WarningCode;
  params: Record<string, string | number>;
  detail: string;
}

// ---------------------------------------------------------------------------
// What the service reads
// ---------------------------------------------------------------------------

export interface GroupRow {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  halfOfId: string | null;
}
export interface SubjectRow {
  id: string;
  name: string;
  code: string | null;
}
export interface RoomRow {
  id: string;
  name: string;
  code: string | null;
}
export interface TeacherRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  signature: string | null;
  isActive: boolean;
}

export interface ExistingLesson {
  id: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  day: number;
  startMin: number;
  endMin: number;
  weeks: WeekPattern;
  from: string | null;
  to: string | null;
  extraGroupIds: string[];
  isLocked: boolean;
  isGenerated: boolean;
}

export interface FrameRow {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startMin: number;
  endMin: number;
}
export interface RastRow {
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startMin: number;
  endMin: number;
}
export interface LunchRules {
  enabled: boolean;
  startMin: number;
  endMin: number;
  minutes: number;
}
export interface ServingRow {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startMin: number;
  endMin: number;
}
export interface SittingRow {
  groupId: string;
  day: number;
  startMin: number;
  endMin: number;
}

export interface RequirementRow {
  id: string;
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  recurrence: WeekPattern;
  from: string | null;
  to: string | null;
  blockId: string | null;
}
export interface BlockRow {
  id: string;
  name: string;
}

export interface PlanContext {
  year: { id: string; name: string; start: string; end: string; numbering: 'NIOARIG' | 'TIOARIG' };
  groups: GroupRow[];
  subjects: SubjectRow[];
  rooms: RoomRow[];
  teachers: TeacherRow[];
  existing: ExistingLesson[];
  frames: FrameRow[];
  rasts: RastRow[];
  lunch: LunchRules | null;
  servings: ServingRow[];
  sittings: SittingRow[];
  requirements: RequirementRow[];
  blocks: BlockRow[];
  /** groupId -> the years the group holds (from its pupils, else its own), in NIOARIG; absent when nothing says. */
  spans: Map<string, { min: number; max: number }>;
}

// ---------------------------------------------------------------------------
// What the plan says
// ---------------------------------------------------------------------------

export interface ResolvedLesson {
  group: GroupRow;
  extraGroups: GroupRow[];
  subject: SubjectRow;
  teacherIds: string[];
  roomId: string | null;
  day: number;
  startMin: number;
  endMin: number;
  weeks: WeekPattern;
  from: string | null;
  to: string | null;
  block: string | null;
  lessonId: string | null;
  /**
   * Teachers the row names who are not active (left, on leave). Resolving a row
   * does not refuse them: a lesson the school already has with such a teacher
   * is still exactly that lesson, and the school's own export, read back, must
   * say "finns redan" and not refuse a file nothing in the schedule moved
   * under (the review of PR #256, M2). The plan refuses them on a row that
   * would CREATE a lesson (refuseInactive), where a deactivated teacher must
   * not be placed, and warns on a row that matches a lesson the school has.
   */
  inactiveTeachers: Array<{ id: string; key: string; name: string }>;
}

/**
 * CREATE: a new locked lesson. UNCHANGED: the school already has exactly this
 * lesson. REFUSED: the row cannot be placed, or it names a lesson the school
 * has with other content (EXISTS_DIFFERENT): the import creates and never
 * changes, because changing a lesson of a school in DIRECT mode has to reach
 * the published days and tell the teachers, which only the grid's own edit
 * does.
 */
export type RowAction = 'CREATE' | 'UNCHANGED' | 'REFUSED';

export interface PlanRow {
  ref: string;
  /** "Matematik · 7A · mån 08:10–09:10": what the reader of a refusal recognises. */
  label: string;
  action: RowAction;
  refusals: Refusal[];
  /** For EXISTS_DIFFERENT: what differs from the school's lesson, in words ("sal", "lärare"). */
  changes: string[];
  existingId: string | null;
  resolved: ResolvedLesson | null;
}

export const DAY_NAMES = ['', 'mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];

export function normalizeName(text: string | null | undefined): string {
  return (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The most characters of a name from the file that a refusal or a label carries. */
export const MAX_SHOWN = 60;

/**
 * A value from the file as an answer may carry it: redacted, on one line, cut.
 * A name is as long as its cell, and an xlsx can use one 32 767-character
 * string for five thousand cells; a refusal per row that quoted it whole was an
 * answer of 160 MB (the review of PR #256). The cut is far above any real name.
 */
export function shortText(value: string | null | undefined): string {
  const flat = redactPersonalNumbers(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}…` : flat;
}

export function labelOf(lesson: ExchangeLesson): string {
  const day = DAY_NAMES[lesson.day] ?? String(lesson.day);
  return `${shortText(lesson.subject)} · ${shortText(lesson.group)} · ${day} ${shortText(lesson.start)}–${shortText(lesson.end)}`;
}

function refusal(code: RefusalCode, params: Record<string, string | number>, detail: string): Refusal {
  return { code, params, detail };
}

// ---------------------------------------------------------------------------
// Resolving names
// ---------------------------------------------------------------------------

export interface Indexes {
  groupsByName: Map<string, GroupRow[]>;
  groupsById: Map<string, GroupRow>;
  subjectsByName: Map<string, SubjectRow[]>;
  subjectsByCode: Map<string, SubjectRow[]>;
  subjectsById: Map<string, SubjectRow>;
  roomsByName: Map<string, RoomRow[]>;
  roomsById: Map<string, RoomRow>;
  teachersBySignature: Map<string, TeacherRow[]>;
  teachersByEmail: Map<string, TeacherRow[]>;
  teachersById: Map<string, TeacherRow>;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function indexContext(ctx: PlanContext): Indexes {
  const idx: Indexes = {
    groupsByName: new Map(),
    groupsById: new Map(),
    subjectsByName: new Map(),
    subjectsByCode: new Map(),
    subjectsById: new Map(),
    roomsByName: new Map(),
    roomsById: new Map(),
    teachersBySignature: new Map(),
    teachersByEmail: new Map(),
    teachersById: new Map(),
  };
  for (const g of ctx.groups) {
    pushTo(idx.groupsByName, normalizeName(g.name), g);
    idx.groupsById.set(g.id, g);
  }
  for (const s of ctx.subjects) {
    pushTo(idx.subjectsByName, normalizeName(s.name), s);
    if (s.code) pushTo(idx.subjectsByCode, normalizeName(s.code), s);
    idx.subjectsById.set(s.id, s);
  }
  for (const r of ctx.rooms) {
    pushTo(idx.roomsByName, normalizeName(r.name), r);
    idx.roomsById.set(r.id, r);
  }
  for (const t of ctx.teachers) {
    if (t.signature) pushTo(idx.teachersBySignature, normalizeName(t.signature), t);
    pushTo(idx.teachersByEmail, normalizeName(t.email), t);
    idx.teachersById.set(t.id, t);
  }
  return idx;
}

type Resolution<T> = { ok: T } | { refusal: Refusal } | { none: true };

function resolveGroup(name: string, id: string | null | undefined, idx: Indexes): Resolution<GroupRow> {
  const byId = id ? idx.groupsById.get(id) : undefined;
  const byName = idx.groupsByName.get(normalizeName(name)) ?? [];
  if (byId) {
    if (name.trim() !== '' && normalizeName(byId.name) !== normalizeName(name)) {
      return { refusal: refusal('ID_NAME_MISMATCH', { kind: 'grupp', id: byId.name, name: shortText(name) }, `Id:t hör till gruppen ${byId.name}, men namnet är ${shortText(name)}. Ta bort id-cellen eller rätta namnet.`) };
    }
    return { ok: byId };
  }
  if (byName.length === 1) return { ok: byName[0]! };
  return {
    refusal: refusal('UNKNOWN_GROUP', { name: shortText(name) }, `Klassen eller gruppen ${shortText(name)} finns inte i läsåret.`),
  };
}

function resolveSubject(
  name: string,
  code: string | null,
  id: string | null | undefined,
  idx: Indexes,
): Resolution<SubjectRow> {
  const byId = id ? idx.subjectsById.get(id) : undefined;
  if (byId) {
    if (name.trim() !== '' && normalizeName(byId.name) !== normalizeName(name)) {
      return { refusal: refusal('ID_NAME_MISMATCH', { kind: 'ämne', id: byId.name, name: shortText(name) }, `Id:t hör till ämnet ${byId.name}, men namnet är ${shortText(name)}. Ta bort id-cellen eller rätta namnet.`) };
    }
    return { ok: byId };
  }
  if (code) {
    const byCode = idx.subjectsByCode.get(normalizeName(code)) ?? [];
    if (byCode.length === 1) {
      const only = byCode[0]!;
      // A code that names one subject while the name names another is a
      // contradiction, not a spelling: refused rather than resolved by taste.
      if (name.trim() !== '' && normalizeName(only.name) !== normalizeName(name)) {
        const named = idx.subjectsByName.get(normalizeName(name)) ?? [];
        if (named.length > 0 && !named.includes(only)) {
          return { refusal: refusal('ID_NAME_MISMATCH', { kind: 'ämne', id: only.name, name: shortText(name) }, `Ämneskoden ${shortText(code)} hör till ${only.name}, men namnet är ${shortText(name)}.`) };
        }
      }
      return { ok: only };
    }
  }
  const byName = idx.subjectsByName.get(normalizeName(name)) ?? [];
  if (byName.length === 1) return { ok: byName[0]! };
  if (byName.length > 1) {
    return {
      refusal: refusal(
        'AMBIGUOUS_SUBJECT',
        { name: shortText(name), count: byName.length },
        `Ämnet ${shortText(name)} finns ${byName.length} gånger i skolan. Ange ämneskod eller id.`,
      ),
    };
  }
  return { refusal: refusal('UNKNOWN_SUBJECT', { name: shortText(name) }, `Ämnet ${shortText(name)} finns inte i skolan.`) };
}

function resolveRoom(name: string | null, id: string | null | undefined, idx: Indexes): Resolution<RoomRow | null> {
  const clean = (name ?? '').trim();
  const byId = id ? idx.roomsById.get(id) : undefined;
  if (byId) {
    if (clean !== '' && normalizeName(byId.name) !== normalizeName(clean)) {
      return { refusal: refusal('ID_NAME_MISMATCH', { kind: 'sal', id: byId.name, name: shortText(clean) }, `Id:t hör till salen ${byId.name}, men namnet är ${shortText(clean)}.`) };
    }
    return { ok: byId };
  }
  if (clean === '') return { ok: null };
  const byName = idx.roomsByName.get(normalizeName(clean)) ?? [];
  if (byName.length === 1) return { ok: byName[0]! };
  if (byName.length > 1) {
    return { refusal: refusal('AMBIGUOUS_ROOM', { name: shortText(clean), count: byName.length }, `Salen ${shortText(clean)} finns ${byName.length} gånger.`) };
  }
  return { refusal: refusal('UNKNOWN_ROOM', { name: shortText(clean) }, `Salen ${shortText(clean)} finns inte i skolan.`) };
}

function describeRef(ref: TeacherRef): string {
  return shortText(ref.short ?? ref.email ?? ref.name ?? ref.id ?? '(tom)');
}

function resolveTeacher(ref: TeacherRef, idx: Indexes): Resolution<TeacherRow> {
  const found = new Map<string, TeacherRow>();
  let ambiguous = false;
  const addAll = (list: TeacherRow[] | undefined): void => {
    if (!list) return;
    if (list.length > 1) ambiguous = true;
    for (const t of list) found.set(t.id, t);
  };
  const byId = ref.id ? idx.teachersById.get(ref.id) : undefined;
  const bySignature = ref.short?.trim() ? idx.teachersBySignature.get(normalizeName(ref.short)) : undefined;
  const byEmail = ref.email?.trim() ? idx.teachersByEmail.get(normalizeName(ref.email)) : undefined;
  if (byId) found.set(byId.id, byId);
  addAll(bySignature);
  addAll(byEmail);
  const label = describeRef(ref);
  if (found.size === 0) {
    return { refusal: refusal('UNKNOWN_TEACHER', { key: label }, `Läraren ${label} finns inte: varken signaturen eller e-postadressen hör till en lärare i läsåret.`) };
  }
  if (ambiguous && found.size > 1) {
    return { refusal: refusal('AMBIGUOUS_TEACHER', { key: label }, `Läraren ${label} kan vara flera personer.`) };
  }
  if (found.size > 1) {
    const names = [...found.values()].map((t) => `${t.firstName} ${t.lastName}`).join(' och ');
    return { refusal: refusal('TEACHER_KEYS_DISAGREE', { key: label }, `Signatur, e-post och id för ${label} pekar på olika personer (${names}).`) };
  }
  return { ok: [...found.values()][0]! };
}

function isoDate(text: string | null): string | null {
  return text === null || text === '' ? null : text;
}

/** Resolves one parsed lesson against the school; either the lesson or every reason it cannot be. */
export function resolveLesson(
  lesson: ExchangeLesson,
  idx: Indexes,
  ctx: PlanContext,
): { resolved: ResolvedLesson } | { refusals: Refusal[] } {
  const refusals: Refusal[] = [];
  const take = <T>(r: Resolution<T>): T | undefined => {
    if ('ok' in r) return r.ok;
    if ('refusal' in r) refusals.push(r.refusal);
    return undefined;
  };

  const group = take(resolveGroup(lesson.group, lesson.ids.group, idx));
  const subject = take(resolveSubject(lesson.subject, lesson.subjectCode, lesson.ids.subject, idx));
  const extras: GroupRow[] = [];
  lesson.extraGroups.forEach((name, i) => {
    const g = take(resolveGroup(name, lesson.ids.extraGroups?.[i] ?? null, idx));
    if (g && g.id !== group?.id && !extras.some((e) => e.id === g.id)) extras.push(g);
  });
  const room = take(resolveRoom(lesson.room, lesson.ids.room, idx));

  const teacherIds: string[] = [];
  const inactiveTeachers: ResolvedLesson['inactiveTeachers'] = [];
  for (const ref of lesson.teachers) {
    const t = take(resolveTeacher(ref, idx));
    if (t) {
      if (teacherIds.includes(t.id)) {
        refusals.push(refusal('SAME_TEACHER_TWICE', { key: describeRef(ref) }, `Läraren ${describeRef(ref)} står både som lärare och medlärare.`));
      } else {
        teacherIds.push(t.id);
        if (!t.isActive) inactiveTeachers.push({ id: t.id, key: describeRef(ref), name: `${t.firstName} ${t.lastName}` });
      }
    }
  }

  const startMin = minutesOfClock(lesson.start);
  const endMin = minutesOfClock(lesson.end);
  if (startMin === null || endMin === null || endMin <= startMin) {
    refusals.push(refusal('BAD_TIME', { start: shortText(lesson.start), end: shortText(lesson.end) }, `Tiden ${shortText(lesson.start)}–${shortText(lesson.end)} är ingen lektionstid (slut måste vara efter start).`));
  } else if (startMin % GRID_MINUTES !== 0 || endMin % GRID_MINUTES !== 0) {
    refusals.push(refusal('OFF_GRID', { start: shortText(lesson.start), end: shortText(lesson.end) }, `Tiden ${shortText(lesson.start)}–${shortText(lesson.end)} ligger inte på femminutersrastret som schemamotorn räknar i.`));
  }
  if (!SCHOOL_DAYS.includes(lesson.day)) {
    refusals.push(refusal('DAY_OUTSIDE_SCHOOL_WEEK', { day: lesson.day }, `Dag ${lesson.day} ligger utanför skolveckan måndag–fredag.`));
  }
  const from = isoDate(lesson.from);
  const to = isoDate(lesson.to);
  if (from !== null && to !== null && to < from) {
    refusals.push(refusal('PERIOD_REVERSED', { from: shortText(from), to: shortText(to) }, `Perioden ${shortText(from)}–${shortText(to)} slutar före den börjar.`));
  } else if ((from !== null && (from < ctx.year.start || from > ctx.year.end)) || (to !== null && (to < ctx.year.start || to > ctx.year.end))) {
    refusals.push(
      refusal('PERIOD_OUTSIDE_YEAR', { from: shortText(from), to: shortText(to), year: ctx.year.name }, `Perioden ${shortText(from) || '…'}–${shortText(to) || '…'} ligger utanför läsåret ${ctx.year.name} (${ctx.year.start}–${ctx.year.end}).`),
    );
  }

  // A block's name is the one text of the file that is written to the database as it is. The
  // database holds it to 1-80 characters (TeachingBlocks_name_is_sane); a name longer than that,
  // or one that holds a personnummer, is refused here, by row, and not by a 500 at the write.
  const block = lesson.block?.trim() ? lesson.block.trim() : null;
  if (block !== null && [...block].length > MAX_BLOCK_NAME) {
    refusals.push(refusal('BAD_BLOCK_NAME', { length: [...block].length, max: MAX_BLOCK_NAME }, `Blocknamnet är ${[...block].length} tecken; ett block får heta högst ${MAX_BLOCK_NAME}.`));
  } else if (block !== null && /[\u0000-\u001f\u007f-\u009f]/.test(block)) {
    // A line break or another control character in a name that is stored and shown in a list.
    refusals.push(refusal('BAD_BLOCK_NAME', { length: [...block].length, max: MAX_BLOCK_NAME }, 'Blocknamnet innehåller radbrytningar eller andra styrtecken och används inte.'));
  } else if (block !== null && hasPersonalNumber(block)) {
    refusals.push(refusal('BAD_BLOCK_NAME', { length: [...block].length, max: MAX_BLOCK_NAME }, 'Blocknamnet liknar ett personnummer och används inte. Rastra tar inte emot personnummer.'));
  }

  if (refusals.length > 0 || !group || !subject || startMin === null || endMin === null || room === undefined) {
    // Every reason is listed: an inactive teacher too, though on a row that resolves it is the plan's to judge.
    for (const t of inactiveTeachers) refusals.push(inactiveRefusal(t));
    return { refusals };
  }
  return {
    resolved: {
      group,
      extraGroups: extras,
      subject,
      teacherIds,
      roomId: room?.id ?? null,
      day: lesson.day,
      startMin,
      endMin,
      weeks: lesson.weeks,
      from,
      to,
      block,
      lessonId: lesson.ids.lesson ?? null,
      inactiveTeachers,
    },
  };
}

/** The longest name a block may have (the database's check, in characters). */
export const MAX_BLOCK_NAME = 80;

/** What a lesson that would be CREATED with a deactivated teacher is refused with. */
export function inactiveRefusal(t: { key: string; name: string }): Refusal {
  return refusal('TEACHER_INACTIVE', { key: t.key }, `Läraren ${t.name} är inte aktiv.`);
}

// ---------------------------------------------------------------------------
// Frames, raster and lunch
// ---------------------------------------------------------------------------

/**
 * The window a stage may be taught in on a weekday: the intersection of every
 * frame the span touches, a weekday frame and an every-day frame both applying
 * (web/lib/frame-times.ts frameWindow and optimization-engine/app/solver/
 * frames.py say the same). A group whose years are unknown keeps the whole day.
 */
export function frameWindowOf(
  frames: readonly FrameRow[],
  span: { min: number; max: number } | undefined,
  day: number,
): { startMin: number; endMin: number } | null {
  if (!span) return { startMin: 0, endMin: 24 * 60 };
  let startMin = 0;
  let endMin = 24 * 60;
  for (const f of frames) {
    if (f.dayOfWeek !== null && f.dayOfWeek !== day) continue;
    if (span.max < f.minGradeLevel || span.min > f.maxGradeLevel) continue;
    startMin = Math.max(startMin, f.startMin);
    endMin = Math.min(endMin, f.endMin);
  }
  return endMin > startMin ? { startMin, endMin } : null;
}

/** The rasts that bind a span on a weekday (src/calendar/rasts-for-span.ts: overlap, a weekday row shadows only the every-day rows it overlaps). */
export function rastsOf(rasts: readonly RastRow[], span: { min: number; max: number }, day: number): RastRow[] {
  const matching = rasts.filter((r) => span.max >= r.minGradeLevel && span.min <= r.maxGradeLevel);
  const today = matching.filter((r) => r.dayOfWeek === day);
  const everyDay = matching.filter(
    (r) => r.dayOfWeek === null && !today.some((t) => r.startMin < t.endMin && t.startMin < r.endMin),
  );
  return [...today, ...everyDay];
}

/** Whether the lesson fits the frames, the raster and the generator's own lunch sittings of every group on it. */
export function fitRefusals(lesson: ResolvedLesson, ctx: PlanContext): { refusals: Refusal[]; warnings: PlanWarning[] } {
  const refusals: Refusal[] = [];
  const warnings: PlanWarning[] = [];
  const groups = [lesson.group, ...lesson.extraGroups];
  const label = (g: GroupRow) => g.name;
  for (const g of groups) {
    const span = ctx.spans.get(g.id);
    if (!span && (ctx.frames.length > 0 || ctx.rasts.length > 0)) {
      warnings.push({
        code: 'NO_GRADE_FOR_RULES',
        params: { group: g.name },
        detail: `${g.name} har ingen känd årskurs, så ramtider och raster kontrollerades inte för den.`,
      });
    }
    if (span && ctx.frames.length > 0) {
      const window = frameWindowOf(ctx.frames, span, lesson.day);
      if (window === null) {
        refusals.push(refusal('OUTSIDE_FRAME', { group: label(g), day: lesson.day, start: clockOfMinutes(lesson.startMin), end: clockOfMinutes(lesson.endMin), frameStart: '', frameEnd: '', closed: 'yes' }, `${g.name} har ingen undervisningstid på ${DAY_NAMES[lesson.day]} enligt ramtiderna.`));
      } else if (lesson.startMin < window.startMin || lesson.endMin > window.endMin) {
        refusals.push(
          refusal(
            'OUTSIDE_FRAME',
            { group: label(g), day: lesson.day, start: clockOfMinutes(lesson.startMin), end: clockOfMinutes(lesson.endMin), frameStart: clockOfMinutes(window.startMin), frameEnd: clockOfMinutes(window.endMin), closed: 'no' },
            `${g.name}: lektionen ${clockOfMinutes(lesson.startMin)}–${clockOfMinutes(lesson.endMin)} ligger utanför ramtiden ${clockOfMinutes(window.startMin)}–${clockOfMinutes(window.endMin)}.`,
          ),
        );
      }
    }
    if (span) {
      for (const r of rastsOf(ctx.rasts, span, lesson.day)) {
        if (lesson.startMin < r.endMin && r.startMin < lesson.endMin) {
          refusals.push(
            refusal(
              'IN_RAST',
              { group: label(g), rast: r.name, start: clockOfMinutes(r.startMin), end: clockOfMinutes(r.endMin) },
              `${g.name}: lektionen ligger över rasten ${r.name} (${clockOfMinutes(r.startMin)}–${clockOfMinutes(r.endMin)}).`,
            ),
          );
        }
      }
    }
    for (const s of ctx.sittings) {
      if (s.groupId === g.id && s.day === lesson.day && lesson.startMin < s.endMin && s.startMin < lesson.endMin) {
        refusals.push(
          refusal(
            'ON_LUNCH_SITTING',
            { group: label(g), start: clockOfMinutes(s.startMin), end: clockOfMinutes(s.endMin) },
            `${g.name}: lektionen ligger över gruppens lunch ${clockOfMinutes(s.startMin)}–${clockOfMinutes(s.endMin)}.`,
          ),
        );
      }
    }
  }
  if (lesson.startMin < SOLVER_DAY.start || lesson.endMin > SOLVER_DAY.end) {
    warnings.push({
      code: 'OUTSIDE_SOLVER_DAY',
      params: { start: clockOfMinutes(lesson.startMin), end: clockOfMinutes(lesson.endMin) },
      detail: `Lektionen ${clockOfMinutes(lesson.startMin)}–${clockOfMinutes(lesson.endMin)} ligger utanför schemamotorns dag 08:00–18:00.`,
    });
  }
  return { refusals, warnings };
}

/** One lesson as the lunch check sees it. */
export interface Occupant {
  groupIds: string[];
  day: number;
  startMin: number;
  endMin: number;
  weeks: WeekPattern;
}

/** The lunch windows that bind a class on a weekday: its stage's servings if any, else the school's window. */
function lunchWindows(ctx: PlanContext, span: { min: number; max: number }, day: number): Array<{ startMin: number; endMin: number }> {
  const matching = ctx.servings.filter((s) => span.max >= s.minGradeLevel && span.min <= s.maxGradeLevel);
  if (matching.length > 0) {
    const today = matching.filter((s) => s.dayOfWeek === day);
    const chosen = today.length > 0 ? today : matching.filter((s) => s.dayOfWeek === null);
    return chosen.map((s) => ({ startMin: s.startMin, endMin: s.endMin }));
  }
  return ctx.lunch?.enabled ? [{ startMin: ctx.lunch.startMin, endMin: ctx.lunch.endMin }] : [];
}

/**
 * Whether a class that is taught inside its lunch window still has `minutes`
 * of it free, in a week of each parity. Asked of CLASSES only, and only of the
 * lessons they carry themselves: a teaching group's lessons take pupils off
 * the class too, so the true answer can only be stricter than this one. The
 * check never refuses what the engine would place (it refuses less).
 */
export function lunchFits(
  ctx: PlanContext,
  group: GroupRow,
  day: number,
  occupants: readonly Occupant[],
): { fits: boolean; window?: { startMin: number; endMin: number } } {
  if (group.kind !== 'CLASS' || !ctx.lunch?.enabled) return { fits: true };
  const span = ctx.spans.get(group.id);
  if (!span) return { fits: true };
  const windows = lunchWindows(ctx, span, day);
  if (windows.length === 0) return { fits: true };
  const mine = occupants.filter((o) => o.day === day && o.groupIds.includes(group.id));
  for (const parity of ['ODD', 'EVEN'] as const) {
    const busy = mine
      .filter((o) => o.weeks === 'ALL' || o.weeks === parity)
      .map((o) => [o.startMin, o.endMin] as const);
    // A class taught in none of its windows asks nothing of the day. Taught
    // in one, it needs a free stretch of the length in ANY window: a serving
    // grants permission to eat, and one free stretch in one of them is a lunch.
    const taught = windows.some((w) => busy.some(([s, e]) => s < w.endMin && w.startMin < e));
    if (!taught) continue;
    if (!windows.some((w) => hasGap(busy, w.startMin, w.endMin, ctx.lunch!.minutes))) {
      return { fits: false, window: windows.find((w) => busy.some(([s, e]) => s < w.endMin && w.startMin < e)) ?? windows[0]! };
    }
  }
  return { fits: true };
}

function hasGap(busy: ReadonlyArray<readonly [number, number]>, from: number, to: number, minutes: number): boolean {
  const spans = busy
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  let cursor = from;
  for (const [s, e] of spans) {
    if (s - cursor >= minutes) return true;
    cursor = Math.max(cursor, e);
  }
  return to - cursor >= minutes;
}

// ---------------------------------------------------------------------------
// Matching what the school already has
// ---------------------------------------------------------------------------

function keyOf(l: { groupId: string; subjectId: string; day: number; startMin: number; weeks: WeekPattern; from: string | null; to: string | null }): string {
  return [l.groupId, l.subjectId, l.day, l.startMin, l.weeks, l.from ?? '', l.to ?? ''].join('|');
}

export function sameTeachers(existing: ExistingLesson, teacherIds: string[]): boolean {
  return (existing.teacherId ?? null) === (teacherIds[0] ?? null) && (existing.coTeacherId ?? null) === (teacherIds[1] ?? null);
}

/** What differs between an existing lesson and the file's row for it, in words. */
export function changesOf(existing: ExistingLesson, l: ResolvedLesson): string[] {
  const changes: string[] = [];
  if (existing.groupId !== l.group.id) changes.push('grupp');
  if (existing.subjectId !== l.subject.id) changes.push('ämne');
  if (existing.day !== l.day || existing.startMin !== l.startMin || existing.endMin !== l.endMin) changes.push('tid');
  if (!sameTeachers(existing, l.teacherIds)) changes.push('lärare');
  if ((existing.roomId ?? null) !== (l.roomId ?? null)) changes.push('sal');
  if (existing.weeks !== l.weeks) changes.push('veckomönster');
  if ((existing.from ?? null) !== (l.from ?? null) || (existing.to ?? null) !== (l.to ?? null)) changes.push('period');
  const extra = [...existing.extraGroupIds].sort().join(',');
  if (extra !== l.extraGroups.map((g) => g.id).sort().join(',')) changes.push('ytterligare klasser');
  return changes;
}

/**
 * Pairs each resolved row with the lesson it stands for, if any: first by the
 * lesson id the file carries, then by the lesson's key (group, subject, day,
 * start, weeks, period). Each existing lesson is claimed once, so two rows can
 * never update one lesson.
 */
export function matchExisting(
  rows: ReadonlyArray<ResolvedLesson | null>,
  existing: readonly ExistingLesson[],
): Array<ExistingLesson | null> {
  const byId = new Map(existing.map((e) => [e.id, e]));
  const byKey = new Map<string, ExistingLesson[]>();
  for (const e of existing) pushTo(byKey, keyOf(e), e);
  const claimed = new Set<string>();
  const out: Array<ExistingLesson | null> = rows.map(() => null);
  rows.forEach((row, i) => {
    if (!row?.lessonId) return;
    const hit = byId.get(row.lessonId);
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id);
      out[i] = hit;
    }
  });
  rows.forEach((row, i) => {
    if (!row || out[i]) return;
    const candidates = (byKey.get(
      keyOf({ groupId: row.group.id, subjectId: row.subject.id, day: row.day, startMin: row.startMin, weeks: row.weeks, from: row.from, to: row.to }),
    ) ?? []).filter((e) => !claimed.has(e.id));
    // Exactly equal lessons first, so two lessons in one slot (a block) pair off right.
    const exact = candidates.find((e) => changesOf(e, row).length === 0);
    const hit = exact ?? candidates[0];
    if (hit) {
      claimed.add(hit.id);
      out[i] = hit;
    }
  });
  return out;
}

/** Key for catching a row that repeats an earlier one. */
export function duplicateKey(l: ResolvedLesson): string {
  return keyOf({ groupId: l.group.id, subjectId: l.subject.id, day: l.day, startMin: l.startMin, weeks: l.weeks, from: l.from, to: l.to }) + '|' + l.teacherIds.join(',') + '|' + (l.roomId ?? '');
}

// ---------------------------------------------------------------------------
// Timplansposter
// ---------------------------------------------------------------------------

/** A lesson of the finished timetable, after the import: what a post is derived from. */
export interface FinalLesson {
  groupId: string;
  subjectId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  startMin: number;
  endMin: number;
  weeks: WeekPattern;
  from: string | null;
  to: string | null;
  block: string | null;
}

export interface RequirementPlan {
  groupId: string;
  groupName: string;
  subjectId: string;
  subjectName: string;
  /** CREATE: the post does not exist. KEEP: it exists (equal or not). SKIP: nothing could be derived. */
  action: 'CREATE' | 'KEEP' | 'SKIP';
  existingId: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  lessonLengths: number[];
  teacherId: string | null;
  coTeacherId: string | null;
  recurrence: WeekPattern;
  from: string | null;
  to: string | null;
  block: string | null;
}

/**
 * The timplanspost each (group, subject) of the finished timetable implies,
 * and what to do with it. A post is the school's decision, so an existing one
 * is never changed: when it differs from the lessons the preview says so
 * (REQ_DIFFERS_FROM_POST) and the lessons stand. A post is derived only when
 * the lessons agree about the one window a post can state (weeks and period).
 */
export function deriveRequirements(
  lessons: readonly FinalLesson[],
  ctx: PlanContext,
  touched: ReadonlySet<string>,
): { plans: RequirementPlan[]; warnings: PlanWarning[] } {
  const idx = indexContext(ctx);
  const warnings: PlanWarning[] = [];
  const plans: RequirementPlan[] = [];
  const pairs = new Map<string, FinalLesson[]>();
  for (const l of lessons) pushTo(pairs, `${l.groupId}|${l.subjectId}`, l);
  const existingByPair = new Map(ctx.requirements.map((r) => [`${r.groupId}|${r.subjectId}`, r]));

  for (const [pair, list] of [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Only pairs the import touched: a post for a pair it did not change is no business of it.
    if (!touched.has(pair)) continue;
    const [groupId, subjectId] = pair.split('|') as [string, string];
    const group = idx.groupsById.get(groupId)!;
    const subject = idx.subjectsById.get(subjectId)!;
    const label = `${subject.name} för ${group.name}`;
    const existing = existingByPair.get(pair);
    const windows = new Set(list.map((l) => `${l.weeks}|${l.from ?? ''}|${l.to ?? ''}`));
    const base = {
      groupId,
      groupName: group.name,
      subjectId,
      subjectName: subject.name,
      existingId: existing?.id ?? null,
    };
    const skip = (): RequirementPlan => ({
      ...base,
      action: existing ? 'KEEP' : 'SKIP',
      lessonsPerWeek: existing?.lessonsPerWeek ?? 0,
      minutesPerLesson: existing?.minutesPerLesson ?? 0,
      lessonLengths: existing?.lessonLengths ?? [],
      teacherId: existing?.teacherId ?? null,
      coTeacherId: existing?.coTeacherId ?? null,
      recurrence: existing?.recurrence ?? 'ALL',
      from: existing?.from ?? null,
      to: existing?.to ?? null,
      block: null,
    });
    if (windows.size > 1) {
      warnings.push({ code: 'REQ_WINDOWS_DIFFER', params: { post: label }, detail: `${label}: lektionerna har olika veckomönster eller perioder, och en timplanspost kan bara ange ett. Ingen post härleddes.` });
      plans.push(skip());
      continue;
    }
    const lengths = list.map((l) => l.endMin - l.startMin).sort((a, b) => b - a);
    // A post holds lessons of 15 to 240 minutes (TeachingRequirements_lesson_lengths_are_canonical).
    if (lengths.some((m) => m < 15 || m > 240)) {
      warnings.push({ code: 'REQ_LENGTH_OUT_OF_RANGE', params: { post: label }, detail: `${label}: en lektion är kortare än 15 eller längre än 240 minuter, vilket en timplanspost inte rymmer. Ingen post härleddes.` });
      plans.push(skip());
      continue;
    }
    if (new Set(lengths).size > 3 || list.length > 40) {
      warnings.push({ code: 'REQ_TOO_MANY_LENGTHS', params: { post: label }, detail: `${label}: lektionerna har fler olika längder än en timplanspost rymmer (högst tre). Ingen post härleddes.` });
      plans.push(skip());
      continue;
    }
    // The lead is the teacher most of the lessons name (the first in the week on a tie); a post
    // has one lead, and Delade lektioner is not derived: the others are warned about, by name.
    const leads = new Map<string, number>();
    for (const l of list) if (l.teacherId) leads.set(l.teacherId, (leads.get(l.teacherId) ?? 0) + 1);
    const ordered = [...list].sort((a, b) => a.startMin - b.startMin);
    const lead = [...leads.entries()].sort((a, b) => b[1] - a[1] || ordered.findIndex((l) => l.teacherId === a[0]) - ordered.findIndex((l) => l.teacherId === b[0]))[0]?.[0] ?? null;
    if (leads.size > 1) {
      const names = [...leads.keys()].map((id) => teacherName(ctx, id)).join(', ');
      warnings.push({ code: 'REQ_TEACHERS_DIFFER', params: { post: label, teachers: names }, detail: `${label}: lektionerna har olika lärare (${names}). Posten får den vanligaste; fördela de andra som delade lektioner.` });
    }
    const coSet = new Set(list.map((l) => l.coTeacherId ?? ''));
    const co = coSet.size === 1 ? [...coSet][0]! || null : null;
    if (coSet.size > 1) {
      warnings.push({ code: 'REQ_CO_TEACHERS_DIFFER', params: { post: label }, detail: `${label}: medlärare finns inte på alla lektioner. Posten fick ingen medlärare.` });
    }
    const blocks = new Set(list.map((l) => l.block ?? ''));
    const block = blocks.size === 1 ? [...blocks][0]! || null : null;
    const derived: RequirementPlan = {
      ...base,
      action: existing ? 'KEEP' : 'CREATE',
      lessonsPerWeek: list.length,
      minutesPerLesson: lengths[0]!,
      lessonLengths: new Set(lengths).size > 1 ? lengths : [],
      teacherId: lead,
      coTeacherId: co && co !== lead ? co : null,
      recurrence: list[0]!.weeks,
      from: list[0]!.from,
      to: list[0]!.to,
      block,
    };
    if (existing) {
      const shape = (r: { lessonsPerWeek: number; minutesPerLesson: number; lessonLengths: number[] }) =>
        (r.lessonLengths.length > 0 ? r.lessonLengths : Array<number>(r.lessonsPerWeek).fill(r.minutesPerLesson)).join('+');
      if (shape(existing) !== shape(derived) || existing.recurrence !== derived.recurrence) {
        warnings.push({
          code: 'REQ_DIFFERS_FROM_POST',
          params: { post: label, post_shape: shape(existing), lessons: shape(derived) },
          detail: `${label}: timplansposten säger ${shape(existing)} minuter i veckan, schemats lektioner är ${shape(derived)}. Posten ändrades inte.`,
        });
      }
      // The existing post stands: keep its figures in the plan so the preview reads true.
      plans.push({ ...derived, action: 'KEEP', lessonsPerWeek: existing.lessonsPerWeek, minutesPerLesson: existing.minutesPerLesson, lessonLengths: existing.lessonLengths, teacherId: existing.teacherId, coTeacherId: existing.coTeacherId, recurrence: existing.recurrence, from: existing.from, to: existing.to });
    } else {
      plans.push(derived);
    }
  }
  return { plans, warnings };
}

function teacherName(ctx: PlanContext, id: string): string {
  const t = ctx.teachers.find((x) => x.id === id);
  return t ? (t.signature ?? `${t.firstName} ${t.lastName}`) : id;
}

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/**
 * What the preview and the apply must agree on: the rows' actions and
 * resolved ids, and the posts. Not timestamps, not the order the database
 * returned anything in. An apply recomputes the plan and refuses (409) when
 * this is not the fingerprint the school was shown.
 */
export function planFingerprint(rows: readonly PlanRow[], requirements: readonly RequirementPlan[]): string {
  const canon = {
    rows: rows.map((r) => [
      r.ref,
      r.action,
      r.existingId,
      r.refusals.map((x) => x.code),
      r.resolved && [
        r.resolved.group.id,
        r.resolved.extraGroups.map((g) => g.id),
        r.resolved.subject.id,
        r.resolved.teacherIds,
        r.resolved.roomId,
        r.resolved.day,
        r.resolved.startMin,
        r.resolved.endMin,
        r.resolved.weeks,
        r.resolved.from,
        r.resolved.to,
        r.resolved.block,
      ],
    ]),
    requirements: requirements.map((q) => [q.groupId, q.subjectId, q.action, q.existingId, q.lessonsPerWeek, q.lessonLengths, q.minutesPerLesson, q.teacherId, q.coTeacherId, q.recurrence, q.from, q.to, q.block]),
  };
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 32);
}
