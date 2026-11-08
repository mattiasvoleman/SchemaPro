import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateChangeDto, PreviewChangeDto, UpdateChangeDto, WeekQueryDto } from './class-teacher.dto';

const problems = async (dto: object): Promise<string[]> => (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).flatMap((error) => Object.values(error.constraints ?? {}));

describe('the dates a klasslärare writes', () => {
  const preview = (over: Record<string, unknown>) =>
    plainToInstance(PreviewChangeDto, { kind: 'OCCASION_MOVE', calendarLessonId: '11111111-1111-4111-8111-111111111111', targetDate: '2027-03-23', targetStart: '10:00', targetEnd: '11:00', ...over });

  it('takes a date that exists, a leap day in a leap year included', async () => {
    expect(await problems(preview({}))).toEqual([]);
    expect(await problems(preview({ targetDate: '2028-02-29' }))).toEqual([]);
    expect(await problems(plainToInstance(WeekQueryDto, { from: '2027-12-31' }))).toEqual([]);
  });

  it('refuses a date that has the shape of one and does not exist, before it reaches the database or the calendar', async () => {
    for (const targetDate of ['2027-02-30', '2027-13-01', '2027-00-10', '2027-04-31', '2027-02-29']) {
      expect(await problems(preview({ targetDate }))).toEqual(['targetDate must be a date that exists.']);
    }
    for (const from of ['2027-13-01', '2027-02-30']) {
      expect(await problems(plainToInstance(WeekQueryDto, { from }))).toEqual(['from must be a date that exists.']);
    }
  });

  it('still names the shape when it is not even that', async () => {
    expect(await problems(preview({ targetDate: '23/03/2027' }))).toContain('targetDate must be YYYY-MM-DD.');
    expect(await problems(plainToInstance(WeekQueryDto, { from: 'tomorrow' }))).toContain('from must be YYYY-MM-DD.');
  });

  it('is the same for a draft being written as for a change tried and for one edited', async () => {
    const base = { kind: 'OCCASION_MOVE', calendarLessonId: '11111111-1111-4111-8111-111111111111', targetStart: '10:00', targetEnd: '11:00', baseVersion: 'a'.repeat(32) };
    expect(await problems(plainToInstance(CreateChangeDto, { ...base, targetDate: '2027-02-30' }))).toEqual(['targetDate must be a date that exists.']);
    expect(await problems(plainToInstance(UpdateChangeDto, { rev: 2, targetDate: '2027-02-30' }))).toEqual(['targetDate must be a date that exists.']);
    expect(await problems(plainToInstance(UpdateChangeDto, { rev: 2, targetDate: '2027-03-30' }))).toEqual([]);
  });
});
