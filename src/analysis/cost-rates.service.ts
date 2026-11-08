import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { COST_CATEGORIES, type CostCategory, type CostRateView } from './analysis.types';

/**
 * The school's cost of an hour in each personalkategori (StaffCostRates,
 * 20270130090000): a rate per category, in SEK, stated by those who decide and
 * read by every administrator. No rate belongs to a person, a post or an
 * employment, and the category is not kept on anyone: it is derived when the
 * cost basis is made. A category the school has not stated has no row; the
 * cost basis then says that, and never prices its hours at zero.
 */

const SELECT = { category: true, hourlyCost: true } as const;
const order = (a: CostRateView, b: CostRateView): number => COST_CATEGORIES.indexOf(a.category) - COST_CATEGORIES.indexOf(b.category);

export const toCostRateView = (row: { category: CostCategory; hourlyCost: unknown }): CostRateView => ({
  category: row.category,
  hourlyCost: Number(row.hourlyCost),
});

@Injectable()
export class CostRatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<CostRateView[]> {
    const schoolId = requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) => tx.staffCostRate.findMany({ where: { schoolId }, select: SELECT }));
    return rows.map(toCostRateView).sort(order);
  }

  /** States the rate, or changes it: one row per school and category. */
  async put(category: CostCategory, hourlyCost: number, user: AuthenticatedUser): Promise<CostRateView> {
    const schoolId = requireSchoolId(user);
    try {
      return toCostRateView(
        await this.prisma.withRls(user, (tx) =>
          tx.staffCostRate.upsert({
            where: { schoolId_category: { schoolId, category } },
            create: { schoolId, category, hourlyCost },
            update: { hourlyCost },
            select: SELECT,
          }),
        ),
      );
    } catch (error) {
      return rethrowPrismaError(error);
    }
  }

  async remove(category: CostCategory, user: AuthenticatedUser): Promise<void> {
    const schoolId = requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const removed = await tx.staffCostRate.deleteMany({ where: { schoolId, category } });
        if (removed.count === 0) throw new NotFoundException('The requested record does not exist.');
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
