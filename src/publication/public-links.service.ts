import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { newToken, tokenHashOf } from './public-token';
import type { CreatePublicLinkDto } from './dto/publication.dto';

export const PUBLIC_GROUP_TOO_SMALL = 'PUBLIC_GROUP_TOO_SMALL';
export const PUBLIC_TEACHER_NOT_SHOWABLE = 'PUBLIC_TEACHER_NOT_SHOWABLE';
export const PUBLIC_LINK_SHAPE = 'PUBLIC_LINK_SHAPE';

export interface PublicLinkView {
  id: string;
  academicYearId: string;
  kind: 'GROUP' | 'TEACHER' | 'ROOM';
  targetId: string | null;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

const SELECT = {
  id: true,
  academicYearId: true,
  kind: true,
  targetGroupId: true,
  targetTeacherId: true,
  targetRoomId: true,
  label: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

type LinkRow = Prisma.PublicTimetableLinkGetPayload<{ select: typeof SELECT }>;

const toView = (row: LinkRow): PublicLinkView => ({
  id: row.id,
  academicYearId: row.academicYearId,
  kind: row.kind,
  targetId: row.targetGroupId ?? row.targetTeacherId ?? row.targetRoomId,
  label: row.label,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
});

/**
 * The share links of the public viewer and the teachers it never shows
 * (migration 20261011120000). The admin's: a link is made, listed and
 * revoked here, and the token is shown ONCE, when it is made — only its hash
 * is stored, so a lost link is revoked and made again, never read back.
 */
@Injectable()
export class PublicLinksService {
  private readonly logger = new Logger(PublicLinksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(academicYearId: string, user: AuthenticatedUser): Promise<PublicLinkView[]> {
    requireSchoolId(user);
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.publicTimetableLink.findMany({
        where: { academicYearId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: SELECT,
      }),
    );
    return rows.map(toView);
  }

  async create(dto: CreatePublicLinkDto, user: AuthenticatedUser): Promise<{ link: PublicLinkView; token: string }> {
    const schoolId = requireSchoolId(user);
    if (dto.kind === 'TEACHER' && (dto.targetId === undefined || dto.label !== undefined)) {
      throw new BadRequestException({
        message:
          'En lärarlänk gäller en lärare och får inget eget namn: den visar läraren som skolan valt (signatur eller namn), och en lista över alla lärare publiceras inte.',
        code: PUBLIC_LINK_SHAPE,
      });
    }
    const token = newToken();
    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.publicTimetableLink.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            kind: dto.kind,
            targetGroupId: dto.kind === 'GROUP' ? (dto.targetId ?? null) : null,
            targetTeacherId: dto.kind === 'TEACHER' ? dto.targetId! : null,
            targetRoomId: dto.kind === 'ROOM' ? (dto.targetId ?? null) : null,
            tokenHash: tokenHashOf(token),
            label: dto.label ?? null,
            createdByUserId: user.userId ?? null,
          },
          select: SELECT,
        }),
      );
      this.logger.log(`Public timetable link created [link=${row.id}, kind=${row.kind}]`);
      return { link: toView(row), token };
    } catch (error) {
      const refusal = viewerRefusal(error);
      if (refusal === PUBLIC_GROUP_TOO_SMALL) {
        throw new BadRequestException({
          message: 'targetId: gruppen är för liten för att visas offentligt med namn; en liten grupp kan peka ut eleverna.',
          code: PUBLIC_GROUP_TOO_SMALL,
        });
      }
      if (refusal === PUBLIC_TEACHER_NOT_SHOWABLE) {
        throw new BadRequestException({
          message: 'targetId: läraren kan inte visas offentligt.',
          code: PUBLIC_TEACHER_NOT_SHOWABLE,
        });
      }
      throw error;
    }
  }

  async revoke(id: string, user: AuthenticatedUser): Promise<PublicLinkView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const found = await tx.publicTimetableLink.findUnique({ where: { id }, select: { id: true, revokedAt: true } });
      if (!found) throw new NotFoundException('Länken finns inte.');
      const row = await tx.publicTimetableLink.update({
        where: { id },
        data: { revokedAt: found.revokedAt ?? new Date() },
        select: SELECT,
      });
      return toView(row);
    });
  }

  async hiddenTeachers(user: AuthenticatedUser): Promise<string[]> {
    requireSchoolId(user);
    const rows = await this.prisma.queryWithRls(user, (db) =>
      db.teacherPublicLabel.findMany({ where: { hidden: true }, select: { userId: true }, orderBy: { userId: 'asc' } }),
    );
    return rows.map((row) => row.userId);
  }

  /** A teacher never shown on any public timetable (skyddad identitet), or shown again. */
  async setHidden(userId: string, hidden: boolean, user: AuthenticatedUser): Promise<{ userId: string; hidden: boolean }> {
    const schoolId = requireSchoolId(user);
    const row = await this.prisma.withRls(user, (tx) =>
      tx.teacherPublicLabel.upsert({
        where: { userId },
        create: { userId, schoolId, hidden },
        update: { hidden },
        select: { userId: true, hidden: true },
      }),
    );
    return row;
  }
}

/** The link triggers' PB400 refusals (20261011120000), by the word that opens their message. */
export function viewerRefusal(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  const isPb400 = cause?.originalCode === 'PB400' || error.message.includes('Code: `PB400`');
  if (!isPb400) return null;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  return /PUBLIC_GROUP_TOO_SMALL/.test(text) ? PUBLIC_GROUP_TOO_SMALL : /PUBLIC_TEACHER_NOT_SHOWABLE/.test(text) ? PUBLIC_TEACHER_NOT_SHOWABLE : null;
}
