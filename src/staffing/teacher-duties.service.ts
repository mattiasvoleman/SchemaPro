import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TeacherDuty } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { SLOT_MINUTES, minutesOf } from '../common/solver-grid';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseDateString, toWallClock } from '../common/utils/time';
import { readYearBoundsForShare, type YearBounds } from '../resources/academic-year-bounds';
import { dayOf } from './duty-dates';
import {
  DUTY_SLOT_REASON,
  WITH_SLOT_TIMES,
  dutySlotConstraintData,
  dutySlotTimes,
  slotGridFault,
  slotsOfLinks,
  slotsOverlap,
  sortSlots,
  type DutySlot,
} from './duty-slot';
import { lockStaffRow } from './staff-lock';
import type {
  CreateTeacherDutyDto,
  TeacherDutySlotDto,
  UpdateTeacherDutyDto,
} from './dto/teacher-duty.dto';

/** The weekly time an uppdrag blocks, as the client wrote it and reads it back. */
export type TeacherDutySlot = DutySlot;

/**
 * An uppdrag as the client sees it: the row, its Från and Till as
 * yyyy-mm-dd, and its times read back from the linked constraints rather
 * than stored twice, Monday first.
 *
 * `blockedSlot` is the first of `slots` (or null), for the web release
 * before 20261017090000, which read it. The old one-time column
 * blockedConstraintId is no longer served: 20261022090000 retired it, and the
 * client never named a constraint anyway.
 */
export interface TeacherDutyResponse extends Omit<TeacherDuty, 'validFrom' | 'validTo'> {
  validFrom: string | null;
  validTo: string | null;
  slots: TeacherDutySlot[];
  blockedSlot: TeacherDutySlot | null;
}

type DutyWithSlots = Prisma.TeacherDutyGetPayload<{ include: typeof WITH_SLOT_TIMES }>;

function toResponse(row: DutyWithSlots): TeacherDutyResponse {
  const { slots: links, validFrom, validTo, ...duty } = row;
  // A constraint RLS hides (none should be: it is the teacher's own) or a
  // weekday-less one (the triggers refuse those) reads as no time rather
  // than as a half-filled one.
  const slots = slotsOfLinks(links);
  return {
    ...duty,
    validFrom: dayOf(validFrom),
    validTo: dayOf(validTo),
    slots,
    blockedSlot: slots[0] ?? null,
  };
}

const WEEKDAY = ['', 'måndag', 'tisdag', 'onsdag', 'torsdag', 'fredag', 'lördag', 'söndag'];
const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * A slot the solver can hold: whole minutes, on its five-minute grid, start
 * before end. Checked before a transaction is opened — it needs nothing from
 * the database — and in Swedish, naming the field, as the rest of this route
 * answers. `field` is the slot's place in the body: `slots[1]`, or the
 * legacy `blockedSlot`.
 */
export function assertDutySlot(slot: TeacherDutySlotDto, field = 'blockedSlot'): void {
  const fault = slotGridFault(slot);
  if (!fault) return;
  if (fault.kind === 'SECONDS') {
    throw new BadRequestException(
      `${field}.${fault.field}: anges i hela minuter — schemat räknar inte sekunder.`,
    );
  }
  if (fault.kind === 'OFF_GRID') {
    const value = slot[fault.field];
    const below = Math.floor(minutesOf(value) / SLOT_MINUTES) * SLOT_MINUTES;
    throw new BadRequestException(
      `${field}.${fault.field}: ${value.slice(0, 5)} ligger inte på schemats ${SLOT_MINUTES}-minutersrutnät. Närmast är ${clock(below)} eller ${clock(below + SLOT_MINUTES)}.`,
    );
  }
  throw new BadRequestException(
    `${field}: starttiden (${slot.startTime.slice(0, 5)}) måste ligga före sluttiden (${slot.endTime.slice(0, 5)}).`,
  );
}

/**
 * Every time on the grid, and no two of them sharing a minute: one uppdrag
 * holds a time once, and two overlapping rows would be one block the
 * drawer lists twice. `from` is the body field the times came in: a fault
 * in the previous web's single `blockedSlot` is named as that field.
 */
export function assertDutySlots(
  slots: readonly TeacherDutySlotDto[],
  from: 'slots' | 'blockedSlot' = 'slots',
): void {
  slots.forEach((slot, index) => assertDutySlot(slot, from === 'blockedSlot' ? 'blockedSlot' : `slots[${index}]`));
  for (let i = 0; i < slots.length; i += 1) {
    for (let j = i + 1; j < slots.length; j += 1) {
      if (slotsOverlap(slots[i], slots[j])) {
        const a = slots[i];
        const b = slots[j];
        throw new BadRequestException(
          `slots[${j}]: ${WEEKDAY[b.dayOfWeek]} ${b.startTime.slice(0, 5)}–${b.endTime.slice(0, 5)} överlappar ` +
            `${a.startTime.slice(0, 5)}–${a.endTime.slice(0, 5)} samma dag. Ett uppdrag håller en tid en gång.`,
        );
      }
    }
  }
}

/**
 * The times a body asks for: `slots`, or the legacy `blockedSlot` as a list
 * of one (null as none). Undefined when it names neither, which a PATCH reads
 * as "leave the times alone". Both at once is a question with two answers.
 */
function requestedSlots(dto: CreateTeacherDutyDto | UpdateTeacherDutyDto): DutySlot[] | undefined {
  if (dto.slots !== undefined && dto.blockedSlot !== undefined) {
    throw new BadRequestException(
      'slots och blockedSlot: ange uppdragets tider i slots — blockedSlot är den äldre formen för en enda tid.',
    );
  }
  if (dto.slots !== undefined) return dto.slots ?? [];
  if (dto.blockedSlot !== undefined) return dto.blockedSlot ? [dto.blockedSlot] : [];
  return undefined;
}

/**
 * Från not after Till, and both inside the läsår when the year could be read
 * (null: RLS hid it, and the duty's own foreign key answers that). Bounds
 * the body left out are the row's, as for a requirement's period.
 */
function assertDutyDates(year: YearBounds | null, validFrom: Date | null, validTo: Date | null): void {
  const day = (value: Date) => value.toISOString().slice(0, 10);
  if (validFrom && validTo && validTo < validFrom) {
    throw new BadRequestException(
      `validTo: Till (${day(validTo)}) ligger före Från (${day(validFrom)}).`,
    );
  }
  if (!year) return;
  for (const [field, value] of [
    ['validFrom', validFrom],
    ['validTo', validTo],
  ] as const) {
    if (value && (value < year.startDate || value > year.endDate)) {
      throw new BadRequestException(
        `${field}: ${day(value)} ligger utanför läsåret (${day(year.startDate)} – ${day(year.endDate)}). ` +
          'Ett uppdrag gäller inom sitt läsår; lämna fältet tomt för läsårets egen gräns.',
      );
    }
  }
}

/** Which body field the times came in, for the 400's field name. */
const slotsField = (dto: CreateTeacherDutyDto | UpdateTeacherDutyDto): 'slots' | 'blockedSlot' =>
  dto.slots === undefined && dto.blockedSlot !== undefined ? 'blockedSlot' : 'slots';

const dateOrNull = (value: string | null | undefined): Date | null =>
  value ? parseDateString(value) : null;

/** Kept here for the callers that import it with the service; see duty-slot.ts. */
export { DUTY_SLOT_REASON };

/**
 * Lärarnas uppdrag: mentorskap, ämnesansvar, rastvakt, APT — the part of a
 * tjänst that is not a timplanspost.
 *
 * ONE WRITER, AS FOR THE POST. An admin writes uppdrag; a teacher reads their
 * own and no colleague's — teacher_duties_teacher_own_select says so for every
 * door, and the list below filters the same way so the gateway and RLS agree.
 * A teacher naming a colleague in the query gets a 403 rather than a quietly
 * emptier list: the question itself is one they may not ask.
 *
 * A FIXED TIME IS A CONSTRAINT THE SERVICE OWNS. Each of `slots` becomes one
 * UNAVAILABLE TEACHER AvailabilityConstraint on that weekday, linked to the
 * uppdrag by a TeacherDutySlots row, all created, moved and deleted in the
 * SAME transaction as the duty, so the timetable never holds a rastvakt slot
 * without its uppdrag or the reverse. The client never names a constraint.
 * The database checks every link as well (TeacherDutySlots_are_the_teachers,
 * migration 20261017090000): what this service writes always passes it, and
 * a PostgREST writer that points a link elsewhere does not.
 *
 * DATES ARE THE UPPDRAG'S, MEASURED AGAINST ITS LÄSÅR. Från and Till lie
 * inside the year, read FOR SHARE in the write's transaction so a year PATCH
 * narrowing the bounds cannot pass the write in between
 * (academic-year-bounds.ts). The times run on the uppdrag's dates; the
 * weekly master holds them all year (duty-slot-year.ts).
 *
 * THE DUTY ROW IS LOCKED before a time is touched. Two PATCHes replacing the
 * times of one duty would otherwise both read its links, both decide what to
 * create, and leave the union — UNAVAILABLE rows blocking the teacher for
 * times nobody chose. FOR NO KEY UPDATE, as everywhere a row is locked to be
 * written without changing its key.
 */
@Injectable()
export class TeacherDutiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    academicYearId: string,
    userId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse[]> {
    requireSchoolId(user);
    let where: Prisma.TeacherDutyWhereInput;
    if (user.role === Role.SCHOOL_ADMIN) {
      where = userId ? { academicYearId, userId } : { academicYearId };
    } else {
      const own = requireUserId(user);
      if (userId && userId !== own) {
        throw new ForbiddenException('Du kan bara läsa dina egna uppdrag.');
      }
      // Duplicates the RLS arm on purpose, as the employments list does.
      where = { academicYearId, userId: own };
    }
    const rows = await this.prisma.withRls(user, async (tx) => {
      const found = await tx.teacherDuty.findMany({
        where,
        include: WITH_SLOT_TIMES,
        orderBy: [{ userId: 'asc' }, { kind: 'asc' }, { label: 'asc' }],
      });
      // Each teacher's uppdrag, with minutes, notes and times: EMPLOYMENT in
      // the läslogg, as their posts are (a teacher's own are left out).
      await recordRead(tx, 'EMPLOYMENT', found.map((row) => row.userId), user.channel);
      return found;
    });
    return rows.map(toResponse);
  }

  async create(dto: CreateTeacherDutyDto, user: AuthenticatedUser): Promise<TeacherDutyResponse> {
    const schoolId = requireSchoolId(user);
    const slots = requestedSlots(dto) ?? [];
    assertDutySlots(slots, slotsField(dto));
    const validFrom = dateOrNull(dto.validFrom);
    const validTo = dateOrNull(dto.validTo);
    assertDutyDates(null, validFrom, validTo);

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        // The person is staff, and stays staff until this commits: the role
        // PATCH reads the same row under the same lock.
        await lockStaffRow(tx, dto.userId, 'uppdrag');
        if (validFrom || validTo) {
          assertDutyDates(await readYearBoundsForShare(tx, dto.academicYearId), validFrom, validTo);
        }
        const duty = await tx.teacherDuty.create({
          data: {
            schoolId,
            userId: dto.userId,
            academicYearId: dto.academicYearId,
            kind: dto.kind,
            label: dto.label.trim(),
            minutesPerWeek: dto.minutesPerWeek,
            countsAsTeaching: dto.countsAsTeaching ?? false,
            subjectId: dto.subjectId ?? null,
            studentGroupId: dto.studentGroupId ?? null,
            validFrom,
            validTo,
            note: dto.note?.trim() || null,
          },
          select: { id: true },
        });
        await addSlots(tx, schoolId, duty.id, dto.userId, slots);
        return tx.teacherDuty.findUniqueOrThrow({ where: { id: duty.id }, include: WITH_SLOT_TIMES });
      });
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTeacherDutyDto,
    user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse> {
    const schoolId = requireSchoolId(user);
    const slots = requestedSlots(dto);
    if (slots) assertDutySlots(slots, slotsField(dto));

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const current = await lockDuty(tx, id);
        // Another school's row is invisible under RLS and reads as missing,
        // which is the 404 the update itself would give.
        if (!current) throw new NotFoundException('The requested record does not exist.');

        // The pair as it will END UP: a PATCH moving only Till is measured
        // with the Från already on the row.
        const datesMove = dto.validFrom !== undefined || dto.validTo !== undefined;
        const validFrom = dto.validFrom !== undefined ? dateOrNull(dto.validFrom) : current.validFrom;
        const validTo = dto.validTo !== undefined ? dateOrNull(dto.validTo) : current.validTo;
        if (datesMove) {
          assertDutyDates(
            validFrom || validTo ? await readYearBoundsForShare(tx, current.academicYearId) : null,
            validFrom,
            validTo,
          );
        }

        if (slots) await replaceSlots(tx, schoolId, current, slots);

        const label = dto.label !== undefined ? dto.label.trim() : current.label;
        return tx.teacherDuty.update({
          where: { id },
          data: {
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.label !== undefined ? { label } : {}),
            ...(dto.minutesPerWeek !== undefined ? { minutesPerWeek: dto.minutesPerWeek } : {}),
            ...(dto.countsAsTeaching !== undefined
              ? { countsAsTeaching: dto.countsAsTeaching }
              : {}),
            ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
            ...(dto.studentGroupId !== undefined ? { studentGroupId: dto.studentGroupId } : {}),
            ...(dto.validFrom !== undefined ? { validFrom } : {}),
            ...(dto.validTo !== undefined ? { validTo } : {}),
            ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
          },
          include: WITH_SLOT_TIMES,
        });
      });
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /** Deletes the uppdrag and the times it blocked, in one transaction. */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const current = await lockDuty(tx, id);
        if (!current) throw new NotFoundException('The requested record does not exist.');
        const links = await tx.teacherDutySlot.findMany({
          where: { teacherDutyId: id },
          select: { availabilityConstraintId: true },
        });
        await tx.teacherDuty.delete({ where: { id } });
        if (links.length > 0) {
          // The links cascade with the duty and TeacherDutySlots_take_their_block
          // has already deleted each constraint; this says so in the code that
          // owns the pair, and costs a statement that finds nothing. deleteMany,
          // so a count of 0 is no reason to fail the delete asked for.
          await tx.availabilityConstraint.deleteMany({
            where: { id: { in: links.map((link) => link.availabilityConstraintId) } },
          });
        }
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

type LockedDuty = Pick<
  TeacherDuty,
  'id' | 'userId' | 'academicYearId' | 'label' | 'validFrom' | 'validTo'
>;

/**
 * The duty row, read under a row lock in the transaction that writes it or its
 * times. Raw SQL because Prisma has no locking read; under RLS the lock also
 * needs the UPDATE policy, which only teacher_duties_admin_all grants, so a
 * row the caller may not write reads as missing. A raw `date` column comes
 * back as the same midnight-UTC Date the model API returns.
 */
async function lockDuty(tx: Prisma.TransactionClient, id: string): Promise<LockedDuty | undefined> {
  const [row] = await tx.$queryRaw<LockedDuty[]>`
    SELECT "id", "userId", "academicYearId", "label", "validFrom", "validTo"
    FROM "TeacherDuties"
    WHERE "id" = ${id}::uuid
    FOR NO KEY UPDATE
  `;
  return row;
}

/**
 * New times for a duty: one constraint per time, then every link in ONE
 * statement — the history writes one version per statement and uppdrag
 * ("0 → 3"), not one per time.
 */
async function addSlots(
  tx: Prisma.TransactionClient,
  schoolId: string,
  teacherDutyId: string,
  userId: string,
  slots: readonly DutySlot[],
): Promise<void> {
  if (slots.length === 0) return;
  const constraintIds: string[] = [];
  for (const slot of sortSlots(slots)) {
    const constraint = await tx.availabilityConstraint.create({
      data: dutySlotConstraintData(schoolId, userId, slot),
      select: { id: true },
    });
    constraintIds.push(constraint.id);
  }
  await tx.teacherDutySlot.createMany({
    data: constraintIds.map((availabilityConstraintId) => ({
      schoolId,
      teacherDutyId,
      availabilityConstraintId,
    })),
  });
}

const sameTime = (a: DutySlot, b: DutySlot) =>
  a.dayOfWeek === b.dayOfWeek &&
  minutesOf(a.startTime) === minutesOf(b.startTime) &&
  minutesOf(a.endTime) === minutesOf(b.endTime);

/**
 * The duty's times become `wanted`, touching as little as possible:
 *
 *   * a time that is already there keeps its constraint and its link;
 *   * a time that moved takes over a constraint that is no longer wanted —
 *     an UPDATE of the constraint, as a PATCH of the one time always was, so
 *     the link stays and the history counts no change;
 *   * what is left over is added, or removed, in one statement each. Removing
 *     a link deletes its constraint (TeacherDutySlots_take_their_block), so a
 *     time nobody holds never keeps blocking the teacher.
 *
 * A moved time gets the bare reason again whatever its row said, as the
 * single time did.
 */
async function replaceSlots(
  tx: Prisma.TransactionClient,
  schoolId: string,
  duty: LockedDuty,
  wanted: readonly DutySlot[],
): Promise<void> {
  const links = await tx.teacherDutySlot.findMany({
    where: { teacherDutyId: duty.id },
    select: {
      id: true,
      availabilityConstraintId: true,
      availabilityConstraint: { select: { dayOfWeek: true, startTime: true, endTime: true } },
    },
  });
  const held = sortSlots(
    links
      .filter((link) => link.availabilityConstraint?.dayOfWeek != null)
      .map((link) => ({
        linkId: link.id,
        constraintId: link.availabilityConstraintId,
        dayOfWeek: link.availabilityConstraint.dayOfWeek as number,
        startTime: toWallClock(link.availabilityConstraint.startTime),
        endTime: toWallClock(link.availabilityConstraint.endTime),
      })),
  );
  // A link whose constraint has no weekday is no time the drawer can show;
  // it is replaced like any other unwanted one.
  const unreadable = links.filter((link) => link.availabilityConstraint?.dayOfWeek == null);

  const spare = [...held];
  const toPlace: DutySlot[] = [];
  for (const slot of sortSlots(wanted)) {
    const index = spare.findIndex((candidate) => sameTime(candidate, slot));
    if (index >= 0) spare.splice(index, 1);
    else toPlace.push(slot);
  }

  const moves = Math.min(spare.length, toPlace.length);
  for (let index = 0; index < moves; index += 1) {
    await tx.availabilityConstraint.update({
      where: { id: spare[index].constraintId },
      data: { ...dutySlotTimes(toPlace[index]), reason: DUTY_SLOT_REASON },
      select: { id: true },
    });
  }
  await addSlots(tx, schoolId, duty.id, duty.userId, toPlace.slice(moves));
  const dropped = [...spare.slice(moves).map((slot) => slot.linkId), ...unreadable.map((link) => link.id)];
  if (dropped.length > 0) {
    await tx.teacherDutySlot.deleteMany({ where: { id: { in: dropped } } });
  }
}
