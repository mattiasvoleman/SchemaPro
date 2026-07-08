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
  AnonymousRequirement,
  AnonymousRoom,
  ConstraintKind,
  DayOfWeek,
  ResourceKind,
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
    };

    // Step 2: Call the AI engine with the stripped payload.
    const response = await this.callAiEngine(payload);

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
    roomAnonMap: Map<string, string>;
    requirementAnonMap: Map<string, string>;
  }> {
    // Anonymous-id lookup tables: realId → anonId.
    const teacherAnonMap = new Map<string, string>();
    const roomAnonMap = new Map<string, string>();
    const groupAnonMap = new Map<string, string>();
    const subjectAnonMap = new Map<string, string>();
    const requirementAnonMap = new Map<string, string>();

    const anonId = (map: Map<string, string>, realId: string): string => {
      const existing = map.get(realId);
      if (existing) return existing;
      const id = randomUUID();
      map.set(realId, id);
      return id;
    };

    // Fetch teaching requirements (no PII fields selected).
    const rawRequirements = await tx.teachingRequirement.findMany({
      where: { academicYearId },
      select: {
        id: true,
        subjectId: true,
        studentGroupId: true,
        teacherId: true,
        lessonsPerWeek: true,
        minutesPerLesson: true,
      },
    });

    // Group headcounts (an aggregate, not PII) enable room-capacity checks.
    const groupSizes = await tx.user.groupBy({
      by: ['studentGroupId'],
      where: {
        role: 'STUDENT',
        isActive: true,
        studentGroupId: { in: rawRequirements.map((r) => r.studentGroupId) },
      },
      _count: { _all: true },
    });
    const sizeByGroup = new Map(
      groupSizes.map((row) => [row.studentGroupId, row._count._all]),
    );

    const requirements: AnonymousRequirement[] = rawRequirements.map((r) => ({
      id: anonId(requirementAnonMap, r.id),
      subjectId: anonId(subjectAnonMap, r.subjectId),
      studentGroupId: anonId(groupAnonMap, r.studentGroupId),
      teacherId: r.teacherId ? anonId(teacherAnonMap, r.teacherId) : null,
      lessonsPerWeek: r.lessonsPerWeek,
      minutesPerLesson: r.minutesPerLesson,
      studentGroupSize: Math.max(1, sizeByGroup.get(r.studentGroupId) ?? 1),
    }));

    // Fetch rooms (drop name, code — keep only capacity and type-agnostic size).
    const rawRooms = await tx.room.findMany({
      where: {
        school: {
          academicYears: { some: { id: academicYearId } },
        },
      },
      select: { id: true, capacity: true },
    });

    const rooms: AnonymousRoom[] = rawRooms.map((r) => ({
      id: anonId(roomAnonMap, r.id),
      capacity: r.capacity,
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

    return {
      requirements,
      rooms,
      constraints,
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
    if (response.status === 'INFEASIBLE') {
      this.logger.warn(
        `AI engine returned INFEASIBLE for academicYearId=${academicYearId}. No master lessons written.`,
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
      },
    });
    const reqById = new Map(requirementDetails.map((r) => [r.id, r]));

    // Delete any existing master lessons for this academic year before writing
    // the new schedule so we don't accumulate stale records.
    await tx.masterLesson.deleteMany({ where: { academicYearId } });

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
            roomId: realRoom ?? null,
            dayOfWeek: lesson.dayOfWeek,
            startTime: this.parseTime(lesson.startTime),
            endTime: this.parseTime(lesson.endTime),
          },
        }),
      ];
    });

    await Promise.all(creates);
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
