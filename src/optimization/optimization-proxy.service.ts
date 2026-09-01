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
import type {
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
  AnonymousConstraint,
  AiEngineLunch,
  AnonymousFixedLesson,
  AnonymousFrameTime,
  AnonymousGroup,
  AnonymousPreviousLesson,
  AnonymousRequirement,
  AnonymousRoom,
  AnonymousRoomPreference,
  ConstraintKind,
  DayOfWeek,
  ObjectiveWeights,
  ResourceKind,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';

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
    const {
      requirements,
      rooms,
      constraints,
      frameTimes,
      roomPreferences,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
      groupAnonMap,
      storedRules,
    } = await this.prisma.withRls(user, (tx) =>
      this.fetchAndAnonymize(tx, academicYearId, requireSchoolId(user)),
    );

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
      roomPreferences,
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
        ? await this.callAiEngine(payload)
        : { requestId, status: 'FEASIBLE', lessons: [], conflicts: null };

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
      ),
    );

    this.logger.log(
      `Optimization complete [requestId=${requestId}, status=${response.status}, ` +
        `lessons=${response.lessons.length}, lunches=${response.lunches?.length ?? 0}]`,
    );

    // The sittings leave this method carrying REAL group ids. Everything the
    // engine sees is anonymised, so a caller handed the raw reply would get
    // uuids that exist in no table — the same unactionable shape the engine's
    // own conflict messages still have.
    return { ...response, lunches: this.realiseLunches(response, groupAnonMap) };
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
  ): AiEngineLunch[] {
    if (!response.lunches?.length) return [];

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
    roomPreferences: AnonymousRoomPreference[];
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
        // Never forwarded — the engine has no notion of weeks. Read here
        // because the subtraction below compares a preserved lesson's weeks
        // against these, and stamped on the lessons the run produces so a
        // spring-only requirement yields spring-only lessons.
        recurrence: true,
        startDate: true,
        endDate: true,
        subject: { select: { requiredRoomTypeId: true } },
      },
    });

    // See PRESERVED_FROM_REGENERATION: these are the lessons regeneration must
    // not touch and must plan around. Those that cover a requirement's whole
    // period are subtracted from its weekly demand, so the solver re-places
    // only the machine-owned remainder.
    const preservedLessons = await tx.masterLesson.findMany({
      where: { academicYearId, OR: PRESERVED_FROM_REGENERATION },
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
      },
    });

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
    const scheduledGroupIds = [
      ...new Set([
        ...rawRequirements.map((r) => r.studentGroupId),
        ...preservedLessons.map((lesson) => lesson.studentGroupId),
        ...preservedLessons.flatMap((lesson) =>
          lesson.extraGroups.map((entry) => entry.studentGroupId),
        ),
      ]),
    ];
    const [homeMembers, teachingMembers] = await Promise.all([
      tx.user.findMany({
        where: {
          role: 'STUDENT',
          isActive: true,
          studentGroupId: { in: scheduledGroupIds },
        },
        select: { id: true, studentGroupId: true },
      }),
      tx.studentGroupMember.findMany({
        where: {
          studentGroupId: { in: scheduledGroupIds },
          student: { role: 'STUDENT', isActive: true },
        },
        select: { studentId: true, studentGroupId: true },
      }),
    ]);

    const groupsByStudent = new Map<string, Set<string>>();
    const membersByGroup = new Map<string, Set<string>>();
    const link = (studentId: string, groupId: string | null) => {
      if (!groupId) return;
      let groups = groupsByStudent.get(studentId);
      if (!groups) groupsByStudent.set(studentId, (groups = new Set()));
      groups.add(groupId);
      let members = membersByGroup.get(groupId);
      if (!members) membersByGroup.set(groupId, (members = new Set()));
      members.add(studentId);
    };
    for (const row of homeMembers) link(row.id, row.studentGroupId);
    for (const row of teachingMembers) link(row.studentId, row.studentGroupId);

    // Room-capacity headcount: distinct students per group across both kinds.
    const sizeByGroup = new Map(
      [...membersByGroup].map(([groupId, members]) => [groupId, members.size]),
    );

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

    /*
     * Year span per scheduled group, for rooms limited to a stage.
     *
     * Derived from the students' HOME classes rather than read off the group:
     * a teaching group carries no gradeLevel of its own, and treating it as
     * unrestricted would let a nionde-group into lågstadiets rooms. A group
     * spanning several years takes the whole span, so a room must cover all of
     * it — half a group in an allowed year is not an allowed placement.
     */
    const involvedStudentIds = [...groupsByStudent.keys()];
    const [studentHomeClasses, allGroups] = await Promise.all([
      involvedStudentIds.length > 0
        ? tx.user.findMany({
            where: { id: { in: involvedStudentIds } },
            select: { id: true, studentGroupId: true },
          })
        : Promise.resolve([] as { id: string; studentGroupId: string | null }[]),
      tx.studentGroup.findMany({
        where: { academicYearId },
        select: { id: true, gradeLevel: true },
      }),
    ]);
    const gradeOfGroup = new Map(allGroups.map((g) => [g.id, g.gradeLevel]));
    const homeClassOf = new Map(
      studentHomeClasses.map((student) => [student.id, student.studentGroupId]),
    );

    const gradeSpanByGroup = new Map<string, { min: number; max: number }>();
    // Every scheduled group, not only those with members: a class created
    // before its students are enrolled still carries its own year, and
    // skipping it would let 7B into lågstadiets rooms until somebody adds the
    // first student.
    for (const groupId of scheduledGroupIds) {
      const members = membersByGroup.get(groupId) ?? new Set<string>();
      const grades: number[] = [];
      for (const studentId of members) {
        const homeClass = homeClassOf.get(studentId);
        const grade = homeClass ? gradeOfGroup.get(homeClass) : null;
        if (typeof grade === 'number') grades.push(grade);
      }
      // No members with a year — fall back to the group's own, and leave it
      // unset when there is none at all rather than inventing one.
      if (grades.length === 0) {
        const own = gradeOfGroup.get(groupId);
        if (typeof own === 'number') grades.push(own);
      }
      if (grades.length > 0) {
        gradeSpanByGroup.set(groupId, {
          min: Math.min(...grades),
          max: Math.max(...grades),
        });
      }
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
      return [
        {
          id: anonId(requirementAnonMap, r.id),
          subjectId: anonId(subjectAnonMap, r.subjectId),
          studentGroupId: anonId(groupAnonMap, r.studentGroupId),
          teacherId: r.teacherId ? anonId(teacherAnonMap, r.teacherId) : null,
          lessonsPerWeek: remaining,
          minutesPerLesson: r.minutesPerLesson,
          studentGroupSize: Math.max(1, sizeByGroup.get(r.studentGroupId) ?? 1),
          minGradeLevel: gradeSpanByGroup.get(r.studentGroupId)?.min ?? null,
          maxGradeLevel: gradeSpanByGroup.get(r.studentGroupId)?.max ?? null,
          requiredRoomType: r.subject.requiredRoomTypeId
            ? anonId(roomTypeAnonMap, r.subject.requiredRoomTypeId)
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
    const groups: AnonymousGroup[] = scheduledGroupIds.map((groupId) => ({
      id: anonId(groupAnonMap, groupId),
      lunchHeadcount: homeCountByGroup.get(groupId) ?? 0,
    }));

    // Fetch rooms (drop name, code — capacity and type are non-PII enums/numbers).
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
      },
    });

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

    const roomPreferences: AnonymousRoomPreference[] = rawPreferences.map((p) => ({
      id: anonId(requirementAnonMap, p.id),
      subjectId: anonId(subjectAnonMap, p.subjectId),
      roomType: p.roomTypeId ? anonId(roomTypeAnonMap, p.roomTypeId) : null,
      // Only rooms the payload actually carries: a wish naming a room that is
      // no longer scheduled would point at nothing the engine can see.
      roomIds: p.rooms
        .map((entry) => roomAnonMap.get(entry.roomId))
        .filter((id): id is string => Boolean(id)),
      weight: p.weight,
    }));

    // Fetch availability constraints (drop reason text field).
    const rawConstraints = await tx.availabilityConstraint.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
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
          id: randomUUID(),
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
      },
    });

    const frameTimes: AnonymousFrameTime[] = rawFrames.map((frame) => ({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek as DayOfWeek | null,
      startTime: this.timeToString(frame.startTime),
      endTime: this.timeToString(frame.endTime),
    }));

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
      roomPreferences,
      fixedLessons,
      groups,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
      groupAnonMap,
      // An empty object would send `rules: {}` and read as "rules were
      // considered and came to nothing", which the engine treats the same but
      // a reader of the payload would not.
      storedRules:
        storedRules !== null && Object.keys(storedRules).length > 0
          ? storedRules
          : null,
    };
  }

  private async callAiEngine(
    payload: AiEngineScheduleRequest,
  ): Promise<AiEngineScheduleResponse> {
    const url = `${this.aiConfig.baseUrl}/v1/schedule`;

    try {
      const response = await firstValueFrom(
        this.http
          .post<AiEngineScheduleResponse>(url, payload, {
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
                const body = error.response.data as { message?: unknown } | null;
                const detail =
                  error.response.status < 500 && typeof body?.message === 'string'
                    ? body.message
                    : 'The AI engine returned an error.';
                throw new HttpException(detail, error.response.status);
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
