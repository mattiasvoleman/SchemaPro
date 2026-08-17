import { ConflictException, Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { UsersService } from '../users/users.service';
import type {
  ImportGroupsDto,
  ImportMembershipsDto,
  ImportReport,
  ImportRoomTypesDto,
  ImportStudentsDto,
  ImportTeachersDto,
} from './dto/import.dto';

/**
 * CSV import: people, classes and teaching-group memberships in bulk.
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
 */
@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
  ) {}

  async importTeachers(
    dto: ImportTeachersDto,
    user: AuthenticatedUser,
  ): Promise<ImportReport> {
    requireSchoolId(user); // 403 up front, same contract as the sibling methods
    return this.importPeople(
      dto.rows.map((row) => ({ ...row, studentGroupId: undefined })),
      'TEACHER',
      user,
    );
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
            gradeLevel: row.gradeLevel ?? null,
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
          },
          user,
        );
        report.created += 1;
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

  /** Name matching is what humans expect: trimmed and case-insensitive. */
  private normalizeName(name: string): string {
    return name.trim().toLowerCase();
  }
}
