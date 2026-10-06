import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma, type LessonRecurrence, type TeacherContractKind } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { parseDateString } from '../common/utils/time';
import { readYearBoundsForShare } from '../resources/academic-year-bounds';
import {
  normalizeNationalCode,
  unknownNationalCodeMessage,
} from '../resources/national-codes';
import { UsersService } from '../users/users.service';
import type {
  ImportGroupsDto,
  ImportMembershipsDto,
  ImportReport,
  ImportRequirementsDto,
  ImportRoomTypesDto,
  ImportSubjectsDto,
  ImportStudentsDto,
  ImportTeacherQualificationsDto,
  ImportTeacherRowDto,
  ImportTeachersDto,
} from './dto/import.dto';

/**
 * Everything a timplan row states about a requirement — that is, every column
 * except the two that identify it (group and subject). Named because it is
 * written twice: once as the data of a create or an update, once as the thing
 * an existing row is compared against to decide updated-versus-skipped.
 */
/**
 * What a timplan row is worth writing.
 *
 * The two sizing fields are always written — every file must carry them. The
 * other seven are written only when the FILE had that column, so the type makes
 * them optional and `requirementIsUnchanged` compares only what is there.
 */
type RequirementValues = {
  teacherId?: string | null;
  coTeacherId?: string | null;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  /** The pupils' ombyte and dusch, outside the lesson; 0 when nobody wrote one. */
  minutesBefore?: number;
  minutesAfter?: number;
  recurrence?: LessonRecurrence;
  startDate?: Date | null;
  endDate?: Date | null;
};

/** A stored row, which always has all nine. */
type StoredRequirementValues = Required<RequirementValues>;

/**
 * CSV import: people, classes, teaching-group memberships and the timplan in
 * bulk.
 *
 * Semantics are ROW-WISE with idempotent re-upload, not all-or-nothing. A
 * school's import file is fixed iteratively — upload, read the report, fix the
 * flagged rows, upload again — so a row that already exists lands in `skipped`
 * (never `errors`), and a failing row never blocks the 400 valid rows around
 * it. All-or-nothing would also be a false promise for people imports: the
 * Supabase invite that precedes each insert is an external side effect no
 * database rollback can undo.
 *
 * People rows reuse UsersService.create wholesale — invite-then-persist,
 * placeholder fallback, the students-only group rule — so import and the
 * one-by-one dialog cannot drift apart.
 *
 * `importRequirements` is the one kind that also UPDATES; the reasoning is on
 * the method.
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  /**
   * Teachers, and — when the file carries the columns — their posts for the
   * active läsår.
   *
   * THE PEOPLE HALF IS WHAT IT WAS: every row goes through UsersService.create,
   * a known email is `skipped`, nobody is emailed. THE POST HALF UPDATES, like
   * the timplan import and for the same reason: tjänstgöringsgrad is a figure a
   * school corrects in the spreadsheet and uploads again, and a create-only
   * second upload would discard every correction under a report saying "0
   * fel". A row whose person already existed and whose post the file changes
   * therefore moves from `skipped` to `updated`; a row whose post the file
   * states as it already is stays `skipped`. created + skipped + updated +
   * errors still accounts for every row.
   *
   * THE ACTIVE YEAR, not a posted one: the staff dialog has no year picker and
   * a staff list is not a year's document — the year is the one the school is
   * planning. No active year is a row error on every row that states a post,
   * and those rows are then NOT imported as people either: a row half written
   * cannot be finished by uploading the same file again, which is the one
   * repair this import promises.
   *
   * The post rows are validated BEFORE anybody is created — nedsättning inside
   * tjänsten, a post stated at all when any of its columns is, the signature
   * free in the year and in the file — so a bad cell never leaves a person
   * behind with no post. The one check that cannot run first is the race on the
   * signature index itself; a P2002 at the write is reported on the row, with
   * the person standing.
   */
  async importTeachers(
    dto: ImportTeachersDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user); // 403 up front, same contract as the sibling methods

    const posts = dto.rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => statesAPost(row));
    if (posts.length === 0) {
      return this.importPeople(
        dto.rows.map((row) => ({ ...row, studentGroupId: undefined })),
        'TEACHER',
        user,
      );
    }

    const errors: ImportReport['errors'] = [];
    const refused = new Set<number>();
    const refuse = (index: number, message: string) => {
      refused.add(index);
      errors.push({ row: index + 1, message });
    };

    for (const { row, index } of posts) {
      const problem = describePostProblem(row);
      if (problem) refuse(index, problem);
    }

    // What the year and the table already hold, read once before anybody is
    // created. The staff read is also what tells created from skipped below.
    const emails = [...new Set(dto.rows.map((row) => row.email.trim().toLowerCase()))];
    const { year, staffByEmail, signatureOwner } = await this.prisma.withRls(user, async (tx) => {
      const activeYear = await tx.academicYear.findFirst({
        where: { isActive: true },
        select: { id: true, name: true },
      });
      const staff = await tx.user.findMany({
        where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, email: { in: emails, mode: 'insensitive' } },
        select: { id: true, email: true },
      });
      const held = activeYear
        ? await tx.teacherEmployment.findMany({
            where: { academicYearId: activeYear.id, signature: { not: null } },
            select: { userId: true, signature: true },
          })
        : [];
      return {
        year: activeYear,
        staffByEmail: new Map(staff.map((person) => [person.email.toLowerCase(), person.id])),
        signatureOwner: new Map(held.map((post) => [post.signature as string, post.userId])),
      };
    });

    if (!year) {
      for (const { index } of posts) {
        if (!refused.has(index)) {
          refuse(
            index,
            'Inget läsår är aktivt. Aktivera ett läsår under Läsår innan tjänster importeras, eller ta bort tjänstekolumnerna.',
          );
        }
      }
    } else {
      // A signature held by somebody else this year, in the table or earlier
      // in the file, is a clash the index would refuse as an unreadable 500.
      const signatureInFile = new Map<string, { email: string; row: number }>();
      for (const { row, index } of posts) {
        if (refused.has(index)) continue;
        const signature = row.signature?.trim();
        if (!signature) continue;
        const email = row.email.trim().toLowerCase();
        const owner = signatureOwner.get(signature);
        if (owner !== undefined && owner !== staffByEmail.get(email)) {
          refuse(
            index,
            `Signaturen "${signature}" används redan av en annan lärare läsåret ${year.name}. Välj en annan signatur.`,
          );
          continue;
        }
        const earlier = signatureInFile.get(signature);
        if (earlier && earlier.email !== email) {
          refuse(
            index,
            `Signaturen "${signature}" står redan på rad ${earlier.row} för en annan lärare. En signatur är unik inom läsåret.`,
          );
          continue;
        }
        signatureInFile.set(signature, { email, row: index + 1 });
      }
    }

    const people = dto.rows
      .map((row, index) => ({ ...row, index, studentGroupId: undefined }))
      .filter((row) => !refused.has(row.index));
    // Which rows the people half CREATED, as opposed to skipped as known. The
    // report's counts cannot say per row, and the post half needs to know
    // which bucket a row sits in to move it.
    const createdRows = new Set<number>();
    const report = await this.importPeople(people, 'TEACHER', user, createdRows);
    report.updated = 0;
    const failedRows = new Set(report.errors.map((error) => error.row - 1));

    // The posts, for the rows that survived both halves. Resolved by email
    // again, because the people half has just created some of them. One
    // transaction per row rather than one for all: a unique violation inside a
    // Postgres transaction aborts it, and a race on one signature must not take
    // the other 300 posts with it.
    const written = new Set<string>();
    for (const { row, index } of posts) {
      if (refused.has(index) || failedRows.has(index)) continue;
      const email = row.email.trim().toLowerCase();
      if (written.has(email)) continue; // the in-file duplicate importPeople skipped
      written.add(email);
      const personCreated = createdRows.has(index);

      try {
        const outcome = await this.prisma.withRls(user, async (tx) => {
          const person = await tx.user.findFirst({
            where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, email: { equals: email, mode: 'insensitive' } },
            select: { id: true },
          });
          if (!person) return 'missing' as const;
          const key = {
            schoolId_userId_academicYearId: {
              schoolId,
              userId: person.id,
              academicYearId: (year as { id: string }).id,
            },
          };
          const values = postValues(row);
          const current = await tx.teacherEmployment.findUnique({ where: key });
          if (!current) {
            await tx.teacherEmployment.create({
              data: { schoolId, userId: person.id, academicYearId: (year as { id: string }).id, ...values },
            });
            return 'created' as const;
          }
          if (postIsUnchanged(current, values)) return 'unchanged' as const;
          await tx.teacherEmployment.update({ where: key, data: values });
          return 'updated' as const;
        });

        if (outcome === 'missing') {
          // The person was neither found nor created — a SCHOOL_ADMIN with
          // this address would have been skipped by the people half as a
          // conflict and is staff; a STUDENT with it is not. The row leaves
          // whichever count the people half put it in.
          if (personCreated) report.created -= 1;
          else report.skipped -= 1;
          errors.push({
            row: index + 1,
            message: `E-postadressen "${row.email}" tillhör ingen lärare. En tjänst kan bara skrivas för en lärare.`,
          });
        } else if (!personCreated && outcome !== 'unchanged') {
          report.skipped -= 1;
          report.updated += 1;
        }
      } catch (error) {
        if (personCreated) report.created -= 1;
        else report.skipped -= 1;
        errors.push({
          row: index + 1,
          message:
            error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
              ? `Signaturen "${row.signature?.trim() ?? ''}" används redan av en annan lärare läsåret ${(year as { name: string }).name}. Välj en annan signatur.`
              : error instanceof Error
                ? error.message
                : 'Tjänsten kunde inte sparas.',
        });
      }
    }

    report.errors = [...report.errors, ...errors].sort((a, b) => a.row - b.row);
    return report;
  }

  /**
   * Behörigheter: one row per teacher and subject, matched by email and by
   * the subject's code or name, with the inclusive årskursspann and the kind.
   *
   * UPDATES a changed span or kind, like the timplan: a behörighetslista is a
   * document a school keeps editing. It never deletes — a teacher left out of
   * the file keeps their rows — and it leaves the columns the file does not
   * carry (validity dates, note) exactly as they are. One row per (teacher,
   * subject) is the table's unique key; a second row in the file for the same
   * pair is a row error naming the first, because Ma 1-6 plus Ma 7-9 is written
   * as 1-9.
   */
  async importTeacherQualifications(
    dto: ImportTeacherQualificationsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const report: ImportReport & { updated: number } = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
      };

      const emails = [...new Set(dto.rows.map((row) => row.teacherEmail.trim().toLowerCase()))];
      const staff = await tx.user.findMany({
        where: {
          role: { in: ['TEACHER', 'SCHOOL_ADMIN'] },
          isActive: true,
          email: { in: emails, mode: 'insensitive' },
        },
        select: { id: true, email: true },
      });
      const staffByEmail = new Map(staff.map((person) => [person.email.toLowerCase(), person.id]));

      const subjects = await tx.subject.findMany({
        select: { id: true, name: true, code: true },
      });

      const existing = await tx.teacherSubjectQualification.findMany({
        select: { id: true, userId: true, subjectId: true, minGradeLevel: true, maxGradeLevel: true, kind: true },
      });
      const existingByKey = new Map(
        existing.map((row) => [`${row.userId}:${row.subjectId}`, row]),
      );

      const seenAtRow = new Map<string, number>();
      for (const [index, row] of dto.rows.entries()) {
        const rowNumber = index + 1;

        const userId = staffByEmail.get(row.teacherEmail.trim().toLowerCase());
        if (!userId) {
          report.errors.push({
            row: rowNumber,
            message: `Ingen aktiv lärare med e-postadressen "${row.teacherEmail.trim()}". Importera lärarna först.`,
          });
          continue;
        }

        const subject = this.resolveSubject(subjects, row.subject);
        if ('message' in subject) {
          report.errors.push({ row: rowNumber, message: subject.message });
          continue;
        }

        if (row.maxGrade < row.minGrade) {
          report.errors.push({
            row: rowNumber,
            message: `Högsta årskurs (${row.maxGrade}) kan inte vara lägre än lägsta (${row.minGrade}). Ett spann skrivs som 7–9, inte 9–7.`,
          });
          continue;
        }

        const key = `${userId}:${subject.id}`;
        const firstRow = seenAtRow.get(key);
        if (firstRow !== undefined) {
          report.errors.push({
            row: rowNumber,
            message: `Samma lärare och ämne står redan på rad ${firstRow}. En lärare har ett årskursspann per ämne — skriv 1–9 i stället för två rader.`,
          });
          continue;
        }
        seenAtRow.set(key, rowNumber);

        const values = { minGradeLevel: row.minGrade, maxGradeLevel: row.maxGrade, kind: row.kind };
        const current = existingByKey.get(key);
        if (!current) {
          await tx.teacherSubjectQualification.create({
            data: { schoolId, userId, subjectId: subject.id, ...values },
          });
          report.created += 1;
          continue;
        }
        if (
          current.minGradeLevel === values.minGradeLevel &&
          current.maxGradeLevel === values.maxGradeLevel &&
          current.kind === values.kind
        ) {
          report.skipped += 1;
          continue;
        }
        await tx.teacherSubjectQualification.update({ where: { id: current.id }, data: values });
        report.updated += 1;
      }

      return report;
    });
  }

  async importStudents(
    dto: ImportStudentsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    requireSchoolId(user); // 403 up front, same contract as the sibling methods
    // Resolve class NAMES once, up front. Names are what a school's lists
    // contain; ids never appear in a CSV.
    const groups = await this.prisma.withRls(user, (tx) =>
      tx.studentGroup.findMany({
        where: { academicYearId: dto.academicYearId },
        select: { id: true, name: true },
      }),
    );
    const groupByName = new Map(
      groups.map((group) => [this.normalizeName(group.name), group.id]),
    );

    const rows = dto.rows.map((row, index) => {
      const groupId = groupByName.get(this.normalizeName(row.className));
      return { ...row, index, studentGroupId: groupId };
    });

    const unresolved = rows.filter((row) => row.studentGroupId === undefined);
    const resolved = rows.filter((row) => row.studentGroupId !== undefined);

    const report = await this.importPeople(resolved, 'STUDENT', user);
    for (const row of unresolved) {
      report.errors.push({
        row: row.index + 1,
        message: `Klassen "${row.className}" finns inte för det valda läsåret. Importera klasserna först.`,
      });
    }
    report.errors.sort((a, b) => a.row - b.row);
    return report;
  }

  async importGroups(
    dto: ImportGroupsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.studentGroup.findMany({
        where: { academicYearId: dto.academicYearId },
        select: { name: true },
      });
      const taken = new Set(existing.map((group) => this.normalizeName(group.name)));

      const report: ImportReport = { created: 0, skipped: 0, errors: [] };
      for (const row of dto.rows) {
        const key = this.normalizeName(row.name);
        if (taken.has(key)) {
          report.skipped += 1; // exists already, or duplicated within the file
          continue;
        }
        taken.add(key);
        await tx.studentGroup.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            name: row.name.trim(),
            // klasser.csv is the class list; the membership file is what
            // creates teaching groups.
            kind: 'CLASS',
            gradeLevel: row.gradeLevel ?? null,
          },
        });
        report.created += 1;
      }
      return report;
    });
  }

  /**
   * Subjects, matched by normalized name so a re-upload is a no-op.
   *
   * The room-type requirement arrives as a NAME and is resolved against the
   * school's own list. An unknown name fails the row rather than creating the
   * subject without its requirement: a silently dropped requirement leaves the
   * subject schedulable in any room at all, which surfaces much later as
   * slöjden placed in a vanlig klassrum and is far harder to trace back to the
   * import than a line in the report.
   *
   * The national ämneskod gets the same treatment, for the same reason: a
   * subject created without the mapping it was given is left out of every
   * timplan sum, and the coverage page's "ämnen utan nationell kod" warning is
   * a far longer way back to a typo than a row error naming it. Known codes are
   * read once from NationalSubjects (28 rows), inside the transaction, so the
   * check costs one query however many rows the file has.
   */
  async importSubjects(
    dto: ImportSubjectsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.subject.findMany({ select: { name: true } });
      const taken = new Set(existing.map((subject) => this.normalizeName(subject.name)));

      const roomTypes = await tx.roomType.findMany({ select: { id: true, name: true } });
      const roomTypeByName = new Map(
        roomTypes.map((type) => [this.normalizeName(type.name), type.id]),
      );

      const nationalSubjects = await tx.nationalSubject.findMany({ select: { code: true } });
      const knownNationalCodes = new Set(nationalSubjects.map((subject) => subject.code));

      const report: ImportReport = { created: 0, skipped: 0, errors: [] };
      for (const [index, row] of dto.rows.entries()) {
        const rowNumber = index + 1;
        const key = this.normalizeName(row.name);
        if (taken.has(key)) {
          report.skipped += 1; // exists already, or duplicated within the file
          continue;
        }

        let requiredRoomTypeId: string | null = null;
        if (row.roomType && row.roomType.trim() !== '') {
          const resolved = roomTypeByName.get(this.normalizeName(row.roomType));
          if (!resolved) {
            report.errors.push({
              row: rowNumber,
              message: `Salstypen "${row.roomType}" finns inte. Lägg till den under Salar, eller lämna kolumnen tom.`,
            });
            continue;
          }
          requiredRoomTypeId = resolved;
        }

        const nationalCode = normalizeNationalCode(row.nationalCode);
        if (nationalCode !== null && !knownNationalCodes.has(nationalCode)) {
          report.errors.push({
            row: rowNumber,
            message: unknownNationalCodeMessage(nationalCode),
          });
          continue;
        }

        taken.add(key);
        await tx.subject.create({
          data: {
            schoolId,
            name: row.name.trim(),
            code: row.code?.trim() || null,
            color: row.color?.trim() || null,
            requiredRoomTypeId,
            nationalCode,
            countsTowardTimplan: row.countsTowardTimplan ?? true,
          },
        });
        report.created += 1;
      }
      return report;
    });
  }

  /**
   * Room types, matched by normalized name so a re-upload is a no-op. Unlike
   * classes these are not scoped to an academic year: a school's slöjdsal
   * outlives any single läsår.
   */
  async importRoomTypes(
    dto: ImportRoomTypesDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const existing = await tx.roomType.findMany({ select: { name: true } });
      const taken = new Set(existing.map((type) => this.normalizeName(type.name)));

      const report: ImportReport = { created: 0, skipped: 0, errors: [] };
      for (const row of dto.rows) {
        const key = this.normalizeName(row.name);
        if (taken.has(key)) {
          report.skipped += 1; // exists already, or duplicated within the file
          continue;
        }
        taken.add(key);
        await tx.roomType.create({ data: { schoolId, name: row.name.trim() } });
        report.created += 1;
      }
      return report;
    });
  }

  async importMemberships(
    dto: ImportMembershipsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const report: ImportReport = { created: 0, skipped: 0, errors: [] };

      // Students by email — the identifier a school's group lists carry.
      const students = await tx.user.findMany({
        where: {
          role: 'STUDENT',
          isActive: true,
          email: {
            in: [...new Set(dto.rows.map((row) => row.email.toLowerCase()))],
            // The column stores emails as typed at invite time; matching must
            // be case-insensitive AT THE QUERY, not only in the in-memory map
            // below — otherwise "Alma@Example.com" in the catalog can never be
            // matched by any CSV row.
            mode: 'insensitive',
          },
        },
        select: { id: true, email: true },
      });
      const studentByEmail = new Map(
        students.map((student) => [student.email.toLowerCase(), student.id]),
      );

      // Groups by name; a missing teaching group is created on the fly — the
      // group IS what this file defines, unlike a student class reference.
      const existing = await tx.studentGroup.findMany({
        where: { academicYearId: dto.academicYearId },
        select: { id: true, name: true },
      });
      const groupByName = new Map(
        existing.map((group) => [this.normalizeName(group.name), group.id]),
      );

      const memberships: { studentGroupId: string; studentId: string }[] = [];
      for (const [index, row] of dto.rows.entries()) {
        const studentId = studentByEmail.get(row.email.toLowerCase());
        if (!studentId) {
          report.errors.push({
            row: index + 1,
            message: `Ingen aktiv elev med e-postadressen "${row.email}". Importera eleverna först.`,
          });
          continue;
        }
        const key = this.normalizeName(row.groupName);
        let groupId = groupByName.get(key);
        if (!groupId) {
          const created = await tx.studentGroup.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              name: row.groupName.trim(),
              // A group named by a membership file is a teaching group by
              // definition: the file exists to say which students cut across
              // their home classes to attend it.
              kind: 'TEACHING_GROUP',
              gradeLevel: null,
            },
            select: { id: true },
          });
          groupId = created.id;
          groupByName.set(key, groupId);
        }
        memberships.push({ studentGroupId: groupId, studentId });
      }

      if (memberships.length > 0) {
        const { count } = await tx.studentGroupMember.createMany({
          data: memberships.map((membership) => ({ schoolId, ...membership })),
          skipDuplicates: true,
        });
        report.created = count;
        report.skipped = memberships.length - count;
      }
      return report;
    });
  }

  /**
   * The timplan: one row per group and subject, saying how many lessons of it
   * are read each week, how long they are, by whom, and over which weeks.
   *
   * THIS KIND UPDATES. Every other import here is create-only, and that is
   * right for them — a class list or a subject catalogue is a set of things
   * that either exist or do not. A timplan is not: it is a document a school
   * iterates on, in the spreadsheet, for weeks. Create-only would have made the
   * second upload of an edited file a complete no-op — every row already
   * existing, every row skipped, the corrections silently discarded and a
   * report that says "0 fel" while nothing changed.
   *
   * IT STILL NEVER DELETES. A row taken OUT of the file is left standing in the
   * timplan: the file is an addition to what the school has, not a claim to be
   * the whole truth of it, and a school that uploads a single-class file to fix
   * one line must not lose the other 300 rows. That asymmetry is not something
   * a report can convey after the fact — it has to be said in the upload dialog
   * before the click (web/components/import/csv-import-dialog.tsx).
   *
   * AND IT DOES NOT REACH ALREADY-GENERATED LESSONS. Requirements are read by
   * the optimizer when a schedule is generated (optimization-proxy.service.ts)
   * and the master lessons it produces carry no link back, so changing a
   * requirement here leaves every existing lesson exactly as it was until the
   * schedule is generated again. Same as editing a requirement in the UI — this
   * import introduces no new surprise, it only makes the existing one reachable
   * 300 rows at a time, which is why the dialog is where it belongs.
   */
  async importRequirements(
    dto: ImportRequirementsDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      // `updated` typed as present rather than optional: it is optional on
      // ImportReport so the six create-only kinds can leave it out, but this
      // method always reports it, including as 0.
      const report: ImportReport & { updated: number } = {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: [],
      };

      /*
       * The optional columns this file actually has, and so the only optional
       * fields it is allowed to write. See the comment where `values` is built
       * for why this cannot be read off the rows.
       *
       * Absent reads as none of them: silence means "change nothing else",
       * which is the recoverable direction. A caller that forgets the key
       * writes too little — visible, and fixable by uploading the full file —
       * where the other reading resets seven fields across a läsår.
       */
      const writable = new Set(dto.columns ?? []);

      const groups = await tx.studentGroup.findMany({
        where: { academicYearId: dto.academicYearId },
        select: { id: true, name: true },
      });
      const groupByName = new Map(
        groups.map((group) => [this.normalizeName(group.name), group.id]),
      );

      // Subjects are not year-scoped; RLS is what confines this to the school.
      const subjects = await tx.subject.findMany({
        select: { id: true, name: true, code: true },
      });

      // Teachers by email, exactly as importMemberships resolves students —
      // read the comment there: `mode: 'insensitive'` has to be on the QUERY,
      // not only on the map below, or a teacher invited as "Karin@skolan.se"
      // is unmatchable by any spelling a CSV can contain.
      const emails = [
        ...new Set(
          dto.rows
            .flatMap((row) => [row.teacherEmail, row.coTeacherEmail])
            .map((email) => email?.trim().toLowerCase())
            .filter((email): email is string => !!email),
        ),
      ];
      const teachers =
        emails.length === 0
          ? []
          : await tx.user.findMany({
              where: {
                role: 'TEACHER',
                isActive: true,
                email: { in: emails, mode: 'insensitive' },
              },
              select: { id: true, email: true },
            });
      const teacherByEmail = new Map(
        teachers.map((teacher) => [teacher.email.toLowerCase(), teacher.id]),
      );

      // Only worth a round trip if some row states a period; a requirement
      // without one runs the whole year by definition and has nothing the
      // year's bounds could contradict. Same reasoning as
      // TeachingRequirementsService.create.
      //
      // Read FOR SHARE, so the lock is held until the whole upload commits.
      // Every dated row below is measured against these bounds, and a year
      // PATCH committing between this read and that commit would count none of
      // the rows, since none has committed, and strand them. The lock makes
      // that PATCH wait for the upload, or the upload for the PATCH — see
      // readYearBoundsForShare.
      const year = dto.rows.some((row) => row.startDate || row.endDate)
        ? await readYearBoundsForShare(tx, dto.academicYearId)
        : null;

      const existing = await tx.teachingRequirement.findMany({
        where: { academicYearId: dto.academicYearId },
        select: {
          id: true,
          studentGroupId: true,
          subjectId: true,
          teacherId: true,
          coTeacherId: true,
          lessonsPerWeek: true,
          minutesPerLesson: true,
          minutesBefore: true,
          minutesAfter: true,
          recurrence: true,
          startDate: true,
          endDate: true,
        },
      });
      const existingByKey = new Map(
        existing.map((row) => [`${row.studentGroupId}:${row.subjectId}`, row]),
      );

      const seenAtRow = new Map<string, number>();

      for (const [index, row] of dto.rows.entries()) {
        const rowNumber = index + 1;

        // An unknown group is a ROW ERROR, never a create. importMemberships
        // does create its groups on the fly, and that is right there: the
        // membership file IS the definition of the teaching group, so a name
        // it has never seen is a new group being declared. A timplan is the
        // opposite — it points AT groups that were declared elsewhere, so a
        // name nothing matches is a typo, and answering a typo by silently
        // creating an empty group for the school leaves them a phantom in
        // every group list, weeks of lessons planned for nobody, and no trace
        // of where it came from.
        const studentGroupId = groupByName.get(this.normalizeName(row.groupName));
        if (!studentGroupId) {
          report.errors.push({
            row: rowNumber,
            message: `Gruppen "${row.groupName}" finns inte för det valda läsåret. Importera grupperna först, eller rätta stavningen.`,
          });
          continue;
        }

        const subject = this.resolveSubject(subjects, row.subject);
        if ('message' in subject) {
          report.errors.push({ row: rowNumber, message: subject.message });
          continue;
        }

        // The in-file duplicate is decided here, on the identifying pair and
        // BEFORE the remaining columns are resolved: two rows for the same
        // group and subject are a defect in the file whether or not the first
        // one also had, say, an unknown teacher. Registering only rows that
        // survive every check would let a broken row hide its own duplicate.
        const key = `${studentGroupId}:${subject.id}`;
        const firstRow = seenAtRow.get(key);
        if (firstRow !== undefined) {
          report.errors.push({
            row: rowNumber,
            message: `Samma grupp och ämne står redan på rad ${firstRow}. Ta bort den ena raden — timplanen har en rad per grupp och ämne.`,
          });
          continue;
        }
        seenAtRow.set(key, rowNumber);

        let teacherId: string | null = null;
        const teacherEmail = row.teacherEmail?.trim();
        if (teacherEmail) {
          teacherId = teacherByEmail.get(teacherEmail.toLowerCase()) ?? null;
          if (!teacherId) {
            report.errors.push({
              row: rowNumber,
              message: `Ingen aktiv lärare med e-postadressen "${teacherEmail}". Importera lärarna först, eller lämna kolumnen tom.`,
            });
            continue;
          }
        }

        let coTeacherId: string | null = null;
        const coTeacherEmail = row.coTeacherEmail?.trim();
        if (coTeacherEmail) {
          coTeacherId = teacherByEmail.get(coTeacherEmail.toLowerCase()) ?? null;
          if (!coTeacherId) {
            report.errors.push({
              row: rowNumber,
              message: `Ingen aktiv lärare med e-postadressen "${coTeacherEmail}" (medlärare). Importera lärarna först, eller lämna kolumnen tom.`,
            });
            continue;
          }
        }

        // Cannot throw: @IsCalendarDate already refused anything that is not a
        // real YYYY-MM-DD, so this is a parse and not a second validation.
        const startDate = row.startDate ? parseDateString(row.startDate) : null;
        const endDate = row.endDate ? parseDateString(row.endDate) : null;
        const periodProblem = this.describePeriodProblem(year, startDate, endDate);
        if (periodProblem) {
          report.errors.push({ row: rowNumber, message: periodProblem });
          continue;
        }

        /*
         * Two different silences, and they mean opposite things.
         *
         * An EMPTY CELL in a column the file has is authoritative: it means
         * "none". Otherwise a period entered by mistake could never be taken
         * off by editing the file, only by opening the row in the app, and
         * re-uploading an edited timplan would stop being a way to fix
         * anything.
         *
         * A COLUMN THE FILE NEVER HAD is not authoritative about anything. A
         * school's own spreadsheet is usually the four required columns wide —
         * the teachers, the terms and the ombyte were set in the app, not in
         * Excel — and uploading it to correct one lesson count must not strip
         * the teacher off every requirement it touches, nor send a class to
         * matematik straight out of duschen by zeroing an idrott's twenty
         * minutes. That is silent loss across a whole läsår under a report that
         * says "312 updated" and lists no errors.
         *
         * The rows cannot tell the two apart on their own. They omit the key
         * when the column is absent, but the global ValidationPipe runs
         * class-transformer, which materialises every declared property, so the
         * omission is gone before this line runs: `'teacherEmail' in row` is
         * true either way. Measured by instrumenting this loop, not assumed.
         * So the file's column set travels beside the rows, and only what it
         * names is written.
         */
        const values: RequirementValues = {
          lessonsPerWeek: row.lessonsPerWeek,
          minutesPerLesson: row.minutesPerLesson,
          // An empty ombyte cell is a 0, not a silence: the columns are
          // optional on the row so a school need not type two zeroes per line,
          // and within a column the file has, "nothing" is the school saying
          // there is no ombyte. The `?? 0` is therefore the empty cell, and the
          // `writable.has` around it is the missing column — the same two
          // silences the block above separates, for a field whose "none"
          // happens to be a number rather than a null.
          ...(writable.has('minutesBefore')
            ? { minutesBefore: row.minutesBefore ?? 0 }
            : {}),
          ...(writable.has('minutesAfter')
            ? { minutesAfter: row.minutesAfter ?? 0 }
            : {}),
          ...(writable.has('teacherEmail') ? { teacherId } : {}),
          ...(writable.has('coTeacherEmail') ? { coTeacherId } : {}),
          ...(writable.has('recurrence') ? { recurrence: row.recurrence } : {}),
          ...(writable.has('startDate') ? { startDate } : {}),
          ...(writable.has('endDate') ? { endDate } : {}),
        };

        const current = existingByKey.get(key);
        if (!current) {
          await tx.teachingRequirement.create({
            data: {
              schoolId,
              academicYearId: dto.academicYearId,
              studentGroupId,
              subjectId: subject.id,
              // Both buffers stated at 0, and overwritten by `values` when the
              // file had the columns. "Leave it as it was" has nothing to
              // protect on a create — no ombyte anybody entered in the app is
              // standing here to lose — so a file without the columns writes the
              // zeroes rather than leaving the two columns for the schema's
              // default to fill in. The row this method creates is then the row
              // this method describes, which is what the import report claims.
              minutesBefore: 0,
              minutesAfter: 0,
              ...values,
            },
          });
          report.created += 1;
          continue;
        }

        // An unchanged row is `skipped`, not `updated`. The count is what the
        // school reads to decide whether the upload did what they meant, so a
        // re-upload of an untouched file has to report 0 updated — an "updated
        // 312" for a file nobody edited makes the number worthless on the one
        // upload where it matters.
        if (this.requirementIsUnchanged(current, values)) {
          report.skipped += 1;
          continue;
        }
        await tx.teachingRequirement.update({
          where: { id: current.id },
          data: values,
        });
        report.updated += 1;
      }

      return report;
    });
  }

  // ---------------------------------------------------------------------------

  private async importPeople(
    rows: Array<{
      firstName: string;
      lastName: string;
      email: string;
      index?: number;
      studentGroupId?: string;
    }>,
    role: 'TEACHER' | 'STUDENT',
    user: AuthenticatedUser,
    /** Filled with the index of every row this call created, for a caller that writes more per row. */
    createdRows?: Set<number>,
  ): Promise<ImportReport> {
    const report: ImportReport = { created: 0, skipped: 0, errors: [] };
    const seenEmails = new Set<string>();

    for (const [position, row] of rows.entries()) {
      const rowNumber = (row.index ?? position) + 1;
      const email = row.email.toLowerCase();
      if (seenEmails.has(email)) {
        report.skipped += 1; // duplicated within the file itself
        continue;
      }
      seenEmails.add(email);

      try {
        await this.users.create(
          {
            role,
            firstName: row.firstName.trim(),
            lastName: row.lastName.trim(),
            email: row.email.trim(),
            phone: null,
            studentGroupId: row.studentGroupId,
            // An import never emails anybody. Uploading a class list is
            // roster preparation, often weeks before term starts; the school
            // decides separately when those people are invited.
            sendInvitation: false,
          },
          user,
        );
        report.created += 1;
        createdRows?.add(row.index ?? position);
      } catch (error) {
        if (error instanceof ConflictException) {
          report.skipped += 1; // already registered — idempotent re-upload
          continue;
        }
        const message =
          error instanceof Error ? error.message : 'Raden kunde inte importeras.';
        report.errors.push({ row: rowNumber, message });
        this.logger.warn(
          `CSV import row failed [role=${role}, row=${rowNumber}]: ${message}`,
        );
      }
    }
    return report;
  }

  /**
   * A subject cell matched against both columns a school might have written
   * in it — the code (MA) and the full name (Matematik).
   *
   * The two are searched together rather than code-first-then-name on purpose.
   * A precedence rule would quietly resolve the case where one string is one
   * subject's CODE and a different subject's NAME, and the school would never
   * learn that the timplan row went to the other subject than the one they
   * meant — a whole subject's lessons in the wrong place, discovered in
   * October. Every candidate is collected instead, and more than one is a row
   * error naming them all.
   */
  private resolveSubject(
    subjects: { id: string; name: string; code: string | null }[],
    written: string,
  ): { id: string } | { message: string } {
    const key = this.normalizeName(written);
    const matches = subjects.filter(
      (subject) =>
        this.normalizeName(subject.name) === key ||
        (!!subject.code && this.normalizeName(subject.code) === key),
    );

    if (matches.length === 0) {
      return {
        message: `Ämnet "${written}" finns inte. Ange ämnets kod eller namn precis som under Ämnen, eller importera ämnena först.`,
      };
    }
    if (matches.length > 1) {
      const named = matches
        .map((subject) =>
          subject.code ? `"${subject.name}" (kod ${subject.code})` : `"${subject.name}"`,
        )
        .join(' och ');
      return {
        message: `Ämnet "${written}" är tvetydigt: det matchar ${named}. Skriv något som bara passar ett av dem.`,
      };
    }
    return { id: matches[0]!.id };
  }

  /**
   * The period rules `TeachingRequirementsService.assertPeriodFitsYear`
   * enforces, returned as a message instead of thrown as a 400.
   *
   * Deliberately not a shared helper with that method: the two differ in what
   * a violation COSTS, and that is the whole point here. Through the API one
   * bad period is one rejected request. Through an import it would be one bad
   * cell rejecting a file of 300 rows, so the school fixes a date, re-uploads
   * everything, and finds the next bad date — one round trip per typo.
   *
   * `year` is null either because no row states a period, or because the
   * lookup found nothing, which under RLS means the year is not the caller's.
   * Silent in both cases, for the reason that method gives: the create is
   * about to be refused by the composite foreign key anyway, and answering
   * "outside its year" about a year the caller cannot see would confirm it
   * exists.
   */
  private describePeriodProblem(
    year: { startDate: Date; endDate: Date } | null,
    startDate: Date | null,
    endDate: Date | null,
  ): string | null {
    const asDate = (value: Date): string => value.toISOString().slice(0, 10);

    if (startDate && endDate && endDate < startDate) {
      return `Slutdatumet (${asDate(endDate)}) ligger före startdatumet (${asDate(startDate)}).`;
    }
    if (!year) return null;

    for (const [label, value] of [
      ['Startdatumet', startDate],
      ['Slutdatumet', endDate],
    ] as const) {
      if (value && (value < year.startDate || value > year.endDate)) {
        return (
          `${label} (${asDate(value)}) ligger utanför läsåret ` +
          `(${asDate(year.startDate)}–${asDate(year.endDate)}).`
        );
      }
    }
    return null;
  }

  /**
   * Whether an upload would change an existing requirement at all.
   *
   * Dates by timestamp, not by identity: Prisma hands back a fresh `Date` per
   * read, so `===` on two DATE columns holding the same day is false every
   * time, and every unchanged row would have counted as updated.
   */
  /**
   * Would writing `values` over `current` change anything?
   *
   * Only the fields `values` actually carries are compared. A field the file
   * had no column for is not going to be written, so a difference there is not
   * a change this upload makes — counting it would report "312 updated" for a
   * four-column file that altered nothing, and the count is the one thing a
   * school reads to decide whether the upload did what they meant.
   *
   * Dates compare on their timestamp rather than on identity: Prisma hands back
   * a fresh Date on every read, so `===` would call every unchanged row changed.
   */
  private requirementIsUnchanged(
    current: StoredRequirementValues,
    values: RequirementValues,
  ): boolean {
    const sameDay = (a: Date | null, b: Date | null): boolean =>
      (a === null) === (b === null) && (!a || !b || a.getTime() === b.getTime());

    if (current.lessonsPerWeek !== values.lessonsPerWeek) return false;
    if (current.minutesPerLesson !== values.minutesPerLesson) return false;
    if ('minutesBefore' in values && current.minutesBefore !== values.minutesBefore) {
      return false;
    }
    if ('minutesAfter' in values && current.minutesAfter !== values.minutesAfter) {
      return false;
    }
    if ('teacherId' in values && current.teacherId !== values.teacherId) {
      return false;
    }
    if ('coTeacherId' in values && current.coTeacherId !== values.coTeacherId) {
      return false;
    }
    if ('recurrence' in values && current.recurrence !== values.recurrence) {
      return false;
    }
    if ('startDate' in values && !sameDay(current.startDate, values.startDate ?? null)) {
      return false;
    }
    if ('endDate' in values && !sameDay(current.endDate, values.endDate ?? null)) {
      return false;
    }
    return true;
  }

  /** Name matching is what humans expect: trimmed and case-insensitive. */
  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// The post half of a teachers file.
// ---------------------------------------------------------------------------

/** Whether the row says anything at all about a post. */
function statesAPost(row: ImportTeacherRowDto): boolean {
  return (
    (row.employmentPercent !== undefined && row.employmentPercent !== null) ||
    (row.reductionPercent !== undefined && row.reductionPercent !== null) ||
    (row.contractKind !== undefined && row.contractKind !== null) ||
    (row.signature !== undefined && row.signature !== null && row.signature.trim() !== '')
  );
}

/**
 * The two rules the post columns have among themselves, as a message: a post
 * is stated by its percentage or not at all, and the nedsättning sits inside
 * it (TeacherEmployments_reduction_within_employment, which the table can only
 * say as a 500).
 */
function describePostProblem(row: ImportTeacherRowDto): string | null {
  if (row.employmentPercent === undefined || row.employmentPercent === null) {
    return 'Raden anger nedsättning, avtalsform eller signatur men ingen tjänstgöringsgrad. Fyll i tjänstgöringsgraden eller lämna alla fyra kolumner tomma.';
  }
  const reduction = row.reductionPercent ?? 0;
  if (reduction > row.employmentPercent) {
    return `Nedsättningen (${reduction} %) kan inte vara större än tjänstgöringsgraden (${row.employmentPercent} %).`;
  }
  return null;
}

interface PostValues {
  employmentPercent: number;
  reductionPercent: number;
  contractKind: TeacherContractKind;
  signature: string | null;
}

/** The columns the file carries. The own target and the note are the dialog's. */
function postValues(row: ImportTeacherRowDto): PostValues {
  return {
    employmentPercent: row.employmentPercent as number,
    reductionPercent: row.reductionPercent ?? 0,
    contractKind: row.contractKind ?? 'FERIE',
    signature: row.signature?.trim() || null,
  };
}

/**
 * Whether writing the file's values over the stored post changes anything.
 * Decimals compare as numbers: Prisma hands back a Decimal object, and a
 * Decimal is never `===` to the number the file said.
 */
function postIsUnchanged(
  current: { employmentPercent: unknown; reductionPercent: unknown; contractKind: TeacherContractKind; signature: string | null },
  values: PostValues,
): boolean {
  return (
    Number(current.employmentPercent) === values.employmentPercent &&
    Number(current.reductionPercent) === values.reductionPercent &&
    current.contractKind === values.contractKind &&
    current.signature === values.signature
  );
}
