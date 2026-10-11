import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../../test/utils/prisma-mock';
import { applyChanges, type StoredChange } from './apply';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const YEAR = 'a0000000-0000-4000-8000-000000000001';
const STAMP = new Date('2026-10-10T08:00:00Z');
const ext = (n: number) => `e${String(n).padStart(7, '0')}-0000-4000-8000-000000000000`;
const loc = (n: number) => `10${String(n).padStart(6, '0')}-0000-4000-8000-000000000000`;
let seq = 0;
const change = (patch: Partial<StoredChange> & Pick<StoredChange, 'entity' | 'op'>): StoredChange => ({
  id: `c${String(++seq).padStart(7, '0')}-0000-4000-8000-000000000000`,
  seq,
  externalId: null,
  localId: null,
  after: null,
  ...patch,
});

const sqlOf = (tx: TxMock) =>
  tx.$executeRaw.mock.calls.map(([statement]) => {
    const sql = statement as { strings: string[]; values: unknown[] };
    return { text: sql.strings.join('?').replace(/\s+/g, ' '), values: sql.values };
  });

describe('applyChanges', () => {
  let tx: TxMock;
  beforeEach(() => {
    seq = 0;
    tx = createTxMock();
    tx.studentGroup.updateMany.mockResolvedValue({ count: 1 });
    tx.user.updateMany.mockResolvedValue({ count: 1 });
  });
  const run = (changes: StoredChange[]) => applyChanges(tx as unknown as PrismaClient, SCHOOL, changes, STAMP);

  it('creates a class and a pupil, then moves the pupil into it by the source ids, in that order', async () => {
    const createGroup = change({ entity: 'GROUP', op: 'CREATE', externalId: ext(70), after: { name: '7A', kind: 'CLASS', academicYearId: YEAR, gradeLevel: 7 } });
    const createPupil = change({ entity: 'PERSON', op: 'CREATE', externalId: ext(1), after: { role: 'STUDENT', firstName: 'Ella', lastName: 'Ek', email: 'ella@skola.se' } });
    const move = change({ entity: 'CLASS_MEMBERSHIP', op: 'MOVE', externalId: ext(1), after: { groupExternalId: ext(70), groupLocalId: null } });
    // Given out of order on purpose: the apply orders by dependency, not by seq.
    const outcome = await run([move, createPupil, createGroup]);

    expect(outcome.applied.sort()).toEqual([createGroup.id, createPupil.id, move.id].sort());
    const group = tx.studentGroup.createMany.mock.calls[0]![0].data[0];
    expect(group).toMatchObject({ schoolId: SCHOOL, academicYearId: YEAR, name: '7A', kind: 'CLASS', gradeLevel: 7, ss12000Id: ext(70), updatedAt: STAMP });
    const pupil = tx.user.createMany.mock.calls[0]![0].data[0];
    expect(pupil).toMatchObject({ schoolId: SCHOOL, role: 'STUDENT', email: 'ella@skola.se', ss12000Id: ext(1), invitedAt: null, updatedAt: STAMP });
    // A catalogue row: a placeholder identity no Supabase user has.
    expect(pupil.authId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pupil.authId).not.toBe(pupil.id);
    const [moveSql] = sqlOf(tx);
    expect(moveSql!.text).toContain(`u."role" = 'STUDENT'`);
    expect(moveSql!.values).toEqual(expect.arrayContaining([pupil.id, group.id]));
    expect(tx.studentGroup.createMany.mock.invocationCallOrder[0]).toBeLessThan(tx.user.createMany.mock.invocationCallOrder[0]!);
    expect(tx.user.createMany.mock.invocationCallOrder[0]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0]!);
  });

  it('skips a change whose dependency was not applied (its create deselected), and applies the rest', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(2), ss12000Id: ext(2) }]);
    const move = change({ entity: 'CLASS_MEMBERSHIP', op: 'MOVE', externalId: ext(1), after: { groupExternalId: ext(70) } });
    const add = change({ entity: 'RESPONSIBLE', op: 'ADD', externalId: ext(1), localId: loc(1), after: { guardianExternalId: ext(10) } });
    const name = change({ entity: 'PERSON', op: 'UPDATE', localId: loc(2), externalId: ext(2), after: { firstName: 'A', lastName: 'B' } });
    const outcome = await run([move, add, name]);
    expect(outcome.applied).toEqual([name.id]);
    expect(outcome.skipped.map((s) => [s.id, s.code])).toEqual([
      [move.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
      [add.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
    ]);
  });

  it('links to rows already linked before the apply, read from the database', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(10), ss12000Id: ext(10) }, { id: loc(1), ss12000Id: ext(1) }]);
    const add = change({ entity: 'RESPONSIBLE', op: 'ADD', externalId: ext(1), localId: loc(1), after: { guardianExternalId: ext(10), guardianLocalId: null } });
    await run([add]);
    expect(tx.guardianStudent.createMany).toHaveBeenCalledWith({
      data: [{ schoolId: SCHOOL, guardianId: loc(10), studentId: loc(1), origin: 'SS12000' }],
      skipDuplicates: true,
    });
  });

  it('writes nothing to the row a deselected LINK matched, whatever local ids the dependants carry', async () => {
    // k3: the admin deselected "P5 -> Lisa", "G3 -> another guardian" and
    // "7C -> local 7C"; the dependants stay selected. Even with local ids in
    // them (as a diff before this rule wrote), none may reach those rows.
    const name = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(5), localId: loc(1), after: { firstName: 'Per', lastName: 'Fem' } });
    const guardianName = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(30), localId: loc(2), after: { firstName: 'Gull', lastName: 'Fem' } });
    const move = change({ entity: 'CLASS_MEMBERSHIP', op: 'MOVE', externalId: ext(5), localId: loc(1), after: { groupExternalId: ext(70), groupLocalId: loc(70) } });
    const member = change({ entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: ext(5), localId: loc(1), after: { groupExternalId: ext(71), groupLocalId: loc(71) } });
    const guardian = change({ entity: 'RESPONSIBLE', op: 'ADD', externalId: ext(5), localId: loc(1), after: { guardianExternalId: ext(30), guardianLocalId: loc(2) } });
    const dutyLink = change({
      entity: 'DUTY_LINK', op: 'ADD', externalId: ext(50),
      after: { personExternalId: ext(31), userLocalId: loc(3), startDate: '2026-08-01', academicYearId: YEAR },
    });
    const outcome = await run([name, guardianName, move, member, guardian, dutyLink]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped.map((s) => s.code)).toEqual(Array(6).fill('SS12000_DEPENDENCY_NOT_APPLIED'));
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.studentGroupMember.createMany).not.toHaveBeenCalled();
    expect(tx.guardianStudent.createMany).not.toHaveBeenCalled();
    expect(tx.ss12000DutyLink.createMany).not.toHaveBeenCalled();
  });

  it('refuses a LINK whose row was linked or deactivated meanwhile (SS12000_TARGET_CHANGED)', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    const link = change({ entity: 'PERSON', op: 'LINK', externalId: ext(1), localId: loc(1) });
    const outcome = await run([link]);
    expect(outcome.skipped).toEqual([expect.objectContaining({ id: link.id, code: 'SS12000_TARGET_CHANGED' })]);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: loc(1), schoolId: SCHOOL, ss12000Id: null, isActive: true },
      data: { ss12000Id: ext(1), updatedAt: STAMP },
    });
  });

  it('deactivates last, never a SCHOOL_ADMIN, and stamps updatedAt with the apply\'s stamp', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(2), ss12000Id: ext(2) }]);
    const off = change({ entity: 'PERSON', op: 'DEACTIVATE', externalId: ext(1), localId: loc(1) });
    const name = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(2), localId: loc(2), after: { firstName: 'A', lastName: 'B' } });
    await run([off, name]);
    const [names, deactivation] = sqlOf(tx);
    expect(names!.text).toContain(`"role" <> 'SCHOOL_ADMIN'`);
    expect(deactivation!.text).toContain(`SET "isActive" = false`);
    expect(deactivation!.text).toContain(`"role" <> 'SCHOOL_ADMIN'`);
    expect(deactivation!.values).toEqual(expect.arrayContaining([STAMP, SCHOOL, loc(1)]));
  });

  it('ends a duty link by setting endedAt, never by removing it', async () => {
    const end = change({ entity: 'DUTY_LINK', op: 'END', externalId: ext(51), localId: loc(500) });
    await run([end]);
    expect(tx.ss12000DutyLink.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [loc(500)] }, schoolId: SCHOOL, endedAt: null },
      data: { endedAt: STAMP, updatedAt: STAMP },
    });
  });

  it('batches writes in chunks of 500', async () => {
    const creates = Array.from({ length: 1201 }, (_, i) =>
      change({ entity: 'PERSON', op: 'CREATE', externalId: ext(i), after: { role: 'GUARDIAN', firstName: 'G', lastName: String(i), email: `g${i}@hem.se` } }),
    );
    await run(creates);
    expect(tx.user.createMany.mock.calls.map(([arg]) => arg.data.length)).toEqual([500, 500, 201]);
  });
});

describe('applyChanges, op by op', () => {
  let tx: TxMock;
  beforeEach(() => {
    seq = 100;
    tx = createTxMock();
  });
  const run = (changes: StoredChange[]) => applyChanges(tx as unknown as PrismaClient, SCHOOL, changes, STAMP);

  it('links a group (unless it was linked meanwhile) and renames one', async () => {
    tx.studentGroup.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    const link = change({ entity: 'GROUP', op: 'LINK', externalId: ext(70), localId: loc(70) });
    const lost = change({ entity: 'GROUP', op: 'LINK', externalId: ext(71), localId: loc(71) });
    const rename = change({ entity: 'GROUP', op: 'UPDATE', externalId: ext(72), localId: loc(72), after: { name: '8B' } });
    const unnamed = change({ entity: 'GROUP', op: 'UPDATE', externalId: ext(73), localId: loc(73), after: {} });
    const move = change({ entity: 'CLASS_MEMBERSHIP', op: 'MOVE', localId: loc(1), externalId: ext(1), after: { groupExternalId: ext(70) } });
    const outcome = await run([link, lost, rename, unnamed, move]);
    expect(outcome.applied.sort()).toEqual([link.id, rename.id, move.id].sort());
    expect(outcome.skipped).toEqual([expect.objectContaining({ id: lost.id, code: 'SS12000_TARGET_CHANGED' })]);
    expect(tx.studentGroup.updateMany).toHaveBeenCalledWith({ where: { id: loc(72), schoolId: SCHOOL }, data: { name: '8B', updatedAt: STAMP } });
    // The move found the group the link made in this same apply.
    expect(sqlOf(tx)[0]!.values).toEqual(expect.arrayContaining([loc(1), loc(70)]));
  });

  it('relinks and reactivates a deactivated row on the admin’s word, and refuses one linked meanwhile', async () => {
    tx.user.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const relink = change({ entity: 'PERSON', op: 'RELINK', externalId: ext(1), localId: loc(1) });
    const lost = change({ entity: 'PERSON', op: 'RELINK', externalId: ext(2), localId: loc(2) });
    const outcome = await run([relink, lost]);
    expect(tx.user.updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: loc(1), schoolId: SCHOOL, ss12000Id: null, role: { not: 'SCHOOL_ADMIN' } },
      data: { ss12000Id: ext(1), isActive: true, updatedAt: STAMP },
    });
    expect(outcome.applied).toEqual([relink.id]);
    expect(outcome.skipped.map((s) => s.code)).toEqual(['SS12000_TARGET_CHANGED']);
  });

  it('changes an email and reactivates a person, never an admin', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    const email = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(1), localId: loc(1), after: { email: 'ny@skola.se' } });
    const back = change({ entity: 'PERSON', op: 'REACTIVATE', externalId: ext(2), localId: loc(2) });
    const nowhere = change({ entity: 'PERSON', op: 'REACTIVATE', externalId: ext(3) });
    const outcome = await run([email, back, nowhere]);
    expect(outcome.applied).toEqual([email.id, back.id]);
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: loc(1), schoolId: SCHOOL, role: { not: 'SCHOOL_ADMIN' } },
      data: { email: 'ny@skola.se', updatedAt: STAMP },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: loc(2), schoolId: SCHOOL, isActive: false, role: { not: 'SCHOOL_ADMIN' } },
      data: { isActive: true, updatedAt: STAMP },
    });
  });

  it('adds a teaching-group member into a group made in the same apply, and skips one with no group', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }, { id: loc(2), ss12000Id: ext(2) }]);
    const createGroup = change({ entity: 'GROUP', op: 'CREATE', externalId: ext(90), after: { name: 'Spanska', kind: 'TEACHING_GROUP', academicYearId: YEAR } });
    const add = change({ entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: ext(1), localId: loc(1), after: { groupExternalId: ext(90) } });
    const orphan = change({ entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: ext(2), localId: loc(2), after: { groupExternalId: ext(91) } });
    const outcome = await run([createGroup, add, orphan]);
    const group = tx.studentGroup.createMany.mock.calls[0]![0].data[0];
    expect(group).toMatchObject({ kind: 'TEACHING_GROUP', gradeLevel: null });
    expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
      data: [{ schoolId: SCHOOL, studentGroupId: group.id, studentId: loc(1) }],
      skipDuplicates: true,
    });
    expect(outcome.skipped.map((s) => s.id)).toEqual([orphan.id]);
  });

  it('adds and updates duty links, re-opening an ended one, and skips what it cannot place', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(5), ss12000Id: ext(5) }]);
    const add = change({
      entity: 'DUTY_LINK', op: 'ADD', externalId: ext(50),
      after: { personExternalId: ext(5), userLocalId: null, dutyRole: 'Förstelärare', startDate: '2026-08-01', endDate: '2027-06-30', academicYearId: YEAR },
    });
    const noYear = change({ entity: 'DUTY_LINK', op: 'ADD', externalId: ext(51), after: { personExternalId: ext(5), startDate: '2026-08-01' } });
    const update = change({
      entity: 'DUTY_LINK', op: 'UPDATE', externalId: ext(52), localId: loc(52),
      after: { personExternalId: ext(5), userLocalId: loc(5), startDate: '2026-08-02', endDate: null },
    });
    const nobody = change({ entity: 'DUTY_LINK', op: 'UPDATE', externalId: ext(53), localId: loc(53), after: { personExternalId: ext(9), startDate: '2026-08-02' } });
    const outcome = await run([add, noYear, update, nobody]);
    expect(tx.ss12000DutyLink.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: loc(5), ss12000DutyId: ext(50), dutyRole: 'Förstelärare',
          startDate: new Date('2026-08-01T00:00:00Z'), endDate: new Date('2027-06-30T00:00:00Z'), academicYearId: YEAR,
        }),
      ],
      skipDuplicates: true,
    });
    expect(tx.ss12000DutyLink.updateMany).toHaveBeenCalledWith({
      where: { id: loc(52), schoolId: SCHOOL },
      data: { userId: loc(5), dutyRole: 'Lärare', startDate: new Date('2026-08-02T00:00:00Z'), endDate: null, endedAt: null, updatedAt: STAMP },
    });
    expect(outcome.skipped.map((s) => s.id).sort()).toEqual([noYear.id, nobody.id].sort());
    expect(outcome.applied.sort()).toEqual([add.id, update.id].sort());
  });
});

describe('nothing is deleted', () => {
  it('no statement in the consumer module removes a row', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      // A Prisma model's delete / deleteMany (tx.user.delete, this.prisma.x.deleteMany, ...),
      // or raw SQL. Map and Set deletes (the in-memory token cache) are not rows.
      const prismaDelete = /\b(tx|db|prisma|this\.prisma)\.\w+\.delete(Many)?\s*\(/;
      if (prismaDelete.test(text) || /\bDELETE\s+FROM\b/i.test(text) || /\bTRUNCATE\b/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('would catch one (the grep is not vacuous)', () => {
    const prismaDelete = /\b(tx|db|prisma|this\.prisma)\.\w+\.delete(Many)?\s*\(/;
    expect(prismaDelete.test('await tx.guardianStudent.deleteMany({ where })')).toBe(true);
    expect(prismaDelete.test('this.prisma.user.delete({ where })')).toBe(true);
    expect(/\bDELETE\s+FROM\b/i.test('Prisma.sql`DELETE FROM "Users"`')).toBe(true);
  });
});
