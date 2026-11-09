import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import type { PlacementPost } from './placement-fit';
import {
  carryPlacementTeachers,
  judgePlacementTeachersNow,
  moveTeachers,
  placementFollowRefusal,
  placementFollowSentence,
  type StoredPlacement,
} from './placement-teachers';

const post = (overrides: Partial<PlacementPost> = {}): PlacementPost => ({
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  lessonLengths: [],
  recurrence: 'ALL_WEEKS',
  blockId: null,
  teacherId: 'anna',
  shares: [{ teacherId: 'bo', lessons: 1, minutes: 60 }],
  ...overrides,
});
const stored = (id: string, teacherId: string | null, dayOfWeek = 2, recurrence: StoredPlacement['recurrence'] = 'ALL_WEEKS'): StoredPlacement => ({
  id,
  requirementId: 'post-1',
  teacherId,
  dayOfWeek,
  startTime: new Date('1970-01-01T10:00:00.000Z'),
  minutes: 60,
  recurrence,
});
const BO = '55555555-5555-4555-8555-555555555555';
const client = (tx: TxMock) => tx as unknown as PrismaClient;

describe('moveTeachers', () => {
  it('writes one statement per new teacher, each with its own rows (a mass swap hands rows to two leads at once)', async () => {
    const tx = createTxMock();
    tx['teachingRequirementPlacement']!['updateMany']!.mockResolvedValue({ count: 1 });
    await moveTeachers(client(tx), [
      { id: 'p1', teacherId: 'xena' },
      { id: 'p2', teacherId: 'yann' },
      { id: 'p3', teacherId: 'xena' },
      { id: 'p4', teacherId: null },
    ]);
    expect(tx['teachingRequirementPlacement']!['updateMany']!.mock.calls).toEqual([
      [{ where: { id: { in: ['p1', 'p3'] } }, data: { teacherId: 'xena' } }],
      [{ where: { id: { in: ['p2'] } }, data: { teacherId: 'yann' } }],
      [{ where: { id: { in: ['p4'] } }, data: { teacherId: null } }],
    ]);
  });

  it('writes nothing for no move', async () => {
    const tx = createTxMock();
    await moveTeachers(client(tx), []);
    expect(tx['teachingRequirementPlacement']!['updateMany']).not.toHaveBeenCalled();
  });
});

describe('placementFollowRefusal', () => {
  it('names the förläggning and its post flat in params, and no person', () => {
    const body = placementFollowRefusal({ ok: false, reason: 'TEACHER', row: stored('p1', BO, 2, 'ODD_WEEKS') }, 'post-1').getResponse() as {
      message: string;
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual({ reason: 'TEACHER', day: 2, start: '10:00', end: '11:00', weeks: 'ODD_WEEKS', requirementId: 'post-1' });
    expect(body.message).toMatch(/^Förläggningen tisdag 10:00–11:00 måste ändras först\. /);
    expect(JSON.stringify(body)).not.toContain(BO);
  });

  it('says a förläggning nobody teaches (its teacher removed) can only be removed, and marks it unstaffed', () => {
    const body = placementFollowRefusal({ ok: false, reason: 'TEACHER_COUNT', row: stored('p1', null) }, 'post-1').getResponse() as {
      message: string;
      params: Record<string, unknown>;
    };
    expect(body.params).toMatchObject({ reason: 'TEACHER_COUNT', unstaffed: 1 });
    expect(body.message).toContain('Ta bort förläggningen först');
    expect(body.message).not.toContain('välj en annan lärare');
    expect(placementFollowSentence({ ok: false, reason: 'TEACHER_COUNT', row: stored('p1', null) }, 'post-1')).toBe(body.message);
  });
});

describe('carryPlacementTeachers', () => {
  it('reads nothing for a post that shares nothing before and after', async () => {
    const tx = createTxMock();
    await carryPlacementTeachers(client(tx), [
      { requirementId: 'post-1', before: post({ shares: [] }), after: post({ shares: [], teacherId: 'xena' }) },
    ]);
    expect(tx['teachingRequirementPlacement']!['findMany']).not.toHaveBeenCalled();
    expect(tx['$executeRaw']).not.toHaveBeenCalled();
  });

  it('moves each post’s rows to its own new lead in one call, then has the database judge them, by name and back', async () => {
    const tx = createTxMock();
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([
      stored('p1', 'anna'),
      { ...stored('p2', 'carl', 3), requirementId: 'post-2' },
    ]);
    tx['teachingRequirementPlacement']!['updateMany']!.mockResolvedValue({ count: 1 });
    await carryPlacementTeachers(client(tx), [
      { requirementId: 'post-1', before: post(), after: post({ teacherId: 'xena' }) },
      { requirementId: 'post-2', before: post({ teacherId: 'carl' }), after: post({ teacherId: 'yann' }) },
    ]);
    expect(tx['teachingRequirementPlacement']!['updateMany']!.mock.calls).toEqual([
      [{ where: { id: { in: ['p1'] } }, data: { teacherId: 'xena' } }],
      [{ where: { id: { in: ['p2'] } }, data: { teacherId: 'yann' } }],
    ]);
    const statements = tx['$executeRaw'].mock.calls.map((call) => (call[0] as TemplateStringsArray).join('?'));
    expect(statements).toEqual([
      'SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit", "TeachingRequirementShares_placement_teachers_fit", "TeachingRequirements_placement_teachers_fit" IMMEDIATE',
      'SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit", "TeachingRequirementShares_placement_teachers_fit", "TeachingRequirements_placement_teachers_fit" DEFERRED',
    ]);
  });

  it('refuses with the post the refused förläggning is on, and moves nothing', async () => {
    const tx = createTxMock();
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue([{ ...stored('p9', 'bo'), requirementId: 'post-2' }]);
    await expect(
      carryPlacementTeachers(client(tx), [
        { requirementId: 'post-1', before: post(), after: post({ teacherId: 'xena' }) },
        { requirementId: 'post-2', before: post(), after: post({ shares: [] }) },
      ]),
    ).rejects.toMatchObject({ status: 409, response: { params: { reason: 'TEACHER', requirementId: 'post-2' } } });
    expect(tx['teachingRequirementPlacement']!['updateMany']).not.toHaveBeenCalled();
    expect(tx['$executeRaw']).not.toHaveBeenCalled();
  });
});

describe('judgePlacementTeachersNow', () => {
  it('names the three constraint triggers, never ALL', async () => {
    const tx = createTxMock();
    await judgePlacementTeachersNow(client(tx));
    const statements = tx['$executeRaw'].mock.calls.map((call) => (call[0] as TemplateStringsArray).join('?'));
    expect(statements.every((sql) => !/\bALL\b/.test(sql))).toBe(true);
  });
});
