import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { SchoolUnitsService } from './school-units.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const F6 = '20000000-0000-4000-8000-0000000000f6';
const U79 = '20000000-0000-4000-8000-000000000079';

const row = (patch: Record<string, unknown> = {}) => ({
  id: F6,
  name: 'Norra F–6',
  code: '11111111',
  schoolTypes: ['GR', 'FKLASS'],
  gradeFrom: 0,
  gradeTo: 6,
  ss12000Id: null,
  ...patch,
});

/** The span trigger's refusal as @prisma/adapter-pg hands it over (P2039, the driver's SQLSTATE in meta). */
const overlapRefusal = () =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code: 'P2039',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: 'SU409', originalMessage: 'SCHOOL_UNIT_SPAN_OVERLAP' } } },
  });

describe('SchoolUnitsService', () => {
  let tx: TxMock;
  let service: SchoolUnitsService;
  const admin = testUser({ schoolId: SCHOOL });

  beforeEach(() => {
    tx = createTxMock();
    service = new SchoolUnitsService(createPrismaMock(tx) as unknown as PrismaService);
    tx['schoolUnit']!['create']!.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: U79, ss12000Id: null, ...data }));
    tx['schoolUnit']!['update']!.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...row(), ...data }));
  });

  it("lists the school's units in their order, saying which are the register's", async () => {
    tx['schoolUnit']!['findMany']!.mockResolvedValue([row({ id: U79, name: 'Norra 7–9', code: '22222222', gradeFrom: 7, gradeTo: 9, ss12000Id: 'aaaaaaaa-0000-4000-8000-000000000001' }), row()]);
    const units = await service.list(admin);
    expect(units.map((unit) => [unit.name, unit.fromSource, unit.schoolTypes])).toEqual([
      ['Norra F–6', false, ['FKLASS', 'GR']],
      ['Norra 7–9', true, ['FKLASS', 'GR']],
    ]);
    expect(tx['schoolUnit']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL } }));
  });

  it('creates a unit with its code as eight digits and each skolform once, in the caller school', async () => {
    const unit = await service.create({ name: '  Norra 7–9 ', code: '2222 2222', schoolTypes: ['GR', 'GR'], gradeFrom: 7, gradeTo: 9 }, admin);
    expect(tx['schoolUnit']!['create']).toHaveBeenCalledWith(
      expect.objectContaining({ data: { schoolId: SCHOOL, name: 'Norra 7–9', code: '22222222', schoolTypes: ['GR'], gradeFrom: 7, gradeTo: 9 } }),
    );
    expect(unit).toMatchObject({ name: 'Norra 7–9', fromSource: false });
  });

  it('refuses a code that is not eight digits, half a span, and a span backwards', async () => {
    await expect(service.create({ name: 'X', code: '1234567' }, admin)).rejects.toMatchObject({ response: { code: 'SCHOOL_UNIT_CODE_INVALID' } });
    await expect(service.create({ name: 'X', gradeFrom: 3 }, admin)).rejects.toMatchObject({ response: { code: 'SCHOOL_UNIT_SPAN_INVALID' } });
    await expect(service.create({ name: 'X', gradeFrom: 6, gradeTo: 3 }, admin)).rejects.toMatchObject({ response: { code: 'SCHOOL_UNIT_SPAN_INVALID' } });
    await expect(service.create({ name: '   ' }, admin)).rejects.toMatchObject({ status: 400 });
    expect(tx['schoolUnit']!['create']).not.toHaveBeenCalled();
  });

  it("refuses a span another unit holds, naming it, and a code another unit has", async () => {
    tx['schoolUnit']!['findMany']!.mockResolvedValue([row()]);
    await expect(service.create({ name: 'Mellan', gradeFrom: 4, gradeTo: 9 }, admin)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SCHOOL_UNIT_SPAN_OVERLAP', message: expect.stringContaining('"Norra F–6"') },
    });
    await expect(service.create({ name: 'Annan', code: '11111111' }, admin)).rejects.toMatchObject({ status: 409, response: { code: 'SCHOOL_UNIT_CODE_TAKEN' } });
    expect(tx['schoolUnit']!['create']).not.toHaveBeenCalled();
  });

  it("answers the database's own refusals, a concurrent writer's, as the same 409s", async () => {
    tx['schoolUnit']!['create']!.mockRejectedValueOnce(overlapRefusal());
    await expect(service.create({ name: 'X', gradeFrom: 0, gradeTo: 3 }, admin)).rejects.toMatchObject({ status: 409, response: { code: 'SCHOOL_UNIT_SPAN_OVERLAP' } });
    tx['schoolUnit']!['create']!.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    );
    await expect(service.create({ name: 'X', code: '99999999' }, admin)).rejects.toMatchObject({ status: 409, response: { code: 'SCHOOL_UNIT_CODE_TAKEN' } });
  });

  it("keeps the register's name, code and skolformer on a linked unit, and lets the school set its span", async () => {
    tx['schoolUnit']!['findFirst']!.mockResolvedValue(row({ ss12000Id: 'aaaaaaaa-0000-4000-8000-000000000001' }));
    for (const dto of [{ name: 'Annat' }, { code: '99999999' }, { schoolTypes: ['GR' as const] }]) {
      await expect(service.update(F6, dto, admin)).rejects.toMatchObject({ status: 409, response: { code: 'SCHOOL_UNIT_FROM_SOURCE' } });
    }
    // The same values are no change.
    await service.update(F6, { name: 'Norra F–6', code: '11111111', schoolTypes: ['FKLASS', 'GR'], gradeFrom: 1, gradeTo: 6 }, admin);
    expect(tx['schoolUnit']!['update']).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: F6 }, data: { name: 'Norra F–6', code: '11111111', schoolTypes: ['FKLASS', 'GR'], gradeFrom: 1, gradeTo: 6 } }),
    );
  });

  it('clears a span with both ends, moves one end against the stored other, and 404s a unit it cannot see', async () => {
    tx['schoolUnit']!['findFirst']!.mockResolvedValue(row());
    await service.update(F6, { gradeFrom: null, gradeTo: null }, admin);
    expect(tx['schoolUnit']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { gradeFrom: null, gradeTo: null } }));
    await service.update(F6, { name: 'Norra lågstadiet' }, admin);
    expect(tx['schoolUnit']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { name: 'Norra lågstadiet' } }));
    // One end alone moves against the stored other: 3 to 6 is a span, 7 to 6 is not.
    await service.update(F6, { gradeFrom: 3 }, admin);
    expect(tx['schoolUnit']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { gradeFrom: 3, gradeTo: 6 } }));
    await expect(service.update(F6, { gradeFrom: 7 }, admin)).rejects.toMatchObject({ response: { code: 'SCHOOL_UNIT_SPAN_INVALID' } });
    tx['schoolUnit']!['findFirst']!.mockResolvedValue(null);
    await expect(service.update(F6, { name: 'X' }, admin)).rejects.toMatchObject({ status: 404 });
  });

  it('removes a unit of the school, and 404s one it cannot see', async () => {
    tx['schoolUnit']!['deleteMany']!.mockResolvedValueOnce({ count: 1 });
    await service.remove(F6, admin);
    expect(tx['schoolUnit']!['deleteMany']).toHaveBeenCalledWith({ where: { id: F6, schoolId: SCHOOL } });
    // The school's lock before the row's, as update() and the sync apply take
    // them: a DELETE locks its row before its trigger takes the school's lock.
    expect(tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx['schoolUnit']!['deleteMany']!.mock.invocationCallOrder[0]!);
    tx['schoolUnit']!['deleteMany']!.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove(F6, admin)).rejects.toMatchObject({ status: 404 });
  });
});
