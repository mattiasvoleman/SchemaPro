import 'reflect-metadata';
import { testUser } from '../../test/utils/prisma-mock';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { FamilyController } from './family.controller';
import type { FamilyService } from './family.service';
import type {
  CreateAbsenceReportDto,
  CreateGuardianLinkDto,
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
} from './dto/family.dto';

const LINK_ID = '66666666-6666-4666-8666-666666666666';
const REPORT_ID = '77777777-7777-4777-8777-777777777777';
const REQUEST_ID = '88888888-8888-4888-8888-888888888888';

describe('FamilyController', () => {
  let family: {
    createLink: jest.Mock;
    removeLink: jest.Mock;
    createAbsenceReport: jest.Mock;
    removeAbsenceReport: jest.Mock;
    createLeaveRequest: jest.Mock;
    decideLeaveRequest: jest.Mock;
  };
  let controller: FamilyController;
  const user = testUser();

  beforeEach(() => {
    family = {
      createLink: jest.fn().mockResolvedValue({ id: LINK_ID }),
      removeLink: jest.fn().mockResolvedValue({ id: LINK_ID }),
      createAbsenceReport: jest.fn().mockResolvedValue({ id: REPORT_ID }),
      removeAbsenceReport: jest.fn().mockResolvedValue({ id: REPORT_ID }),
      createLeaveRequest: jest.fn().mockResolvedValue({ id: REQUEST_ID }),
      decideLeaveRequest: jest
        .fn()
        .mockResolvedValue({ id: REQUEST_ID, status: 'APPROVED', absenceDays: 2 }),
    };
    controller = new FamilyController(family as unknown as FamilyService);
  });

  describe('delegation', () => {
    it('createLink passes the DTO and the principal through unchanged', async () => {
      const dto: CreateGuardianLinkDto = {
        guardianId: '44444444-4444-4444-8444-444444444444',
        studentId: '55555555-5555-4555-8555-555555555555',
      };

      await expect(controller.createLink(dto, user)).resolves.toEqual({
        id: LINK_ID,
      });
      expect(family.createLink).toHaveBeenCalledWith(dto, user);
    });

    it('removeLink passes the path id and the principal', async () => {
      await expect(controller.removeLink(LINK_ID, user)).resolves.toEqual({
        id: LINK_ID,
      });
      expect(family.removeLink).toHaveBeenCalledWith(LINK_ID, user);
    });

    it('createAbsenceReport passes the DTO and the principal', async () => {
      const dto: CreateAbsenceReportDto = {
        studentId: '55555555-5555-4555-8555-555555555555',
        date: '2026-08-07',
        type: 'SICK',
      };

      await expect(controller.createAbsenceReport(dto, user)).resolves.toEqual({
        id: REPORT_ID,
      });
      expect(family.createAbsenceReport).toHaveBeenCalledWith(dto, user);
    });

    it('removeAbsenceReport passes the path id and the principal', async () => {
      await expect(
        controller.removeAbsenceReport(REPORT_ID, user),
      ).resolves.toEqual({ id: REPORT_ID });
      expect(family.removeAbsenceReport).toHaveBeenCalledWith(REPORT_ID, user);
    });

    it('createLeaveRequest passes the DTO and the principal', async () => {
      const dto: CreateLeaveRequestDto = {
        studentId: '55555555-5555-4555-8555-555555555555',
        startDate: '2026-08-10',
        endDate: '2026-08-12',
        reason: 'Family trip',
      };

      await expect(controller.createLeaveRequest(dto, user)).resolves.toEqual({
        id: REQUEST_ID,
      });
      expect(family.createLeaveRequest).toHaveBeenCalledWith(dto, user);
    });

    it('decideLeaveRequest passes id, DTO and principal in order', async () => {
      const dto: DecideLeaveRequestDto = { status: 'APPROVED', note: 'Ok' };

      await expect(
        controller.decideLeaveRequest(REQUEST_ID, dto, user),
      ).resolves.toEqual({ id: REQUEST_ID, status: 'APPROVED', absenceDays: 2 });
      expect(family.decideLeaveRequest).toHaveBeenCalledWith(
        REQUEST_ID,
        dto,
        user,
      );
    });

    it('propagates service failures instead of swallowing them', async () => {
      const boom = new Error('boom');
      family.removeLink.mockRejectedValue(boom);

      await expect(controller.removeLink(LINK_ID, user)).rejects.toBe(boom);
    });
  });

  // The @Roles metadata IS the authorization model for these routes —
  // RolesGuard reads it at runtime. A handler losing its decorator would
  // silently open the route to every authenticated role.
  describe('route authorization metadata', () => {
    const rolesOf = (handler: (...args: never[]) => unknown): Role[] =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[];

    it('guards the whole controller with JwtAuthGuard + RolesGuard', () => {
      // '__guards__' is Nest's GUARDS_METADATA constant.
      const guards = Reflect.getMetadata('__guards__', FamilyController) as
        | unknown[]
        | undefined;
      expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('restricts guardian-link management to school admins', () => {
      expect(rolesOf(FamilyController.prototype.createLink)).toEqual([
        Role.SCHOOL_ADMIN,
      ]);
      expect(rolesOf(FamilyController.prototype.removeLink)).toEqual([
        Role.SCHOOL_ADMIN,
      ]);
    });

    it('opens absence reporting to guardians, students and admins only', () => {
      expect(rolesOf(FamilyController.prototype.createAbsenceReport)).toEqual([
        Role.GUARDIAN,
        Role.STUDENT,
        Role.SCHOOL_ADMIN,
      ]);
      expect(rolesOf(FamilyController.prototype.removeAbsenceReport)).toEqual([
        Role.GUARDIAN,
        Role.STUDENT,
        Role.SCHOOL_ADMIN,
      ]);
    });

    it('opens leave requests to guardians, students and admins only', () => {
      expect(rolesOf(FamilyController.prototype.createLeaveRequest)).toEqual([
        Role.GUARDIAN,
        Role.STUDENT,
        Role.SCHOOL_ADMIN,
      ]);
    });

    it('restricts leave decisions to school admins', () => {
      expect(rolesOf(FamilyController.prototype.decideLeaveRequest)).toEqual([
        Role.SCHOOL_ADMIN,
      ]);
    });
  });
});
