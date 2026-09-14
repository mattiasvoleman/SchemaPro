import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMasterLessonDto } from './create-master-lesson.dto';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '55555555-5555-4555-8555-555555555555';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '11111111-1111-4111-8111-111111111111';
const CO_TEACHER_ID = '22222222-2222-4222-8222-222222222222';
const ROOM_ID = '33333333-3333-4333-8333-333333333333';

/** Every required field, and no assignment at all. */
const base = {
  academicYearId: YEAR_ID,
  subjectId: SUBJECT_ID,
  studentGroupId: GROUP_ID,
  dayOfWeek: 2,
  startTime: '08:20',
  endTime: '09:20',
};

/** The properties that failed validation. */
const failing = async (body: object) =>
  (await validate(plainToInstance(CreateMasterLessonDto, body))).map(
    (error) => error.property,
  );

describe('CreateMasterLessonDto assignments', () => {
  it('reads an explicit null as a lesson placed without a room, a teacher or a co-teacher', async () => {
    await expect(
      failing({ ...base, roomId: null, teacherId: null, coTeacherId: null }),
    ).resolves.toEqual([]);
    await expect(failing(base)).resolves.toEqual([]);
  });

  it('carries all three assignments when they are named', async () => {
    await expect(
      failing({ ...base, roomId: ROOM_ID, teacherId: TEACHER_ID, coTeacherId: CO_TEACHER_ID }),
    ).resolves.toEqual([]);
  });

  it('refuses an id that is not a v4 uuid, so a typo cannot read as an unassigned lesson', async () => {
    await expect(failing({ ...base, roomId: 'Sal 1' })).resolves.toEqual(['roomId']);
    await expect(failing({ ...base, teacherId: 'anna.ek' })).resolves.toEqual(['teacherId']);
    await expect(failing({ ...base, coTeacherId: 42 })).resolves.toEqual(['coTeacherId']);
  });
});
