// `@Type(() => …)` on the rooms reads design-time metadata.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApplyItemDto, CreateExamDto } from './exam.dto';

const ID = '99999999-9999-4999-8999-999999999999';

const failing = async (cls: new () => object, body: object): Promise<string[]> =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();

const exam = (over: Record<string, unknown> = {}) => ({
  academicYearId: ID,
  subjectId: ID,
  name: 'Matematik, algebra',
  lengthMinutes: 60,
  writers: 25,
  windowKind: 'WEEK',
  windowFrom: '2030-10-07',
  windowTo: '2030-10-11',
  groupIds: [ID],
  ...over,
});

const item = (over: Record<string, unknown> = {}) => ({
  examId: ID,
  examVersion: '2030-09-01T08:00:00.000Z',
  date: '2030-10-08',
  start: '08:20',
  rooms: [{ roomId: ID, writers: 25, teacherIds: [ID] }],
  ...over,
});

describe('the dates of an exam', () => {
  it('are days of the calendar: the pattern alone let 2026-11-32 through to the database', async () => {
    expect(await failing(CreateExamDto, exam())).toEqual([]);
    expect(await failing(CreateExamDto, exam({ windowFrom: '2030-11-32' }))).toEqual(['windowFrom']);
    expect(await failing(CreateExamDto, exam({ windowTo: '2030-02-30' }))).toEqual(['windowTo']);
    // 31 November is a day to the pattern and to a lenient reader that calls it 1 December.
    expect(await failing(CreateExamDto, exam({ windowFrom: '2030-11-31', windowTo: '2030-11-31' }))).toEqual(['windowFrom', 'windowTo']);
    expect(await failing(CreateExamDto, exam({ windowFrom: '2030-00-10' }))).toEqual(['windowFrom']);
  });

  it('keep a leap day and refuse a date with a time on it', async () => {
    expect(await failing(CreateExamDto, exam({ windowFrom: '2032-02-29', windowTo: '2032-02-29' }))).toEqual([]);
    expect(await failing(CreateExamDto, exam({ windowFrom: '2031-02-29', windowTo: '2031-02-29' }))).toEqual(['windowFrom', 'windowTo']);
    expect(await failing(CreateExamDto, exam({ windowFrom: '2030-10-07T08:00:00Z' }))).toEqual(['windowFrom']);
  });

  it('are days of the calendar in a placement too', async () => {
    expect(await failing(ApplyItemDto, item())).toEqual([]);
    expect(await failing(ApplyItemDto, item({ date: '2030-10-32' }))).toEqual(['date']);
    expect(await failing(ApplyItemDto, item({ date: '2030-11-31' }))).toEqual(['date']);
  });
});
