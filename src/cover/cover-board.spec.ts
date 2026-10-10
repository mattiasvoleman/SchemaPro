import { deriveStatus, pairsStatement, summaryOf, toBoardItem, type PairRow } from './cover-board';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const AHEAD = new Date('2026-10-14T10:00:00.000Z');
const PAST = new Date('2026-10-14T07:00:00.000Z');

const row = (overrides: Partial<PairRow> = {}): PairRow => ({
  absenceId: 'abs-a',
  absentTeacherId: 'A',
  lessonId: 'L',
  isLive: true,
  decisionId: null,
  decision: null,
  decidedAt: null,
  removedTeachers: null,
  date: '2026-10-14',
  startsAt: new Date('2026-10-14T09:00:00.000Z'),
  endsAt: AHEAD,
  subjectId: 'ma',
  studentGroupId: '7a',
  roomId: 'r',
  lessonStatus: 'SCHEDULED',
  cancelCause: null,
  absenceStartsAt: new Date('2026-10-13T22:00:00.000Z'),
  absenceEndsAt: new Date('2026-10-14T22:00:00.000Z'),
  absenceStatus: 'ACTIVE',
  teachers: [{ teacherId: 'A', role: 'LEAD' }],
  extraGroupIds: [],
  coveringSubstituteIds: [],
  ...overrides,
});

describe('the cover board', () => {
  describe('status per pair, from the decision', () => {
    it('CANCELLED for a cancelled lesson whatever the cause, and the cause is carried', () => {
      const item = toBoardItem(row({ lessonStatus: 'CANCELLED', cancelCause: 'EVENT' }), NOW);
      expect([item.status, item.cancelCause]).toEqual(['CANCELLED', 'EVENT']);
    });

    it('COVERED only for a SUBSTITUTE decision with a qualifying substitute row', () => {
      const covered = toBoardItem(
        row({
          decision: 'SUBSTITUTE',
          decidedAt: NOW,
          teachers: [{ teacherId: 'S', role: 'SUBSTITUTE' }],
          coveringSubstituteIds: ['S'],
          removedTeachers: [{ teacherId: 'A', role: 'LEAD' }],
          isLive: false,
        }),
        NOW,
      );
      expect([covered.status, covered.substituteId, covered.absentRole, covered.decisionStale]).toEqual(['COVERED', 'S', 'LEAD', false]);
    });

    it('a substitute who is absent themself reads their own pair OPEN, not covered by themself', () => {
      // S holds a SUBSTITUTE row and is away; the SQL leaves S out of the
      // covering list (the absent person), and there is no decision.
      const item = toBoardItem(
        row({ absentTeacherId: 'S', teachers: [{ teacherId: 'S', role: 'SUBSTITUTE' }], coveringSubstituteIds: [] }),
        NOW,
      );
      expect([item.status, item.absentRole, item.substituteId]).toEqual(['OPEN', 'SUBSTITUTE', null]);
    });

    it('two absent co-teachers: the second stays OPEN once the first is covered', () => {
      const teachers = [
        { teacherId: 'B', role: 'ASSISTANT' as const },
        { teacherId: 'S', role: 'SUBSTITUTE' as const },
      ];
      const first = toBoardItem(
        row({ decision: 'SUBSTITUTE', decidedAt: NOW, isLive: false, teachers, coveringSubstituteIds: ['S'], removedTeachers: [{ teacherId: 'A', role: 'LEAD' }] }),
        NOW,
      );
      const second = toBoardItem(row({ absenceId: 'abs-b', absentTeacherId: 'B', teachers, coveringSubstituteIds: ['S'] }), NOW);
      expect([first.status, second.status]).toEqual(['COVERED', 'OPEN']);
    });

    it('HANDLED for självstudier and the co-teacher', () => {
      expect(toBoardItem(row({ decision: 'SUPERVISED_STUDY', isLive: false }), NOW).status).toBe('HANDLED');
      expect(toBoardItem(row({ decision: 'CO_TEACHER', isLive: false }), NOW).status).toBe('HANDLED');
    });

    it('a SUBSTITUTE decision with no qualifying row left is OPEN and stale', () => {
      const item = toBoardItem(row({ decision: 'SUBSTITUTE', isLive: false, teachers: [], coveringSubstituteIds: [] }), NOW);
      expect([item.status, item.decisionStale]).toEqual(['OPEN', true]);
      // A CANCELLED decision on a lesson reinstated since: the same.
      expect(deriveStatus({ lessonStatus: 'SCHEDULED', endsAt: AHEAD, decision: 'CANCELLED', coveringSubstituteIds: [] }, NOW)).toEqual({
        status: 'OPEN',
        decisionStale: true,
        passed: false,
      });
    });

    it('PASSED is an overlay on an ended lesson', () => {
      const item = toBoardItem(row({ endsAt: PAST }), NOW);
      expect([item.status, item.passed]).toEqual(['OPEN', true]);
      expect(summaryOf([item])).toEqual({ open: 0, covered: 0, cancelled: 0, handled: 0, passedOpen: 1 });
    });

    it('outsideAbsence when the decision’s lesson no longer overlaps the period', () => {
      const moved = toBoardItem(
        row({ decision: 'CO_TEACHER', isLive: false, absenceEndsAt: new Date('2026-10-14T08:30:00.000Z') }),
        NOW,
      );
      expect(moved.outsideAbsence).toBe(true);
      expect(toBoardItem(row(), NOW).outsideAbsence).toBe(false);
    });
  });

  it('carries no reason, reasonId or note in a board item', () => {
    const item = toBoardItem(row({ decision: 'SUPERVISED_STUDY', isLive: false }), NOW);
    expect(JSON.stringify(item)).not.toMatch(/reason|note/i);
  });

  it('the statement reads no reasonId and no note, and leaves WITHDRAWN absences out', () => {
    for (const scope of [
      { kind: 'window' as const, from: '2026-10-14', to: '2026-10-14', winFrom: NOW, winTo: AHEAD },
      { kind: 'absences' as const, ids: ['abs-a'] },
    ]) {
      const { sql } = pairsStatement(scope);
      expect(sql).not.toMatch(/reasonId|"note"/);
      expect(sql).toContain(`ta."status" = 'ACTIVE'`);
      expect(sql).toContain(`cl."status" IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')`);
    }
  });
});
