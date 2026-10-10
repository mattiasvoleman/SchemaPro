import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../../test/utils/prisma-mock';
import type { LocalSlice } from './diff';
import { basisHash, readLocalSlice } from './local-slice';

const YEAR = 'a0000000-0000-4000-8000-000000000001';

const slice = (): LocalSlice => ({
  schoolName: 'Ekskolan',
  users: [
    {
      id: '10000001-0000-4000-8000-000000000000', role: 'STUDENT', firstName: 'Ella', lastName: 'Ek', email: 'Ella@skola.se', isActive: true,
      studentGroupId: null, ss12000Id: null, invited: false, updatedAt: new Date('2026-09-01T00:00:00Z'), deactivatedBySync: false,
    },
    {
      id: '10000002-0000-4000-8000-000000000000', role: 'TEACHER', firstName: 'Tor', lastName: 'Lund', email: 'tor@skola.se', isActive: true,
      studentGroupId: null, ss12000Id: 'e0000002-0000-4000-8000-000000000000', invited: true, updatedAt: new Date('2026-09-01T00:00:00Z'), deactivatedBySync: false,
    },
  ],
  groups: [{ id: '20000001-0000-4000-8000-000000000000', name: '7A', kind: 'CLASS', academicYearId: YEAR, gradeLevel: 7, ss12000Id: null, updatedAt: new Date() }],
  teachingMembers: [],
  guardianLinks: [],
  dutyLinks: [],
  years: [{ id: YEAR, startDate: '2026-08-01', endDate: '2027-07-31', isActive: true }],
  lastAppliedAt: null,
});
const source = { modifiedCursor: null, deletedCursor: null, organisationIds: ['aaaaaaaa-0000-4000-8000-000000000001'] };

describe('basisHash', () => {
  it('is stable across row order, email case and timestamps the diff does not compare', () => {
    const a = slice();
    const b = slice();
    b.users.reverse();
    b.users[1]!.email = 'ella@SKOLA.se';
    b.users.forEach((user) => (user.updatedAt = new Date()));
    expect(basisHash(a, source)).toMatch(/^[0-9a-f]{64}$/);
    expect(basisHash(b, source)).toBe(basisHash(a, source));
  });

  it.each([
    ['a name', (s: LocalSlice) => void (s.users[0]!.firstName = 'Elle')],
    ['a class', (s: LocalSlice) => void (s.users[0]!.studentGroupId = '20000001-0000-4000-8000-000000000000')],
    ['an activation', (s: LocalSlice) => void (s.users[0]!.isActive = false)],
    ['a link', (s: LocalSlice) => void (s.users[0]!.ss12000Id = 'e0000009-0000-4000-8000-000000000000')],
    ['an invitation', (s: LocalSlice) => void (s.users[0]!.invited = true)],
    ['a group name', (s: LocalSlice) => void (s.groups[0]!.name = '7B')],
    ['a guardian link', (s: LocalSlice) => void s.guardianLinks.push({ guardianId: 'x', studentId: 'y', origin: 'MANUAL' })],
    ['the active year', (s: LocalSlice) => void (s.years[0]!.isActive = false)],
  ])('moves when %s changes', (_label, mutate) => {
    const changed = slice();
    mutate(changed);
    expect(basisHash(changed, source)).not.toBe(basisHash(slice(), source));
  });

  it('moves when the cursors or the organisations move', () => {
    const base = basisHash(slice(), source);
    expect(basisHash(slice(), { ...source, modifiedCursor: new Date('2026-10-01T00:00:00Z') })).not.toBe(base);
    expect(basisHash(slice(), { ...source, organisationIds: [...source.organisationIds, 'aaaaaaaa-0000-4000-8000-000000000002'] })).not.toBe(base);
  });
});

describe('readLocalSlice', () => {
  it('locks every row the apply relies on FOR NO KEY UPDATE before reading, when asked', async () => {
    const tx = createTxMock();
    await readLocalSlice(tx as unknown as PrismaClient, 'school', { lock: true });
    const sql = tx.$executeRaw.mock.calls.map(([statement]) => (statement as { strings: string[] }).strings.join('?'));
    expect(sql).toHaveLength(5);
    for (const table of ['Users', 'StudentGroups', 'GuardianStudents', 'StudentGroupMembers', 'Ss12000DutyLinks']) {
      expect(sql.some((text) => text.includes(`"${table}"`) && text.includes('FOR NO KEY UPDATE'))).toBe(true);
    }
  });

  it('calls a person deactivated by an applied sync change, and untouched since, deactivatedBySync', async () => {
    const tx = createTxMock();
    tx.user.findMany.mockResolvedValue([
      { id: 'u1', role: 'STUDENT', firstName: 'A', lastName: 'B', email: 'a@b.se', isActive: false, studentGroupId: null, ss12000Id: 'e1', invitedAt: null, updatedAt: new Date('2026-10-01T10:00:00Z') },
      { id: 'u2', role: 'STUDENT', firstName: 'C', lastName: 'D', email: 'c@d.se', isActive: false, studentGroupId: null, ss12000Id: 'e2', invitedAt: null, updatedAt: new Date('2026-10-05T10:00:00Z') },
    ]);
    tx.ss12000SyncChange.findMany.mockResolvedValue([
      { localId: 'u1', runId: 'r1' },
      { localId: 'u2', runId: 'r1' },
    ]);
    tx.ss12000SyncRun.findMany.mockResolvedValue([{ id: 'r1', appliedAt: new Date('2026-10-01T10:00:00Z') }]);
    tx.school.findFirst.mockResolvedValue({ name: 'Ekskolan', timezone: 'Europe/Stockholm' });
    const result = await readLocalSlice(tx as unknown as PrismaClient, 'school', { lock: false });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(result.users.map((u) => [u.id, u.deactivatedBySync])).toEqual([
      ['u1', true],
      // An admin touched u2 after the sync's deactivation: not the sync's to undo.
      ['u2', false],
    ]);
  });
});
