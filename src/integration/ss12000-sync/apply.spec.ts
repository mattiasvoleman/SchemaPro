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
    tx.user.findMany.mockResolvedValue([{ id: loc(10), ss12000Id: ext(10) }]);
    const add = change({ entity: 'RESPONSIBLE', op: 'ADD', externalId: ext(1), localId: loc(1), after: { guardianExternalId: ext(10), guardianLocalId: null } });
    await run([add]);
    expect(tx.guardianStudent.createMany).toHaveBeenCalledWith({
      data: [{ schoolId: SCHOOL, guardianId: loc(10), studentId: loc(1), origin: 'SS12000' }],
      skipDuplicates: true,
    });
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
