import { createTxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { readPersonDays } from './cover-context';
import { hardFindings } from './cover-rules';

/*
 * Administratör som lärare (Users.teaches), beslut 4: an administrator who teaches
 * counts as a teacher where the question is "who teaches in the school", and is NOT
 * a teacher where the question is "who may step in": the substitute, the cover
 * request's colleague side, the pool and a klasslärare stay the teachers'. The cover
 * rules are the one place those steps meet, and this pins that they read the row's
 * role and not the mark: a teaching administrator is INACTIVE as a candidate, and is
 * not read in the school's default list of people to judge.
 *
 * The other steps are pinned beside their own specs (calendar-lessons.service.spec.ts:
 * the substitute and the suggestions; cover-requests.service.spec.ts: the recipients).
 */
describe('a teaching administrator is not a cover candidate', () => {
  const date = '2026-10-20';
  const timezone = 'Europe/Stockholm';
  const MARKED = '99999999-9999-4999-8999-999999999999';
  const TEACHER = '88888888-8888-4888-8888-888888888888';

  it('is read as no active teacher, whatever the mark: only a TEACHER is one', async () => {
    const tx = createTxMock();
    const read = await readPersonDays(tx as unknown as PrismaClient, {
      date,
      timezone,
      academicYearId: null,
      known: [
        { id: MARKED, role: 'SCHOOL_ADMIN', isActive: true },
        { id: TEACHER, role: 'TEACHER', isActive: true },
      ],
    });
    expect(read.days.get(MARKED)?.isActiveTeacher).toBe(false);
    expect(read.days.get(TEACHER)?.isActiveTeacher).toBe(true);
  });

  it('is judged INACTIVE by the hard rules, so the board never proposes them', async () => {
    const tx = createTxMock();
    const read = await readPersonDays(tx as unknown as PrismaClient, {
      date,
      timezone,
      academicYearId: null,
      known: [{ id: MARKED, role: 'SCHOOL_ADMIN', isActive: true }],
    });
    const target = { id: 'lesson', date, start: Date.parse(`${date}T08:00:00Z`), end: Date.parse(`${date}T08:45:00Z`), teacherIds: [] as string[] };
    const findings = hardFindings(read.days.get(MARKED)!, target);
    expect(findings.map((finding) => finding.code)).toContain('INACTIVE');
  });

  it('is not in the default read of the school’s teachers either: the list is TEACHER, and active', async () => {
    const tx = createTxMock();
    await readPersonDays(tx as unknown as PrismaClient, { date, timezone, academicYearId: null });
    expect(tx['user']!['findMany']).toHaveBeenCalledWith({
      where: { role: 'TEACHER', isActive: true },
      select: { id: true, role: true, isActive: true },
    });
  });
});
