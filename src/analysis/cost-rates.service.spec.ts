import { NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { CostRatesService, toCostRateView } from './cost-rates.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';

describe('CostRatesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: CostRatesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new CostRatesService(prisma as unknown as PrismaService);
  });

  it('lists the rates in the categories\' order with the cost as a number', async () => {
    tx.staffCostRate.findMany.mockResolvedValue([
      { category: 'SUBSTITUTE', hourlyCost: '310.50' },
      { category: 'TEACHER', hourlyCost: '420.00' },
    ]);
    await expect(service.list(testUser())).resolves.toEqual([
      { category: 'TEACHER', hourlyCost: 420 },
      { category: 'SUBSTITUTE', hourlyCost: 310.5 },
    ]);
    expect(tx.staffCostRate.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { category: true, hourlyCost: true } });
  });

  it('states a rate as one row per school and category, the first time and every time after', async () => {
    tx.staffCostRate.upsert.mockResolvedValue({ category: 'TEACHER', hourlyCost: '435.00' });
    await expect(service.put('TEACHER', 435, testUser())).resolves.toEqual({ category: 'TEACHER', hourlyCost: 435 });
    expect(tx.staffCostRate.upsert).toHaveBeenCalledWith({
      where: { schoolId_category: { schoolId: SCHOOL, category: 'TEACHER' } },
      create: { schoolId: SCHOOL, category: 'TEACHER', hourlyCost: 435 },
      update: { hourlyCost: 435 },
      select: { category: true, hourlyCost: true },
    });
  });

  it('removes a rate, and answers 404 for one the school never stated', async () => {
    tx.staffCostRate.deleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(service.remove('SUBSTITUTE', testUser())).resolves.toBeUndefined();
    expect(tx.staffCostRate.deleteMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL, category: 'SUBSTITUTE' } });
    tx.staffCostRate.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.remove('SUBSTITUTE', testUser())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('turns a database refusal into the answer every service gives', async () => {
    tx.staffCostRate.upsert.mockRejectedValue(new Error('boom'));
    await expect(service.put('TEACHER', 1, testUser())).rejects.toThrow('boom');
    tx.staffCostRate.deleteMany.mockRejectedValue(new Error('boom'));
    await expect(service.remove('TEACHER', testUser())).rejects.toThrow('boom');
  });

  it('reads a Prisma decimal as a number', () => {
    expect(toCostRateView({ category: 'TEACHER', hourlyCost: { toString: () => '12.34', valueOf: () => '12.34' } as never })).toEqual({
      category: 'TEACHER',
      hourlyCost: 12.34,
    });
  });
});
