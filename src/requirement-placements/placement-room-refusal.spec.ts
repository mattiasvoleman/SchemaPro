import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import type { RoomNeeds } from '../optimization/room-eligibility';
import { roomNeedsOf } from '../optimization/room-eligibility';
import { roomRefusalReason, roomRefusalsOf } from './placement-room-refusal';

/*
 * A FÖRLÄGGNINGS SAL (E4b): the rule a lay in a room is held to (BOARD_ROOM_NOT_ALLOWED, board-tray/lay-room.ts), asked of the year's rows at once.
 * The generator's own rule for a room is roomAllowed (calendar/possible-times.ts, the engine's `_room_allowed` and `_grade_allowed`); this says WHICH of
 * its three parts a room fails, in the order a lay says it: the seats, then the kind, then the years.
 */

jest.mock('../optimization/room-eligibility', () => ({ ...jest.requireActual('../optimization/room-eligibility'), loadRosters: jest.fn(async () => ({})), roomNeedsOf: jest.fn() }));

const room = (over: Record<string, unknown> = {}) => ({ id: 'r1', name: 'Sal 1', capacity: 30, roomTypeId: null, minGradeLevel: null, maxGradeLevel: null, building: null, ...over });
const needs = (over: Partial<RoomNeeds> = {}): RoomNeeds => ({ studentGroupSize: 25, minGradeLevel: 7, maxGradeLevel: 7, requiredRoomTypeId: null, ...over });

describe('roomRefusalReason', () => {
  it('lets a room that has seats, is the kind the subject needs and is for the years', () => {
    expect(roomRefusalReason(room(), needs())).toBeNull();
    expect(roomRefusalReason(room({ capacity: null }), needs({ studentGroupSize: 500 }))).toBeNull();
    expect(roomRefusalReason(room({ roomTypeId: 'lab' }), needs({ requiredRoomTypeId: 'lab' }))).toBeNull();
    expect(roomRefusalReason(room({ minGradeLevel: 7, maxGradeLevel: 9 }), needs())).toBeNull();
  });

  it('says SEATS for a room with fewer seats than pupils, TYPE for another kind than the subject needs, YEARS for years the room is fenced from', () => {
    expect(roomRefusalReason(room({ capacity: 24 }), needs())).toBe('SEATS');
    expect(roomRefusalReason(room({ roomTypeId: 'plain' }), needs({ requiredRoomTypeId: 'lab' }))).toBe('TYPE');
    expect(roomRefusalReason(room({ roomTypeId: null }), needs({ requiredRoomTypeId: 'lab' }))).toBe('TYPE');
    expect(roomRefusalReason(room({ minGradeLevel: 8 }), needs())).toBe('YEARS');
    expect(roomRefusalReason(room({ maxGradeLevel: 6 }), needs())).toBe('YEARS');
  });

  it('names the seats before the kind, and the kind before the years, as a lay does', () => {
    expect(roomRefusalReason(room({ capacity: 10, roomTypeId: 'plain', minGradeLevel: 8 }), needs({ requiredRoomTypeId: 'lab' }))).toBe('SEATS');
    expect(roomRefusalReason(room({ roomTypeId: 'plain', minGradeLevel: 8 }), needs({ requiredRoomTypeId: 'lab' }))).toBe('TYPE');
  });

  it('lets a group whose years are not known: there is nothing to check it against', () => {
    expect(roomRefusalReason(room({ minGradeLevel: 8 }), needs({ minGradeLevel: null, maxGradeLevel: null }))).toBeNull();
  });
});

describe('roomRefusalsOf', () => {
  const basis = {} as never;
  const year = { id: 'y1', gradeNumbering: 'NIOARIG' };
  const rows = [
    { id: 'a', roomId: 'r1', studentGroupId: 'g1', subjectId: 's1' },
    { id: 'b', roomId: 'r2', studentGroupId: 'g1', subjectId: 's2' },
    { id: 'c', roomId: null, studentGroupId: 'g1', subjectId: 's1' },
    { id: 'd', roomId: 'r1', studentGroupId: 'g2', subjectId: 's1' },
  ];

  const arrange = () => {
    const tx = createTxMock();
    tx['room']!['findMany']!.mockResolvedValue([room({ id: 'r1' }), room({ id: 'r2', roomTypeId: 'plain' })]);
    tx['subject']!['findMany']!.mockResolvedValue([{ id: 's1', requiredRoomTypeId: null }, { id: 's2', requiredRoomTypeId: 'lab' }]);
    tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: 'g1', gradeLevel: 7, halfOfId: null }, { id: 'g2', gradeLevel: 7, halfOfId: null }]);
    (roomNeedsOf as jest.Mock).mockReset().mockImplementation((_rosters, attendance: { groupIds: string[] }, subject: { requiredRoomTypeId: string | null }) =>
      needs({ studentGroupSize: attendance.groupIds[0] === 'g2' ? 40 : 25, requiredRoomTypeId: subject.requiredRoomTypeId }),
    );
    return tx;
  };

  it('answers for each row with a room that the generator would not take, with the room and why, and for no other', async () => {
    const tx = arrange();
    const refusals = await roomRefusalsOf(tx as unknown as PrismaClient, year, basis, rows);
    expect([...refusals]).toEqual([
      ['b', { roomId: 'r2', reason: 'TYPE' }],
      ['d', { roomId: 'r1', reason: 'SEATS' }],
    ]);
  });

  it('reads the year\'s rooms, subjects and classes once for all the rows, and nothing when no row has a room', async () => {
    const tx = arrange();
    await roomRefusalsOf(tx as unknown as PrismaClient, year, basis, rows);
    expect(tx['room']!['findMany']).toHaveBeenCalledTimes(1);
    expect(tx['room']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] } }, select: expect.any(Object) });
    expect(tx['subject']!['findMany']).toHaveBeenCalledTimes(1);
    expect(tx['studentGroup']!['findMany']).toHaveBeenCalledTimes(1);
    const none = arrange();
    expect(await roomRefusalsOf(none as unknown as PrismaClient, year, basis, [rows[2]!])).toEqual(new Map());
    expect(none['room']!['findMany']).not.toHaveBeenCalled();
  });

  it('reads the needs in the numbering of the year, and asks a row\'s own class and subject and no other', async () => {
    const tx = arrange();
    await roomRefusalsOf(tx as unknown as PrismaClient, { id: 'y1', gradeNumbering: 'TIOARIG' }, basis, [rows[1]!]);
    expect(roomNeedsOf).toHaveBeenCalledWith(expect.anything(), { groupIds: ['g1'] }, { requiredRoomTypeId: 'lab' }, 'TIOARIG');
  });

  it('leaves a row whose room is not a room of the school to the write\'s foreign key, as a lay does', async () => {
    const tx = arrange();
    tx['room']!['findMany']!.mockResolvedValue([]);
    expect(await roomRefusalsOf(tx as unknown as PrismaClient, year, basis, rows)).toEqual(new Map());
  });
});
