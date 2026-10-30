import { createHash } from 'node:crypto';
import type { LessonRecurrence } from '@prisma/client';
import type {
  AiEngineScheduleRequest,
  AnonymousFixedLesson,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';

/*
 * WHAT A SCHEMAFÖRSLAG WAS SOLVED FROM, BY CONTENT (design §5).
 *
 * A candidate is stored for days and applied later, and between the two the
 * school goes on editing: a lesson is locked, a teacher is swapped on a
 * timplanspost, a pupil moves into 7A:2. Applying a candidate over any of that
 * would replace the draft with an answer to a question nobody is asking any
 * more. So the candidate run hashes everything the engine was sent, and the
 * apply hashes it again in its own transaction and refuses a difference — the
 * pattern the room and staffing proposals already follow, here over the whole
 * of what fetchAndAnonymize reads.
 *
 * OVER REAL IDS, NEVER THE PAYLOAD'S. Every id in the payload is a fresh
 * random uuid per request, so a digest of the payload itself would differ
 * between two reads of an unchanged school and refuse every apply. The
 * payload is turned back through the maps it was built with first; the fixed
 * lessons, whose own ids are minted per request and mapped nowhere, enter by
 * what they ARE (group, classes, teachers, room, day, clock) and not by any
 * id at all.
 *
 * BY CONTENT ON PURPOSE. A master lesson's id is not part of what the engine
 * solves against, and a version restore recreates every row under a new one:
 * restoring the very draft a batch was solved from makes the batch applicable
 * again, which is the behaviour a school would expect.
 *
 * SIX PARTS, so a refusal can say what changed ("Lärare eller timplan",
 * "Låsta lektioner", …) rather than only that something did. The basis is the
 * digest of the six digests; the parts are stored beside it.
 *
 * NO PUPIL. Nothing in the payload names a pupil — sizes, headcounts and
 * shared-pupil pairs are what reach the engine — and nothing else enters
 * here. A digest of the rosters would turn every pupil swap into a stale
 * candidate and put a function of student ids into a stored row; the derived
 * needs the engine actually read are the right granularity.
 *
 * Left out: requestId (fresh per request), weights and search (they differ
 * between the candidates of one run by design), and a caller's body rules
 * (a candidate run has none; the school's stored rules are in `rules`).
 */

/** Bumped when what a part covers changes, so an old run reads as stale rather than equal. */
export const BASIS_VERSION = 1;

export const BASIS_PARTS = ['requirements', 'preserved', 'draft', 'rooms', 'rules', 'rosters'] as const;

/**
 * Every top-level field of Generera's payload is in exactly one of these two
 * lists, and ai-engine-contract.spec.ts holds them to the payload it posts. A
 * field the engine is sent later, and the basis does not read, would let a
 * candidate solved before a change to it be applied after: that spec fails
 * until the field is read in basisInputsOf (and BASIS_VERSION bumped) or put
 * among the exclusions with its reason. Fields inside a piece are covered by
 * the spreads below.
 */
export const BASIS_PAYLOAD_FIELDS = [
  'constraints',
  'fixedLessons',
  'frameTimes',
  'groupConflicts',
  'groups',
  'lunchPlacements',
  'lunchServings',
  'previousLessons',
  'rasts',
  'requirements',
  'roomPreferences',
  'rooms',
  'siteTravelTimes',
  'teacherDayLimits',
  'teacherWorkRules',
] as const;

/**
 * Not the draft's content: the request's own id, the year (one run, one
 * year), and what a caller adds per request — a body's rules (a candidate run
 * sends the school's stored rules, which the basis reads), the weights and
 * the search, which differ between the candidates of one run by design.
 */
export const BASIS_EXCLUDED_FIELDS = ['academicYearId', 'requestId', 'rules', 'search', 'weights'] as const;
export type BasisPart = (typeof BASIS_PARTS)[number];
export type BasisParts = Record<BasisPart, string>;

/** A lesson regeneration keeps, by content: what the engine was told it must plan around. */
export interface PreservedContent {
  studentGroupId: string;
  extraGroupIds: string[];
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  /** HH:MM:SS, the clock the payload carries. */
  startTime: string;
  endTime: string;
  /**
   * A/B-veckor: the parity the engine was told the lock holds its window in.
   * Only on an alternating lock, so a school without one hashes what it did,
   * and a lock moved between odd and even weeks makes a run stale.
   */
  recurrence?: Exclude<LessonRecurrence, 'ALL_WEEKS'>;
}

/** One of the draft's own (non-preserved) lessons, by content. */
export interface DraftContent {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  endTime: string;
  recurrence: LessonRecurrence | null;
  /** YYYY-MM-DD, or null for the open end. */
  startDate: string | null;
  endDate: string | null;
}

/** What the engine was sent for one fetch, minus what a single request adds on top. */
export type BasisPayload = Pick<
  AiEngineScheduleRequest,
  | 'requirements'
  | 'rooms'
  | 'constraints'
  | 'frameTimes'
  | 'lunchServings'
  | 'lunchPlacements'
  | 'rasts'
  | 'roomPreferences'
  | 'teacherWorkRules'
  | 'teacherDayLimits'
  | 'fixedLessons'
  | 'groups'
  | 'previousLessons'
  | 'groupConflicts'
  | 'siteTravelTimes'
>;

/**
 * A post written at another post's times rather than sent (same-times.ts),
 * by what it is written with: the payload carries nothing of it.
 */
export interface MirroredRow {
  id: string;
  /** The sent post whose times it takes. */
  mirrorOf: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
}

export interface BasisSource {
  payload: BasisPayload;
  /**
   * Every realId → anonId map the payload was built through, the teacher's
   * and the subject's included. Anonymous ids are random uuids, unique across
   * the maps, so one reversed union turns any of them back.
   */
  maps: readonly ReadonlyMap<string, string>[];
  /** The school's saved lunch rules as the fetch read them; never a caller's. */
  storedRules: ScheduleRules | null;
  /** The non-preserved masters, the lessons a regeneration replaces. */
  draftLessons: readonly DraftContent[];
  /**
   * The posts of a block on another block's times. Absent or empty for a
   * school with none, whose `requirements` part is then what it always was.
   */
  mirrors?: readonly MirroredRow[];
}

/** The six parts' content, in real ids, before hashing. */
export type BasisInputs = Record<BasisPart, unknown>;

/**
 * The canonical text of a value: object keys in code-unit order at every
 * depth, every array in the order of its elements' own canonical texts.
 *
 * Every array, because the reads behind the payload carry no order a school
 * could see — two fetches of an unchanged school may answer rows in any order
 * Postgres likes, and frames and servings have no id to sort by. That makes
 * every list a multiset here, which is why each record below is an OBJECT
 * with named fields and never a tuple: a pair is the one tuple that enters
 * (groupConflicts), and a conflict pair is unordered anyway.
 *
 * Code-unit order, not localeCompare: the same text must sort the same on
 * every machine and in every locale, or two API instances disagree about one
 * school. A key whose value is undefined is left out, as JSON.stringify does;
 * a Map or a Set is refused, because Object.entries reads both as empty and a
 * part built over one would hash the same whatever it held.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError('canonicalJson: a Map or a Set has no canonical form here; pass an array.');
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).sort(byCodeUnit).join(',')}]`;
  }
  switch (typeof value) {
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => byCodeUnit(a, b));
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
    }
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: a non-finite number has no JSON form.');
      return JSON.stringify(value);
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    default:
      throw new TypeError(`canonicalJson: cannot encode a ${typeof value}.`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** The basis of a run: one digest over the six. */
export function basisOf(parts: BasisParts): string {
  return sha256Hex(canonicalJson({ v: BASIS_VERSION, parts }));
}

export function basisPartsOf(inputs: BasisInputs): BasisParts {
  return Object.fromEntries(
    BASIS_PARTS.map((part) => [part, sha256Hex(canonicalJson(inputs[part]))]),
  ) as BasisParts;
}

/**
 * The parts whose digests differ, in BASIS_PARTS order. A stored value that is
 * not a parts object (a run written before parts were kept, a hand-edited row)
 * differs in every part: nothing it says can be trusted to match.
 */
export function changedParts(stored: unknown, current: BasisParts): BasisPart[] {
  const previous =
    stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  return BASIS_PARTS.filter((part) => previous[part] !== current[part]);
}

/**
 * The six parts' content, every anonymous id turned back.
 *
 * Exported for the specs that hold "no pupil ever enters" and "each part moves
 * with its own inputs only"; the run and the apply use basisPartsOf over it.
 */
export function basisInputsOf(source: BasisSource): BasisInputs {
  const realByAnon = new Map<string, string>();
  for (const map of source.maps) {
    for (const [realId, anonId] of map) realByAnon.set(anonId, realId);
  }
  // An anonymous id with no real counterpart is a broken invariant (every id
  // in the payload is minted through one of the maps), and a basis built over
  // one would be random — every apply would be refused as stale with nothing
  // to say why. Loud instead.
  const realOf = (anonId: string): string => {
    const realId = realByAnon.get(anonId);
    if (realId === undefined) {
      throw new Error('candidate basis: an anonymous id in the payload has no real counterpart.');
    }
    return realId;
  };
  const realOrNull = (anonId: string | null | undefined): string | null =>
    anonId === null || anonId === undefined ? null : realOf(anonId);
  const { payload } = source;

  return {
    // As sent, every field, so a field the engine is sent later is covered the
    // day it is added; only the ids are turned back. And beside them the
    // posts written at a sent post's times, which an apply writes with their
    // own group and teachers: a teacher changed on one since the run puts
    // that teacher at the candidate's times unasked, so it makes the run
    // stale. Only when there are any, so the part of a school without a
    // block on another's times hashes what it always did.
    requirements: [
      ...payload.requirements.map((requirement) => ({
        ...requirement,
        id: realOf(requirement.id),
        subjectId: realOf(requirement.subjectId),
        studentGroupId: realOf(requirement.studentGroupId),
        // Ersättande grupper: the derived key, in real ids ("7A~SvA7"). Only
        // on a requirement sent with one, so every other part hashes as before.
        ...(requirement.pupilGroupId !== undefined ? { pupilGroupId: realOf(requirement.pupilGroupId) } : {}),
        teacherId: realOrNull(requirement.teacherId),
        coTeacherId: realOrNull(requirement.coTeacherId),
        requiredRoomType: realOrNull(requirement.requiredRoomType),
        ...(requirement.blockId !== undefined ? { blockId: realOf(requirement.blockId) } : {}),
        // Delade lektioner: each lesson's teacher, so shares changed since the
        // run make it stale. As [length, teacher] pairs, because the digest
        // sorts every array (canonicalJson) and a list of teachers sorted
        // apart from its lengths could not tell Bo's 40 from Bo's 80. Only on
        // a post sent with the list.
        ...(requirement.lessonTeacherIds !== undefined
          ? {
              lessonTeacherIds: requirement.lessonTeacherIds.map((anon, index) => [
                requirement.lessonLengths?.[index] ?? requirement.minutesPerLesson,
                realOrNull(anon),
              ]),
            }
          : {}),
      })),
      ...(source.mirrors ?? []).map((row) => ({ ...row })),
    ],
    preserved: payload.fixedLessons.map((lesson) => fixedLessonContent(lesson, realOf)),
    draft: {
      previousLessons: payload.previousLessons.map((lesson) => ({
        ...lesson,
        requirementId: realOf(lesson.requirementId),
      })),
      lessons: source.draftLessons.map(draftContentOf),
    },
    rooms: {
      rooms: payload.rooms.map((room) => ({
        ...room,
        id: realOf(room.id),
        type: realOrNull(room.type),
        ...(room.siteId !== undefined ? { siteId: realOf(room.siteId) } : {}),
      })),
      // Restid i generatorn: the walks, with the rooms' sites above, in the
      // rooms' part. The key is sent only when the school turned the walk on
      // and has a figure, and is read the same way, so every other school
      // keeps the basis it had; a school that turns it on after a run makes
      // that run stale, which is the truth: it was solved without the walk.
      ...(payload.siteTravelTimes !== undefined
        ? {
            siteTravelTimes: payload.siteTravelTimes.map((row) => ({
              ...row,
              siteAId: realOf(row.siteAId),
              siteBId: realOf(row.siteBId),
            })),
          }
        : {}),
      roomPreferences: payload.roomPreferences.map((rule) => ({
        ...rule,
        id: realOf(rule.id),
        subjectId: realOf(rule.subjectId),
        roomType: realOrNull(rule.roomType),
        roomIds: rule.roomIds.map(realOf),
      })),
    },
    rules: {
      constraints: payload.constraints.map((constraint) => ({
        ...constraint,
        id: realOf(constraint.id),
        ...(constraint.resourceId !== undefined ? { resourceId: realOf(constraint.resourceId) } : {}),
      })),
      frameTimes: payload.frameTimes,
      rasts: payload.rasts,
      lunchServings: payload.lunchServings,
      lunchPlacements: payload.lunchPlacements.map((placement) => ({
        ...placement,
        studentGroupId: realOf(placement.studentGroupId),
      })),
      teacherWorkRules: payload.teacherWorkRules.map((rule) => ({
        ...rule,
        id: realOf(rule.id),
        teacherId: realOf(rule.teacherId),
      })),
      // Lärarens dag: deltid in days, by the post (its own id space, kept and
      // reversed). The key is sent only when a post sets a limit, and is read
      // the same way, so a school that limits nobody's days keeps the basis it
      // had: its batches stay fresh across the release that added the field.
      ...(payload.teacherDayLimits !== undefined
        ? {
            teacherDayLimits: payload.teacherDayLimits.map((limit) => ({
              ...limit,
              id: realOf(limit.id),
              teacherId: realOf(limit.teacherId),
            })),
          }
        : {}),
      // Restid i generatorn: the switch is a Skolregler rule, and a stale
      // schemaförslag should say the rules changed when it was turned, not
      // only the rooms (whose part carries the walks and the sites). Present
      // only when the walk was sent, as the rooms' keys are.
      ...(payload.siteTravelTimes !== undefined ? { keepsTravelTime: true } : {}),
      storedRules: source.storedRules,
    },
    rosters: {
      groups: payload.groups.map((group) => ({ ...group, id: realOf(group.id) })),
      groupConflicts: payload.groupConflicts.map(([first, second]) => [realOf(first), realOf(second)]),
      // Ersättande grupper: who sits each locked lesson, when a replacing
      // group takes some of its groups' pupils elsewhere ("7A without SvA7"),
      // beside the lesson it is of. Not in the preserved part, which the
      // apply compares with database rows that know no such key. Only when a
      // lock carries one, so every other school's part hashes as before.
      ...(payload.fixedLessons.some((lesson) => lesson.pupilGroupIds !== undefined)
        ? {
            lockedPupils: payload.fixedLessons
              .filter((lesson) => lesson.pupilGroupIds !== undefined)
              .map((lesson) => ({ ...fixedLessonContent(lesson, realOf), pupilGroupIds: lesson.pupilGroupIds!.map(realOf) })),
          }
        : {}),
    },
  };
}

/**
 * A fixed lesson by content. NOT a spread: its own `id` is minted per request
 * and maps nowhere, so the fields are named, and preservedContentOf below
 * names the same ones over a database row — the apply's last check compares
 * the two, and they agree because they are this one shape.
 */
function fixedLessonContent(
  lesson: AnonymousFixedLesson,
  realOf: (anonId: string) => string,
): PreservedContent {
  const orNull = (anonId: string | null): string | null => (anonId === null ? null : realOf(anonId));
  return {
    studentGroupId: realOf(lesson.studentGroupId),
    extraGroupIds: (lesson.extraGroupIds ?? []).map(realOf),
    teacherId: orNull(lesson.teacherId),
    coTeacherId: orNull(lesson.coTeacherId),
    roomId: orNull(lesson.roomId),
    dayOfWeek: lesson.dayOfWeek,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    ...(lesson.recurrence !== undefined ? { recurrence: lesson.recurrence } : {}),
  };
}

/** A preserved master lesson as the database holds it. */
export interface PreservedRow {
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  extraGroups?: { studentGroupId: string }[];
  /** A/B-veckor: read wherever this is compared with a payload's lock (fixedLessonContent). */
  recurrence: LessonRecurrence;
}

/**
 * The same content over a database row, for the apply's last check: after the
 * write, the preserved lessons must still be exactly the ones the candidate
 * was solved around.
 */
export function preservedContentOf(row: PreservedRow): PreservedContent {
  return {
    studentGroupId: row.studentGroupId,
    extraGroupIds: (row.extraGroups ?? []).map((entry) => entry.studentGroupId),
    teacherId: row.teacherId ?? null,
    coTeacherId: row.coTeacherId ?? null,
    roomId: row.roomId ?? null,
    dayOfWeek: row.dayOfWeek,
    startTime: clockOf(row.startTime, true) ?? '',
    endTime: clockOf(row.endTime, true) ?? '',
    ...(row.recurrence !== 'ALL_WEEKS' ? { recurrence: row.recurrence } : {}),
  };
}

/** The `preserved` part's digest over database rows. */
export function preservedPartOf(rows: readonly PreservedRow[]): string {
  return sha256Hex(canonicalJson(rows.map(preservedContentOf)));
}

/** Only the content fields: a caller's richer row (an id, the tray flag) does not enter. */
function draftContentOf(lesson: DraftContent): DraftContent {
  return {
    subjectId: lesson.subjectId,
    studentGroupId: lesson.studentGroupId,
    teacherId: lesson.teacherId ?? null,
    coTeacherId: lesson.coTeacherId ?? null,
    roomId: lesson.roomId ?? null,
    dayOfWeek: lesson.dayOfWeek,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
    recurrence: lesson.recurrence ?? null,
    startDate: lesson.startDate ?? null,
    endDate: lesson.endDate ?? null,
  };
}

/**
 * A `@db.Time` value (midnight-anchored UTC) as HH:MM, or HH:MM:SS with
 * `seconds`. A string passes through; anything else is null.
 */
export function clockOf(value: Date | string | null | undefined, seconds = false): string | null {
  if (typeof value === 'string') return value;
  if (!(value instanceof Date)) return null;
  const pad = (part: number) => part.toString().padStart(2, '0');
  const clock = `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  return seconds ? `${clock}:${pad(value.getUTCSeconds())}` : clock;
}

/** A `@db.Date` value as YYYY-MM-DD, or null. */
export function dayOf(value: Date | string | null | undefined): string | null {
  if (typeof value === 'string') return value.slice(0, 10);
  return value instanceof Date ? value.toISOString().slice(0, 10) : null;
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
