import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import { lessonDiffers, readGrundschema, readPublishedMasters, slotChanged, snapshotFor } from './published-grundschema';

const time = (h: number) => new Date(Date.UTC(1970, 0, 1, h));
const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = '44444444-4444-4444-8444-444444444444';

function published(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pl',
    schoolId: SCHOOL,
    publicationId: 'pub',
    academicYearId: YEAR,
    masterLessonId: 'm1',
    subjectId: 'ma',
    studentGroupId: '7a',
    teacherId: 'anna',
    coTeacherId: 'gone-teacher',
    roomId: 'gone-room',
    dayOfWeek: 1,
    startTime: time(8),
    endTime: time(9),
    isLocked: true,
    isGenerated: false,
    isParked: false,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    extraGroupIds: ['7b', 'gone-group'],
    studentIds: ['bo', 'gone-pupil'],
    ...overrides,
  };
}

describe('the published grundschema', () => {
  let tx: TxMock;
  beforeEach(() => {
    tx = createTxMock();
    tx.subject.findMany.mockResolvedValue([{ id: 'ma', name: 'Matematik' }]);
    tx.studentGroup.findMany.mockResolvedValue([
      { id: '7a', name: '7A' },
      { id: '7b', name: '7B' },
    ]);
    tx.room.findMany.mockResolvedValue([]);
    tx.user.findMany.mockResolvedValue([{ id: 'anna' }, { id: 'bo' }]);
  });

  it('is the snapshot valid today, else the nearest ahead, else the last', () => {
    const segments = [
      { publicationId: 'ht', from: '2026-08-17', to: '2027-01-10' },
      { publicationId: 'vt', from: '2027-01-11', to: '2027-06-11' },
    ];
    expect(snapshotFor(segments, '2026-10-12')).toBe('ht');
    expect(snapshotFor(segments, '2026-08-01')).toBe('ht');
    expect(snapshotFor(segments, '2027-01-11')).toBe('vt');
    expect(snapshotFor(segments, '2027-07-01')).toBe('vt');
    expect(snapshotFor([], '2027-07-01')).toBeNull();
  });

  it('maps a vanished reference the way the live key would have acted', async () => {
    tx.publishedLesson.findMany.mockResolvedValue([
      published(),
      // A deleted subject drops the row, as CASCADE would have dropped the lesson.
      published({ id: 'pl2', masterLessonId: 'm2', subjectId: 'gone-subject' }),
    ]);
    const rows = await readPublishedMasters(tx as unknown as PrismaClient, 'pub');
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'm1',
        teacherId: 'anna',
        coTeacherId: null,
        roomId: null,
        extraGroups: [{ studentGroupId: '7b' }],
        participants: [{ studentId: 'bo' }],
        subject: { id: 'ma', name: 'Matematik' },
        studentGroup: { id: '7a', name: '7A' },
      }),
    ]);
  });

  it('gives the admin the masters, the draft, and asks nothing more', async () => {
    const live = jest.fn().mockResolvedValue([{ id: 'draft' }]);
    const read = await readGrundschema(tx as unknown as PrismaClient, { role: Role.SCHOOL_ADMIN, schoolId: SCHOOL }, YEAR, live);
    expect(read).toEqual({ rows: [{ id: 'draft' }], source: { kind: 'LIVE' } });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('asks a teacher nothing more when the live read finds lessons: DIRECT sends what it always sent', async () => {
    const live = jest.fn().mockResolvedValue([{ id: 'm1' }]);
    const read = await readGrundschema(tx as unknown as PrismaClient, { role: Role.TEACHER, schoolId: SCHOOL }, YEAR, live);
    expect(read.source).toEqual({ kind: 'LIVE' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('reads the published snapshot for a teacher in a DRAFT school, and for the families whoever asks', async () => {
    tx.$queryRaw.mockResolvedValue([{ mode: 'DRAFT' }]);
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.timetablePublication.findMany.mockResolvedValue([
      { id: 'pub', publishedAt: new Date('2026-08-01'), validFrom: new Date('2026-08-17'), validTo: new Date('2027-06-11') },
    ]);
    tx.publishedLesson.findMany.mockResolvedValue([published()]);
    const teacher = await readGrundschema(tx as unknown as PrismaClient, { role: Role.TEACHER, schoolId: SCHOOL }, YEAR, async () => []);
    expect(teacher.source).toEqual({ kind: 'PUBLISHED', publicationId: 'pub' });
    expect(teacher.rows).toHaveLength(1);

    const live = jest.fn().mockResolvedValue([{ id: 'draft' }]);
    const families = await readGrundschema(tx as unknown as PrismaClient, { role: Role.SCHOOL_ADMIN, schoolId: SCHOOL }, YEAR, live, {
      forFamilies: true,
    });
    expect(families.source).toEqual({ kind: 'PUBLISHED', publicationId: 'pub' });
    expect(live).not.toHaveBeenCalled();
  });

  it('compares a slot on what moves a lesson, and a lesson on everything a snapshot holds', () => {
    const base = {
      dayOfWeek: 1,
      startTime: time(8),
      endTime: time(9),
      roomId: 'r',
      teacherId: 't',
      recurrence: 'ALL_WEEKS' as const,
      startDate: null,
      endDate: null,
      coTeacherId: null,
      isParked: false,
      subjectId: 'ma',
      studentGroupId: '7a',
      extraGroups: [{ studentGroupId: '7b' }],
      participants: [],
    };
    expect(slotChanged(base, { ...base, isParked: true })).toBe(false);
    expect(slotChanged(base, { ...base, endTime: time(10) })).toBe(true);
    expect(lessonDiffers(base, { ...base, isParked: true })).toBe(true);
    expect(lessonDiffers(base, { ...base, extraGroups: [] })).toBe(true);
    expect(lessonDiffers(base, { ...base })).toBe(false);
  });
});
