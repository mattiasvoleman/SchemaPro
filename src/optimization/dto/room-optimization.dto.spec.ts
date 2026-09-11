import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyRoomChangesDto, RoomProposalDto } from './room-optimization.dto';

const YEAR = '44444444-4444-4444-8444-444444444444';
const LESSON = '55555555-5555-4555-8555-555555555555';
const ROOM_A = '66666666-6666-4666-8666-666666666666';
const ROOM_B = '77777777-7777-4777-8777-777777777777';
const BASIS = 'ab'.repeat(32);

/** The fields that failed, as the global ValidationPipe would see them. */
const failures = async <T extends object>(cls: new () => T, body: unknown) => {
  const errors = await validate(plainToInstance(cls, body) as object);
  const flatten = (list: typeof errors, prefix = ''): string[] =>
    list.flatMap((error) => [
      ...(error.constraints ? [`${prefix}${error.property}`] : []),
      ...flatten(error.children ?? [], `${prefix}${error.property}.`),
    ]);
  return flatten(errors);
};

const move = (overrides: Record<string, unknown> = {}) => ({
  lessonId: LESSON,
  fromRoomId: ROOM_A,
  toRoomId: ROOM_B,
  ...overrides,
});

describe('RoomProposalDto', () => {
  it.each(['TEACHERS', 'GROUPS', 'BOTH'])('accepts %s', async (walkers) => {
    await expect(failures(RoomProposalDto, { academicYearId: YEAR, walkers })).resolves.toEqual([]);
  });

  it('refuses a walker kind the engine has never heard of', async () => {
    await expect(
      failures(RoomProposalDto, { academicYearId: YEAR, walkers: 'PUPILS' }),
    ).resolves.toEqual(['walkers']);
  });
});

describe('ApplyRoomChangesDto', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    academicYearId: YEAR,
    basis: BASIS,
    changes: [move()],
    ...overrides,
  });

  it('accepts a proposal as the proposal route returns it', async () => {
    await expect(failures(ApplyRoomChangesDto, body())).resolves.toEqual([]);
  });

  it('refuses a basis that is not a sha256 digest', async () => {
    await expect(
      failures(ApplyRoomChangesDto, body({ basis: 'AB'.repeat(32) })),
    ).resolves.toEqual(['basis']);
    await expect(
      failures(ApplyRoomChangesDto, body({ basis: BASIS.slice(1) })),
    ).resolves.toEqual(['basis']);
  });

  it('refuses an apply that moves nothing', async () => {
    await expect(failures(ApplyRoomChangesDto, body({ changes: [] }))).resolves.toEqual([
      'changes',
    ]);
  });

  it('takes as many moves as the engine can send lessons, and no more', async () => {
    const many = (count: number) => Array.from({ length: count }, () => move());
    await expect(failures(ApplyRoomChangesDto, body({ changes: many(5000) }))).resolves.toEqual(
      [],
    );
    await expect(failures(ApplyRoomChangesDto, body({ changes: many(5001) }))).resolves.toEqual(
      ['changes'],
    );
  });

  it('refuses a move from no room — a roomless lesson is never given one', async () => {
    await expect(
      failures(ApplyRoomChangesDto, body({ changes: [move({ fromRoomId: null })] })),
    ).resolves.toEqual(['changes.0.fromRoomId']);
  });

  it('refuses a move to no room', async () => {
    await expect(
      failures(ApplyRoomChangesDto, body({ changes: [move({ toRoomId: 'sal 1' })] })),
    ).resolves.toEqual(['changes.0.toRoomId']);
  });
});
