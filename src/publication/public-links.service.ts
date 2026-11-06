import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { todayInZone } from '../common/utils/time';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { codeForDisplay, newCode, tokenHashOf } from './public-token';
import type { CreatePublicLinkDto } from './dto/publication.dto';
import { recordRead } from '../access-log/access-log';
import { DEFAULT_VIEWER_MODES, modeFor, viewerIsOn, type ViewerMode, type ViewerModes } from './viewer-modes';

export const PUBLIC_GROUP_TOO_SMALL = 'PUBLIC_GROUP_TOO_SMALL';
export const PUBLIC_TEACHER_NOT_SHOWABLE = 'PUBLIC_TEACHER_NOT_SHOWABLE';
export const PUBLIC_STUDENT_NOT_SHOWABLE = 'PUBLIC_STUDENT_NOT_SHOWABLE';
export const PUBLIC_LINK_SHAPE = 'PUBLIC_LINK_SHAPE';

export interface PublicLinkView {
  id: string;
  academicYearId: string;
  kind: 'GROUP' | 'TEACHER' | 'ROOM' | 'STUDENT';
  targetId: string | null;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /**
   * Why a link that is not revoked still answers the viewer's one 404, or
   * null when it resolves. The same predicate app.public_timetable asks
   * (20261011120000, 20261011133000); the probe pins the two together.
   */
  notShownBecause: NotShownReason | null;
  /**
   * Whether the school lets this link's viewer be framed by its websites
   * (20261102090000): not revoked, the viewer answering the link, open to
   * everyone, the scope's embedding on and at least one website; never a
   * pupil's. The same predicate app.public_timetable_embed asks; the probe
   * pins the two together.
   */
  embeddable: boolean;
}

type EmbedSettings = Pick<
  Prisma.PublicationSettingsGetPayload<object>,
  'viewerAudience' | 'publicEmbedGroups' | 'publicEmbedTeachers' | 'publicEmbedRooms' | 'publicEmbedOrigins'
>;

/**
 * app.public_timetable_embed's settings half, for a link of `kind`: the
 * viewer is open to everyone, the kind's embedding is on and there is a
 * website. Whether the viewer answers the link at all is notShownBecause's.
 */
export function embedsKind(settings: EmbedSettings | null, kind: 'GROUP' | 'TEACHER' | 'ROOM' | 'STUDENT'): boolean {
  if (!settings || settings.viewerAudience !== 'EVERYONE' || settings.publicEmbedOrigins.length === 0) return false;
  if (kind === 'GROUP') return settings.publicEmbedGroups;
  if (kind === 'ROOM') return settings.publicEmbedRooms;
  if (kind === 'TEACHER') return settings.publicEmbedTeachers;
  return false;
}

/**
 * Why a link that is not revoked still answers the viewer's 404 to a visitor
 * (the admin may read it; the visitor never learns it). AUDIENCE is not one:
 * a viewer for staff is every link's, and the page says so once.
 */
export type NotShownReason =
  | 'VIEWER_OFF'
  | 'SCOPE_OFF'
  | 'INDEX_NOT_LISTED'
  | 'TEACHER_HIDDEN'
  | 'TARGET_HIDDEN'
  | 'PROTECTED'
  | 'TARGET_GONE'
  | 'NO_SIGNATURE'
  | 'GROUP_TOO_SMALL'
  | 'YEAR_ENDED';

const SELECT = {
  id: true,
  academicYearId: true,
  kind: true,
  targetGroupId: true,
  targetTeacherId: true,
  targetRoomId: true,
  targetStudentId: true,
  label: true,
  createdAt: true,
  revokedAt: true,
  lastUsedAt: true,
} as const;

type LinkRow = Prisma.PublicTimetableLinkGetPayload<{ select: typeof SELECT }>;

const toView = (row: LinkRow, notShownBecause: NotShownReason | null, embeddable: boolean): PublicLinkView => ({
  id: row.id,
  academicYearId: row.academicYearId,
  kind: row.kind,
  targetId: row.targetGroupId ?? row.targetTeacherId ?? row.targetRoomId ?? row.targetStudentId,
  label: row.label,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  notShownBecause,
  embeddable: embeddable && row.revokedAt === null,
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
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.publicTimetableLink.findMany({
        where: { academicYearId },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: SELECT,
      });
      if (rows.length === 0) return [];
      const reasons = await notShownReasons(tx as unknown as PrismaClient, academicYearId, rows);
      const settings = await tx.publicationSettings.findUnique({ where: { schoolId } });
      // Framed only where the viewer answers the link at all, as the database asks.
      return rows.map((row) => {
        const reason = reasons.get(row.id) ?? null;
        return toView(row, reason, reason === null && embedsKind(settings, row.kind));
      });
    });
  }

  async create(dto: CreatePublicLinkDto, user: AuthenticatedUser): Promise<{ link: PublicLinkView; token: string }> {
    const schoolId = requireSchoolId(user);
    // A teacher's link has no name of its own (it is titled by the school's
    // display), and a pupil's always names the pupil. A teacher with no
    // target is the list of teachers, which only a school that shows
    // teachers as a list has an answer for.
    if (
      (dto.kind === 'TEACHER' && dto.label !== undefined) ||
      (dto.kind === 'STUDENT' && dto.targetId === undefined)
    ) {
      throw new BadRequestException({
        message:
          dto.kind === 'STUDENT'
            ? 'En elevlänk gäller en elev: den har en kod och inget index, för en lista över elever vore ett register över var de är.'
            : 'En lärarlänk får inget eget namn: den visar läraren som skolan valt (signatur eller namn).',
        code: PUBLIC_LINK_SHAPE,
      });
    }
    // A code, not a name or a signature: a hundred random bits that are on
    // no page and can be typed from a letter. Only its hash is stored.
    const code = newCode();
    try {
      const { row, reason, embeddable } = await this.prisma.withRls(user, async (tx) => {
        const created = await tx.publicTimetableLink.create({
          data: {
            schoolId,
            academicYearId: dto.academicYearId,
            kind: dto.kind,
            targetGroupId: dto.kind === 'GROUP' ? (dto.targetId ?? null) : null,
            targetTeacherId: dto.kind === 'TEACHER' ? (dto.targetId ?? null) : null,
            targetRoomId: dto.kind === 'ROOM' ? (dto.targetId ?? null) : null,
            targetStudentId: dto.kind === 'STUDENT' ? dto.targetId! : null,
            tokenHash: tokenHashOf(code),
            label: dto.label ?? null,
            createdByUserId: user.userId ?? null,
          },
          select: SELECT,
        });
        const settings = await tx.publicationSettings.findUnique({ where: { schoolId } });
        const reasons = await notShownReasons(tx as unknown as PrismaClient, dto.academicYearId, [created]);
        const why = reasons.get(created.id) ?? null;
        return { row: created, reason: why, embeddable: why === null && embedsKind(settings, created.kind) };
      });
      this.logger.log(`Public timetable link created [link=${row.id}, kind=${row.kind}]`);
      return { link: toView(row, reason, embeddable), token: codeForDisplay(code) };
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
      if (refusal === PUBLIC_STUDENT_NOT_SHOWABLE) {
        throw new BadRequestException({
          message: 'targetId: eleven kan inte visas offentligt.',
          code: PUBLIC_STUDENT_NOT_SHOWABLE,
        });
      }
      throw error;
    }
  }

  async revoke(id: string, user: AuthenticatedUser): Promise<PublicLinkView> {
    requireSchoolId(user);
    // A revoked link answers nothing and frames nowhere.
    return this.prisma.withRls(user, async (tx) => {
      const found = await tx.publicTimetableLink.findUnique({ where: { id }, select: { id: true, revokedAt: true } });
      if (!found) throw new NotFoundException('Länken finns inte.');
      const row = await tx.publicTimetableLink.update({
        where: { id },
        data: { revokedAt: found.revokedAt ?? new Date() },
        select: SELECT,
      });
      return toView(row, null, false);
    });
  }

  async hiddenTeachers(user: AuthenticatedUser): Promise<string[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.teacherPublicLabel.findMany({
        where: { hidden: true },
        select: { userId: true },
        orderBy: { userId: 'asc' },
      });
      // Which teachers are never shown in public is skyddad identitet, a fact
      // about each of them: recorded as the register's facts are (PEOPLE).
      await recordRead(tx, 'PEOPLE', rows.map((row) => row.userId), user.channel);
      return rows.map((row) => row.userId);
    });
  }

  /**
   * The classes, groups, rooms and pupils the school hides from Schemavisaren
   * one by one (20270118090000). Which pupils are hidden is a fact about each
   * of them: recorded as the register's facts are (PEOPLE).
   */
  async hiddenTargets(user: AuthenticatedUser): Promise<HiddenTargets> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.publicTimetableHidden.findMany({
        select: { targetGroupId: true, targetRoomId: true, targetStudentId: true },
        orderBy: { id: 'asc' },
      });
      const students = rows.map((row) => row.targetStudentId).filter((id): id is string => id !== null);
      await recordRead(tx, 'PEOPLE', students, user.channel);
      return {
        groups: rows.map((row) => row.targetGroupId).filter((id): id is string => id !== null),
        rooms: rows.map((row) => row.targetRoomId).filter((id): id is string => id !== null),
        students,
      };
    });
  }

  /** A class, group, room or pupil hidden from Schemavisaren, or shown again. */
  async setHiddenTarget(kind: HiddenKind, id: string, hidden: boolean, user: AuthenticatedUser): Promise<{ kind: HiddenKind; id: string; hidden: boolean }> {
    const schoolId = requireSchoolId(user);
    const column = kind === 'group' ? 'targetGroupId' : kind === 'room' ? 'targetRoomId' : 'targetStudentId';
    await this.prisma.withRls(user, async (tx) => {
      if (hidden) {
        // A pupil, group or room of another school is no key of this one's (composite foreign key): 23503, an unknown id.
        await tx.publicTimetableHidden.upsert({
          where: { [column]: id } as never,
          create: { schoolId, [column]: id },
          update: {},
        });
      } else {
        await tx.publicTimetableHidden.deleteMany({ where: { [column]: id } });
      }
    });
    return { kind, id, hidden };
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

/** The kinds of hidden schedule the table holds; a teacher's is TeacherPublicLabels'. */
export type HiddenKind = 'group' | 'room' | 'student';
export interface HiddenTargets {
  groups: string[];
  rooms: string[];
  students: string[];
}

/** The link triggers' PB400 refusals (20261011120000), by the word that opens their message. */
export function viewerRefusal(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  const isPb400 = cause?.originalCode === 'PB400' || error.message.includes('Code: `PB400`');
  if (!isPb400) return null;
  const text = typeof cause?.originalMessage === 'string' ? cause.originalMessage : error.message;
  if (/PUBLIC_GROUP_TOO_SMALL/.test(text)) return PUBLIC_GROUP_TOO_SMALL;
  if (/PUBLIC_TEACHER_NOT_SHOWABLE/.test(text)) return PUBLIC_TEACHER_NOT_SHOWABLE;
  return /PUBLIC_STUDENT_NOT_SHOWABLE/.test(text) ? PUBLIC_STUDENT_NOT_SHOWABLE : null;
}

/**
 * Why each unrevoked link answers the viewer's 404: app.schemavisaren_read's
 * own conditions, in its order, read the way an admin can read them. The
 * list showed "Aktiv" on a link a hidden teacher, a switched-off kind, a
 * shrunk group or an ended year had already made a 404.
 */
async function notShownReasons(
  tx: PrismaClient,
  academicYearId: string,
  rows: readonly LinkRow[],
): Promise<Map<string, NotShownReason>> {
  const out = new Map<string, NotShownReason>();
  const live = rows.filter((row) => row.revokedAt === null);
  if (live.length === 0) return out;
  const year = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { schoolId: true, endDate: true, school: { select: { timezone: true } } },
  });
  if (!year) return out;
  const settings = await tx.publicationSettings.findUnique({ where: { schoolId: year.schoolId } });
  const modes: ViewerModes = settings ?? DEFAULT_VIEWER_MODES;
  const teacherIds = live.map((row) => row.targetTeacherId).filter((id): id is string => id !== null);
  const studentIds = live.map((row) => row.targetStudentId).filter((id): id is string => id !== null);
  const groupIds = live.map((row) => row.targetGroupId).filter((id): id is string => id !== null);
  const roomIds = live.map((row) => row.targetRoomId).filter((id): id is string => id !== null);
  const hiddenTeachers = new Set(
    (await tx.teacherPublicLabel.findMany({ where: { hidden: true, userId: { in: teacherIds } }, select: { userId: true } })).map(
      (label) => label.userId,
    ),
  );
  const hiddenTargets = await tx.publicTimetableHidden.findMany({
    where: { OR: [{ targetGroupId: { in: groupIds } }, { targetRoomId: { in: roomIds } }, { targetStudentId: { in: studentIds } }] },
    select: { targetGroupId: true, targetRoomId: true, targetStudentId: true },
  });
  const hiddenIds = new Set(hiddenTargets.flatMap((row) => [row.targetGroupId, row.targetRoomId, row.targetStudentId]).filter((id): id is string => id !== null));
  // A pupil is protected by a mark of their own or of a guardian of theirs.
  const guardians = studentIds.length
    ? await tx.guardianStudent.findMany({ where: { studentId: { in: studentIds } }, select: { studentId: true, guardianId: true } })
    : [];
  const marked = new Set(
    (
      await tx.personProtection.findMany({
        where: { userId: { in: [...teacherIds, ...studentIds, ...guardians.map((link) => link.guardianId)] } },
        select: { userId: true },
      })
    ).map((mark) => mark.userId),
  );
  const pupilsWithMarkedGuardian = new Set(guardians.filter((link) => marked.has(link.guardianId)).map((link) => link.studentId));
  const pupils = new Map(
    (await tx.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, isActive: true, role: true } })).map((user) => [user.id, user]),
  );
  const signed = new Set(
    (
      await tx.teacherEmployment.findMany({
        where: { academicYearId, userId: { in: teacherIds }, signature: { not: null } },
        select: { userId: true },
      })
    ).map((post) => post.userId),
  );
  const groups = new Map(
    (
      await tx.studentGroup.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, kind: true, _count: { select: { teachingMembers: { where: { student: { isActive: true } } } } } },
      })
    ).map((group) => [group.id, group]),
  );
  // The viewer's week without a date is today's, and a week past the year is no week of the link's.
  const today = todayInZone(year.school.timezone);
  const ended = today.getTime() > year.endDate.getTime();
  const anyOn = viewerIsOn(modes);
  for (const row of live) {
    const target = row.targetGroupId ?? row.targetTeacherId ?? row.targetRoomId ?? row.targetStudentId;
    const group = row.targetGroupId ? groups.get(row.targetGroupId) : undefined;
    // Which mode governs the link: its kind's, and for a link to one group its group's kind.
    let mode: ViewerMode;
    if (row.kind === 'GROUP' && target === null) {
      mode = modes.viewerClassMode === 'LIST' || modes.viewerGroupMode === 'LIST' ? 'LIST' : modes.viewerClassMode !== 'OFF' || modes.viewerGroupMode !== 'OFF' ? 'CODE' : 'OFF';
    } else {
      mode = modeFor(modes, row.kind, group ? (group.kind === 'CLASS' ? 'CLASS' : 'TEACHING_GROUP') : null);
    }
    let reason: NotShownReason | null = null;
    if (!anyOn) reason = 'VIEWER_OFF';
    else if (mode === 'OFF' || (row.kind === 'TEACHER' && settings?.publicTeacherDisplay === 'NONE')) reason = 'SCOPE_OFF';
    else if (target === null && mode !== 'LIST') reason = 'INDEX_NOT_LISTED';
    else if (row.targetTeacherId && hiddenTeachers.has(row.targetTeacherId)) reason = 'TEACHER_HIDDEN';
    else if (target !== null && hiddenIds.has(target)) reason = 'TARGET_HIDDEN';
    else if (row.targetTeacherId && marked.has(row.targetTeacherId)) reason = 'PROTECTED';
    else if (row.targetStudentId && (marked.has(row.targetStudentId) || pupilsWithMarkedGuardian.has(row.targetStudentId))) reason = 'PROTECTED';
    else if (row.targetStudentId && !(pupils.get(row.targetStudentId)?.isActive && pupils.get(row.targetStudentId)?.role === 'STUDENT')) reason = 'TARGET_GONE';
    else if (row.targetTeacherId && settings?.publicTeacherDisplay === 'SIGNATURE' && !signed.has(row.targetTeacherId)) {
      reason = 'NO_SIGNATURE';
    } else if (group && group.kind !== 'CLASS' && settings && group._count.teachingMembers < settings.publicMinGroupSize) reason = 'GROUP_TOO_SMALL';
    if (reason === null && ended) reason = 'YEAR_ENDED';
    if (reason !== null) out.set(row.id, reason);
  }
  return out;
}
