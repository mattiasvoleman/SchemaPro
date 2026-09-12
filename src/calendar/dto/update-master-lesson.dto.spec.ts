import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMasterLessonDto } from './update-master-lesson.dto';

const ROOM_ID = '33333333-3333-4333-8333-333333333333';
const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const CO_TEACHER_ID = '22222222-2222-4222-8222-222222222222';

/** The properties that failed validation. */
const failing = async (body: object) =>
  (await validate(plainToInstance(UpdateMasterLessonDto, body))).map(
    (error) => error.property,
  );

describe('UpdateMasterLessonDto assignments', () => {
  it('reads an explicit null as clearing the room, the teacher and the co-teacher', async () => {
    await expect(
      failing({ roomId: null, teacherId: null, coTeacherId: null }),
    ).resolves.toEqual([]);
  });

  it('leaves an assignment alone when the field is absent, so a PATCH touches only what it names', async () => {
    await expect(failing({ dayOfWeek: 3, startTime: '10:15' })).resolves.toEqual([]);
  });

  it('carries the second teacher of a co-taught lesson, which undoing a delete used to drop', async () => {
    await expect(
      failing({ roomId: ROOM_ID, teacherId: TEACHER_ID, coTeacherId: CO_TEACHER_ID }),
    ).resolves.toEqual([]);
  });

  it('refuses an id that is not a v4 uuid, so a typo cannot read as clearing the field', async () => {
    await expect(failing({ roomId: 'Sal 1' })).resolves.toEqual(['roomId']);
    await expect(failing({ teacherId: 'anna.ek' })).resolves.toEqual(['teacherId']);
    await expect(failing({ coTeacherId: 42 })).resolves.toEqual(['coTeacherId']);
  });
});
