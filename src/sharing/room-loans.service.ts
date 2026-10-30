import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient, type RoomLoanStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import type { CreateRoomLoanDto } from './dto/sharing.dto';
import { roomLoanRefusal } from './sharing-errors';
import { siblingSchools } from './sharing.service';

/**
 * Salslån (Delade lokaler och lärare, 20261217090000): a room of another
 * school of the huvudman, borrowed for weekly windows between two dates.
 *
 * The borrower holds the room by a room of its own (the loan's local room),
 * since its lessons need a room of their own school. The first request
 * makes it in the borrower's own transaction, under the borrower's own arms
 * on Rooms; every later request for the same room names it again. The loan
 * itself is written only by the database's four functions, each for one
 * side, and both schools read the loans between them.
 *
 * No person's name crosses: a loan says which school asked and which
 * answered. The rooms a school may ask for are another school's names,
 * capacities and room types (app.lendable_rooms), no personal data, so
 * nothing here is written to the read log.
 */
export interface RoomLoanView {
  id: string;
  status: RoomLoanStatus;
  /** ISO weekday, 1 = Monday. */
  dayOfWeek: number;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  endDate: string;
  /** The borrower's note to the owner. */
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  endedAt: string | null;
  /**
   * This school's room: the room lent out (a loan the school lends), or the
   * school's own room for the room it borrows.
   */
  room: { id: string; name: string };
  /** The other school, while it has the same huvudman (the arms show nothing else). */
  school: { id: string; name: string };
  /** For a borrowed room: the owner's name for it, while the owner offers it. */
  ownerRoomName: string | null;
  /**
   * For a borrowed room: the owner's room, for asking again (the next
   * läsår's loan). Null for a room the school lends.
   */
  ownerRoomId: string | null;
}

export interface RoomLoansView {
  /** Loans of this school's rooms to the other schools. */
  lent: RoomLoanView[];
  /** Loans of the other schools' rooms to this school. */
  borrowed: RoomLoanView[];
}

export interface LendableRoomView {
  id: string;
  name: string;
  capacity: number | null;
  roomTypeName: string | null;
  /** The school's own room for it, when it has borrowed the room before. */
  localRoomId: string | null;
}

export interface LendableSchoolView {
  id: string;
  name: string;
  rooms: LendableRoomView[];
}

export const ROOM_LOAN_LOCAL_ROOM_NAME_TAKEN = 'ROOM_LOAN_LOCAL_ROOM_NAME_TAKEN';
export const ROOM_LOAN_WINDOW_INVALID = 'ROOM_LOAN_WINDOW_INVALID';

/** At most 400 days between the first date and the last (RoomLoans_at_most_400_days). */
export const MAX_LOAN_DAYS = 400;

const clock = (time: Date): string => time.toISOString().slice(11, 16);
const day = (date: Date): string => date.toISOString().slice(0, 10);
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;

/** A request the database would refuse by its checks, refused first with a sentence. */
export function windowProblem(dto: Pick<CreateRoomLoanDto, 'windows' | 'startDate' | 'endDate'>): string | null {
  for (const window of dto.windows) {
    if (minutesOf(window.startTime) >= minutesOf(window.endTime)) {
      return 'Varje tid behöver sluta efter att den börjar.';
    }
  }
  const span = daysBetween(dto.startDate, dto.endDate);
  if (!(span >= 0)) return 'Lånets sista dag kommer före dess första.';
  if (span > MAX_LOAN_DAYS) return `Ett lån gäller högst ${MAX_LOAN_DAYS} dagar. Begär nästa läsår för sig.`;
  const keys = dto.windows.map((window) => `${window.dayOfWeek} ${minutesOf(window.startTime)}`);
  if (new Set(keys).size !== keys.length) return 'Samma tid står två gånger.';
  return null;
}

const LOAN_SELECT = {
  id: true,
  status: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  startDate: true,
  endDate: true,
  note: true,
  createdAt: true,
  decidedAt: true,
  endedAt: true,
  roomId: true,
  ownerSchoolId: true,
  borrowerSchoolId: true,
} as const;

@Injectable()
export class RoomLoansService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<RoomLoansView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, (tx) => this.read(tx, schoolId));
  }

  /** The rooms of the other schools of the huvudman the school may ask to borrow, by school. */
  async rooms(user: AuthenticatedUser): Promise<LendableSchoolView[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const siblings = await siblingSchools(tx);
      const rooms = await lendableRooms(tx);
      const locals = await tx.roomLoan.findMany({
        where: { borrowerSchoolId: schoolId },
        distinct: ['roomId'],
        select: { roomId: true, localRoomId: true },
      });
      const localOf = new Map(locals.map((row) => [row.roomId, row.localRoomId]));
      return siblings
        .map((school) => ({
          id: school.id,
          name: school.name,
          rooms: rooms
            .filter((room) => room.schoolId === school.id)
            .map((room) => ({
              id: room.id,
              name: room.name,
              capacity: room.capacity,
              roomTypeName: room.roomTypeName,
              localRoomId: localOf.get(room.id) ?? null,
            })),
        }))
        .filter((school) => school.rooms.length > 0);
    });
  }

  async request(dto: CreateRoomLoanDto, user: AuthenticatedUser): Promise<RoomLoansView> {
    const schoolId = requireSchoolId(user);
    requireUserId(user);
    const problem = windowProblem(dto);
    if (problem) throw new BadRequestException({ message: problem, code: ROOM_LOAN_WINDOW_INVALID });
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const room = (await lendableRooms(tx)).find((row) => row.id === dto.roomId);
        if (!room) {
          throw new NotFoundException({
            message: 'Salen finns inte bland huvudmannens andra skolors salar.',
            code: 'ROOM_LOAN_ROOM_NOT_FOUND',
          });
        }
        const earlier = await tx.roomLoan.findFirst({
          where: { borrowerSchoolId: schoolId, roomId: dto.roomId },
          select: { localRoomId: true },
        });
        const localRoomId = dto.localRoomId ?? earlier?.localRoomId ?? (await this.makeLocalRoom(tx, schoolId, dto, room));
        const note = dto.note?.trim() ? dto.note.trim() : null;
        for (const window of dto.windows) {
          await tx.$queryRaw(
            Prisma.sql`SELECT app.room_loan_request(${dto.roomId}::uuid, ${localRoomId}::uuid, ${window.dayOfWeek}::integer,
                                                    ${window.startTime}::time, ${window.endTime}::time,
                                                    ${dto.startDate}::date, ${dto.endDate}::date, ${note}::text)::text AS id`,
          );
        }
        return this.read(tx, schoolId);
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** The owner answers a pending loan of its room. */
  decide(id: string, approve: boolean, user: AuthenticatedUser): Promise<RoomLoansView> {
    return this.act(user, Prisma.sql`SELECT app.room_loan_decide(${id}::uuid, ${approve})`);
  }

  /** The borrower withdraws a pending or approved loan. */
  withdraw(id: string, user: AuthenticatedUser): Promise<RoomLoansView> {
    return this.act(user, Prisma.sql`SELECT app.room_loan_withdraw(${id}::uuid)`);
  }

  /** The owner ends an approved loan of its room. */
  revoke(id: string, user: AuthenticatedUser): Promise<RoomLoansView> {
    return this.act(user, Prisma.sql`SELECT app.room_loan_revoke(${id}::uuid)`);
  }

  private async act(user: AuthenticatedUser, statement: Prisma.Sql): Promise<RoomLoansView> {
    const schoolId = requireSchoolId(user);
    requireUserId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // $executeRaw: the functions return void, which $queryRaw cannot read.
        await tx.$executeRaw(statement);
        return this.read(tx, schoolId);
      });
    } catch (error) {
      this.rethrow(error);
    }
  }

  /** The school's own room for a room it borrows the first time: named after the room and its school. */
  private async makeLocalRoom(
    tx: PrismaClient,
    schoolId: string,
    dto: CreateRoomLoanDto,
    room: { name: string; capacity: number | null; schoolName: string },
  ): Promise<string> {
    const name = dto.localRoomName?.trim() || `${room.name} (${room.schoolName})`;
    try {
      const created = await tx.room.create({
        data: { schoolId, name, capacity: room.capacity, roomTypeId: dto.localRoomTypeId ?? null },
        select: { id: true },
      });
      return created.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          message: `Skolan har redan en sal som heter ${name}. Välj ett annat namn för den lånade salen.`,
          code: ROOM_LOAN_LOCAL_ROOM_NAME_TAKEN,
        });
      }
      throw error;
    }
  }

  private async read(tx: PrismaClient, schoolId: string): Promise<RoomLoansView> {
    const siblings = await siblingSchools(tx);
    const schoolOf = new Map(siblings.map((school) => [school.id, school]));
    const lent = await tx.roomLoan.findMany({
      where: { ownerSchoolId: schoolId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { ...LOAN_SELECT, room: { select: { id: true, name: true } } },
    });
    const borrowed = await tx.roomLoan.findMany({
      where: { borrowerSchoolId: schoolId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { ...LOAN_SELECT, localRoom: { select: { id: true, name: true } } },
    });
    const ownerRooms = borrowed.length ? new Map((await lendableRooms(tx)).map((room) => [room.id, room.name])) : new Map<string, string>();
    const view = (
      loan: (typeof lent)[number] | (typeof borrowed)[number],
      room: { id: string; name: string },
      otherSchoolId: string,
      ownerRoomName: string | null,
      ownerRoomId: string | null,
    ): RoomLoanView | null => {
      const school = schoolOf.get(otherSchoolId);
      // The arms show a loan only while both schools have the huvudman.
      if (!school) return null;
      return {
        id: loan.id,
        status: loan.status,
        dayOfWeek: loan.dayOfWeek,
        startTime: clock(loan.startTime),
        endTime: clock(loan.endTime),
        startDate: day(loan.startDate),
        endDate: day(loan.endDate),
        note: loan.note,
        createdAt: loan.createdAt.toISOString(),
        decidedAt: loan.decidedAt?.toISOString() ?? null,
        endedAt: loan.endedAt?.toISOString() ?? null,
        room,
        school: { id: school.id, name: school.name },
        ownerRoomName,
        ownerRoomId,
      };
    };
    return {
      lent: lent
        .map((loan) => view(loan, loan.room, loan.borrowerSchoolId, null, null))
        .filter((loan): loan is RoomLoanView => loan !== null),
      borrowed: borrowed
        .map((loan) => view(loan, loan.localRoom, loan.ownerSchoolId, ownerRooms.get(loan.roomId) ?? null, loan.roomId))
        .filter((loan): loan is RoomLoanView => loan !== null),
    };
  }

  private rethrow(error: unknown): never {
    const refusal = roomLoanRefusal(error);
    if (refusal) throw refusal;
    rethrowPrismaError(error);
  }
}

/** The other schools' rooms the chosen school may ask for (app.lendable_rooms), with the school's name. */
async function lendableRooms(
  tx: PrismaClient,
): Promise<Array<{ id: string; schoolId: string; schoolName: string; name: string; capacity: number | null; roomTypeName: string | null }>> {
  const siblings = new Map((await siblingSchools(tx)).map((school) => [school.id, school.name]));
  const rows = await tx.$queryRaw<
    Array<{ school_id: string; room_id: string; name: string; capacity: number | null; room_type_name: string | null }>
  >(Prisma.sql`SELECT school_id, room_id, name, capacity, room_type_name FROM app.lendable_rooms()`);
  return rows.map((row) => ({
    id: row.room_id,
    schoolId: row.school_id,
    schoolName: siblings.get(row.school_id) ?? '',
    name: row.name,
    capacity: row.capacity,
    roomTypeName: row.room_type_name,
  }));
}
