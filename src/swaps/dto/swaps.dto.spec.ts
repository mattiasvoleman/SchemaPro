import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ApplySwapDto, MakeRoomDto, PairSwapDto, SuggestSwapsDto } from './swaps.dto';

const A = '55555555-5555-4555-8555-555555555555';
const B = '66666666-6666-4666-8666-666666666666';

const slot = (startTime: string, endTime: string, dayOfWeek = 1) => ({ dayOfWeek, startTime, endTime });
const move = (lessonId: string, from = slot('08:00', '09:00'), to = slot('10:00', '11:00', 2)) => ({ lessonId, from, to });
const body = (moves: unknown[]) => ({ lessonId: A, moves });

/** The dotted path of every constraint that failed, however deeply the slot is nested. */
function paths(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [...(error.constraints ? [path] : []), ...paths(error.children ?? [], path)];
  });
}
const failing = async (value: object) => paths(await validate(plainToInstance(ApplySwapDto, value)));

describe('ApplySwapDto clocks', () => {
  it('takes every clock of the day, 00:00 to 23:59', async () => {
    await expect(failing(body([move(A, slot('00:00', '00:45'), slot('23:00', '23:59')), move(B)]))).resolves.toEqual([]);
  });

  /*
   * parseTimeString wraps an hour past 23 into the next day, so "34:00" is
   * stored as 10:00. A request judged on one clock and written on another
   * double-booked a teacher; the pattern is where it stops (the service stops
   * it a second time: swaps.apply.spec.ts).
   */
  it.each(['24:00', '25:00', '34:00', '99:99', '12:60', '08:75', '8:00', '08:00:00', '0800', ' 08:00', '08:00 ', ''])(
    'refuses %p as the new start, the new end, the old start and the old end',
    async (clock) => {
      expect(await failing(body([move(A, slot('08:00', '09:00'), slot(clock, '11:00')), move(B)]))).toEqual(['moves.0.to.startTime']);
      expect(await failing(body([move(A, slot('08:00', '09:00'), slot('10:00', clock)), move(B)]))).toEqual(['moves.0.to.endTime']);
      expect(await failing(body([move(A, slot(clock, '09:00'), slot('10:00', '11:00')), move(B)]))).toEqual(['moves.0.from.startTime']);
      expect(await failing(body([move(A, slot('08:00', clock), slot('10:00', '11:00')), move(B)]))).toEqual(['moves.0.from.endTime']);
    },
  );
});

describe('E5a: what the doors take', () => {
  const check = async (type: new () => object, value: object) => paths(await validate(plainToInstance(type, value), { whitelist: true, forbidNonWhitelisted: true }));

  it('takes Gör plats as a school day, a clock of it and a depth of one to three', async () => {
    expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: { dayOfWeek: 5, startTime: '23:59', depth: 3 } })).toEqual([]);
    expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: { dayOfWeek: 1, startTime: '00:00' } })).toEqual([]);
    for (const [bad, field] of [
      [{ dayOfWeek: 6, startTime: '08:00' }, 'dayOfWeek'],
      [{ dayOfWeek: 0, startTime: '08:00' }, 'dayOfWeek'],
      [{ dayOfWeek: 1, startTime: '24:00' }, 'startTime'],
      [{ dayOfWeek: 1, startTime: '8:00' }, 'startTime'],
      [{ dayOfWeek: 1, startTime: '08:00', depth: 4 }, 'depth'],
      [{ dayOfWeek: 1, startTime: '08:00', depth: 0 }, 'depth'],
      [{ dayOfWeek: 1, startTime: '08:00', depth: 1.5 }, 'depth'],
    ] as const) {
      expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: bad })).toEqual([`makeRoom.${field}`]);
    }
    expect(await check(MakeRoomDto, { dayOfWeek: 1, startTime: '08:00', depth: 2 })).toEqual([]);
  });

  it('still takes a swap search of one lesson, as it was asked before Gör plats', async () => {
    expect(await check(SuggestSwapsDto, { lessonId: A })).toEqual([]);
    expect(await check(SuggestSwapsDto, { lessonId: A, limit: 30 })).toEqual([]);
    expect(await check(SuggestSwapsDto, { lessonId: 'nope' })).toEqual(['lessonId']);
  });

  it('takes a brick as the possible times take one, and leaves "a lesson or a brick" to the service', async () => {
    const brick = { academicYearId: A, studentGroupId: A, subjectId: B, minutes: 60 };
    expect(await check(SuggestSwapsDto, { brick, makeRoom: { dayOfWeek: 1, startTime: '08:00' } })).toEqual([]);
    expect(await check(SuggestSwapsDto, { brick: { ...brick, minutes: 3 }, makeRoom: { dayOfWeek: 1, startTime: '08:00' } })).toEqual(['brick.minutes']);
  });

  it('takes two lesson ids for Byt plats', async () => {
    expect(await check(PairSwapDto, { lessonId: A, otherLessonId: B })).toEqual([]);
    expect(await check(PairSwapDto, { lessonId: A })).toEqual(['otherLessonId']);
    expect(await check(PairSwapDto, { lessonId: 'nope', otherLessonId: 'nope' })).toEqual(['lessonId', 'otherLessonId']);
  });

  it('takes otherRooms as a boolean on makeRoom', async () => {
    expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: { dayOfWeek: 1, startTime: '08:00', otherRooms: true } })).toEqual([]);
    expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: { dayOfWeek: 1, startTime: '08:00' } })).toEqual([]);
    expect(await check(SuggestSwapsDto, { lessonId: A, makeRoom: { dayOfWeek: 1, startTime: '08:00', otherRooms: 'yes' } })).toEqual(['makeRoom.otherRooms']);
  });

  it('takes the room a move gives a lesson as two ids, both the school’s rooms as uuids, and leaves "another room" to the service', async () => {
    const withRoom = (room: unknown) => ({ ...move(A), room });
    expect(await check(ApplySwapDto, { lessonId: A, moves: [withRoom({ from: A, to: B }), move(B)] })).toEqual([]);
    expect(await check(ApplySwapDto, { lessonId: A, moves: [withRoom({ from: A }), move(B)] })).toEqual(['moves.0.room.to']);
    expect(await check(ApplySwapDto, { lessonId: A, moves: [withRoom({ from: 'nope', to: 'nope' }), move(B)] })).toEqual(['moves.0.room.from', 'moves.0.room.to']);
    expect(await check(ApplySwapDto, { lessonId: A, moves: [withRoom('r1'), move(B)] })).toEqual(['moves.0.room']);
    // Left out is what it always was: the lesson keeps its room.
    expect(await check(ApplySwapDto, { lessonId: A, moves: [move(A), move(B)] })).toEqual([]);
  });

  it('takes alsoPicked as ids, forBrick as a boolean, and a lessonId only when it is not for a brick', async () => {
    const moves = [move(A), move(B)];
    expect(await check(ApplySwapDto, { lessonId: A, alsoPicked: [B], moves })).toEqual([]);
    expect(await check(ApplySwapDto, { lessonId: A, alsoPicked: ['nope'], moves })).toEqual(['alsoPicked']);
    expect(await check(ApplySwapDto, { lessonId: A, alsoPicked: 'x', moves })).toEqual(['alsoPicked']);
    expect(await check(ApplySwapDto, { lessonId: A, forBrick: 'yes', moves })).toEqual(['forBrick']);
    expect(await check(ApplySwapDto, { forBrick: true, moves: [move(A)] })).toEqual([]);
    expect(await check(ApplySwapDto, { moves })).toEqual(['lessonId']);
    // One move is the service's to judge: it is a proposal only for a brick, and the service says so before it reads anything.
    expect(await check(ApplySwapDto, { lessonId: A, moves: [move(A)] })).toEqual([]);
    expect(await check(ApplySwapDto, { lessonId: A, moves: [] })).toEqual(['moves']);
  });
});
