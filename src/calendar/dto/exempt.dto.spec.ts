import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMasterLessonDto } from './create-master-lesson.dto';
import { JudgeLessonsDto } from './judge-lessons.dto';
import { UpdateMasterLessonDto } from './update-master-lesson.dto';

/*
 * `exempt` names the rules an administrator answers "Lägg ändå" to (Undantag med flit): FRAME and LUNCH, and nothing else. A rule that cannot
 * be exempted is a 400 before the service, so that a request cannot name a clash, a closed årskurs, another school's time or the school day.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const NOT_EXEMPTABLE = ['TEACHER', 'ROOM', 'GROUP', 'PUPILS', 'AVAILABILITY', 'GRADE_RULE', 'OTHER_SCHOOL', 'SCHOOL_DAY', 'frame', ''];

const bodies: Array<[string, (exempt: unknown) => Promise<string[]>]> = [
  [
    'the PATCH',
    async (exempt) => (await validate(plainToInstance(UpdateMasterLessonDto, { exempt }))).map((error) => error.property),
  ],
  [
    'the create',
    async (exempt) =>
      (await validate(plainToInstance(CreateMasterLessonDto, { academicYearId: ID, subjectId: ID, studentGroupId: ID, dayOfWeek: 1, startTime: '10:00', endTime: '11:00', exempt }))).map((error) => error.property),
  ],
  [
    'the läsande frågan',
    async (exempt) => (await validate(plainToInstance(JudgeLessonsDto, { moves: [{ lessonId: ID, exempt }] }))).map((error) => error.property),
  ],
];

describe.each(bodies)('exempt on %s', (_name, failing) => {
  it('takes the two names, either or both or none, and leaves a request that does not name it alone', async () => {
    for (const exempt of [['FRAME'], ['LUNCH'], ['FRAME', 'LUNCH'], []]) expect(await failing(exempt)).toEqual([]);
  });

  it.each(NOT_EXEMPTABLE)('refuses %j', async (name) => {
    expect((await failing([name])).length).toBeGreaterThan(0);
    expect((await failing(['FRAME', name])).length).toBeGreaterThan(0);
  });

  it('refuses a list that is not a list and one longer than the rules there are', async () => {
    expect((await failing('FRAME')).length).toBeGreaterThan(0);
    expect((await failing(['FRAME', 'LUNCH', 'FRAME'])).length).toBeGreaterThan(0);
  });
});
