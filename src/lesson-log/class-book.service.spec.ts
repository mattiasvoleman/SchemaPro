import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import { CLASS_BOOK_GROUP_NOT_FOUND, CLASS_BOOK_RANGE, ClassBookService } from './class-book.service';

const CLASS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LANGUAGE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_CLASS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const P1 = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';
const P2 = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';
const OUTSIDER = 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3';

const at = (date: string, utc: string) => new Date(`${date}T${utc}:00.000Z`);

const lesson = (id: string, groupId: string, groupName: string, overrides: Record<string, unknown> = {}) => ({
  id,
  date: new Date('2026-10-20T00:00:00.000Z'),
  startsAt: at('2026-10-20', '06:00'),
  endsAt: at('2026-10-20', '06:45'),
  status: 'SCHEDULED',
  studentGroupId: groupId,
  subject: { name: 'Matematik' },
  studentGroup: { name: groupName },
  extraGroups: [] as { studentGroupId: string; studentGroup: { name: string } }[],
  room: { name: 'B204' },
  teachers: [{ role: 'LEAD', teacher: { firstName: 'Anna', lastName: 'Lind' } }],
  ...overrides,
});

describe('ClassBookService', () => {
  let tx: TxMock;
  let service: ClassBookService;
  const query = { groupId: CLASS, from: '2026-10-19', to: '2026-10-25' };

  beforeEach(() => {
    tx = createTxMock();
    service = new ClassBookService(createPrismaMock(tx) as unknown as PrismaService);
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.studentGroup.findFirst.mockResolvedValue({ id: CLASS, name: '7A', kind: 'CLASS', school: { name: 'Norra skolan' } });
    tx.user.findMany.mockImplementation(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        // The class's pupils, and then the roster reader's home-class question.
        where.studentGroupId === CLASS ? [{ id: P1 }, { id: P2 }] : [],
      ),
    );
  });

  it('holds the class’s own lessons and another group’s with a pupil of the class on it, counted; drops one with none', async () => {
    tx.studentGroupMember.findMany.mockImplementation((args: { distinct?: unknown }) =>
      Promise.resolve(
        args.distinct
          ? // The pupils' teaching groups.
            [{ studentGroupId: LANGUAGE }]
          : // The roster reader: LANGUAGE's members among the class's pupils.
            [{ studentId: P1, studentGroupId: LANGUAGE }],
      ),
    );
    tx.calendarLesson.findMany.mockResolvedValue([
      lesson('own', CLASS, '7A', { teachers: [{ role: 'SUBSTITUTE', teacher: { firstName: 'Bo', lastName: 'Berg' } }] }),
      lesson('joined', OTHER_CLASS, '7B', { extraGroups: [{ studentGroupId: CLASS, studentGroup: { name: '7A' } }] }),
      lesson('spanish', LANGUAGE, 'Spanska 7', { subject: { name: 'Spanska' } }),
      lesson('elsewhere', OTHER_CLASS, '7B'),
    ]);
    tx.lessonLog.findMany.mockResolvedValue([
      { calendarLessonId: 'spanish', topic: 'Verb', homework: 'Glosor', updatedAt: new Date('2026-10-20T09:15:00.000Z') },
    ]);

    const book = await service.classBook(query, testUser({ role: 'TEACHER' as never }));

    expect(book).toMatchObject({
      school: 'Norra skolan',
      group: { id: CLASS, name: '7A', kind: 'CLASS' },
      from: '2026-10-19',
      to: '2026-10-25',
      timezone: 'Europe/Stockholm',
      pupils: 2,
    });
    // The log's version too, which an administrator's removal sends as its basis.
    expect(book.lessons.map((l) => [l.id, l.attending, l.topic, l.homework, l.logUpdatedAt])).toEqual([
      ['own', null, null, null, null],
      ['joined', null, null, null, null],
      ['spanish', 1, 'Verb', 'Glosor', '2026-10-20T09:15:00.000Z'],
    ]);
    expect(book.lessons[0]).toMatchObject({
      date: '2026-10-20',
      start: '08:00',
      end: '08:45',
      groups: ['7A'],
      teachers: [{ name: 'Bo Berg', substitute: true }],
      room: 'B204',
    });
    // The candidates: the class, its pupils' groups and the lessons naming a pupil.
    expect(tx.calendarLesson.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          date: { gte: new Date('2026-10-19T00:00:00.000Z'), lte: new Date('2026-10-25T00:00:00.000Z') },
          status: { in: ['SCHEDULED', 'COMPLETED', 'CANCELLED'] },
          OR: [
            { studentGroupId: { in: [CLASS, LANGUAGE] } },
            { extraGroups: { some: { studentGroupId: { in: [CLASS, LANGUAGE] } } } },
            { participants: { some: { studentId: { in: [P1, P2] } } } },
          ],
        },
      }),
    );
    // Never the note to the substitute, never a pupil's name, nothing in the läslogg.
    expect(tx.lessonSubstituteNote.findMany).not.toHaveBeenCalled();
    expect(JSON.stringify(book)).not.toContain(P1);
    expect(recordedReads(tx)).toEqual([]);
  });

  it('gives a teaching group its own lessons only, asking no roster', async () => {
    tx.studentGroup.findFirst.mockResolvedValue({ id: LANGUAGE, name: 'Spanska 7', kind: 'TEACHING_GROUP', school: { name: 'Norra skolan' } });
    tx.calendarLesson.findMany.mockResolvedValue([lesson('spanish', LANGUAGE, 'Spanska 7')]);
    const book = await service.classBook({ ...query, groupId: LANGUAGE }, testUser());
    expect(book.pupils).toBe(0);
    expect(book.lessons.map((l) => l.id)).toEqual(['spanish']);
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLessonStudent.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLesson.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ studentGroupId: { in: [LANGUAGE] } }, { extraGroups: { some: { studentGroupId: { in: [LANGUAGE] } } } }],
        }),
      }),
    );
  });

  it('asks the roster reader only among the class’s pupils, so a lesson naming an outsider is not the class’s', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([lesson('named', OTHER_CLASS, '7B')]);
    tx.calendarLessonStudent.findMany.mockResolvedValue([]);
    const book = await service.classBook(query, testUser());
    expect(book.lessons).toEqual([]);
    expect(tx.calendarLessonStudent.findMany).toHaveBeenCalledWith({
      where: { calendarLessonId: { in: ['named'] }, studentId: { in: [P1, P2] } },
      select: { calendarLessonId: true, studentId: true },
    });
    expect(JSON.stringify(tx.calendarLessonStudent.findMany.mock.calls)).not.toContain(OUTSIDER);
  });

  it('is a 404 for a group that is not the school’s, and a 400 for a period that is not one or longer than 200 days', async () => {
    tx.studentGroup.findFirst.mockResolvedValue(null);
    await expect(service.classBook(query, testUser())).rejects.toMatchObject({
      constructor: NotFoundException,
      response: { code: CLASS_BOOK_GROUP_NOT_FOUND },
    });
    for (const [from, to] of [
      ['2026-10-25', '2026-10-19'],
      ['2026-08-01', '2027-02-17'],
      ['2026-13-01', '2026-13-02'],
    ]) {
      await expect(service.classBook({ ...query, from: from!, to: to! }, testUser())).rejects.toMatchObject({
        constructor: BadRequestException,
        response: { code: CLASS_BOOK_RANGE },
      });
    }
  });
});
