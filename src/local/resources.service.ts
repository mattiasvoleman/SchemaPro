import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { CreateResourceDto, UpdateResourceDto } from './dto/resource.dto';
import { mostHeld } from './external-conflicts';
import type { ResourceAvailabilityResponse, ResourceResponse } from './local-types';

const SELECT = {
  id: true,
  name: true,
  resourceTypeId: true,
  quantity: true,
  siteId: true,
  place: true,
  requiresApproval: true,
  resourceType: { select: { name: true } },
} as const;

type Row = {
  id: string;
  name: string;
  resourceTypeId: string;
  quantity: number;
  siteId: string | null;
  place: string | null;
  requiresApproval: boolean;
  resourceType: { name: string };
};

/** The most a window can be asked about: a term and a bit. */
const MAX_WINDOW_MS = 400 * 86_400_000;

/**
 * What a school lends out that is not a room and is not scheduled: equipment
 * (30 tablets), a vehicle, a space where nobody teaches. Personnel read the list
 * and ask what is free in a window; Planering writes it, as it writes the rooms.
 */
@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: AuthenticatedUser): Promise<ResourceResponse[]> {
    return this.prisma.withRls(user, async (tx) => this.read(tx));
  }

  /**
   * Every resource with how many of it nobody holds at any minute of [from, to):
   * the quantity less the most the active bookings hold at one moment in it.
   * A booking waiting for a decision (PENDING) holds, as the constraint counts it.
   */
  async availability(from: string, to: string, user: AuthenticatedUser): Promise<ResourceAvailabilityResponse[]> {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('to must be after from.');
    }
    if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
      throw new BadRequestException('The window is at most 400 days.');
    }
    return this.prisma.withRls(user, async (tx) => {
      const resources = await this.read(tx);
      const bookings = await tx.resourceBooking.findMany({
        where: { status: { in: ['PENDING', 'APPROVED'] }, startsAt: { lt: end }, endsAt: { gt: start } },
        select: { resourceId: true, quantity: true, startsAt: true, endsAt: true },
      });
      const byResource = new Map<string, Array<{ start: number; end: number; quantity: number }>>();
      for (const booking of bookings) {
        const list = byResource.get(booking.resourceId) ?? [];
        list.push({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime(), quantity: booking.quantity });
        byResource.set(booking.resourceId, list);
      }
      return resources.map((resource) => ({
        ...resource,
        free: Math.max(0, resource.quantity - mostHeld(byResource.get(resource.id) ?? [], start.getTime(), end.getTime())),
      }));
    });
  }

  async create(dto: CreateResourceDto, user: AuthenticatedUser): Promise<ResourceResponse> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const row = await tx.resource.create({
          data: {
            schoolId,
            name: dto.name.trim(),
            resourceTypeId: dto.resourceTypeId,
            quantity: dto.quantity ?? 1,
            siteId: dto.siteId ?? null,
            place: blankAsNone(dto.place),
            ...(dto.requiresApproval !== undefined ? { requiresApproval: dto.requiresApproval } : {}),
          },
          select: SELECT,
        });
        return this.respond(tx, row);
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(id: string, dto: UpdateResourceDto, user: AuthenticatedUser): Promise<ResourceResponse> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        if (dto.quantity !== undefined) await this.assertQuantityHolds(tx, id, dto.quantity);
        const row = await tx.resource.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.resourceTypeId !== undefined ? { resourceTypeId: dto.resourceTypeId } : {}),
            ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
            ...(dto.siteId !== undefined ? { siteId: dto.siteId } : {}),
            ...(dto.place !== undefined ? { place: blankAsNone(dto.place) } : {}),
            ...(dto.requiresApproval !== undefined ? { requiresApproval: dto.requiresApproval } : {}),
          },
          select: SELECT,
        });
        return this.respond(tx, row);
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * A resource that is let out is not deleted (the key is RESTRICT); asked first so
   * the answer says why. Its other bookings go with it (CASCADE), as a room's do.
   */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    try {
      await this.prisma.withRls(user, async (tx) => {
        const series = await tx.externalBooking.count({ where: { resourceId: id } });
        if (series > 0) {
          throw new ConflictException({
            message: `Resursen hyrs ut i ${series} serie(r) av externa bokningar. Ta bort dem först.`,
            code: 'RESOURCE_IS_LET_OUT',
          });
        }
        await tx.resource.delete({ where: { id } });
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * A lower quantity than a later booking already holds would leave bookings no
   * resource can honour. The trigger judges a booking against the quantity at the
   * time it is written; this is the other direction.
   */
  private async assertQuantityHolds(tx: PrismaClient, id: string, quantity: number): Promise<void> {
    const bookings = await tx.resourceBooking.findMany({
      where: { resourceId: id, status: { in: ['PENDING', 'APPROVED'] }, endsAt: { gt: new Date() } },
      select: { quantity: true, startsAt: true, endsAt: true },
    });
    const held = mostHeld(
      bookings.map((booking) => ({ start: booking.startsAt.getTime(), end: booking.endsAt.getTime(), quantity: booking.quantity })),
      Date.now(),
      Math.max(0, ...bookings.map((booking) => booking.endsAt.getTime())) + 1,
    );
    if (held > quantity) {
      throw new BadRequestException(`Det finns bokningar som håller upp till ${held} av resursen. Antalet kan inte vara lägre än så.`);
    }
  }

  private async read(tx: PrismaClient): Promise<ResourceResponse[]> {
    const rows = (await tx.resource.findMany({ orderBy: [{ name: 'asc' }], select: SELECT })) as Row[];
    return this.respondAll(tx, rows);
  }

  private async respond(tx: PrismaClient, row: Row): Promise<ResourceResponse> {
    return (await this.respondAll(tx, [row]))[0];
  }

  private async respondAll(tx: PrismaClient, rows: Row[]): Promise<ResourceResponse[]> {
    const siteIds = [...new Set(rows.map((row) => row.siteId).filter((id): id is string => id !== null))];
    const sites = siteIds.length === 0 ? [] : await tx.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, name: true } });
    const names = new Map(sites.map((site) => [site.id, site.name]));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      resourceTypeId: row.resourceTypeId,
      resourceTypeName: row.resourceType.name,
      quantity: row.quantity,
      siteId: row.siteId,
      siteName: row.siteId ? (names.get(row.siteId) ?? null) : null,
      place: row.place,
      requiresApproval: row.requiresApproval,
    }));
  }
}

/** A text as the school meant it: trimmed, and a blank as none. */
function blankAsNone(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
