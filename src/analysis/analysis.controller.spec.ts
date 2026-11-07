import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AREA_KEY, type AreaRequirement } from '../auth/decorators/area.decorator';
import { AnalysisController } from './analysis.controller';
import { AnalysisThrottlerGuard, PER_ADDRESS } from './analysis-throttler.guard';

const user = { authId: 'a', role: 'SCHOOL_ADMIN' } as AuthenticatedUser;
const YEAR = '99999999-9999-4999-8999-999999999999';

describe('AnalysisController', () => {
  const analysis = { keyFigures: jest.fn(), costBasis: jest.fn(), payrollBasis: jest.fn(), payrollFile: jest.fn() };
  const parts = { list: jest.fn(), create: jest.fn(), update: jest.fn(), remove: jest.fn() };
  const rates = { list: jest.fn(), put: jest.fn(), remove: jest.fn() };
  const controller = new AnalysisController(analysis as never, parts as never, rates as never);

  beforeEach(() => jest.clearAllMocks());

  const metadata = (handler: keyof AnalysisController, key: string) => Reflect.getMetadata(key, AnalysisController.prototype[handler]) as unknown;
  const guards = (handler: keyof AnalysisController) => (Reflect.getMetadata('__guards__', AnalysisController.prototype[handler]) as unknown[] | undefined) ?? [];
  const area = (handler: keyof AnalysisController) => Reflect.getMetadata(AREA_KEY, AnalysisController.prototype[handler]) as AreaRequirement | undefined;

  it('hands each view its query and the caller', async () => {
    await controller.keyFigures({ academicYearId: YEAR }, user);
    expect(analysis.keyFigures).toHaveBeenCalledWith(YEAR, user);
    await controller.costBasis({ academicYearId: YEAR, from: '2026-10-01', to: '2026-10-31' }, user);
    expect(analysis.costBasis).toHaveBeenCalledWith({ academicYearId: YEAR, from: '2026-10-01', to: '2026-10-31' }, user);
    const query = { academicYearId: YEAR, from: '2026-11-01', to: '2026-11-30' };
    await controller.payrollBasis(query, user);
    expect(analysis.payrollBasis).toHaveBeenCalledWith(query, user);
    await controller.payrollFile({ ...query, format: 'CSV' }, user);
    expect(analysis.payrollFile).toHaveBeenCalledWith({ ...query, format: 'CSV' }, user);
  });

  it('hands the skoldelar and the rates to their services', async () => {
    const dto = { name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 };
    await controller.listParts(user);
    await controller.createPart(dto, user);
    await controller.updatePart('p', { account: '4011' }, user);
    await controller.removePart('p', user);
    expect(parts.list).toHaveBeenCalledWith(user);
    expect(parts.create).toHaveBeenCalledWith(dto, user);
    expect(parts.update).toHaveBeenCalledWith('p', { account: '4011' }, user);
    expect(parts.remove).toHaveBeenCalledWith('p', user);
    await controller.listRates(user);
    await controller.putRate('SUBSTITUTE', { hourlyCost: 310 }, user);
    await controller.removeRate('TEACHER', user);
    expect(rates.list).toHaveBeenCalledWith(user);
    expect(rates.put).toHaveBeenCalledWith('SUBSTITUTE', 310, user);
    expect(rates.remove).toHaveBeenCalledWith('TEACHER', user);
  });

  it('refuses a category the school cannot state a rate for', async () => {
    expect(() => controller.putRate('PRINCIPAL', { hourlyCost: 1 }, user)).toThrow(BadRequestException);
    await expect(controller.removeRate('', user)).rejects.toBeInstanceOf(BadRequestException);
    expect(rates.put).not.toHaveBeenCalled();
    expect(rates.remove).not.toHaveBeenCalled();
  });

  it('limits the four views per login, with a ceiling per address a school\'s staff stay under', () => {
    for (const handler of ['keyFigures', 'costBasis', 'payrollBasis', 'payrollFile'] as const) {
      expect(guards(handler)).toContain(AnalysisThrottlerGuard);
      expect(metadata(handler, 'THROTTLER:LIMITdefault')).toBe(PER_ADDRESS.limit);
      expect(metadata(handler, 'THROTTLER:TTLdefault')).toBe(PER_ADDRESS.ttl);
    }
    for (const handler of ['listParts', 'createPart', 'listRates', 'putRate'] as const) {
      expect(guards(handler)).not.toContain(AnalysisThrottlerGuard);
    }
  });

  it('asks the deciders for every write of the skoldelar and the rates, and nothing of a read', () => {
    for (const handler of ['createPart', 'updatePart', 'removePart', 'putRate', 'removeRate'] as const) {
      expect(area(handler)).toEqual({ kind: 'decides' });
    }
    for (const handler of ['keyFigures', 'costBasis', 'payrollBasis', 'listParts', 'listRates'] as const) {
      expect(area(handler)).toBeUndefined();
    }
    expect(Reflect.getMetadata(AREA_KEY, AnalysisController)).toMatchObject({ kind: 'any' });
  });
});
