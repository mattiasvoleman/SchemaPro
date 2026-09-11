import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateMasterLessonDto } from './update-master-lesson.dto';

const TEACHER_ID = '77777777-7777-4777-8777-777777777777';

/**
 * The properties that failed validation, under the whitelist options the
 * global ValidationPipe runs with: a field the DTO does not declare fails here
 * as it would over HTTP, instead of being dropped without a word.
 */
const failing = async (body: object) =>
  (
    await validate(plainToInstance(UpdateMasterLessonDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((error) => error.property);

describe('UpdateMasterLessonDto assignments', () => {
  // The second teacher sits beside the room and the first teacher on purpose:
  // it was once missing from this DTO, and a co-taught lesson could then be
  // updated with everything but it.
  const ASSIGNMENTS = ['roomId', 'teacherId', 'coTeacherId'] as const;

  it.each(ASSIGNMENTS)('accepts a v4 id for %s', async (field) => {
    await expect(failing({ [field]: TEACHER_ID })).resolves.toEqual([]);
  });

  it.each(ASSIGNMENTS)('accepts null for %s, which clears the assignment', async (field) => {
    await expect(failing({ [field]: null })).resolves.toEqual([]);
  });

  it.each(ASSIGNMENTS)('refuses a %s that is not a v4 id', async (field) => {
    await expect(failing({ [field]: 'Anna Svensson' })).resolves.toEqual([field]);
  });
});
