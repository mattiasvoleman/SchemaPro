import 'reflect-metadata';
import { testUser } from '../../test/utils/prisma-mock';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { ImportController } from './import.controller';
import type { ImportService } from './import.service';
import type {
  ImportGroupsDto,
  ImportMembershipsDto,
  ImportReport,
  ImportRequirementsDto,
  ImportStudentsDto,
  ImportTeachersDto,
} from './dto/import.dto';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const REPORT: ImportReport = { created: 1, skipped: 2, errors: [] };

describe('ImportController', () => {
  let imports: {
    importTeachers: jest.Mock;
    importStudents: jest.Mock;
    importGroups: jest.Mock;
    importMemberships: jest.Mock;
    importRequirements: jest.Mock;
  };
  let controller: ImportController;
  const user = testUser();

  beforeEach(() => {
    imports = {
      importTeachers: jest.fn().mockResolvedValue(REPORT),
      importStudents: jest.fn().mockResolvedValue(REPORT),
      importGroups: jest.fn().mockResolvedValue(REPORT),
      importMemberships: jest.fn().mockResolvedValue(REPORT),
      importRequirements: jest.fn().mockResolvedValue(REPORT),
    };
    controller = new ImportController(imports as unknown as ImportService);
  });

  describe('delegation', () => {
    it('importTeachers passes the DTO and the principal through unchanged', async () => {
      const dto: ImportTeachersDto = {
        rows: [{ firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' }],
      };

      await expect(controller.importTeachers(dto, user)).resolves.toEqual(REPORT);
      expect(imports.importTeachers).toHaveBeenCalledWith(dto, user);
    });

    it('importStudents passes the DTO and the principal through unchanged', async () => {
      const dto: ImportStudentsDto = {
        academicYearId: YEAR_ID,
        rows: [
          {
            firstName: 'Alma',
            lastName: 'Berg',
            email: 'alma@example.com',
            className: '7A',
          },
        ],
      };

      await expect(controller.importStudents(dto, user)).resolves.toEqual(REPORT);
      expect(imports.importStudents).toHaveBeenCalledWith(dto, user);
    });

    it('importGroups passes the DTO and the principal through unchanged', async () => {
      const dto: ImportGroupsDto = {
        academicYearId: YEAR_ID,
        rows: [{ name: '7A', gradeLevel: 7 }],
      };

      await expect(controller.importGroups(dto, user)).resolves.toEqual(REPORT);
      expect(imports.importGroups).toHaveBeenCalledWith(dto, user);
    });

    it('importMemberships passes the DTO and the principal through unchanged', async () => {
      const dto: ImportMembershipsDto = {
        academicYearId: YEAR_ID,
        rows: [{ groupName: 'Ma71', email: 'alma@example.com' }],
      };

      await expect(controller.importMemberships(dto, user)).resolves.toEqual(REPORT);
      expect(imports.importMemberships).toHaveBeenCalledWith(dto, user);
    });

    it('importRequirements passes the DTO and the principal through unchanged', async () => {
      const dto: ImportRequirementsDto = {
        academicYearId: YEAR_ID,
        rows: [
          {
            groupName: '7A',
            subject: 'MA',
            lessonsPerWeek: 3,
            minutesPerLesson: 60,
            teacherEmail: 'karin@example.com',
            coTeacherEmail: null,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
          },
        ],
      };

      await expect(controller.importRequirements(dto, user)).resolves.toEqual(REPORT);
      expect(imports.importRequirements).toHaveBeenCalledWith(dto, user);
    });

    it('propagates service failures instead of swallowing them', async () => {
      const boom = new Error('boom');
      imports.importStudents.mockRejectedValue(boom);

      await expect(
        controller.importStudents(
          { academicYearId: YEAR_ID, rows: [] } as unknown as ImportStudentsDto,
          user,
        ),
      ).rejects.toBe(boom);
    });
  });

  // The decorators ARE the authorization and rate-limit model for these
  // routes — RolesGuard and ThrottlerGuard read this metadata at runtime.
  // Everything here is declared at CLASS level, so one dropped decorator
  // would silently open every bulk-import endpoint at once — including the
  // timplan route, the only one that can also OVERWRITE existing rows.
  describe('route metadata', () => {
    const handlers = [
      ImportController.prototype.importTeachers,
      ImportController.prototype.importStudents,
      ImportController.prototype.importGroups,
      ImportController.prototype.importMemberships,
      ImportController.prototype.importRequirements,
    ];

    it('guards the whole controller with JwtAuthGuard + RolesGuard', () => {
      // '__guards__' is Nest's GUARDS_METADATA constant.
      const guards = Reflect.getMetadata('__guards__', ImportController) as
        | unknown[]
        | undefined;
      expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('restricts every import route to school admins via class-level @Roles', () => {
      expect(Reflect.getMetadata(ROLES_KEY, ImportController)).toEqual([
        Role.SCHOOL_ADMIN,
      ]);
      // No handler carries a wider per-route override that would shadow the
      // controller-level restriction.
      for (const handler of handlers) {
        expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      }
    });

    it('rate-limits the controller to 10 requests per minute (each request is up to 500 invites)', () => {
      // @nestjs/throttler stores per-throttler metadata under
      // `THROTTLER:LIMIT<name>` / `THROTTLER:TTL<name>` on the class.
      expect(Reflect.getMetadata('THROTTLER:LIMITdefault', ImportController)).toBe(10);
      expect(Reflect.getMetadata('THROTTLER:TTLdefault', ImportController)).toBe(60_000);
    });
  });
});
