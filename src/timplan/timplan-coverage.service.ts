import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import {
  computePlannedCoverage,
  type PlannedCoverage,
  type PlannedCoverageInput,
  type PlannedPupilInput,
  type PlannedVerdict,
} from '../common/timplan-planned';
import {
  computeScheduledCoverage,
  type ScheduledCoverage,
  type ScheduledLessonInput,
  type ScheduledVerdict,
} from '../common/timplan-scheduled';
import type { TimplanCoverageQueryDto } from './dto/timplan-coverage.dto';
import { describePlannedVerdict } from './timplan-planned-messages';
import { describeScheduledVerdict } from './timplan-scheduled-messages';
import { readHomePupils, rostersOfYear, type RosterViewer } from '../year-rollover/projected-rosters';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null): string | null => (value === null ? null : asDay(value));

/** A @db.Time back out as the wall clock it is, "HH:MM". */
const asClock = (value: Date): string => value.toISOString().slice(11, 16);

/** The layer-2 document, each verdict with its Swedish sentence. */
export interface ScheduledCoverageResponse extends Omit<ScheduledCoverage, 'verdicts'> {
  academicYearId: string;
  layer: 'scheduled';
  verdicts: (ScheduledVerdict & { message: string })[];
}

/** The layer-1 document, each verdict with its Swedish sentence. */
export interface TimplanCoverageResponse extends Omit<PlannedCoverage, 'verdicts'> {
  academicYearId: string;
  layer: 'planned';
  verdicts: (PlannedVerdict & { message: string })[];
}

/**
 * Timplanstäckning, layer 1: planerat mot timplan for one läsår.
 *
 * EVERY ROW IS READ UNDER THE CALLER'S RLS, IN ONE TRANSACTION, then handed to
 * the pure module (src/common/timplan-planned.ts) — the same arithmetic the
 * web's Mål mode repaints with. Nothing is stored: a requirement saved a
 * second ago is in the next answer.
 *
 * THE ROLE SPLIT. SCHOOL_ADMIN gets the pupil level: the listed pupils, the
 * per-class min/median/max and the pupil verdicts. TEACHER gets the group level
 * only — the module's includePupils false strips every pupil id, figure and
 * verdict. A teacher's coverage is still COMPUTED from the pupils (a class
 * carried by its språkval groups is covered when every pupil is), from
 * memberships the staff arms already let a teacher read; only the answer is
 * narrower.
 *
 * PUPIL IDS ONLY, NEVER NAMES. The response names no pupil — the web resolves
 * ids against the people it already holds — and nothing here logs one.
 *
 * Deactivated pupils are left out: a pupil who has left the school is not
 * under anybody's timplan.
 */
@Injectable()
export class TimplanCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  async planned(
    query: TimplanCoverageQueryDto,
    user: AuthenticatedUser,
  ): Promise<TimplanCoverageResponse> {
    requireSchoolId(user);
    if (query.studentGroupId !== undefined) {
      // P2's answer has one shape, and it has no drill-down to give.
      throw new BadRequestException(
        "studentGroupId: gäller lagren 'scheduled' och 'delivered'; planerat mot timplan har ingen elevvy per grupp.",
      );
    }
    const includePupils = user.role === Role.SCHOOL_ADMIN;
    const input = await this.prisma.withRls(user, (tx) =>
      readPlannedInput(tx, user, query.academicYearId, includePupils),
    );
    if (!input) throw new NotFoundException('Läsåret finns inte.');
    const coverage = computePlannedCoverage(input);
    return {
      academicYearId: query.academicYearId,
      layer: 'planned',
      ...coverage,
      verdicts: coverage.verdicts.map((verdict) => ({
        ...verdict,
        message: describePlannedVerdict(verdict),
      })),
    };
  }

  /** Layer 2 — see readScheduledInput for what is read and who sees what. */
  async scheduled(
    query: TimplanCoverageQueryDto,
    user: AuthenticatedUser,
  ): Promise<ScheduledCoverageResponse> {
    requireSchoolId(user);
    const includePupils = user.role === Role.SCHOOL_ADMIN;
    const input = await this.prisma.withRls(user, (tx) =>
      readScheduledInput(tx, user, query.academicYearId, includePupils),
    );
    if (!input) throw new NotFoundException('Läsåret finns inte.');
    const { planned, lessons } = input;
    const coverage = computeScheduledCoverage({
      year: planned.year,
      closures: planned.closures,
      subjects: planned.subjects,
      groups: planned.groups,
      requirements: planned.requirements,
      lessons,
      pupils: planned.pupils,
      includePupils,
      drillGroupId: includePupils ? (query.studentGroupId ?? null) : null,
    });
    return {
      academicYearId: query.academicYearId,
      layer: 'scheduled',
      ...coverage,
      verdicts: coverage.verdicts.map((verdict) => ({
        ...verdict,
        message: describeScheduledVerdict(verdict),
      })),
    };
  }
}

/**
 * Layer 2, schemalagt mot planerat: the year's grundschema against its
 * timplansposter (src/common/timplan-scheduled.ts). P2's rows and rosters
 * through readPlannedInput, unchanged, plus the year's master lessons — parked
 * ones included, for the tray's minutes — in the same transaction.
 *
 * The roles as layer 1: SCHOOL_ADMIN gets the pupil level and, with
 * studentGroupId, every pupil of that group; TEACHER gets the group level,
 * studentGroupId or not (includePupils false strips every pupil id). No
 * timplan is needed — target columns belong to layer 1 — and a year without a
 * grundschema answers 200 with TIMPLAN_SCHEDULE_NONE.
 */
export async function readScheduledInput(
  tx: Prisma.TransactionClient,
  viewer: RosterViewer,
  academicYearId: string,
  includePupils: boolean,
): Promise<{ planned: PlannedCoverageInput; lessons: ScheduledLessonInput[] } | null> {
  const planned = await readPlannedInput(tx, viewer, academicYearId, includePupils);
  if (!planned) return null;
  const rows = await tx.masterLesson.findMany({
    where: { academicYearId },
    select: {
      id: true,
      studentGroupId: true,
      subjectId: true,
      startTime: true,
      endTime: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      isParked: true,
      extraGroups: { select: { studentGroupId: true } },
      participants: { select: { studentId: true } },
    },
    orderBy: { id: 'asc' },
  });
  return {
    planned,
    lessons: rows.map((row) => ({
      id: row.id,
      studentGroupId: row.studentGroupId,
      subjectId: row.subjectId,
      startTime: asClock(row.startTime),
      endTime: asClock(row.endTime),
      recurrence: row.recurrence,
      startDate: asDayOrNull(row.startDate),
      endDate: asDayOrNull(row.endDate),
      isParked: row.isParked,
      extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId),
      studentIds: row.participants.map((entry) => entry.studentId),
    })),
  };
}

/**
 * The year's rows, as the pure module wants them. Null when RLS hides the
 * year. One statement after another in the caller's transaction (a
 * transaction is one connection; see load-input.ts on Promise.all).
 */
export async function readPlannedInput(
  tx: Prisma.TransactionClient,
  viewer: RosterViewer,
  academicYearId: string,
  includePupils: boolean,
): Promise<PlannedCoverageInput | null> {
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { startDate: true, endDate: true, isActive: true, predecessorId: true },
  });
  if (!year) return null;
  // The pupils as the year's activation would place them, for a rolled year
  // not yet activated (projected-rosters.ts); the active year asks nothing more.
  const basis = await rostersOfYear(tx, viewer, academicYearId, year);

  const attachments = await tx.academicYearTimplan.findMany({
    where: { academicYearId },
    select: { gradeLevel: true, localTimplanId: true },
  });
  const planIds = [...new Set(attachments.map((row) => row.localTimplanId))];
  const plans =
    planIds.length === 0
      ? []
      : await tx.localTimplan.findMany({
          where: { id: { in: planIds } },
          select: {
            id: true,
            name: true,
            status: true,
            entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true } },
          },
        });
  const subjects = await tx.subject.findMany({
    select: { id: true, name: true, nationalCode: true, countsTowardTimplan: true },
  });
  const groups = await tx.studentGroup.findMany({
    where: { academicYearId },
    select: { id: true, name: true, kind: true, gradeLevel: true },
  });
  const requirements = await tx.teachingRequirement.findMany({
    where: { academicYearId },
    select: {
      id: true,
      studentGroupId: true,
      subjectId: true,
      lessonsPerWeek: true,
      minutesPerLesson: true,
      lessonLengths: true,
      recurrence: true,
      startDate: true,
      endDate: true,
    },
    orderBy: { id: 'asc' },
  });
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId },
    select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
  });

  const classIds = groups.filter((g) => g.kind === 'CLASS').map((g) => g.id);
  const teachingIds = groups.filter((g) => g.kind === 'TEACHING_GROUP').map((g) => g.id);
  const homes =
    classIds.length === 0
      ? []
      : await readHomePupils(tx, basis, { role: 'STUDENT', isActive: true }, classIds);
  const memberships =
    teachingIds.length === 0
      ? []
      : await tx.studentGroupMember.findMany({
          where: { studentGroupId: { in: teachingIds }, student: { isActive: true } },
          select: { studentId: true, studentGroupId: true },
        });

  const pupils = new Map<string, PlannedPupilInput>();
  for (const row of homes) {
    pupils.set(row.id, { id: row.id, homeGroupId: row.studentGroupId, groupIds: [] });
  }
  for (const row of memberships) {
    const pupil = pupils.get(row.studentId) ?? { id: row.studentId, homeGroupId: null, groupIds: [] };
    pupil.groupIds.push(row.studentGroupId);
    pupils.set(row.studentId, pupil);
  }

  return {
    year: { startDate: asDay(year.startDate), endDate: asDay(year.endDate) },
    closures: breaks.map((row) => ({
      startDate: asDay(row.startDate),
      endDate: asDay(row.endDate),
      minGradeLevel: row.minGradeLevel,
      maxGradeLevel: row.maxGradeLevel,
    })),
    plans,
    attachments,
    subjects,
    groups,
    requirements: requirements.map((row) => ({
      ...row,
      startDate: asDayOrNull(row.startDate),
      endDate: asDayOrNull(row.endDate),
    })),
    pupils: [...pupils.values()],
    includePupils,
  };
}
