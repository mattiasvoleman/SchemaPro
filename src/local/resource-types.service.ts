import { BadRequestException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { CreateResourceTypeDto, UpdateResourceTypeDto } from './dto/resource.dto';
import type { ResourceTypeResponse } from './local-types';

/**
 * The kinds of resource a school has named for itself (Surfplattor, Minibuss,
 * Aulan): rows and not free text, as the room types are, so that a kind is
 * picked from a list and "Minibus" and "Minibuss" are not two kinds.
 */
@Injectable()
export class ResourceTypesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser): Promise<ResourceTypeResponse[]> {
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.resourceType.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, _count: { select: { resources: true } } },
      });
      return rows.map((row) => ({ id: row.id, name: row.name, resources: row._count.resources }));
    });
  }

  async create(dto: CreateResourceTypeDto, user: AuthenticatedUser): Promise<ResourceTypeResponse> {
    const schoolId = requireSchoolId(user);
    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.resourceType.create({ data: { schoolId, name: dto.name.trim() }, select: { id: true, name: true } }),
      );
      return { ...row, resources: 0 };
    } catch (error) {
      rethrowPrismaError(error); // a name the school has: 409
    }
  }

  async update(id: string, dto: UpdateResourceTypeDto, user: AuthenticatedUser): Promise<ResourceTypeResponse> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const row = await tx.resourceType.update({
          where: { id },
          data: { ...(dto.name !== undefined ? { name: dto.name.trim() } : {}) },
          select: { id: true, name: true, _count: { select: { resources: true } } },
        });
        return { id: row.id, name: row.name, resources: row._count.resources };
      });
    } catch (error) {
      rethrowPrismaError(error); // 409 for a name the school has, 404 for an unknown id
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, async (tx) => {
        // The key is RESTRICT, so the database refuses a kind in use; asking first
        // turns that into a sentence that says how many.
        const type = await tx.resourceType.findUnique({ where: { id }, select: { _count: { select: { resources: true } } } });
        if (!type) return;
        if (type._count.resources > 0) {
          throw new BadRequestException(
            `Slaget används av ${type._count.resources} resurs(er) och kan inte tas bort. Byt slag på dem först.`,
          );
        }
        await tx.resourceType.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      rethrowPrismaError(error);
    }
  }
}
