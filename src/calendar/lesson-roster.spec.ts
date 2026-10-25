import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { calendarLessonRosters, rostersOf, scopeOf } from './lesson-roster';

/**
 * The one reader of who attends a lesson. The fixtures below play the
 * database: each row names the group (or lesson) it belongs to, and the
 * mock answers by the `in` list it is asked, so a scope that reads another
 * scope's group shows up as a wrong roster.
 */

type Row = Record<string, unknown>;
type Where = Record<string, { in?: unknown[] } | unknown>;

/** findMany over rows: the rows whose `in` columns hold the asked values (other conditions are asserted, not applied). */
const answer = (rows: Row[]) => (query: { where?: Where } = {}) =>
  Promise.resolve(
    rows.filter((row) =>
      Object.entries(query.where ?? {}).every(([column, condition]) => {
        const list = (condition as { in?: unknown[] } | undefined)?.in;
        return !Array.isArray(list) || row[column] === undefined || list.includes(row[column]);
      }),
    ),
  );

describe('lesson roster', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;

  beforeEach(() => {
    tx = createTxMock();
    // 7A: Ada and Bo at home. Ma7 (a nivågrupp): Ada and Cy, no home pupils.
    tx.user.findMany.mockImplementation(
      answer([
        { id: 'ada', studentGroupId: '7A' },
        { id: 'bo', studentGroupId: '7A' },
        { id: 'dan', studentGroupId: '8B' },
      ]),
    );
    tx.studentGroupMember.findMany.mockImplementation(
      answer([
        { studentId: 'ada', studentGroupId: 'Ma7' },
        { studentId: 'cy', studentGroupId: 'Ma7' },
      ]),
    );
  });

  it('is the union of the home classes, the teaching groups and the pupils named, per lesson', async () => {
    // The named pupils who are active pupils: Eli; Gus has left.
    tx.user.findMany.mockImplementation((query: { where: Where }) =>
      'studentGroupId' in query.where ? answer([{ id: 'ada', studentGroupId: '7A' }, { id: 'bo', studentGroupId: '7A' }])(query) : Promise.resolve([{ id: 'eli' }]),
    );
    const rosters = await rostersOf(
      client(),
      [
        { subjectId: 'MA', groupIds: ['7A'], participantIds: [] },
        { subjectId: 'MA', groupIds: ['Ma7'], participantIds: ['eli', 'gus'] },
        { subjectId: 'MA', groupIds: ['7A', 'Ma7'], participantIds: [] },
      ],
      { pupils: 'ACTIVE' },
    );
    expect(rosters.map((roster) => [...roster].sort())).toEqual([
      ['ada', 'bo'],
      ['ada', 'cy', 'eli'],
      ['ada', 'bo', 'cy'],
    ]);
    // Three statements for three lessons: one per source, never one per lesson.
    expect(tx.user.findMany).toHaveBeenCalledTimes(2);
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledTimes(1);
    // Who is told: active pupils, by every source.
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: ['7A', 'Ma7'] }, role: 'STUDENT', isActive: true },
      select: { id: true, studentGroupId: true },
    });
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: ['7A', 'Ma7'] }, student: { role: 'STUDENT', isActive: true } },
      select: { studentId: true, studentGroupId: true },
    });
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['eli', 'gus'] }, role: 'STUDENT', isActive: true },
      select: { id: true },
    });
  });

  it('reads membership as recorded for a register, and only the pupils asked about', async () => {
    const [roster] = await rostersOf(client(), [{ subjectId: 'MA', groupIds: ['7A', 'Ma7'], participantIds: ['gus'] }], {
      pupils: 'RECORDED',
      among: ['cy', 'gus', 'zed'],
    });
    expect([...roster!].sort()).toEqual(['cy', 'gus']);
    // No role or status filter: a queued register drains after a pupil leaves.
    expect(tx.user.findMany).toHaveBeenCalledTimes(1);
    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: ['7A', 'Ma7'] }, id: { in: ['cy', 'gus', 'zed'] } },
      select: { id: true, studentGroupId: true },
    });
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: ['7A', 'Ma7'] }, studentId: { in: ['cy', 'gus', 'zed'] } },
      select: { studentId: true, studentGroupId: true },
    });
  });

  it('asks nothing for no lesson, or for nobody to ask about', async () => {
    await expect(rostersOf(client(), [], { pupils: 'ACTIVE' })).resolves.toEqual([]);
    await expect(rostersOf(client(), [{ subjectId: 'MA', groupIds: ['7A'], participantIds: ['x'] }], { pupils: 'RECORDED', among: [] })).resolves.toEqual([
      new Set(),
    ]);
    await expect(calendarLessonRosters(client(), [{ id: 'l1', subjectId: 'MA', studentGroupId: '7A', extraGroups: [] }], { pupils: 'RECORDED', among: [] })).resolves.toEqual(
      new Map([['l1', new Set()]]),
    );
    expect(tx.user.findMany).not.toHaveBeenCalled();
    expect(tx.studentGroupMember.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLessonStudent.findMany).not.toHaveBeenCalled();
  });

  it('reads calendar lessons’ named pupils in one statement and keys the rosters by lesson', async () => {
    tx.calendarLessonStudent.findMany.mockResolvedValue([
      { calendarLessonId: 'l2', studentId: 'cy' },
      { calendarLessonId: 'l2', studentId: 'dan' },
    ]);
    const rosters = await calendarLessonRosters(
      client(),
      [
        { id: 'l1', subjectId: 'MA', studentGroupId: '7A', extraGroups: [] },
        { id: 'l2', subjectId: 'MA', studentGroupId: 'Ma7', extraGroups: [{ studentGroupId: '7A' }] },
      ],
      { pupils: 'RECORDED' },
    );
    expect([...rosters.get('l1')!].sort()).toEqual(['ada', 'bo']);
    expect([...rosters.get('l2')!].sort()).toEqual(['ada', 'bo', 'cy', 'dan']);
    expect(tx.calendarLessonStudent.findMany).toHaveBeenCalledWith({
      where: { calendarLessonId: { in: ['l1', 'l2'] } },
      select: { calendarLessonId: true, studentId: true },
    });
  });

  it('takes a lesson in hand as its subject, its class, the groups joined to it and the pupils named on it', () => {
    expect(
      scopeOf({
        subjectId: 'MA',
        studentGroupId: '7A',
        extraGroups: [{ studentGroupId: 'Ma7' }],
        participants: [{ studentId: 'eli' }],
      }),
    ).toEqual({ subjectId: 'MA', groupIds: ['7A', 'Ma7'], participantIds: ['eli'] });
    expect(scopeOf({ subjectId: 'MA', studentGroupId: '7A' })).toEqual({ subjectId: 'MA', groupIds: ['7A'], participantIds: [] });
  });

  describe('Ersättande grupper: a replacing group takes its members off its subject’s other lessons', () => {
    // SvA7 replaces Svenska and holds Ada (of 7A) and Cy.
    beforeEach(() => {
      tx.studentGroup.findMany.mockImplementation(
        answer([
          { id: 'SvA7', replacesSubjectId: 'SV' },
          { id: 'EnS', replacesSubjectId: 'EN' },
        ]),
      );
      tx.studentGroupMember.findMany.mockImplementation(
        answer([
          { studentId: 'ada', studentGroupId: 'Ma7' },
          { studentId: 'cy', studentGroupId: 'Ma7' },
          { studentId: 'ada', studentGroupId: 'SvA7' },
          { studentId: 'cy', studentGroupId: 'SvA7' },
        ]),
      );
    });

    it('lists 7A’s svenska without its SvA pupils, and every other lesson as before', async () => {
      const rosters = await rostersOf(
        client(),
        [
          { subjectId: 'SV', groupIds: ['7A'], participantIds: [] },
          { subjectId: 'MA', groupIds: ['7A'], participantIds: [] },
          { subjectId: 'SV', groupIds: ['Ma7'], participantIds: [] },
        ],
        { pupils: 'RECORDED' },
      );
      expect(rosters.map((roster) => [...roster].sort())).toEqual([['bo'], ['ada', 'bo'], []]);
      // The replacing groups of the scopes' subjects (SvA7; EnS replaces
      // Engelska, which no scope is in), in one statement, and their members
      // in another.
      expect(tx.studentGroup.findMany).toHaveBeenCalledTimes(1);
      expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
        where: { replacesSubjectId: { in: ['SV', 'MA'] } },
        select: { id: true, replacesSubjectId: true },
      });
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: ['SvA7'] } },
        select: { studentId: true, studentGroupId: true },
      });
    });

    it('keeps SvA7’s pupils on a lesson SvA7 is added to, and a named pupil on any lesson', async () => {
      const rosters = await rostersOf(
        client(),
        [
          { subjectId: 'SV', groupIds: ['7A', 'SvA7'], participantIds: [] },
          { subjectId: 'SV', groupIds: ['7A'], participantIds: ['ada'] },
          { subjectId: 'SV', groupIds: ['SvA7'], participantIds: [] },
        ],
        { pupils: 'RECORDED' },
      );
      expect(rosters.map((roster) => [...roster].sort())).toEqual([['ada', 'bo', 'cy'], ['ada', 'bo'], ['ada', 'cy']]);
    });

    it('asks the members only about the pupils asked about', async () => {
      const [roster] = await rostersOf(client(), [{ subjectId: 'SV', groupIds: ['7A'], participantIds: [] }], {
        pupils: 'RECORDED',
        among: ['ada', 'bo'],
      });
      expect([...roster!].sort()).toEqual(['bo']);
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: ['SvA7'] }, studentId: { in: ['ada', 'bo'] } },
        select: { studentId: true, studentGroupId: true },
      });
    });

    it('reads no member at a school with no replacing group in the lessons’ subjects', async () => {
      tx.studentGroup.findMany.mockResolvedValue([]);
      const [roster] = await rostersOf(client(), [{ subjectId: 'SV', groupIds: ['7A'], participantIds: [] }], {
        pupils: 'RECORDED',
      });
      expect([...roster!].sort()).toEqual(['ada', 'bo']);
      // The teaching groups' read only: no second one for replacing members.
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledTimes(1);
    });

    it('follows into the calendar lessons’ rosters, by each lesson’s subject', async () => {
      const rosters = await calendarLessonRosters(
        client(),
        [
          { id: 'sv', subjectId: 'SV', studentGroupId: '7A', extraGroups: [] },
          { id: 'en', subjectId: 'EN', studentGroupId: '7A', extraGroups: [] },
        ],
        { pupils: 'RECORDED' },
      );
      expect([...rosters.get('sv')!].sort()).toEqual(['bo']);
      // EnS replaces Engelska but holds nobody of 7A: 7A's engelska is whole.
      expect([...rosters.get('en')!].sort()).toEqual(['ada', 'bo']);
    });
  });
});
