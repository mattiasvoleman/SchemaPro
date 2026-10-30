import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import { PUPIL_LIST, WITH_SVA, WITHOUT, type PupilListSchool } from '../../test/utils/pupil-list';
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

  describe('Elevlistan i uppföljningen: the class\'s own lesson counts the pupils a replacing group leaves it', () => {
    // The shared school (src/common/__fixtures__/pupil-list-cases.json): 7A of
    // Alva (SvA7, the half), Bo (Stöd7, the half) and Cim. The service and the
    // roster reader run whole; the router answers their reads from the school.
    type Where = Record<string, any>;
    const has = (condition: unknown, value: unknown) =>
      condition === undefined ||
      (condition !== null && typeof condition === 'object' && 'in' in (condition as Where) ? (condition as Where)['in'].includes(value) : condition === value);
    const arrange = (school: PupilListSchool) => {
      const c7a = school.groups.find((group) => group.name === '7A')!;
      const memberships = PUPIL_LIST.pupils.flatMap((pupil) => pupil.groupIds.map((studentGroupId) => ({ studentId: pupil.id, studentGroupId })));
      tx.studentGroup.findFirst.mockResolvedValue({ id: c7a.id, name: '7A', kind: 'CLASS', school: { name: 'Norra skolan' } });
      tx.user.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          PUPIL_LIST.pupils
            .filter((pupil) => has(where['studentGroupId'], pupil.homeGroupId) && has(where['id'], pupil.id))
            .map((pupil) => ({ id: pupil.id, studentGroupId: pupil.homeGroupId })),
        ),
      );
      tx.studentGroupMember.findMany.mockImplementation(({ where, distinct }: { where: Where; distinct?: unknown }) => {
        const rows = memberships.filter((row) => has(where['studentId'], row.studentId) && has(where['studentGroupId'], row.studentGroupId));
        return Promise.resolve(distinct ? [...new Set(rows.map((row) => row.studentGroupId))].map((studentGroupId) => ({ studentGroupId })) : rows);
      });
      tx.studentGroup.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          school.groups.filter((group) => {
            const replaces = where['replacesSubjectId'];
            if (replaces && 'not' in replaces && group.replacesSubjectId === null) return false;
            if (replaces && 'in' in replaces && !replaces['in'].includes(group.replacesSubjectId)) return false;
            return has(where['id'], group.id);
          }),
        ),
      );
      tx.calendarLessonStudent.findMany.mockImplementation(({ where }: { where: Where }) =>
        Promise.resolve(
          PUPIL_LIST.lessons.flatMap((l) =>
            l.named.filter((studentId) => has(where['calendarLessonId'], l.id) && has(where['studentId'], studentId)).map((studentId) => ({ calendarLessonId: l.id, studentId })),
          ),
        ),
      );
      const nameOf = (id: string) => school.groups.find((group) => group.id === id)!.name;
      tx.calendarLesson.findMany.mockResolvedValue(
        PUPIL_LIST.lessons.map((l) =>
          lesson(l.id, l.groupIds[0]!, nameOf(l.groupIds[0]!), {
            subjectId: l.subjectId,
            extraGroups: l.groupIds.slice(1).map((studentGroupId) => ({ studentGroupId, studentGroup: { name: nameOf(studentGroupId) } })),
          }),
        ),
      );
      return c7a.id;
    };
    const counts = async (school: PupilListSchool) => {
      const groupId = arrange(school);
      const book = await service.classBook({ ...query, groupId }, testUser({ role: 'TEACHER' as never }));
      return Object.fromEntries(book.lessons.map((l) => [PUPIL_LIST.lessons.find((x) => x.id === l.id)!.name, l.attending]));
    };

    it('with SvA7 replacing svenska: 7A\'s own svenska holds 2 of its 3; one naming Alva or carrying SvA7 holds all, and says nothing more', async () => {
      expect(await counts(WITH_SVA)).toEqual({
        '7A:s svenska': 2,
        '7A:s svenska, Alva namngiven': null,
        '7A:s svenska med SvA7 tillagd': null,
        'halvans svenska': 1,
        'SvA7:s svenska som andraspråk': 1,
        'Stöd7:s svenska': 1,
        '7A:s matematik': null,
      });
    });

    it('with no replacing group: every own lesson holds the class, null, as before, and no own lesson is rostered', async () => {
      expect(await counts(WITHOUT)).toEqual({
        '7A:s svenska': null,
        '7A:s svenska, Alva namngiven': null,
        '7A:s svenska med SvA7 tillagd': null,
        'halvans svenska': 2,
        'SvA7:s svenska som andraspråk': 1,
        'Stöd7:s svenska': 1,
        '7A:s matematik': null,
      });
      const own = new Set(PUPIL_LIST.lessons.filter((l) => l.groupIds.includes(WITHOUT.groups.find((g) => g.name === '7A')!.id)).map((l) => l.id));
      const asked = (tx.calendarLessonStudent.findMany.mock.calls as Array<[{ where: Where }]>).flatMap(([args]) => args.where['calendarLessonId']['in'] as string[]);
      expect(asked.filter((id) => own.has(id))).toEqual([]);
    });
  });
});
