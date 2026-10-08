import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CancelLessonDto, ChangeRoomDto } from './lesson-action.dto';

const ROOM_ID = '33333333-3333-4333-8333-333333333333';

/** The properties that failed validation. */
const failing = async (body: object) =>
  (await validate(plainToInstance(ChangeRoomDto, body))).map((error) => error.property);

describe('ChangeRoomDto', () => {
  it('reads an explicit null as taking the room away, and a uuid as moving the lesson', async () => {
    await expect(failing({ roomId: null })).resolves.toEqual([]);
    await expect(failing({ roomId: ROOM_ID, note: 'Projektorn trasig' })).resolves.toEqual([]);
  });

  it('refuses a body that does not name the room, so silence cannot read as clearing it', async () => {
    // The field every other nullable id pairs with IsOptional, and the one that
    // must not: IsOptional would let an omitted roomId through as well, and the
    // service reads every roomId that is not null as a room to look up, so a
    // body that forgot the field would reach the database instead of being
    // refused here with the field named.
    await expect(failing({})).resolves.toEqual(['roomId']);
    await expect(failing({ note: 'Projektorn trasig' })).resolves.toEqual(['roomId']);
  });

  it('refuses a room that is not a v4 uuid', async () => {
    await expect(failing({ roomId: 'Sal 1' })).resolves.toEqual(['roomId']);
  });
});

describe('CancelLessonDto', () => {
  const cancelFailing = async (body: object) =>
    (await validate(plainToInstance(CancelLessonDto, body))).map((error) => error.property);

  it('takes no cause, or one of the three the column admits', async () => {
    await expect(cancelFailing({})).resolves.toEqual([]);
    for (const cause of ['TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE', 'MANUAL']) {
      await expect(cancelFailing({ cause, reason: 'Sjuk' })).resolves.toEqual([]);
    }
  });

  it('refuses a cause the enum does not have, naming the field', async () => {
    for (const cause of ['SICK', 'teacher_unavailable', '', null, 3]) {
      await expect(cancelFailing({ cause })).resolves.toEqual(cause === null ? [] : ['cause']);
    }
  });
});
