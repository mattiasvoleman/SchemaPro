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
    const body = placementFollowRefusal({ ok: false, reason: 'TEACHER', row: stored('p1', BO, 2, 'ODD_WEEKS'), unstaffed: false, startsSharing: false }, 'post-1').getResponse() as {
      message: string;
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual({ reason: 'TEACHER', day: 2, start: '10:00', end: '11:00', weeks: 'ODD_WEEKS', requirementId: 'post-1' });
    expect(body.message).toMatch(/^Förläggningen tisdag 10:00–11:00 måste ändras först\. /);
    expect(JSON.stringify(body)).not.toContain(BO);
  });

  it('carries the flag followPlacements gives, and the sentence follows it', () => {
    const nobody = placementFollowRefusal({ ok: false, reason: 'TEACHER_COUNT', row: stored('p1', null), unstaffed: true, startsSharing: false }, 'post-1');
    const body = nobody.getResponse() as { message: string; params: Record<string, unknown> };
    expect(body.params).toMatchObject({ reason: 'TEACHER_COUNT', unstaffed: 1 });
    expect(body.message).toContain('Ta bort förläggningen först');
    expect(body.message).not.toContain('välj en annan lärare');
    expect(placementFollowSentence({ ok: false, reason: 'TEACHER_COUNT', row: stored('p1', null), unstaffed: true, startsSharing: false }, 'post-1')).toBe(body.message);
  });
});

describe('placementFollowRefusal: a post that starts to share and changes its huvudlärare at once (review of #298, LÅG-3 of the second round)', () => {
  it('says why the förläggning cannot be given a teacher, and the two steps that go, in params as `starts`', () => {
    const body = placementFollowRefusal({ ok: false, reason: 'TEACHER', row: stored('p1', null, 2, 'ODD_WEEKS'), unstaffed: false, startsSharing: true }, 'post-1').getResponse() as {
      message: string;
      params: Record<string, unknown>;
    };
    expect(body.params).toEqual({ reason: 'TEACHER', day: 2, start: '10:00', end: '11:00', weeks: 'ODD_WEEKS', requirementId: 'post-1', starts: 1 });
    expect(body.message).toContain('ny huvudlärare och delade lektioner i samma ändring');
    expect(body.message).not.toContain('Välj en av postens lärare');
  });

  it('is the ordinary sentence otherwise, and the unstaffed sentence wins over it', () => {
    const plain = placementFollowRefusal({ ok: false, reason: 'TEACHER', row: stored('p1', null), unstaffed: false, startsSharing: false }, 'post-1').getResponse() as { message: string; params: Record<string, unknown> };
    expect(plain.message).toContain('Välj en av postens lärare');
    expect(plain.params).not.toHaveProperty('starts');
    const counted = placementFollowRefusal({ ok: false, reason: 'TEACHER_COUNT', row: stored('p1', null), unstaffed: false, startsSharing: true }, 'post-1').getResponse() as { message: string; params: Record<string, unknown> };
    expect(counted.message).not.toContain('ny huvudlärare');
    expect(counted.params).not.toHaveProperty('starts');
    const both = placementFollowRefusal({ ok: false, reason: 'TEACHER', row: stored('p1', null), unstaffed: true, startsSharing: true }, 'post-1').getResponse() as { message: string };
    expect(both.message).toContain('ingen lärare sedan dess lärare togs bort');
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

describe('carryPlacementTeachers and a förläggning that names nobody (review of #298, MEDEL-3)', () => {
  const refusalOf = async (change: Parameters<typeof carryPlacementTeachers>[1][number], rows: StoredPlacement[]) => {
    const tx = createTxMock();
    tx['teachingRequirementPlacement']!['findMany']!.mockResolvedValue(rows);
    try {
      await carryPlacementTeachers(client(tx), [change]);
    } catch (error) {
      return (error as { getResponse(): { message: string; params: Record<string, unknown> } }).getResponse();
    }
    throw new Error('not refused');
  };

  it('is not unstaffed on a post that starts to share and leaves its lead fewer lessons than are placed: TEACHER_COUNT, choose another teacher', async () => {
    const body = await refusalOf(
      { requirementId: 'post-1', before: post({ shares: [] }), after: post({ shares: [{ teacherId: BO, lessons: 2, minutes: 60 }] }) },
      [stored('p1', null), stored('p2', null, 4)],
    );
    expect(body.params).toEqual({ reason: 'TEACHER_COUNT', day: 4, start: '10:00', end: '11:00', weeks: 'ALL_WEEKS', requirementId: 'post-1' });
    expect(body.message).toContain('välj en annan lärare');
  });

  it('is unstaffed on a shared post whose share’s teacher was removed, when the change leaves no lesson nobody teaches', async () => {
    const removed = post({ shares: [{ teacherId: null, lessons: 1, minutes: 60 }] });
    const body = await refusalOf(
      { requirementId: 'post-1', before: removed, after: post({ teacherId: 'xena', shares: [{ teacherId: 'dan', lessons: 1, minutes: 60 }] }) },
      [stored('p1', null)],
    );
    expect(body.params).toMatchObject({ reason: 'TEACHER', unstaffed: 1, requirementId: 'post-1' });
    expect(body.message).toContain('Ta bort förläggningen först');
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
