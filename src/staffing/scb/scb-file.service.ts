import { Injectable, NotFoundException } from '@nestjs/common';
import type { SchoolForm } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { recordRead } from '../../access-log/access-log';
import { PrismaService } from '../../database/prisma.service';
import { requireSchoolId } from '../../common/utils/request-context';
import { todayInZone, zonedTimeToUtc } from '../../common/utils/time';
import { addDays } from '../../common/year-rollover';
import { dayOf } from '../duty-dates';
import { readLoadInput } from '../load-input';
import { buildTeacherLoadReport } from '../teacher-load';
import {
  buildScbFile,
  inScbFile,
  longAbsenceOf,
  scbMatdatum,
  type ScbAbsence,
  type ScbFile,
  type ScbTeacher,
} from './scb-pedpers';

/**
 * GET /staffing/scb-file: SCB:s Pedagogisk personal for one läsår, built by
 * scb-pedpers.ts from what this reads in ONE RLS transaction as the admin:
 *
 *   1. readLoadInput, the load report's own reader, and the report built from
 *      it: the planned teaching per teacher and each post with its periods,
 *      its anställningsform and its karriärtjänst (one statement for the
 *      post's figures and its SCB fields);
 *   2. the year's name and the school's name and timezone (the download day
 *      is the school's, column 2);
 *   3. the year's förstelärare uppdrag, with their dates;
 *   4. the subjects the teaching is in (their national codes are the SCB
 *      columns), the year's timplans by årskurs (the verksamhetstyp), and the
 *      school's skolenheter;
 *   5. the teachers' names and roles, and whether each account is active:
 *      a post outlives its account, and the file names the person whose
 *      account was closed, for the school to say whether they still worked
 *      on the mätdatum;
 *   6. their registered absences over the läsår, dates only: a stretch of
 *      30 days or more over the mätdatum is named, records that follow on
 *      from each other joined, since SCB counts a whole such leave as L and
 *      SchemaPro reads L from the post alone.
 *
 * Then, in the same transaction, the läslogg: every teacher the file names,
 * EMPLOYMENT (their post, its form and its karriärtjänst) and PEOPLE (their
 * name, which the gateway now hands out with them), and STAFF_ABSENCES for
 * each whose long absence the file names. Written before the response
 * leaves, so a file is never delivered unrecorded.
 *
 * Admin only (the controller). The load report's own läslogg is not written
 * here: this route records what it hands out, once.
 */
@Injectable()
export class ScbFileService {
  constructor(private readonly prisma: PrismaService) {}

  async build(academicYearId: string, user: AuthenticatedUser, now: Date = new Date()): Promise<ScbFile> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const read = await readLoadInput(tx, user, academicYearId, schoolId);
      if (!read) throw new NotFoundException('Academic year not found.');
      const report = buildTeacherLoadReport(read.input);

      const yearRow = await tx.academicYear.findUnique({
        where: { id: academicYearId },
        select: { name: true, school: { select: { name: true, timezone: true } } },
      });
      if (!yearRow) throw new NotFoundException('Academic year not found.');

      const duties = await tx.teacherDuty.findMany({
        where: { academicYearId, kind: 'FORSTELARARE' },
        select: { userId: true, validFrom: true, validTo: true },
      });
      const subjectIds = [...new Set(report.teachers.flatMap((row) => row.assignments.map((a) => a.subjectId)))];
      const subjects =
        subjectIds.length > 0
          ? await tx.subject.findMany({
              where: { id: { in: subjectIds } },
              select: { id: true, nationalCode: true, code: true, name: true },
            })
          : [];
      const timplans = await tx.academicYearTimplan.findMany({
        where: { academicYearId },
        select: { gradeLevel: true, localTimplan: { select: { schoolForm: true } } },
      });
      const units = await tx.schoolUnit.findMany({
        where: { schoolId },
        select: { id: true, name: true, code: true, gradeFrom: true, gradeTo: true },
      });

      const teachers: ScbTeacher[] = report.teachers.map((row) => {
        const scb = read.scbPostOf(row.userId);
        return {
          userId: row.userId,
          assignments: row.assignments,
          employment:
            row.employment === null
              ? null
              : {
                  ...row.employment,
                  employmentForm: scb?.employmentForm ?? null,
                  firstTeacherPercent: scb?.firstTeacherPercent ?? null,
                  lecturerPercent: scb?.lecturerPercent ?? null,
                },
        };
      });
      const named = teachers.filter(inScbFile).map((row) => row.userId);
      const users =
        named.length > 0
          ? await tx.user.findMany({
              where: { id: { in: named } },
              select: { id: true, firstName: true, lastName: true, role: true, isActive: true, deactivatedAt: true },
            })
          : [];

      const timezone = yearRow.school?.timezone ?? 'Europe/Stockholm';
      /** The school's day an instant falls on. */
      const dayIn = (at: Date): string => dayOf(todayInZone(timezone, at))!;
      const matdatum = scbMatdatum(read.year.startDate);
      // The läsår (and the mätdatum, should a year not hold it) as the
      // school's days: every record a stretch over the mätdatum can be
      // joined from, [first 00:00, the day after the last 00:00).
      const first = matdatum < read.year.startDate ? matdatum : read.year.startDate;
      const last = matdatum > read.year.endDate ? matdatum : read.year.endDate;
      const over = {
        start: zonedTimeToUtc(first, '00:00', timezone),
        end: zonedTimeToUtc(addDays(last, 1), '00:00', timezone),
      };
      const absences: ScbAbsence[] =
        named.length > 0
          ? (
              await tx.teacherAbsence.findMany({
                where: { userId: { in: named }, status: 'ACTIVE', startsAt: { lt: over.end }, endsAt: { gt: over.start } },
                select: { userId: true, startsAt: true, endsAt: true },
              })
            ).map((absence) => ({
              userId: absence.userId,
              from: dayIn(absence.startsAt),
              // An end at midnight closes the day before it.
              to: dayIn(new Date(absence.endsAt.getTime() - 1)),
            }))
          : [];
      const file = buildScbFile({
        exportDate: dayIn(now),
        year: { name: yearRow.name, startDate: read.year.startDate, endDate: read.year.endDate },
        schoolName: yearRow.school?.name ?? '',
        teachers,
        firstTeacherDuties: duties.map((duty) => ({
          userId: duty.userId,
          validFrom: dayOf(duty.validFrom),
          validTo: dayOf(duty.validTo),
        })),
        subjects,
        schoolFormByGrade: new Map<number, SchoolForm>(
          timplans.map((row) => [row.gradeLevel, row.localTimplan.schoolForm]),
        ),
        people: new Map(
          users.map((person) => [
            person.id,
            {
              firstName: person.firstName,
              lastName: person.lastName,
              ...(person.isActive !== false ? {} : { inactiveSince: person.deactivatedAt ? dayIn(person.deactivatedAt) : null }),
            },
          ]),
        ),
        adminIds: new Set(users.filter((person) => person.role === 'SCHOOL_ADMIN').map((person) => person.id)),
        units,
        absences,
      });

      await recordRead(tx, 'EMPLOYMENT', named, user.channel);
      await recordRead(tx, 'PEOPLE', named, user.channel);
      await recordRead(
        tx,
        'STAFF_ABSENCES',
        named.filter((userId) => longAbsenceOf(absences, userId, matdatum) !== undefined),
        user.channel,
      );
      return file;
    });
  }
}
