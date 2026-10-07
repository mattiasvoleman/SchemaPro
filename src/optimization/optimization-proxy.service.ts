import { randomUUID } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AxiosError } from 'axios';
import type { PrismaClient } from '@prisma/client';
import { firstValueFrom, TimeoutError } from 'rxjs';
import { timeout, catchError } from 'rxjs/operators';
import type { AiEngineConfig } from '../config/configuration';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import type { RecurrenceWindow } from '../calendar/lesson-recurrence';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { gradeSpanOf, loadRosters, roomNeedsOf } from './room-eligibility';
import { STAFF_UNSTAFFED_REQUIREMENTS } from '../staffing/staffing-checks';
import type {
  AiEngineConflictAnalysis,
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
  AnonymousConstraint,
  AiEngineLunch,
  AnonymousFixedLesson,
  AnonymousFrameTime,
  AnonymousLunchPlacement,
  AnonymousLunchServing,
  AnonymousRast,
  AnonymousGroup,
  AnonymousPreviousLesson,
  AnonymousRequirement,
  AnonymousRoom,
  AnonymousRoomPreference,
  AnonymousTeacherWorkRule,
  ConstraintKind,
  DayOfWeek,
  ObjectiveWeights,
  ResourceKind,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import { refuseRostersNotActivated } from '../year-rollover/rosters-current';

/**
 * Masking proxy between NestJS and the Python AI engine.
 *
 * ## PII stripping contract
 *
 * 1. Fetch raw scheduling data from Prisma under the caller's RLS session.
 * 2. Re-map every record to a **new anonymous UUID** — never use real DB ids
 *    for resources that could be correlated back to a person (teachers are
 *    Users, and Users is the PII table). A fresh `anonymousId` map is built
 *    per-request and discarded after the response is processed.
 * 3. Drop every text field (names, codes, reasons, notes).
 * 4. Forward the sanitized payload to the AI engine over HTTPS with a
 *    pre-shared service API key (never the caller's JWT).
 * 5. Map the AI engine's anonymous response back to real DB ids using the
 *    retained anon→real id map before persisting master lessons.
 */
/**
 * Master lessons a regeneration leaves alone, expressed once.
 *
 * The first shape is the whole rule: `isGenerated` is false on everything the
 * optimizer did not produce, and nothing else in the timetable is the
 * machine's to replace. The other three are what a human has since done to a
 * lesson the machine did produce — locked it into place, opened it to a second
 * class, filled it with named students — each an intent the solver cannot
 * express and therefore could never put back.
 *
 * Ownership used to be inferred from the row looking untouched: default
 * recurrence and no dates, so nobody has been here, so it is ours. That held
 * only while nothing but a human ever set those columns. A generated lesson
 * now inherits its requirement's window, so "kemi bara på vårterminen"
 * describes the optimizer's own output exactly as well as a handmade lesson —
 * and read as handmade it was preserved, its requirement still counted as
 * unmet, and the next run stacked a second copy on top of it. Every press of
 * generate added another layer. The three window conditions are gone from this
 * list for that reason, and a handmade lesson carrying a window is caught by
 * `isGenerated: false` like every other handmade lesson.
 *
 * Referenced from the two places that must agree exactly: the fetch that
 * forwards these to the engine as immovable placements, and the delete that
 * clears the machine-owned remainder. One constant, because a lesson that is
 * in one list and not the other is either sent twice or thrown away.
 */
const PRESERVED_FROM_REGENERATION = [
  { isGenerated: false },
  { isLocked: true },
  { extraGroups: { some: {} } },
  { participants: { some: {} } },
];

/** The maps an engine refusal can name something through. */
export interface AnonMaps {
  requirementAnonMap: Map<string, string>;
  roomAnonMap: Map<string, string>;
  groupAnonMap: Map<string, string>;
  /**
   * Room types too. "No room satisfies capacity/type/years for requirement X
   * (…, required type Y, …)" names an anonymised TYPE, and leaving it out left
   * the one part of that sentence a school would actually look up untranslated.
   */
  roomTypeAnonMap: Map<string, string>;
  /** And the reservation an engine refusal names. */
  constraintAnonMap: Map<string, string>;
  /**
   * And the teacher's arbetstid one names.
   *
   * REQUIRED, not optional like `lessonAnonMap` below, although the room route
   * sends no work rules and passes an empty map. A refusal here says "this
   * teacher's lunch has nowhere to go" and can name nobody — the teacher map is
   * discarded on purpose, because no person's name may enter the stored
   * conflicts — so the RULE's id is the only thing a school can look the refusal
   * up by. Left optional, a route that forgot it would answer with a uuid that
   * exists in no table and nothing would report it.
   */
  workRuleAnonMap: Map<string, string>;
  /** Real group id -> the school's own name, the last step out of id space. */
  nameById: Map<string, string>;
  /**
   * Master lessons, for the room optimisation: its payload names placed
   * lessons rather than requirements, and a refusal that names one should come
   * back naming the row the school can find.
   */
  lessonAnonMap?: Map<string, string>;
}

/**
 * A timplanspost by the name the Timplan page gives its cell
 * (`requirements.cellLabel`, "{subject} för {group}"), or the subject alone
 * when the group has none. One function for every refusal that names a row,
 * the engine's and the staffing pre-flight's alike.
 */
function requirementName(subject: string, group: string | undefined | null): string {
  return group ? `${subject} för ${group}` : subject;
}

@Injectable()
export class OptimizationProxyService {
  private readonly logger = new Logger(OptimizationProxyService.name);
  private readonly aiConfig: AiEngineConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiConfig = this.configService.getOrThrow<AiEngineConfig>('aiEngine');
  }

  async triggerScheduling(
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights | null,
    rules?: ScheduleRules | null,
  ): Promise<AiEngineScheduleResponse> {
    const requestId = randomUUID();

    this.logger.log(
      `Optimization requested [requestId=${requestId}, academicYearId=${academicYearId}]`,
    );

    // Step 1: Fetch raw data under the authenticated user's RLS session.
    // teacherAnonMap / subjectAnonMap are produced by fetchAndAnonymize and not
    // needed here: the response names requirements, rooms and — since the
    // engine began returning sittings — student groups, so those three maps are
    // the ones that have to come back out.
    //
    // The staffing pre-flight runs first, in the same transaction: a school
    // whose policy refuses to generate around a teacherless row is answered
    // before the payload is built, the engine is never called, and nothing is
    // written — see unstaffedRefusal.
    const fetched = await this.prisma.withRls(user, async (tx) => {
      // A rolled year not yet activated has no pupils in its classes.
      await refuseRostersNotActivated(tx, academicYearId);
      const refusal = await this.unstaffedRefusal(tx, academicYearId, requireSchoolId(user), requestId);
      if (refusal) return { refusal, data: null };
      return {
        refusal: null,
        data: await this.fetchAndAnonymize(tx, academicYearId, requireSchoolId(user)),
      };
    });
    if (fetched.refusal) {
      this.logger.warn(
        `Optimization refused before the engine: ${fetched.refusal.conflicts?.summaryParams?.count ?? 0} requirement(s) without a teacher [requestId=${requestId}, academicYearId=${academicYearId}]`,
      );
      return fetched.refusal;
    }
    const {
      requirements,
      rooms,
      constraints,
      frameTimes,
      lunchServings,
      lunchPlacements,
      rasts,
      roomPreferences,
      teacherWorkRules,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
      groupAnonMap,
      headcountByGroup,
      roomTypeAnonMap,
      constraintAnonMap,
      workRuleAnonMap,
      nameById,
      storedRules,
    } = fetched.data;

    const anonMaps: AnonMaps = {
      requirementAnonMap,
      roomAnonMap,
      groupAnonMap,
      roomTypeAnonMap,
      constraintAnonMap,
      workRuleAnonMap,
      nameById,
    };

    // The school's saved lunch rules, unless this caller brought their own.
    // Body-wins rather than merge-per-field: two half-specified rule sets
    // silently combining into a third nobody wrote is worse than either.
    const effectiveRules = rules ?? storedRules;

    const payload: AiEngineScheduleRequest = {
      requestId,
      academicYearId,
      requirements,
      rooms,
      constraints,
      frameTimes,
      lunchServings,
      lunchPlacements,
      rasts,
      roomPreferences,
      teacherWorkRules,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      ...(weights ? { weights } : {}),
      ...(effectiveRules ? { rules: effectiveRules } : {}),
    };

    // Step 2: Call the AI engine with the stripped payload. When every
    // requirement is already covered by locked lessons there is nothing left
    // to solve — skip the engine and just clean up unlocked leftovers.
    const response: AiEngineScheduleResponse =
      requirements.length > 0
        ? await this.callAiEngine<AiEngineScheduleResponse>('/v1/schedule', payload, anonMaps)
        : { requestId, status: 'FEASIBLE', lessons: [], conflicts: null };

    // The sittings, with real group ids, computed once: they are both written
    // below and returned to the caller. Null when the engine was not asked.
    const realisedLunches = this.realiseLunches(response, groupAnonMap);
    if (realisedLunches === null) {
      this.logger.warn(
        `Engine skipped (every requirement is hand-placed); the previous run's sittings stand [academicYearId=${academicYearId}].`,
      );
    }

    // Step 3: Persist the master-lesson output, translating anon ids back.
    // `requirements` rides along as the demand the response is checked against
    // before anything is deleted — see persistMasterLessons.
    await this.prisma.withRls(user, (tx) =>
      this.persistMasterLessons(
        tx,
        academicYearId,
        user,
        response,
        requirements,
        requirementAnonMap,
        roomAnonMap,
        realisedLunches,
        headcountByGroup,
      ),
    );

    this.logger.log(
      `Optimization complete [requestId=${requestId}, status=${response.status}, ` +
        `lessons=${response.lessons.length}, lunches=${response.lunches?.length ?? 0}]`,
    );

    // The sittings and the refusal leave this method carrying REAL ids and
    // the school's own names. Everything the engine sees is anonymised, so a
    // caller handed the raw reply would get uuids that exist in no table.
    return {
      ...response,
      lunches: realisedLunches ?? [],
      conflicts: this.realiseConflicts(response.conflicts, anonMaps),
    };
  }

  /**
   * The engine's refusal with its ids turned back and its classes named.
   *
   * Ids inside the text go back to real ones through deanonymise, and a
   * group's real id goes one step further, to the name the school gave it:
   * "student group 4A", not a uuid in either id space. The ids in
   * resourceIds are mapped back the same way and, for groups, ALSO returned
   * as resourceNames. The lunch stage's lines say "the classes named here"
   * and carry the classes only in that field — which, until this, no layer
   * mapped back and no screen showed, so a school read "0 class(es)" one
   * week and "the classes named here" with nobody named the next.
   */
  private realiseConflicts(
    conflicts: AiEngineConflictAnalysis | null | undefined,
    maps: AnonMaps,
  ): AiEngineConflictAnalysis | null {
    if (!conflicts) return null;
    // EVERY id space, not only the groups'. `resourceIds` is mixed: the lunch
    // lines put classes in it, and the reservation line puts whatever the
    // reservation is about — a teacher, a room or a class. Reversing the
    // group map alone left a teacher's anonymous uuid in the response and
    // silently gave that detail fewer names than ids.
    const realByAnon = new Map<string, string>();
    for (const map of [
      maps.groupAnonMap,
      maps.roomAnonMap,
      maps.requirementAnonMap,
      maps.roomTypeAnonMap,
      maps.constraintAnonMap,
      // The arbetstid a "teacher's lunch has nowhere to go" refusal names. It
      // belongs in this list and not only in deanonymise's: the rule's id also
      // travels in `resourceIds`, where an untranslated one is a uuid the school
      // can look up in no table — and no NAME will ever fill that slot for it,
      // since the teacher map is discarded by design.
      maps.workRuleAnonMap,
    ]) {
      for (const [realId, anonId] of map) realByAnon.set(anonId, realId);
    }
    return {
      summary: this.named(conflicts.summary, maps),
      summaryCode: conflicts.summaryCode,
      summaryParams: this.namedParams(conflicts.summaryParams ?? {}, maps),
      conflicts: conflicts.conflicts.map((detail) => {
        const resourceIds = detail.resourceIds.map(
          (anonId) => realByAnon.get(anonId) ?? anonId,
        );
        return {
          ...detail,
          message: this.named(detail.message, maps),
          params: this.namedParams(detail.params ?? {}, maps),
          resourceIds,
          // Only the ones there IS a name for. A teacher is deliberately
          // absent — see nameById — so a reservation about one names the
          // reservation in its sentence and nobody in this list.
          resourceNames: resourceIds
            .map((realId) => maps.nameById.get(realId))
            .filter((name): name is string => name !== undefined),
        };
      }),
    };
  }

  /**
   * The generate pre-flight: STAFF_UNSTAFFED_REQUIREMENTS, or null to go on.
   *
   * A week solved for a timplanspost with no teacher is a week nobody can
   * teach: the engine places the row with no teacher constraint at all, and the
   * school finds out on the first Monday. Whether to start anyway is the
   * school's call — StaffingPolicy.unstaffedGeneration, ALLOW by default, which
   * is today's behaviour — and REFUSE answers here, before the payload is built
   * or the engine is woken.
   *
   * THROUGH realiseConflicts, AS AN ENGINE REFUSAL WOULD COME BACK. The rows
   * get anonymous ids and the refusal names them by those, exactly as the
   * engine's own refusals do, and the same path that turns an engine refusal
   * into the school's words turns these into "Matematik för 7B" in
   * resourceNames — the name the Timplan page gives the cell. So the job row,
   * the generate page and the history read this refusal the way they read
   * every other, with no second route for one code. Never a person: the
   * sentence counts rows, and the names are a subject and a group.
   *
   * Status INFEASIBLE because that is what the reply means to everything
   * downstream — no lessons came back, persistMasterLessons writes nothing and
   * the school's grundschema stands — and the summaryCode says why it was not
   * the solver that decided.
   */
  private async unstaffedRefusal(
    tx: PrismaClient,
    academicYearId: string,
    schoolId: string,
    requestId: string,
  ): Promise<AiEngineScheduleResponse | null> {
    const policy = await tx.staffingPolicy.findUnique({
      where: { schoolId },
      select: { unstaffedGeneration: true },
    });
    if (policy?.unstaffedGeneration !== 'REFUSE') return null;
    const unstaffed = await tx.teachingRequirement.findMany({
      where: { academicYearId, teacherId: null },
      select: {
        id: true,
        subject: { select: { name: true } },
        studentGroup: { select: { name: true } },
      },
    });
    if (unstaffed.length === 0) return null;

    const requirementAnonMap = new Map<string, string>();
    const nameById = new Map<string, string>();
    const named = unstaffed
      .map((row) => ({ id: row.id, name: requirementName(row.subject.name, row.studentGroup.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'sv') || a.id.localeCompare(b.id));
    for (const row of named) {
      requirementAnonMap.set(row.id, randomUUID());
      nameById.set(row.id, row.name);
    }
    const anonIds = [...requirementAnonMap.values()];
    const params = { count: named.length };
    // The catalogue's English (optimization-engine/app/messages.py), rendered
    // here because the engine never sees this refusal; the web renders the
    // Swedish from the code and params.
    const message =
      `${named.length === 1 ? '1 requirement has' : `${named.length} requirements have`} no teacher, ` +
      `and the school's staffing policy refuses to generate a timetable until every requirement has one. ` +
      `Staff the requirements named here, or allow generation without a teacher in the staffing settings.`;
    const conflicts: AiEngineConflictAnalysis = {
      summary: message,
      summaryCode: STAFF_UNSTAFFED_REQUIREMENTS,
      summaryParams: params,
      conflicts: [
        {
          category: 'INSUFFICIENT_RESOURCES',
          code: STAFF_UNSTAFFED_REQUIREMENTS,
          params,
          message,
          requirementIds: anonIds,
          roomIds: [],
          constraintIds: [],
          resourceIds: anonIds,
        },
      ],
    };
    return {
      requestId,
      status: 'INFEASIBLE',
      lessons: [],
      lunches: [],
      conflicts: this.realiseConflicts(conflicts, {
        requirementAnonMap,
        roomAnonMap: new Map(),
        groupAnonMap: new Map(),
        roomTypeAnonMap: new Map(),
        constraintAnonMap: new Map(),
        workRuleAnonMap: new Map(),
        nameById,
      }),
    };
  }

  /** An engine sentence with its ids turned back and its groups named. */
  private named(text: string, maps: AnonMaps): string {
    let out = this.deanonymise(text, maps);
    for (const [realId, name] of maps.nameById) out = out.split(realId).join(name);
    return out;
  }

  /**
   * The same substitution over the values a sentence carries.
   *
   * A param holding a group's id is an anonymous uuid, and the Swedish
   * sentence rendering it would otherwise name a row that exists in no table.
   * Numbers pass through untouched.
   */
  private namedParams(
    params: Record<string, string | number>,
    maps: AnonMaps,
  ): Record<string, string | number> {
    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key,
        typeof value === 'string' ? this.named(value, maps) : value,
      ]),
    );
  }

  /**
   * The engine's sittings with their anonymous group ids turned back.
   *
   * A sitting whose group cannot be resolved is DROPPED, not passed through
   * with the anonymous id: the map is built from the same groups the payload
   * was assembled from, so an unresolvable id means the engine invented one,
   * and a lunch pointing at a group that does not exist is worse than no lunch
   * at all — it would be stored, drawn, and unexplainable.
   */
  private realiseLunches(
    response: AiEngineScheduleResponse,
    groupAnonMap: Map<string, string>,
  ): AiEngineLunch[] | null {
    // No `lunches` at all is not the same as none: the engine answers with
    // a list — empty when the school has no lunch rule — and only a reply
    // built here without calling it carries none. That reply must not wipe
    // the sittings: a week that is wholly hand-placed skips the engine, and
    // its classes still eat where the last run put them. (A panel found the
    // rows being deleted and nothing written.) Placing lunches around locked
    // lessons alone would need the engine to accept an empty timplan; until
    // it does, the last run's sittings stand and the log says so.
    if (response.lunches === undefined) return null;
    if (response.lunches.length === 0) return [];

    const realIdOf = new Map(
      [...groupAnonMap].map(([realId, anonId]) => [anonId, realId]),
    );
    const realised: AiEngineLunch[] = [];
    for (const lunch of response.lunches) {
      const studentGroupId = realIdOf.get(lunch.studentGroupId);
      if (!studentGroupId) {
        this.logger.warn(
          `Dropping a sitting for unknown group ${lunch.studentGroupId}.`,
        );
        continue;
      }
      realised.push({ ...lunch, studentGroupId });
    }
    return realised;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchAndAnonymize(
    tx: PrismaClient,
    academicYearId: string,
    schoolId: string,
  ): Promise<{
    requirements: AnonymousRequirement[];
    rooms: AnonymousRoom[];
    constraints: AnonymousConstraint[];
    frameTimes: AnonymousFrameTime[];
    lunchServings: AnonymousLunchServing[];
    lunchPlacements: AnonymousLunchPlacement[];
    rasts: AnonymousRast[];
    roomPreferences: AnonymousRoomPreference[];
    teacherWorkRules: AnonymousTeacherWorkRule[];
    fixedLessons: AnonymousFixedLesson[];
    groups: AnonymousGroup[];
    previousLessons: AnonymousPreviousLesson[];
    groupConflicts: [string, string][];
    roomAnonMap: Map<string, string>;
    requirementAnonMap: Map<string, string>;
    /**
     * Needed to read the sittings back. The comment above says only the room
     * and requirement maps are used to reverse the response — that was true
     * until the engine began returning lunches, which name a student group.
     */
    groupAnonMap: Map<string, string>;
    /** groupId → children who eat AS this group, for the stored sittings. */
    headcountByGroup: Map<string, number>;
    /** Needed to translate "required type X" in an engine refusal. */
    roomTypeAnonMap: Map<string, string>;
    /** And the reservation one names. */
    constraintAnonMap: Map<string, string>;
    /** And the arbetstid one names, which is the ONLY way back to that row. */
    workRuleAnonMap: Map<string, string>;
    /** Real group id → the school's name for it, for realiseConflicts. */
    nameById: Map<string, string>;
    storedRules: ScheduleRules | null;
  }> {
    // Anonymous-id lookup tables: realId → anonId.
    const teacherAnonMap = new Map<string, string>();
    const roomAnonMap = new Map<string, string>();
    const groupAnonMap = new Map<string, string>();
    const subjectAnonMap = new Map<string, string>();
    const requirementAnonMap = new Map<string, string>();
    // Room types are school-authored names ("Trä- och metallslöjd"), so they
    // are anonymised like every other identifier: the solver only ever needs
    // to know that a room's type and a requirement's required type are the
    // SAME token, never what the school calls it.
    const roomTypeAnonMap = new Map<string, string>();
    const constraintAnonMap = new Map<string, string>();
    // The teacher's arbetstid. A map rather than a fresh uuid per row, and for
    // the reason spelled out where the constraint map is used: the engine puts
    // this id in the refusal it writes, and an id minted on the way out exists
    // in no table in either id space — not lookupable by the school, by this
    // gateway, or by a developer holding the database. It is the more important
    // here than anywhere else, because the refusal is about a PERSON and the
    // person's own map is deliberately thrown away.
    const workRuleAnonMap = new Map<string, string>();

    const anonId = (map: Map<string, string>, realId: string): string => {
      const existing = map.get(realId);
      if (existing) return existing;
      const id = randomUUID();
      map.set(realId, id);
      return id;
    };

    // Fetch teaching requirements (no PII fields selected). The subject's
    // required room type is an enum (not PII) and rides along for room
    // eligibility in the engine.
    const rawRequirements = await tx.teachingRequirement.findMany({
      where: { academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        lessonsPerWeek: true,
        minutesPerLesson: true,
        // The pupil buffers. Numbers, not names, so they cross to the engine
        // like the lesson length beside them — and they are the class's own
        // occupancy, never the teacher's or the room's.
        minutesBefore: true,
        minutesAfter: true,
        // Never forwarded — the engine has no notion of weeks. Read here
        // because the subtraction below compares a preserved lesson's weeks
        // against these, and stamped on the lessons the run produces so a
        // spring-only requirement yields spring-only lessons.
        recurrence: true,
        startDate: true,
        endDate: true,
        // The names ride along on joins that were already being made. They
        // are never forwarded to the engine, which sees anonymous tokens
        // throughout; they are what a refusal is turned back into on its way
        // to the school — see realiseConflicts.
        subject: {
          select: {
            requiredRoomTypeId: true,
            name: true,
            requiredRoomType: { select: { name: true } },
          },
        },
      },
    });

    // See PRESERVED_FROM_REGENERATION: these are the lessons regeneration must
    // not touch and must plan around. Those that cover a requirement's whole
    // period are subtracted from its weekly demand, so the solver re-places
    // only the machine-owned remainder.
    const preservedLessons = await tx.masterLesson.findMany({
      // A parked lesson is preserved like any hand-made one — regeneration
      // does not own it — but it is NOT sent as a fixed placement: it occupies
      // nothing, and blocking the engine out of a slot nobody is in would be
      // reading its memory of where it was as where it is.
      where: { academicYearId, isParked: false, OR: PRESERVED_FROM_REGENERATION },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        roomId: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        // Not forwarded — the engine has no notion of weeks. Selected because
        // the subtraction below has to know which weeks a preserved lesson is
        // really there before it cancels any of a requirement's demand.
        recurrence: true,
        startDate: true,
        endDate: true,
        extraGroups: { select: { studentGroupId: true } },
        // The pupils a hand-placed lesson names one by one. Not forwarded —
        // the engine plans around the lesson's groups — but a pupil who is
        // in the building for it puts their home class at lunch (see
        // atSchool), and a panel found that class going without.
        participants: { select: { studentId: true } },
      },
    });
    const participantIds = new Set(
      preservedLessons.flatMap((lesson) =>
        (lesson.participants ?? []).map((entry) => entry.studentId),
      ),
    );

    // Student -> groups, from BOTH membership kinds: the home class
    // (Users.studentGroupId) and teaching groups (StudentGroupMembers). Only
    // aggregates and id-relations derived from this ever leave this method —
    // student ids themselves are never sent to the engine.
    /*
     * Every group the week concerns — not only the ones with a requirement.
     *
     * A class whose lessons are every one of them placed by hand has no
     * requirement left after the subtraction below, and used to fall out of the
     * payload entirely. Its children are still in the building, and a class that
     * books no seats while its children eat is the one error direction the seat
     * rule cannot afford.
     */
    /*
     * AND EVERY HOME CLASS, whether or not the timplan names it.
     *
     * The paragraph above covers a class whose lessons are hand-placed. It did
     * not cover the school in the screenshot: every lesson on a teaching group
     * (4ma1, 4sv1, 4no1 …) and not one on the class itself. Such a class has no
     * requirement, no preserved lesson, and so no entry here — and a group not
     * in `groups` is a group the engine owes no lunch. Its children were in the
     * building all along; their meal was never placed, and the sittings the
     * engine DID place — for the teaching groups, headcount 0 — were dropped at
     * persist because a pupil eats with their class. Zero rows, and a notice
     * saying no lunch had been placed for the year.
     *
     * A class is a class by `kind`, read here once and reused for the spans
     * below. Fetched before the membership queries because those are scoped to
     * this list, and a class's pupils have to be counted for its headcount.
     */
    const allGroups = await tx.studentGroup.findMany({
      where: { academicYearId },
      select: { id: true, gradeLevel: true, kind: true, name: true },
    });
    // What the school calls each thing, for the refusal on its way back.
    //
    // ONE MAP OVER EVERY KIND OF ID, because a refusal names whatever it is
    // about and the ids are unique across the tables. A class is its own
    // name; a timplan row has none of its own and is named the way the
    // Timplan page names it, by subject and group. Nothing here is ever sent
    // to the engine, which sees anonymous tokens throughout.
    //
    // NO PERSON'S NAME GOES IN. firstName/lastName are marked PII in the
    // schema, and this map ends up denormalised into OptimizationJobs.conflicts
    // — a copy that no rename or deletion would ever reach. A reservation is
    // named by what it reserves and when, below.
    const nameById = new Map<string, string>();
    for (const group of allGroups) {
      if (typeof group.name === 'string' && group.name.length > 0) {
        nameById.set(group.id, group.name);
      }
    }
    // A timplan row carries no name of its own, and is named the way the app
    // already speaks it: `requirements.cellLabel` is "{subject} för {group}",
    // the aria-label on exactly this cell. Unique by construction — the
    // schema's @@unique(schoolId, academicYearId, studentGroupId, subjectId)
    // means group + subject names one row inside a läsår. The groups go in
    // first, above, because this reads them.
    for (const requirement of rawRequirements) {
      const subject = requirement.subject?.name;
      if (!subject) continue;
      nameById.set(requirement.id, requirementName(subject, nameById.get(requirement.studentGroupId)));
      const roomTypeId = requirement.subject.requiredRoomTypeId;
      const roomType = requirement.subject.requiredRoomType?.name;
      if (roomTypeId && roomType) nameById.set(roomTypeId, roomType);
    }
    const homeClassIds = allGroups
      .filter((group) => group.kind === 'CLASS')
      .map((group) => group.id);

    const scheduledGroupIds = [
      ...new Set([
        ...rawRequirements.map((r) => r.studentGroupId),
        ...preservedLessons.map((lesson) => lesson.studentGroupId),
        ...preservedLessons.flatMap((lesson) =>
          lesson.extraGroups.map((entry) => entry.studentGroupId),
        ),
        ...homeClassIds,
      ]),
    ];
    // Who sits where, and so how big each group is and which years it holds.
    // Read through room-eligibility.ts because the room optimisation reads it
    // the same way: a lesson it moves may only land where this run could have
    // put it, and that holds only while both count 7A with one piece of code.
    const rosters = await loadRosters(tx, scheduledGroupIds, allGroups, participantIds);
    const { groupsByStudent, membersByGroup, homeMembers, homeClassOf } = rosters;

    /*
     * Dining-hall headcount, which is deliberately NOT the same number.
     *
     * A child eats once. Ma71's students are already counted in 7A, where their
     * home class is, so Ma71 itself brings nobody to the hall — send its size
     * here and the hall fills up twice over with the same children, and the
     * school is told to build a bigger one.
     *
     * Home-class membership only, therefore: Users.studentGroupId, never
     * StudentGroupMembers. That alone is the whole rule — a teaching group is
     * nobody's home class, so it counts nought without being asked about its
     * kind. Checking the kind as well was strictly worse: it would count a
     * student whose home class had been set to a teaching group nowhere at all,
     * and an undercounted hall sends children to a room with no chairs in it.
     */
    const homeCountByGroup = new Map<string, number>();
    for (const row of homeMembers) {
      if (!row.studentGroupId) continue;
      homeCountByGroup.set(
        row.studentGroupId,
        (homeCountByGroup.get(row.studentGroupId) ?? 0) + 1,
      );
    }

    // Year span per scheduled group, for rooms limited to a stage and for the
    // frames, rasts and sittings that reach a stage. See gradeSpanOf for why it
    // is read off the pupils' home classes rather than off the group.
    const gradeSpanByGroup = new Map<string, { min: number; max: number }>();
    for (const groupId of scheduledGroupIds) {
      const span = gradeSpanOf(rosters, [groupId]);
      if (span) gradeSpanByGroup.set(groupId, span);
    }
    // A group the timplan names but whose year cannot be derived is bound by
    // NO frame and NO rast — the engine reads "unknown" as "unrestricted", on
    // purpose. That is how a slöjd group with no members and no gradeLevel of
    // its own gets a lesson laid straight across förmiddagsrasten. Said in the
    // log here and on the generate page, because the grid only ever shows the
    // band and the lesson on top of it, never why.
    const spanless = rawRequirements
      .map((r) => r.studentGroupId)
      .filter((groupId, index, all) => all.indexOf(groupId) === index)
      .filter((groupId) => !gradeSpanByGroup.has(groupId));
    if (spanless.length > 0) {
      this.logger.warn(
        `${spanless.length} group(s) with requirements have no derivable year; frame times and rasts will not bind their lessons [academicYearId=${academicYearId}].`,
      );
    }

    // Groups sharing at least one student can never hold overlapping lessons —
    // that is the whole point of teaching groups being real sets of students
    // rather than labels. One pass over students; each contributes the pairs
    // among its own groups, deduplicated by ordered key.
    const conflictPairKeys = new Set<string>();
    const realGroupConflicts: [string, string][] = [];
    for (const groups of groupsByStudent.values()) {
      if (groups.size < 2) continue;
      const list = [...groups].sort();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const key = `${list[i]}:${list[j]}`;
          if (!conflictPairKeys.has(key)) {
            conflictPairKeys.add(key);
            realGroupConflicts.push([list[i], list[j]]);
          }
        }
      }
    }

    /*
     * How much of the weekly demand is already placed by hand.
     *
     * Only a lesson that is there for every week the requirement is can cancel
     * one of its lessons a week. The engine has no concept of weeks at all, so
     * whatever is subtracted here is subtracted from all of them alike — there
     * is no way to say "one lesson, but only on odd ones". That leaves only the
     * choice of which way to be wrong, and the two directions are not
     * symmetric.
     *
     * Counting a lesson that is absent for part of the requirement
     * under-delivers, invisibly: lessonsPerWeek 2 with one locked odd-week
     * lesson sends 1 to the solver, and the class quietly gets one lesson on
     * even weeks for the rest of the year while the timplan says two. Nothing
     * on any screen says so. Not counting it over-delivers: an extra lesson on
     * odd weeks, sitting on the timetable in front of the administrator, who
     * can unlock or remove it. That costs packing room and not correctness —
     * the preserved lesson is forwarded as a fixed placement either way, so its
     * slot stays blocked in every week, and what the engine adds carries the
     * requirement's own window.
     *
     * So the test below is a covering test, and everything it cannot be sure of
     * falls on the visible side: equal recurrence, and a date window enclosing
     * the requirement's. Equal rather than covering recurrences on purpose —
     * an ALL_WEEKS lesson does cover an ODD_WEEKS requirement, and counting it
     * would buy one lesson of packing room in exchange for a second comparison
     * that has to stay right forever. Equality also keeps a recurrence added to
     * the enum later on the safe side without this line being touched: two
     * lessons with the same recurrence run the same weeks whatever it is, and
     * anything unequal is simply not counted. calendar/lesson-recurrence.ts
     * reads a missing recurrence as ALL_WEEKS because there the wrong guess
     * would drop half a school's lessons; here the wrong guess would hide them,
     * so an absent column on either side counts for nothing.
     */
    const coversDemand = (
      lesson: RecurrenceWindow,
      requirement: RecurrenceWindow,
    ): boolean => {
      if (!lesson.recurrence || !requirement.recurrence) return false;
      if (lesson.recurrence !== requirement.recurrence) return false;

      // Both columns are `@db.Date`, so both sides arrive at midnight UTC and
      // compare as plain instants. A null bound is the open one — "from the
      // start of the year", "until it ends" — so it encloses whatever the
      // requirement asks for, while a bound on the lesson and none on the
      // requirement encloses nothing: the requirement outlives the lesson.
      if (
        lesson.startDate &&
        (!requirement.startDate || lesson.startDate > requirement.startDate)
      ) {
        return false;
      }
      if (
        lesson.endDate &&
        (!requirement.endDate || lesson.endDate < requirement.endDate)
      ) {
        return false;
      }
      return true;
    };

    // Keyed on the demand a lesson answers, which one requirement per (year,
    // group, subject) — TeachingRequirement's own unique key — makes
    // unambiguous. The lessons themselves rather than a count, because whether
    // any of them cancels anything is a question about the requirement's
    // period and cannot be answered until the requirement is in hand.
    const preservedByDemand = new Map<string, RecurrenceWindow[]>();
    for (const lesson of preservedLessons) {
      const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
      const forDemand = preservedByDemand.get(key);
      if (forDemand) forDemand.push(lesson);
      else preservedByDemand.set(key, [lesson]);
    }

    const requirements: AnonymousRequirement[] = rawRequirements.flatMap((r) => {
      const alreadyCovered = (
        preservedByDemand.get(`${r.studentGroupId}:${r.subjectId}`) ?? []
      ).filter((lesson) => coversDemand(lesson, r)).length;
      const remaining = r.lessonsPerWeek - alreadyCovered;
      if (remaining <= 0) return [];
      const needs = roomNeedsOf(rosters, { groupIds: [r.studentGroupId] }, r.subject);
      return [
        {
          id: anonId(requirementAnonMap, r.id),
          subjectId: anonId(subjectAnonMap, r.subjectId),
          studentGroupId: anonId(groupAnonMap, r.studentGroupId),
          teacherId: r.teacherId ? anonId(teacherAnonMap, r.teacherId) : null,
          lessonsPerWeek: remaining,
          minutesPerLesson: r.minutesPerLesson,
          // Forwarded as they stand, beside the length and not folded into it:
          // the engine has to place 60 minutes of teaching and keep the class
          // clear for 90, and a sum would lose which of the two it was told.
          minutesBefore: r.minutesBefore,
          minutesAfter: r.minutesAfter,
          studentGroupSize: needs.studentGroupSize,
          minGradeLevel: needs.minGradeLevel,
          maxGradeLevel: needs.maxGradeLevel,
          requiredRoomType: needs.requiredRoomTypeId
            ? anonId(roomTypeAnonMap, needs.requiredRoomTypeId)
            : null,
          coTeacherId: r.coTeacherId ? anonId(teacherAnonMap, r.coTeacherId) : null,
        },
      ];
    });

    // Previous (unlocked) placements → minimal-disruption re-optimization.
    // Mapped to their requirement via (group, subject); lessons whose
    // requirement no longer exists (or is fully locked) are skipped.
    const anonReqByDemand = new Map<string, string>();
    for (const r of rawRequirements) {
      const anon = requirementAnonMap.get(r.id);
      if (anon) anonReqByDemand.set(`${r.studentGroupId}:${r.subjectId}`, anon);
    }
    const unlockedLessons = await tx.masterLesson.findMany({
      where: { academicYearId, isLocked: false },
      select: {
        subjectId: true,
        studentGroupId: true,
        dayOfWeek: true,
        startTime: true,
      },
    });
    const previousLessons: AnonymousPreviousLesson[] = unlockedLessons.flatMap(
      (lesson) => {
        const anonReq = anonReqByDemand.get(
          `${lesson.studentGroupId}:${lesson.subjectId}`,
        );
        if (!anonReq) return [];
        return [
          {
            requirementId: anonReq,
            dayOfWeek: lesson.dayOfWeek as DayOfWeek,
            startTime: this.timeToString(lesson.startTime),
          },
        ];
      },
    );

    const fixedLessons: AnonymousFixedLesson[] = preservedLessons.map((lesson) => ({
      id: randomUUID(),
      teacherId: lesson.teacherId ? anonId(teacherAnonMap, lesson.teacherId) : null,
      coTeacherId: lesson.coTeacherId
        ? anonId(teacherAnonMap, lesson.coTeacherId)
        : null,
      studentGroupId: anonId(groupAnonMap, lesson.studentGroupId),
      roomId: lesson.roomId ? anonId(roomAnonMap, lesson.roomId) : null,
      dayOfWeek: lesson.dayOfWeek as DayOfWeek,
      startTime: this.timeToString(lesson.startTime),
      endTime: this.timeToString(lesson.endTime),
      extraGroupIds: lesson.extraGroups.map((entry) =>
        anonId(groupAnonMap, entry.studentGroupId),
      ),
    }));

    /*
     * Who the dining hall has to seat.
     *
     * One entry per group the week concerns, carrying only how many children it
     * brings to lunch. Its own list rather than a field on each requirement,
     * because the fact belongs to the group: hanging it off requirements meant a
     * class whose lessons were all placed by hand disappeared from the count
     * along with its requirements, while its children kept eating.
     */
    // HOME CLASSES ONLY. `groups` is who eats, and a pupil eats once, with their
    // class. A teaching group here would be a second mandatory meal for the
    // same children — thirty minutes reserved on Ma71's day for a lunch nobody
    // takes there, and an INFEASIBLE with a lunch cause on the day it does not
    // fit. Its lessons still keep the class's meal clear, through the shared-
    // pupil pairs below.
    //
    // AND ONLY THE CLASSES THAT ARE AT SCHOOL THIS WEEK: a class eats when the
    // week holds a lesson its pupils sit in — a requirement or a locked lesson
    // on the class itself, or on a teaching group one of its pupils belongs
    // to. For one release every class of the year was sent, on the argument
    // that a class in the register is a class in the building. A school that
    // was scheduling two classes as a trial, with the other twenty-two entered
    // and full of pupils but without a single lesson, had all twenty-four sent
    // to the hall: 530 children in 115 seats, and it was told, in a second, by
    // arithmetic, that its dining hall could not feed two classes of twenty.
    // The register says who exists; the timplan says who is here.
    const lessonGroupIds = new Set<string>([
      ...rawRequirements.map((r) => r.studentGroupId),
      ...preservedLessons.map((lesson) => lesson.studentGroupId),
      ...preservedLessons.flatMap((lesson) =>
        lesson.extraGroups.map((entry) => entry.studentGroupId),
      ),
    ]);
    const classesWithAParticipant = new Set<string>();
    for (const studentId of participantIds) {
      const homeClass = homeClassOf.get(studentId);
      if (homeClass) classesWithAParticipant.add(homeClass);
    }
    const atSchool = (classId: string): boolean => {
      if (lessonGroupIds.has(classId)) return true;
      if (classesWithAParticipant.has(classId)) return true;
      for (const studentId of membersByGroup.get(classId) ?? []) {
        for (const groupId of groupsByStudent.get(studentId) ?? []) {
          if (lessonGroupIds.has(groupId)) return true;
        }
      }
      return false;
    };
    const homeClassSet = new Set(homeClassIds);
    const groups: AnonymousGroup[] = scheduledGroupIds
      .filter((groupId) => homeClassSet.has(groupId) && atSchool(groupId))
      .map((groupId) => ({
      id: anonId(groupAnonMap, groupId),
      lunchHeadcount: homeCountByGroup.get(groupId) ?? 0,
      // The same span the requirements carry, sent on the group as well: a
      // sitting and a frame both reach a stage, and a MEAL has no requirement
      // to read one off. Null for a group whose years cannot be derived — the
      // engine reads that as "unknown" and leaves it the school-wide window.
      minGradeLevel: gradeSpanByGroup.get(groupId)?.min ?? null,
      maxGradeLevel: gradeSpanByGroup.get(groupId)?.max ?? null,
    }));

    // Fetch rooms. The name and the type's name are read for the way BACK —
    // a refusal that names a room should name it the way the Salar page does
    // — and never forwarded: what the engine gets is capacity, an anonymous
    // type token and the year span.
    const rawRooms = await tx.room.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
      },
      select: {
        id: true,
        capacity: true,
        roomTypeId: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        // Same reason as the subject's name above: for the way back, never
        // for the engine.
        name: true,
        roomType: { select: { name: true } },
      },
    });
    for (const room of rawRooms) {
      if (room.name) nameById.set(room.id, room.name);
      if (room.roomTypeId && room.roomType?.name) {
        nameById.set(room.roomTypeId, room.roomType.name);
      }
    }

    /*
     * The school's lunch rules, read inside this same RLS transaction.
     *
     * They used to live in one administrator's browser, so a colleague
     * generating the schedule ran under different rules without knowing it. A
     * disabled row is read as no rule at all rather than as a lunch of zero
     * minutes — "we have not decided" and "we decided against" both mean the
     * engine should not reserve anything.
     */
    const lunchSettings = await tx.lunchSetting.findUnique({
      where: { schoolId },
      select: {
        lunchEnabled: true,
        lunchStartTime: true,
        lunchEndTime: true,
        lunchMinutes: true,
        diningSeats: true,
        maxLessonsPerDayPerGroup: true,
      },
    });
    const storedRules: ScheduleRules | null = !lunchSettings
      ? null
      : {
          ...(lunchSettings.lunchEnabled
            ? {
                lunchStartTime: this.timeToString(lunchSettings.lunchStartTime),
                lunchEndTime: this.timeToString(lunchSettings.lunchEndTime),
                lunchMinutes: lunchSettings.lunchMinutes,
                ...(lunchSettings.diningSeats !== null
                  ? { diningSeats: lunchSettings.diningSeats }
                  : {}),
              }
            : {}),
          ...(lunchSettings.maxLessonsPerDayPerGroup !== null
            ? {
                maxLessonsPerDayPerGroup:
                  lunchSettings.maxLessonsPerDayPerGroup,
              }
            : {}),
        };

    // Soft room wishes. Anonymised like everything else: the engine sees ids
    // it cannot resolve, and the weights that order them.
    const rawPreferences = await tx.roomPreference.findMany({
      select: {
        id: true,
        subjectId: true,
        kind: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        roomTypeId: true,
        weight: true,
        rooms: { select: { roomId: true } },
      },
    });

    const rooms: AnonymousRoom[] = rawRooms.map((r) => ({
      id: anonId(roomAnonMap, r.id),
      capacity: r.capacity,
      type: r.roomTypeId ? anonId(roomTypeAnonMap, r.roomTypeId) : null,
      minGradeLevel: r.minGradeLevel,
      maxGradeLevel: r.maxGradeLevel,
    }));

    const roomPreferences: AnonymousRoomPreference[] = rawPreferences.map((p) => {
      // Only rooms the payload actually carries: one no longer scheduled points
      // at nothing the engine can see.
      //
      // Dropping them is right for a WISH and a silent weakening for a LOCK: a
      // lock whose rooms all vanish here becomes a rule naming nothing, and the
      // engine reads that as "no restriction" rather than as "impossible". Kept
      // and reported instead — the unresolved count rides along so the caller
      // can say which rule stopped meaning what it says.
      const roomIds = p.rooms
        .map((entry) => roomAnonMap.get(entry.roomId))
        .filter((id): id is string => Boolean(id));
      if (p.kind === 'LOCK' && roomIds.length < p.rooms.length) {
        this.logger.warn(
          `Room lock ${p.id} names ${p.rooms.length - roomIds.length} room(s) ` +
            `no longer in the payload; the lock is narrower than it reads.`,
        );
      }
      return {
        id: anonId(requirementAnonMap, p.id),
        subjectId: anonId(subjectAnonMap, p.subjectId),
        kind: p.kind,
        minGradeLevel: p.minGradeLevel,
        maxGradeLevel: p.maxGradeLevel,
        roomType: p.roomTypeId ? anonId(roomTypeAnonMap, p.roomTypeId) : null,
        roomIds,
        weight: p.weight,
      };
    });

    // Fetch availability constraints (drop reason text field). An uppdrag's
    // slot only in its own läsår — see constraintsOfYear.
    const rawConstraints = await tx.availabilityConstraint.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
        AND: [constraintsOfYear(academicYearId)],
      },
      select: {
        id: true,
        resourceType: true,
        userId: true,
        roomId: true,
        studentGroupId: true,
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
        type: true,
      },
    });

    const constraints: AnonymousConstraint[] = rawConstraints.flatMap(
      (c): AnonymousConstraint[] => {
        const common = {
          // Through the map, not a fresh uuid. A bare randomUUID() here was an
          // id that existed in no table in either id space: the engine put it
          // in `constraintIds` and in the sentence it wrote, and what came out
          // the other end could not be looked up by the school, by this
          // gateway, or by a developer holding the database.
          id: anonId(constraintAnonMap, c.id),
          resourceKind: c.resourceType as ResourceKind,
          dayOfWeek: c.dayOfWeek as DayOfWeek | null,
          date: c.date ? c.date.toISOString().slice(0, 10) : null,
          startTime: this.timeToString(c.startTime),
          endTime: this.timeToString(c.endTime),
          kind: c.type as ConstraintKind,
        };

        // A year range names no resource, so it carries its bounds instead and
        // the engine matches them against each group's own span. Fanning it out
        // to one rule per class here was the alternative: twelve classes across
        // five weekdays is sixty rows for what an admin wrote as one line, and
        // the payload is capped at five thousand.
        if (c.resourceType === 'GRADE_LEVEL') {
          return [
            {
              ...common,
              minGradeLevel: c.minGradeLevel,
              maxGradeLevel: c.maxGradeLevel,
            },
          ];
        }

        const resourceId = c.userId
          ? anonId(teacherAnonMap, c.userId)
          : c.roomId
            ? anonId(roomAnonMap, c.roomId)
            : c.studentGroupId
              ? anonId(groupAnonMap, c.studentGroupId)
              : null;

        // A row whose declared type has no matching id used to be forwarded
        // with a freshly minted uuid the engine could never match against
        // anything: the rule saved, listed and constrained nothing, silently.
        // The API refuses to write one now; a survivor from before that check
        // is dropped here rather than sent as a lie.
        if (resourceId === null) {
          this.logger.warn(
            `Skipping constraint ${c.id}: ${c.resourceType} names no resource.`,
          );
          return [];
        }

        return [{ ...common, resourceId }];
      },
    );

    // Ramtider. School-scoped like the constraints above, and read through the
    // same year -> school hop rather than a schoolId the caller supplied, so a
    // request for another school's year cannot pull this school's rows.
    //
    // Nothing to anonymise: a frame names a span of years, which is a property
    // of the timetable and not of a person or a room.
    const rawFrames = await tx.frameTime.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        changeoverMinutes: true,
      },
    });

    const frameTimes: AnonymousFrameTime[] = rawFrames.map((frame) => ({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(frame.startTime),
      endTime: this.timeToString(frame.endTime),
      changeoverMinutes: frame.changeoverMinutes,
    }));

    // Lunchsittningar. School-scoped like the frames above and read through the
    // same year -> school hop, so a request for another school's year cannot
    // pull this school's rows. Nothing to anonymise: a sitting names a span of
    // years, not a person or a room.
    const rawServings = await tx.lunchServing.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        seats: true,
      },
    });

    const lunchServings: AnonymousLunchServing[] = rawServings.map((serving) => ({
      minGradeLevel: serving.minGradeLevel,
      maxGradeLevel: serving.maxGradeLevel,
      dayOfWeek: serving.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(serving.startTime),
      endTime: this.timeToString(serving.endTime),
      seats: serving.seats,
    }));

    // Meals the school placed by hand. YEAR-scoped, like every sitting: this
    // is what the school decided against one läsår's lessons. Anonymised
    // through the group map, and a row whose class the map does not know is
    // left out — the engine would have no lunch variable to pin for it.
    const handSittings = await tx.lunchSitting.findMany({
      where: { academicYearId, isGenerated: false },
      select: { studentGroupId: true, dayOfWeek: true, startTime: true },
    });
    const lunchPlacements: AnonymousLunchPlacement[] = handSittings.flatMap((sitting) => {
      const anonymous = groupAnonMap.get(sitting.studentGroupId);
      return anonymous === undefined
        ? []
        : [
            {
              studentGroupId: anonymous,
              dayOfWeek: sitting.dayOfWeek as DayOfWeek,
              startTime: this.timeToString(sitting.startTime),
            },
          ];
    });

    // Raster. School-scoped and read through the same year -> school hop as the
    // frames and the sittings above, so a request for another school's year
    // cannot pull this school's rows. The NAME is deliberately not sent: the
    // engine subtracts minutes and has nothing to say about what they are
    // called, and every field that reaches it is one more thing that could
    // identify a school in a payload built to be anonymous.
    const rawRasts = await tx.rast.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        minGradeLevel: true,
        maxGradeLevel: true,
        dayOfWeek: true,
        startTime: true,
        endTime: true,
        requiresLessonBefore: true,
      },
    });

    const rasts: AnonymousRast[] = rawRasts.map((rast) => ({
      minGradeLevel: rast.minGradeLevel,
      maxGradeLevel: rast.maxGradeLevel,
      dayOfWeek: rast.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(rast.startTime),
      endTime: this.timeToString(rast.endTime),
      requiresLessonBefore: rast.requiresLessonBefore,
    }));

    /*
     * Lärarnas arbetstid. School-scoped and read through the same year -> school
     * hop as the frames, the sittings and the rasts above, so a request for
     * another school's year cannot pull this school's rows.
     *
     * BOTH IDS ARE ANONYMISED, and they are anonymised differently on purpose.
     * The teacher goes through `teacherAnonMap`, the same map the requirements
     * and the fixed lessons use, so the engine can tell that this rule and that
     * lesson concern one person — and that map is DISCARDED when the request
     * ends, because a refusal about a teacher must never be able to name them.
     * The rule's own id goes through `workRuleAnonMap`, which is kept and
     * reversed on the way back, because the refusal has to name SOMETHING the
     * school can open, and with the person unnameable the row is all there is.
     *
     * A rule whose teacher is not already in the map is LEFT OUT. That teacher
     * appears in no requirement, no fixed lesson and no reservation this year, so
     * the engine has no lesson of theirs to hang an assumption on — and minting a
     * teacher token here would send a rule about somebody the payload never
     * mentions, which is a fresh uuid the engine can match against nothing. Said
     * in the log, because "my lunch rule did nothing" is otherwise invisible.
     *
     * No name, and nothing but numbers and clocks. The engine has nothing to say
     * about what a teacher is called, and every field that reaches it is one more
     * thing that could identify a school in a payload built to be anonymous.
     */
    const rawWorkRules = await tx.teacherWorkRule.findMany({
      where: { school: { academicYears: { some: { id: academicYearId } } } },
      select: {
        id: true,
        userId: true,
        lunchMinutes: true,
        lunchStartTime: true,
        lunchEndTime: true,
        minDailyRestMinutes: true,
      },
    });

    const teacherWorkRules: AnonymousTeacherWorkRule[] = rawWorkRules.flatMap(
      (rule): AnonymousTeacherWorkRule[] => {
        const teacherId = teacherAnonMap.get(rule.userId);
        if (teacherId === undefined) {
          this.logger.warn(
            `Skipping work rule ${rule.id}: its teacher has no lesson, reservation ` +
              `or requirement in this year, so there is nothing to hold it against.`,
          );
          return [];
        }
        return [
          {
            id: anonId(workRuleAnonMap, rule.id),
            teacherId,
            lunchMinutes: rule.lunchMinutes,
            lunchStartTime: rule.lunchStartTime
              ? this.timeToString(rule.lunchStartTime)
              : null,
            lunchEndTime: rule.lunchEndTime
              ? this.timeToString(rule.lunchEndTime)
              : null,
            minDailyRestMinutes: rule.minDailyRestMinutes,
          },
        ];
      },
    );

    // Anonymize the conflict pairs with the same group map the requirements
    // used, so the engine sees a consistent id space. Pairs whose groups never
    // reached the payload (no requirement and no fixed lesson references them)
    // are dropped — the engine would have nothing to constrain.
    const groupConflicts: [string, string][] = realGroupConflicts.flatMap(
      ([a, b]) => {
        const anonA = groupAnonMap.get(a);
        const anonB = groupAnonMap.get(b);
        return anonA && anonB ? [[anonA, anonB] as [string, string]] : [];
      },
    );

    return {
      requirements,
      rooms,
      constraints,
      frameTimes,
      lunchServings,
      lunchPlacements,
      rasts,
      roomPreferences,
      teacherWorkRules,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
      groupAnonMap,
      headcountByGroup: homeCountByGroup,
      roomTypeAnonMap,
      constraintAnonMap,
      workRuleAnonMap,
      nameById,
      // An empty object would send `rules: {}` and read as "rules were
      // considered and came to nothing", which the engine treats the same but
      // a reader of the payload would not.
      storedRules:
        storedRules !== null && Object.keys(storedRules).length > 0
          ? storedRules
          : null,
    };
  }

  /**
   * Turn the anonymous ids in an engine refusal back into real ones.
   *
   * Every named refusal the engine can produce — "A room lock leaves
   * requirement 8f2c… nowhere to go", "No room satisfies capacity/type/years
   * for requirement …" — names an id the engine minted. Forwarded verbatim it
   * is a uuid that exists in no table, which is the state the engine's conflict
   * MESSAGES are still in.
   *
   * A substitution rather than a second implementation of the rule: rebuilding
   * the lock resolution here in TypeScript to phrase a nicer sentence would be
   * two implementations of one meaning, and the one that drifts is the one
   * nobody runs. The engine keeps saying what is wrong; this only restores who
   * it is about.
   */
  private deanonymise(message: string, maps: AnonMaps): string {
    const real = new Map<string, string>();
    for (const map of [
      maps.requirementAnonMap,
      maps.roomAnonMap,
      maps.groupAnonMap,
      maps.roomTypeAnonMap,
      maps.constraintAnonMap,
      maps.workRuleAnonMap,
      maps.lessonAnonMap ?? new Map<string, string>(),
    ]) {
      for (const [realId, anonId] of map) real.set(anonId, realId);
    }
    // Only whole uuids are replaced, so a message that happens to contain a
    // uuid-shaped substring of something else is left alone.
    return message.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      (found) => real.get(found) ?? found,
    );
  }

  /**
   * POST an anonymised payload to one of the engine's routes.
   *
   * Public, and taking the path, because the room optimisation calls a second
   * route with exactly the same needs: the service key, the timeout, and the
   * three failures told apart below. A copy of this method would be a second
   * place that forgets one of them — which is how "unreachable" and "answered
   * with an error" were once the same sentence.
   *
   * `maps` turns ids in a refusal back into ones the school can look up; pass
   * the maps the payload was built with.
   */
  async callAiEngine<TResponse>(
    path: string,
    payload: object,
    maps: AnonMaps,
  ): Promise<TResponse> {
    const url = `${this.aiConfig.baseUrl}${path}`;

    try {
      const response = await firstValueFrom(
        this.http
          .post<TResponse>(url, payload, {
            headers: {
              'X-API-Key': this.aiConfig.apiKey,
              'Content-Type': 'application/json',
            },
          })
          .pipe(
            timeout(this.aiConfig.timeoutMs),
            /*
             * Three different failures, told apart, because they need three
             * different things done about them.
             *
             * "Returned an error" used to cover two of them. An AxiosError with
             * no `response` is a request that never arrived — the engine
             * refused the connection, or the host does not resolve — and
             * reporting that as the engine having answered sent whoever read
             * the log looking at the engine's own logs, which are empty because
             * it was never running. That is the ordinary case locally: the
             * engine is a separate service and it is easy to forget to start.
             *
             * The status is kept from the response where there is one, because
             * a 400 from the engine means this request was wrong and a 500
             * means the engine broke, and flattening both into 502 loses the
             * only thing that separates them.
             */
            catchError((error: unknown) => {
              if (error instanceof TimeoutError) {
                throw new ServiceUnavailableException(
                  'The AI engine did not respond in time.',
                );
              }
              if (error instanceof AxiosError) {
                if (error.response === undefined) {
                  this.logger.error(
                    `AI engine unreachable at ${this.aiConfig.baseUrl} [${error.code ?? 'no code'}]`,
                  );
                  throw new ServiceUnavailableException(
                    'The AI engine could not be reached.',
                  );
                }
                /*
                 * The engine's own sentence, not a generic one.
                 *
                 * Every named refusal the engine can produce — a lesson length
                 * off the grid, a lunch an availability rule leaves no room
                 * for, a frame too tight for its own stage — arrived here and
                 * was replaced by "The AI engine returned an error.", which
                 * tells a school nothing it can act on. The messages exist and
                 * name the requirement, the group and the day; they were simply
                 * thrown away one layer below the screen that shows them.
                 *
                 * Only the message is forwarded, and only when it is a string:
                 * the engine's error body is {code, message}, and passing the
                 * object through would put a JSON blob in a toast. A 5xx from
                 * the engine keeps the generic text — an internal failure's
                 * detail is ours to read in the logs, not the school's.
                 */
                const body = error.response.data as {
                  message?: unknown;
                  details?: { code?: unknown; params?: unknown } | null;
                } | null;
                const readable =
                  error.response.status < 500 && typeof body?.message === 'string';
                const detail = readable
                  ? this.deanonymise(body.message as string, maps)
                  : 'The AI engine returned an error.';
                // The refusal's own name and values travel with it, so the
                // screen can say in Swedish what the engine said in English.
                // An object body rather than a string: Nest returns it as the
                // response body, where `message` is still where every reader
                // of this API already looks.
                const named =
                  readable && body?.details && typeof body.details.code === 'string'
                    ? {
                        code: body.details.code,
                        params: this.namedParams(
                          (body.details.params ?? {}) as Record<string, string | number>,
                          maps,
                        ),
                      }
                    : {};
                throw new HttpException(
                  { message: detail, ...named },
                  error.response.status,
                );
              }
              throw new ServiceUnavailableException('AI engine unavailable.');
            }),
          ),
      );

      return response.data;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('AI engine unavailable.');
    }
  }

  private async persistMasterLessons(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
    response: AiEngineScheduleResponse,
    requirements: AnonymousRequirement[],
    requirementAnonMap: Map<string, string>,
    roomAnonMap: Map<string, string>,
    /**
     * Sittings carrying REAL group ids — realiseLunches has already run. Null
     * when the engine was never asked, and then the stored sittings are left
     * exactly as they were.
     */
    lunches: AiEngineLunch[] | null,
    /** groupId → children seated, so the kitchen's list needs no re-derivation. */
    headcountByGroup: Map<string, number>,
  ): Promise<void> {
    // Neither verdict yields lessons, so both must bail out *before* the
    // delete-and-recreate below — otherwise a run that produced nothing would
    // wipe the school's existing unlocked timetable.
    if (response.status === 'INFEASIBLE' || response.status === 'TIMEOUT') {
      this.logger.warn(
        `AI engine returned ${response.status} for academicYearId=${academicYearId}. No master lessons written.`,
      );
      return;
    }

    // Invert: anonId → realId for requirements and rooms.
    const realRequirementId = new Map<string, string>(
      [...requirementAnonMap.entries()].map(([real, anon]) => [anon, real]),
    );
    const realRoomId = new Map<string, string>(
      [...roomAnonMap.entries()].map(([real, anon]) => [anon, real]),
    );

    if (!user.schoolId) {
      throw new Error('Cannot persist master lessons: schoolId missing from JWT.');
    }
    const schoolId = user.schoolId;

    // Fetch requirement details needed for the MasterLesson record. Read again
    // rather than carried from the fetch phase: the solver has been running in
    // between, and every other field written below comes from this same row.
    const requirementDetails = await tx.teachingRequirement.findMany({
      where: { academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
        recurrence: true,
        startDate: true,
        endDate: true,
      },
    });
    const reqById = new Map(requirementDetails.map((r) => [r.id, r]));

    /*
     * The whole replacement is built and checked here, BEFORE a single row is
     * deleted — the ordering is the guard, not an optimization.
     *
     * The engine places every lesson it is asked for or none at all: one
     * decision variable per lesson-per-week, all of them extracted into the
     * response. So a solution that does not carry exactly the demand it was
     * sent is not an answer to this request, whatever its status says, and the
     * timetable must not be replaced by it. A well-formed but empty
     * `{status:"FEASIBLE", lessons:[]}` used to reach the delete below and
     * leave the school's year with nothing in it — and no snapshot is taken
     * before a regeneration, so there was nothing to put back.
     */
    const demandByRequirement = new Map(
      requirements.map((r) => [r.id, r.lessonsPerWeek]),
    );
    const placedByRequirement = new Map<string, number>();
    let unmatchedLessons = 0;

    const creates = response.lessons.flatMap((lesson) => {
      const realReqId = realRequirementId.get(lesson.requirementId);
      const req = realReqId ? reqById.get(realReqId) : undefined;
      // Either the response names a requirement this request never sent, or
      // the requirement has been deleted while the solver was running. Both
      // mean the solution no longer describes this academic year.
      if (!req || !demandByRequirement.has(lesson.requirementId)) {
        unmatchedLessons++;
        return [];
      }

      placedByRequirement.set(
        lesson.requirementId,
        (placedByRequirement.get(lesson.requirementId) ?? 0) + 1,
      );

      const realRoom = lesson.roomId ? realRoomId.get(lesson.roomId) : null;

      return [
        {
          schoolId,
          academicYearId,
          subjectId: req.subjectId,
          studentGroupId: req.studentGroupId,
          teacherId: req.teacherId ?? null,
          coTeacherId: req.coTeacherId ?? null,
          roomId: realRoom ?? null,
          dayOfWeek: lesson.dayOfWeek,
          startTime: this.parseTime(lesson.startTime),
          endTime: this.parseTime(lesson.endTime),
          // The window comes from the requirement, never from the engine — the
          // engine was never told about weeks and packs a spring-only course as
          // if it ran all year. Stamping the period on afterwards over-provisions
          // (two half-year subjects get separate slots where one would have
          // done) and that is the visible kind of wrong; a lesson that came back
          // as an ordinary weekly one would silently turn "kemi bara på
          // vårterminen" into a year-long course.
          recurrence: req.recurrence,
          startDate: req.startDate,
          endDate: req.endDate,
          // What makes the next run allowed to delete this row again: the one
          // place in the codebase that sets it true, and the column
          // PRESERVED_FROM_REGENERATION asks to tell whose lesson this is.
          isGenerated: true,
        },
      ];
    });

    const offTarget = [...demandByRequirement].filter(
      ([anonRequirementId, wanted]) =>
        (placedByRequirement.get(anonRequirementId) ?? 0) !== wanted,
    ).length;
    if (unmatchedLessons > 0 || offTarget > 0) {
      const requested = [...demandByRequirement.values()].reduce(
        (sum, count) => sum + count,
        0,
      );
      this.logger.error(
        `Rejected AI engine solution [academicYearId=${academicYearId}, status=${response.status}, requestedLessons=${requested}, placedLessons=${creates.length}, unmatchedLessons=${unmatchedLessons}, requirementsOffTarget=${offTarget}]. Timetable left untouched.`,
      );
      throw new HttpException(
        'The AI engine returned a solution that does not match the requested timetable. The existing timetable was left unchanged.',
        HttpStatus.BAD_GATEWAY,
      );
    }

    // Non-destructive regeneration: handmade lessons, locked lessons AND
    // participant lessons (manual multi-class / individual-student constructs)
    // are preserved verbatim; only lessons this optimizer wrote are replaced by
    // the new solution. The same four shapes the fetch above shares — and the
    // rows about to be deleted are exactly the ones a previous run stamped
    // `isGenerated`; see the constant for why that is a column and not a guess.
    const preservedWhere = { OR: PRESERVED_FROM_REGENERATION };

    /*
     * The dated lessons of the templates about to go, removed before the
     * templates themselves.
     *
     * CalendarLessons.masterLessonId is ON DELETE SET NULL, so they would
     * otherwise outlive their template as orphans — and publish keys its
     * idempotency set on (masterLessonId, date), which an orphan matches
     * nothing in. Publishing again after a regeneration then materialized the
     * same week a second time: one lesson a week over four weeks came back as
     * eight, half of them at a slot no timetable mentions any more.
     *
     * Same rule the single-lesson delete uses (master-lessons.service.ts):
     * future, still-SCHEDULED, no attendance recorded. What has already
     * happened stays exactly as it happened, orphaned but intact.
     */
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const { count: removedCalendarLessons } = await tx.calendarLesson.deleteMany({
      where: {
        masterLesson: { is: { academicYearId, NOT: preservedWhere } },
        status: 'SCHEDULED',
        date: { gte: today },
        attendanceRecords: { none: {} },
      },
    });

    const { count: removedUnlocked } = await tx.masterLesson.deleteMany({
      where: { academicYearId, NOT: preservedWhere },
    });
    const lockedPreserved = await tx.masterLesson.count({
      where: { academicYearId, ...preservedWhere },
    });

    await Promise.all(creates.map((data) => tx.masterLesson.create({ data })));

    /*
     * The sittings, in the same transaction and with the same all-or-nothing
     * shape as the lessons above.
     *
     * The solver's rows are replaced; the school's are kept. A hand-placed
     * sitting went to the engine as a pin on the lunch variable it builds, not
     * as a fixed lesson beside it, so there is one reservation per meal and the
     * row survives the run that honoured it. See replaceSittings.
     *
     * Reached only after the guards above, so a run the gateway refused leaves
     * last week's flow exactly where it was — and so does a run that never
     * asked the engine, which has no sittings to replace them with.
     */
    if (lunches !== null) {
      await this.replaceSittings(tx, schoolId, academicYearId, lunches, headcountByGroup, today);
    }

    // Append a REGENERATE entry to the schedule audit trail.
    await tx.scheduleChangeLog.create({
      data: {
        schoolId,
        academicYearId,
        masterLessonId: null,
        actorId: user.userId ?? null,
        action: 'REGENERATE',
        after: {
          solverStatus: response.status,
          lessonsCreated: creates.length,
          unlockedReplaced: removedUnlocked,
          lockedPreserved,
          calendarLessonsRemoved: removedCalendarLessons,
        },
      },
    });
  }

  /**
   * Replace the stored sittings with the engine's, classes only, and clear
   * the calendar's future meals so publish re-derives them. The body that
   * used to sit inline in persistMasterLessons; lifted out so a run that
   * never asked the engine can skip it whole.
   */
  private async replaceSittings(
    tx: PrismaClient,
    schoolId: string,
    academicYearId: string,
    lunches: AiEngineLunch[],
    headcountByGroup: Map<string, number>,
    today: Date,
  ): Promise<void> {
    /*
     * The solver's rows only. A meal the school placed by hand is an
     * instruction, not an output: it went to the engine as a pin, and a run
     * that deleted it would honour it once and forget it for the next.
     */
    await tx.lunchSitting.deleteMany({ where: { academicYearId, isGenerated: true } });
    const handPlaced = await tx.lunchSitting.findMany({
      where: { academicYearId, isGenerated: false },
      select: { id: true, studentGroupId: true, dayOfWeek: true, startTime: true },
    });
    const handByKey = new Map(
      handPlaced.map((row) => [`${row.studentGroupId}:${row.dayOfWeek}`, row]),
    );

    /*
     * Classes eat. Teaching groups do not.
     *
     * The engine gives a lunch interval to every group that carries a
     * requirement — its own comment says so, EVERY HOME CLASS EATS EVERY SCHOOL
     * DAY — and the set it iterates unions the groups with lessons, so Ma71
     * arrives with headcount 0 and gets a sitting every school day. Those rows
     * are not wrong in the engine, where the interval is what keeps a teaching
     * group's lessons out of its members' meal; they are wrong in this table,
     * which is the kitchen's list and the pupil's band. A pupil eats once, with
     * their class.
     */
    const classIds = new Set(
      (
        await tx.studentGroup.findMany({
          where: { academicYearId, kind: 'CLASS' },
          select: { id: true },
        })
      ).map((group) => group.id),
    );
    const classSittings = lunches.filter((lunch) => classIds.has(lunch.studentGroupId));

    /*
     * The engine reports a pinned meal back like any other, so the answer for a
     * hand-placed day lands on a row that already exists — and creating over it
     * would break LunchSittings_group_day_key inside this transaction, after a
     * solve the school watched succeed. So a hand row keeps its start, the one
     * thing the school said, and takes the rest from the answer: the length,
     * because lunchMinutes may have changed since it was placed, and the
     * headcount, because the class may have. If the answer's start is not the
     * school's, the pin did not bind — two halves of one seam have drifted, and
     * that is said loudly rather than papered over.
     */
    const fresh = classSittings.filter(
      (lunch) => !handByKey.has(`${lunch.studentGroupId}:${lunch.dayOfWeek}`),
    );
    for (const lunch of classSittings) {
      const hand = handByKey.get(`${lunch.studentGroupId}:${lunch.dayOfWeek}`);
      if (hand === undefined) continue;
      if (this.timeToString(hand.startTime) !== lunch.startTime) {
        this.logger.error(
          `A hand-placed lunch did not bind: group ${lunch.studentGroupId} day ${lunch.dayOfWeek} ` +
            `was placed at ${this.timeToString(hand.startTime)} and the engine answered ${lunch.startTime}.`,
        );
      }
      await tx.lunchSitting.update({
        where: { id: hand.id },
        data: {
          endTime: this.parseTime(lunch.endTime),
          headcount: headcountByGroup.get(lunch.studentGroupId) ?? 0,
        },
      });
    }
    /*
     * A hand-placed row the engine did not answer for was not honoured: the
     * school switched lunch off, or the class is not at school this week. It
     * goes, for the rule the spec states for the solver's rows — a school that
     * switched lunch off must not keep last term's flow on the grid — and here
     * with a sharper reason: with no meal in the model the lessons were placed
     * straight across it, and kept it would reach the pupil's calendar on top
     * of one.
     */
    const answered = new Set(
      classSittings.map((lunch) => `${lunch.studentGroupId}:${lunch.dayOfWeek}`),
    );
    const unanswered = handPlaced.filter(
      (row) => !answered.has(`${row.studentGroupId}:${row.dayOfWeek}`),
    );
    if (unanswered.length > 0) {
      await tx.lunchSitting.deleteMany({
        where: { id: { in: unanswered.map((row) => row.id) } },
      });
    }

    if (fresh.length > 0) {
      await tx.lunchSitting.createMany({
        data: fresh.map((lunch) => ({
          schoolId,
          academicYearId,
          studentGroupId: lunch.studentGroupId,
          dayOfWeek: lunch.dayOfWeek,
          startTime: this.parseTime(lunch.startTime),
          endTime: this.parseTime(lunch.endTime),
          headcount: headcountByGroup.get(lunch.studentGroupId) ?? 0,
          isGenerated: true,
        })),
      });
    }

    /*
     * And the meals already on the calendar go with them.
     *
     * This file's own header states the rule: whoever replaces a generated
     * timetable deletes its future materializations in the same transaction.
     * The half for the lessons was written; the half for the meal was not, and
     * publish then skipped every (group, date) that already existed — so a
     * republished week kept last month's lunch times for ever, and no screen
     * anywhere said the two disagreed.
     *
     * No academicYearId column is needed to find them: a CalendarLunch belongs
     * to a StudentGroup and a StudentGroup belongs to a year, so the relation
     * filter reaches them. Adding the column and backfilling it from
     * LunchSittings — the obvious alternative — joins on
     * (schoolId, studentGroupId, dayOfWeek) while that table's unique key
     * includes the year, so a school in its second läsår has two matching rows
     * and the backfill is ambiguous.
     *
     * The same three-part guard the lessons use does NOT apply. A CalendarLesson
     * may carry attendance, and rewriting one would be rewriting what happened;
     * a CalendarLunch carries no attendance, no status and no participants, so
     * there is nothing to preserve and no reason to keep the past. Only the
     * future is deleted all the same, because a meal that was eaten is a fact
     * about a day that has been.
     */
    await tx.calendarLunch.deleteMany({
      where: {
        studentGroup: { is: { academicYearId } },
        date: { gte: today },
      },
    });
  }

  /** Converts a Prisma `Time` value (a JS Date with time component) to HH:MM:SS. */
  private timeToString(date: Date): string {
    const h = date.getUTCHours().toString().padStart(2, '0');
    const m = date.getUTCMinutes().toString().padStart(2, '0');
    const s = date.getUTCSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  /** Parses HH:MM:SS from the AI engine response into a Date for Prisma Time fields. */
  private parseTime(timeStr: string): Date {
    const [h, m, s] = timeStr.split(':').map(Number);
    const d = new Date(0);
    d.setUTCHours(h ?? 0, m ?? 0, s ?? 0, 0);
    return d;
  }
}
