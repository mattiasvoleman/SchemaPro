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
import { PrismaService } from '../database/prisma.service';
import type {
  AiEngineScheduleRequest,
  AiEngineScheduleResponse,
  AnonymousConstraint,
  AnonymousFixedLesson,
  AnonymousPreviousLesson,
  AnonymousRequirement,
  AnonymousRoom,
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
    // teacherAnonMap / groupAnonMap / subjectAnonMap are produced by
    // fetchAndAnonymize but only requirementAnonMap and roomAnonMap are needed
    // to reverse-map the AI engine's response back to real DB ids.
    const {
      requirements,
      rooms,
      constraints,
      fixedLessons,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
    } = await this.prisma.withRls(user, (tx) =>
      this.fetchAndAnonymize(tx, academicYearId),
    );

    const payload: AiEngineScheduleRequest = {
      requestId,
      academicYearId,
      requirements,
      rooms,
      constraints,
      fixedLessons,
      previousLessons,
      groupConflicts,
      ...(weights ? { weights } : {}),
      ...(rules ? { rules } : {}),
    };

    // Step 2: Call the AI engine with the stripped payload. When every
    // requirement is already covered by locked lessons there is nothing left
    // to solve — skip the engine and just clean up unlocked leftovers.
    const response: AiEngineScheduleResponse =
      requirements.length > 0
        ? await this.callAiEngine(payload)
        : { requestId, status: 'FEASIBLE', lessons: [], conflicts: null };

    // Step 3: Persist the master-lesson output, translating anon ids back.
    await this.prisma.withRls(user, (tx) =>
      this.persistMasterLessons(
        tx,
        academicYearId,
        user,
        response,
        requirementAnonMap,
        roomAnonMap,
      ),
    );

    this.logger.log(
      `Optimization complete [requestId=${requestId}, status=${response.status}, lessons=${response.lessons.length}]`,
    );

    return response;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async fetchAndAnonymize(
    tx: PrismaClient,
    academicYearId: string,
  ): Promise<{
    requirements: AnonymousRequirement[];
    rooms: AnonymousRoom[];
    constraints: AnonymousConstraint[];
    fixedLessons: AnonymousFixedLesson[];
    previousLessons: AnonymousPreviousLesson[];
    groupConflicts: [string, string][];
    roomAnonMap: Map<string, string>;
    requirementAnonMap: Map<string, string>;
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
        subject: { select: { requiredRoomTypeId: true } },
      },
    });

    // Student -> groups, from BOTH membership kinds: the home class
    // (Users.studentGroupId) and teaching groups (StudentGroupMembers). Only
    // aggregates and id-relations derived from this ever leave this method —
    // student ids themselves are never sent to the engine.
    const scheduledGroupIds = [
      ...new Set(rawRequirements.map((r) => r.studentGroupId)),
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

    // Locked master lessons are immovable, and participant lessons
    // (multi-class / individual students) are manual constructs the generator
    // never recreates — both are forwarded to the engine as fixed placements
    // and preserved by regeneration. Their count is subtracted from the
    // weekly demand of the matching requirement so the solver only re-places
    // the machine-owned remainder.
    const lockedLessons = await tx.masterLesson.findMany({
      where: {
        academicYearId,
        OR: [
          { isLocked: true },
          { extraGroups: { some: {} } },
          { participants: { some: {} } },
        ],
      },
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
        extraGroups: { select: { studentGroupId: true } },
      },
    });

    const lockedCountByDemand = new Map<string, number>();
    for (const lesson of lockedLessons) {
      const key = `${lesson.studentGroupId}:${lesson.subjectId}`;
      lockedCountByDemand.set(key, (lockedCountByDemand.get(key) ?? 0) + 1);
    }

    const requirements: AnonymousRequirement[] = rawRequirements.flatMap((r) => {
      const lockedCount =
        lockedCountByDemand.get(`${r.studentGroupId}:${r.subjectId}`) ?? 0;
      const remaining = r.lessonsPerWeek - lockedCount;
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

    const fixedLessons: AnonymousFixedLesson[] = lockedLessons.map((lesson) => ({
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

    const rooms: AnonymousRoom[] = rawRooms.map((r) => ({
      id: anonId(roomAnonMap, r.id),
      capacity: r.capacity,
      type: r.roomTypeId ? anonId(roomTypeAnonMap, r.roomTypeId) : null,
      minGradeLevel: r.minGradeLevel,
      maxGradeLevel: r.maxGradeLevel,
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
        dayOfWeek: true,
        date: true,
        startTime: true,
        endTime: true,
        type: true,
      },
    });

    const constraints: AnonymousConstraint[] = rawConstraints.map((c) => {
      let resourceId: string;
      if (c.userId) {
        resourceId = anonId(teacherAnonMap, c.userId);
      } else if (c.roomId) {
        resourceId = anonId(roomAnonMap, c.roomId);
      } else if (c.studentGroupId) {
        resourceId = anonId(groupAnonMap, c.studentGroupId);
      } else {
        resourceId = randomUUID();
      }

      return {
        id: randomUUID(),
        resourceKind: c.resourceType as ResourceKind,
        resourceId,
        dayOfWeek: c.dayOfWeek as DayOfWeek | null,
        date: c.date ? c.date.toISOString().slice(0, 10) : null,
        startTime: this.timeToString(c.startTime),
        endTime: this.timeToString(c.endTime),
        kind: c.type as ConstraintKind,
      };
    });

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
      fixedLessons,
      previousLessons,
      groupConflicts,
      roomAnonMap,
      requirementAnonMap,
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
            catchError((error: unknown) => {
              if (error instanceof TimeoutError) {
                throw new ServiceUnavailableException(
                  'The AI engine did not respond in time.',
                );
              }
              if (error instanceof AxiosError) {
                const status = error.response?.status ?? HttpStatus.BAD_GATEWAY;
                throw new HttpException(
                  'The AI engine returned an error.',
                  status,
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

    // Fetch requirement details needed for the MasterLesson record.
    const requirementDetails = await tx.teachingRequirement.findMany({
      where: { academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        coTeacherId: true,
      },
    });
    const reqById = new Map(requirementDetails.map((r) => [r.id, r]));

    // Non-destructive regeneration: locked lessons AND participant lessons
    // (manual multi-class / individual-student constructs) are preserved
    // verbatim; only machine-owned lessons are replaced by the new solution.
    const preservedWhere = {
      OR: [
        { isLocked: true },
        { extraGroups: { some: {} } },
        { participants: { some: {} } },
      ],
    };
    const { count: removedUnlocked } = await tx.masterLesson.deleteMany({
      where: { academicYearId, NOT: preservedWhere },
    });
    const lockedPreserved = await tx.masterLesson.count({
      where: { academicYearId, ...preservedWhere },
    });

    const creates = response.lessons.flatMap((lesson) => {
      const realReqId = realRequirementId.get(lesson.requirementId);
      if (!realReqId) return [];
      const req = reqById.get(realReqId);
      if (!req) return [];

      const realRoom = lesson.roomId ? realRoomId.get(lesson.roomId) : null;

      return [
        tx.masterLesson.create({
          data: {
            schoolId: user.schoolId as string,
            academicYearId,
            subjectId: req.subjectId,
            studentGroupId: req.studentGroupId,
            teacherId: req.teacherId ?? null,
            coTeacherId: req.coTeacherId ?? null,
            roomId: realRoom ?? null,
            dayOfWeek: lesson.dayOfWeek,
            startTime: this.parseTime(lesson.startTime),
            endTime: this.parseTime(lesson.endTime),
          },
        }),
      ];
    });

    await Promise.all(creates);

    // Append a REGENERATE entry to the schedule audit trail.
    await tx.scheduleChangeLog.create({
      data: {
        schoolId: user.schoolId,
        academicYearId,
        masterLessonId: null,
        actorId: user.userId ?? null,
        action: 'REGENERATE',
        after: {
          solverStatus: response.status,
          lessonsCreated: creates.length,
          unlockedReplaced: removedUnlocked,
          lockedPreserved,
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
