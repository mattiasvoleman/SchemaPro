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
  protectedIdentity: false,
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
    expect(outcome.applied.sort()).toEqual([email.id, back.id].sort());
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: loc(1), schoolId: SCHOOL, role: { not: 'SCHOOL_ADMIN' } },
      data: { email: 'ny@skola.se', updatedAt: STAMP },
    });
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: loc(2), schoolId: SCHOOL, isActive: false, role: { not: 'SCHOOL_ADMIN' } },
      data: { isActive: true, updatedAt: STAMP },
    });
  });

  it('writes the e-mail addresses after everything else, one at a time in the source order', async () => {
    // An address change locks the person's row until the apply commits, and a
    // register save naming the person waits for it: last, it is held for the
    // apply's last moments only.
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    const first = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(1), localId: loc(1), after: { email: 'ny1@skola.se' } });
    const second = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(2), localId: loc(2), after: { email: 'ny2@skola.se' } });
    const back = change({ entity: 'PERSON', op: 'REACTIVATE', externalId: ext(3), localId: loc(3) });
    const gone = change({ entity: 'PERSON', op: 'DEACTIVATE', externalId: ext(4), localId: loc(4) });
    await run([first, second, back, gone]);

    const emailCalls = tx.user.updateMany.mock.calls
      .map(([arg], i) => ({ order: tx.user.updateMany.mock.invocationCallOrder[i]!, email: (arg as { data: { email?: string } }).data.email }))
      .filter((call) => call.email !== undefined);
    expect(emailCalls.map((call) => call.email)).toEqual(['ny1@skola.se', 'ny2@skola.se']);
    const others = [
      ...tx.user.updateMany.mock.invocationCallOrder.filter((_, i) => (tx.user.updateMany.mock.calls[i]![0] as { data: { email?: string } }).data.email === undefined),
      ...tx.$executeRaw.mock.invocationCallOrder,
    ];
    expect(others.length).toBeGreaterThan(0);
    expect(Math.min(...emailCalls.map((call) => call.order))).toBeGreaterThan(Math.max(...others));
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

  it('skips a member the source puts in a half of a class they are not in, or in its other half, and adds the rest', async () => {
    const H1 = loc(51);
    const H2 = loc(52);
    const CLASS = loc(50);
    tx.user.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      'ss12000Id' in where
        ? [1, 2, 3, 4].map((n) => ({ id: loc(n), ss12000Id: ext(n) }))
        : [
            { id: loc(1), studentGroupId: CLASS },
            { id: loc(2), studentGroupId: loc(60) },
            { id: loc(3), studentGroupId: CLASS },
            { id: loc(4), studentGroupId: CLASS },
          ],
    );
    tx.studentGroup.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      'ss12000Id' in where
        ? [
            { id: H1, ss12000Id: ext(91) },
            { id: H2, ss12000Id: ext(92) },
          ]
        : [
            { id: H1, halfOfId: CLASS, halfOf: { predecessorId: null } },
            { id: H2, halfOfId: CLASS, halfOf: { predecessorId: null } },
          ],
    );
    // Pupil 3 is in 7A:2 already.
    tx.studentGroupMember.findMany.mockResolvedValue([{ studentId: loc(3), studentGroupId: H2, halfOfId: CLASS }]);
    const add = (n: number, group: number) =>
      change({ entity: 'GROUP_MEMBERSHIP', op: 'ADD', externalId: ext(n), localId: loc(n), after: { groupExternalId: ext(group) } });
    const inClass = add(1, 91);
    const otherClass = add(2, 91);
    const otherHalf = add(3, 91);
    const both = [add(4, 91), add(4, 92)];

    const outcome = await run([inClass, otherClass, otherHalf, ...both]);

    expect(outcome.skipped.map((s) => [s.id, s.code])).toEqual([
      [otherClass.id, 'SS12000_HALF_MEMBER_NOT_IN_CLASS'],
      [otherHalf.id, 'SS12000_HALF_MEMBER_NOT_IN_CLASS'],
      [both[1]!.id, 'SS12000_HALF_MEMBER_NOT_IN_CLASS'],
    ]);
    expect(tx.studentGroupMember.createMany).toHaveBeenCalledWith({
      data: [
        { schoolId: SCHOOL, studentGroupId: H1, studentId: loc(1) },
        { schoolId: SCHOOL, studentGroupId: H1, studentId: loc(4) },
      ],
      skipDuplicates: true,
    });
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

describe('applyChanges: skolenheter', () => {
  let tx: TxMock;
  const UNIT = '20000000-0000-4000-8000-0000000000a1';
  const OTHER = '20000000-0000-4000-8000-0000000000a2';
  beforeEach(() => {
    seq = 0;
    tx = createTxMock();
    tx.schoolUnit.updateMany.mockResolvedValue({ count: 1 });
    tx.schoolUnit.create.mockResolvedValue({});
  });
  const run = (changes: StoredChange[]) => applyChanges(tx as unknown as PrismaClient, SCHOOL, changes, STAMP);
  const local = (patch: Record<string, unknown>) => ({ id: UNIT, code: null, gradeFrom: null, gradeTo: null, ss12000Id: null, ...patch });

  it('creates a unit under the source id with what the change carries, before any group', async () => {
    const unit = change({ entity: 'ORGANISATION', op: 'CREATE', externalId: ext(1), after: { name: 'Ekskolan', code: '12345678', schoolTypes: ['GR', 'FKLASS', 'GY'], gradeFrom: 0, gradeTo: 6 } });
    const group = change({ entity: 'GROUP', op: 'CREATE', externalId: ext(70), after: { name: '7A', kind: 'CLASS', academicYearId: YEAR, gradeLevel: 7 } });
    const outcome = await run([group, unit]);
    expect(outcome.applied.sort()).toEqual([unit.id, group.id].sort());
    expect(tx.schoolUnit.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        schoolId: SCHOOL, name: 'Ekskolan', code: '12345678', schoolTypes: ['FKLASS', 'GR'], gradeFrom: 0, gradeTo: 6, ss12000Id: ext(1), updatedAt: STAMP,
      }),
    });
    expect(tx.schoolUnit.create.mock.invocationCallOrder[0]).toBeLessThan(tx.studentGroup.createMany.mock.invocationCallOrder[0]!);
  });

  it('links only a unit still unlinked, then writes the source fields through the id it linked', async () => {
    tx.schoolUnit.findMany.mockResolvedValue([local({})]);
    const link = change({ entity: 'ORGANISATION', op: 'LINK', externalId: ext(1), localId: UNIT, after: { ss12000Id: ext(1) } });
    const name = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(1), localId: null, after: { name: 'Ekskolan' } });
    const types = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(1), localId: null, after: { schoolTypes: ['GR'] } });
    expect((await run([types, name, link])).applied.sort()).toEqual([link.id, name.id, types.id].sort());
    expect(tx.schoolUnit.updateMany.mock.calls.map(([args]) => args)).toEqual([
      { where: { id: UNIT, schoolId: SCHOOL, ss12000Id: null }, data: { ss12000Id: ext(1), updatedAt: STAMP } },
      { where: { id: UNIT, schoolId: SCHOOL }, data: { name: 'Ekskolan', updatedAt: STAMP } },
      { where: { id: UNIT, schoolId: SCHOOL }, data: { schoolTypes: ['GR'], updatedAt: STAMP } },
    ]);
    tx.schoolUnit.updateMany.mockResolvedValue({ count: 0 });
    const again = change({ entity: 'ORGANISATION', op: 'LINK', externalId: ext(1), localId: UNIT, after: { ss12000Id: ext(1) } });
    expect((await run([again])).skipped.map((s) => s.code)).toEqual(['SS12000_TARGET_CHANGED']);
  });

  it('updates a unit through the source id only, including one this apply links', async () => {
    tx.schoolUnit.findMany.mockResolvedValue([local({})]);
    const link = change({ entity: 'ORGANISATION', op: 'LINK', externalId: ext(1), localId: UNIT, after: { ss12000Id: ext(1) } });
    const span = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(1), localId: null, after: { gradeFrom: 7, gradeTo: 9 } });
    const stray = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(2), localId: null, after: { gradeFrom: 0, gradeTo: 6 } });
    const outcome = await run([span, stray, link]);
    expect(outcome.applied.sort()).toEqual([link.id, span.id].sort());
    expect(outcome.skipped.map((s) => [s.id, s.code])).toEqual([[stray.id, 'SS12000_DEPENDENCY_NOT_APPLIED']]);
    expect(tx.schoolUnit.updateMany).toHaveBeenLastCalledWith({ where: { id: UNIT, schoolId: SCHOOL }, data: { gradeFrom: 7, gradeTo: 9, updatedAt: STAMP } });
  });

  it('skips a write another unit\'s code or årskurser block, instead of failing the whole apply', async () => {
    tx.schoolUnit.findMany.mockResolvedValue([local({ id: OTHER, code: '87654321', gradeFrom: 0, gradeTo: 6, ss12000Id: ext(9) }), local({ ss12000Id: ext(1) })]);
    const code = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(1), localId: UNIT, after: { code: '87654321' } });
    const span = change({ entity: 'ORGANISATION', op: 'UPDATE', externalId: ext(1), localId: UNIT, after: { gradeFrom: 5, gradeTo: 9 } });
    const create = change({ entity: 'ORGANISATION', op: 'CREATE', externalId: ext(3), after: { name: 'Ny', code: null, schoolTypes: [], gradeFrom: 6, gradeTo: 6 } });
    const outcome = await run([code, span, create]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped.map((s) => s.code)).toEqual(['SCHOOL_UNIT_SPAN_OVERLAP', 'SCHOOL_UNIT_CODE_TAKEN', 'SCHOOL_UNIT_SPAN_OVERLAP']);
    expect(tx.schoolUnit.updateMany).not.toHaveBeenCalled();
    expect(tx.schoolUnit.create).not.toHaveBeenCalled();
  });
});

describe('applyChanges: the mark of a protected identity (20270107090000)', () => {
  let tx: TxMock;
  beforeEach(() => {
    seq = 0;
    tx = createTxMock();
    tx.user.updateMany.mockResolvedValue({ count: 1 });
  });
  const run = (changes: StoredChange[]) => applyChanges(tx as unknown as PrismaClient, SCHOOL, changes, STAMP);
  const marked = () => tx.personProtection.createMany.mock.calls.flatMap(([args]) => args.data as Array<Record<string, unknown>>);

  it('marks a protected person the apply creates, links or relinks, with that change and by the row it made', async () => {
    const create = change({ entity: 'PERSON', op: 'CREATE', externalId: ext(1), protectedIdentity: true, after: { role: 'STUDENT', firstName: 'S', lastName: 'P', email: 's@skola.se' } });
    const link = change({ entity: 'PERSON', op: 'LINK', externalId: ext(2), localId: loc(2), protectedIdentity: true });
    const relink = change({ entity: 'PERSON', op: 'RELINK', externalId: ext(3), localId: loc(3), protectedIdentity: true });
    const plain = change({ entity: 'PERSON', op: 'CREATE', externalId: ext(4), after: { role: 'STUDENT', firstName: 'O', lastName: 'P', email: 'o@skola.se' } });
    const outcome = await run([create, link, relink, plain]);
    expect(outcome.applied).toHaveLength(4);
    const created = (tx.user.createMany.mock.calls[0]![0].data as Array<{ id: string; ss12000Id: string }>).find((row) => row.ss12000Id === ext(1))!;
    expect(marked().map((row) => row['userId']).sort()).toEqual([created.id, loc(2), loc(3)].sort());
    expect(marked().every((row) => row['schoolId'] === SCHOOL && row['source'] === 'SS12000')).toBe(true);
    expect(tx.personProtection.createMany.mock.calls[0]![0].skipDuplicates).toBe(true);
    // After the person exists: the key needs the row.
    expect(tx.user.createMany.mock.invocationCallOrder[0]).toBeLessThan(tx.personProtection.createMany.mock.invocationCallOrder[0]!);
  });

  it('marks nobody whose create or link was not made', async () => {
    tx.user.updateMany.mockResolvedValue({ count: 0 });
    const link = change({ entity: 'PERSON', op: 'LINK', externalId: ext(2), localId: loc(2), protectedIdentity: true });
    const outcome = await run([link]);
    expect(outcome.skipped.map((s) => s.code)).toEqual(['SS12000_TARGET_CHANGED']);
    expect(tx.personProtection.createMany).not.toHaveBeenCalled();
  });

  it('PROTECTION ADD marks a person linked before, resolved by the source id and never by the local id it carries', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    const add = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(1), userLocalId: loc(99) } });
    const stray = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(2), userLocalId: loc(2) } });
    const outcome = await run([add, stray]);
    expect(outcome.applied).toEqual([add.id]);
    expect(outcome.skipped).toEqual([{ id: stray.id, code: 'SS12000_DEPENDENCY_NOT_APPLIED', entity: 'PROTECTION', externalId: null }]);
    expect(marked()).toEqual([{ userId: loc(1), schoolId: SCHOOL, source: 'SS12000', kind: null }]);
  });

  it('writes the register\'s kind with each mark the sync makes, from the person change or the ADD (20270111090000)', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    const create = change({
      entity: 'PERSON', op: 'CREATE', externalId: ext(5), protectedIdentity: true,
      after: { role: 'STUDENT', firstName: 'S', lastName: 'P', email: 's5@skola.se', protectionKind: 'SKYDDAD_FOLKBOKFORING' },
    });
    const link = change({ entity: 'PERSON', op: 'LINK', externalId: ext(2), localId: loc(2), protectedIdentity: true, after: { ss12000Id: ext(2), protectionKind: 'SEKRETESSMARKERING' } });
    const add = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(1), userLocalId: loc(1), kind: 'SKYDDAD_FOLKBOKFORING' } });
    // A kind the diff never writes is no kind.
    const odd = change({ entity: 'PERSON', op: 'RELINK', externalId: ext(3), localId: loc(3), protectedIdentity: true, after: { protectionKind: 'Ingen' } });
    await run([create, link, add, odd]);
    const created = (tx.user.createMany.mock.calls[0]![0].data as Array<{ id: string; ss12000Id: string }>).find((row) => row.ss12000Id === ext(5))!;
    expect(Object.fromEntries(marked().map((row) => [row['userId'], row['kind']]))).toEqual({
      [created.id]: 'SKYDDAD_FOLKBOKFORING', [loc(2)]: 'SEKRETESSMARKERING', [loc(1)]: 'SKYDDAD_FOLKBOKFORING', [loc(3)]: null,
    });
  });

  it('PROTECTION UPDATE gives the sync\'s mark the register\'s kind, and skips a mark removed since the diff', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }, { id: loc(2), ss12000Id: ext(2) }]);
    tx.personProtection.findMany.mockResolvedValue([{ userId: loc(1) }]);
    const kept = change({ entity: 'PROTECTION', op: 'UPDATE', after: { personExternalId: ext(1), userLocalId: loc(1), kind: 'SKYDDAD_FOLKBOKFORING' } });
    const gone = change({ entity: 'PROTECTION', op: 'UPDATE', after: { personExternalId: ext(2), userLocalId: loc(2), kind: 'SKYDDAD_FOLKBOKFORING' } });
    const stray = change({ entity: 'PROTECTION', op: 'UPDATE', after: { personExternalId: ext(9), userLocalId: loc(1), kind: null } });
    const outcome = await run([kept, gone, stray]);
    expect(tx.personProtection.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.personProtection.updateMany).toHaveBeenCalledWith({
      where: { schoolId: SCHOOL, userId: { in: [loc(1), loc(2)] }, source: 'SS12000' },
      data: { kind: 'SKYDDAD_FOLKBOKFORING' },
    });
    expect(outcome.applied).toEqual([kept.id]);
    expect(outcome.skipped.map((s) => [s.id, s.code])).toEqual([
      [stray.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
      [gone.id, 'SS12000_TARGET_CHANGED'],
    ]);
    expect(tx.personProtection.createMany).not.toHaveBeenCalled();
  });

  it('PROTECTION END lifts only a mark the sync wrote', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    const end = change({ entity: 'PROTECTION', op: 'END', after: { personExternalId: ext(1), userLocalId: loc(1) } });
    const outcome = await run([end]);
    expect(outcome.applied).toEqual([end.id]);
    expect(tx.personProtection.deleteMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL, userId: { in: [loc(1)] }, source: 'SS12000' } });
  });

  it('PROTECTION ADD by address marks the local row the diff matched, unlinked, if the row is still the school\'s with that address', async () => {
    tx.user.findMany.mockImplementation(async (args: { where: { ss12000Id?: unknown; id?: { in: string[] } } }) =>
      args.where.id
        ? args.where.id.in
            .filter((id) => id === loc(2) || id === loc(5))
            .map((id) => ({ id, email: id === loc(2) ? 'S2@skola.se ' : 'annan@skola.se' }))
        : [],
    );
    const ours = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(2), userLocalId: loc(2), byAddress: true, email: 's2@skola.se' } });
    const gone = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(3), userLocalId: loc(3), byAddress: true, email: 's3@skola.se' } });
    // The row's address changed since the diff: not the person it matched.
    const moved = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(5), userLocalId: loc(5), byAddress: true, email: 's5@skola.se' } });
    // Without byAddress a local id is never trusted.
    const plain = change({ entity: 'PROTECTION', op: 'ADD', after: { personExternalId: ext(4), userLocalId: loc(2) } });
    const outcome = await run([ours, gone, moved, plain]);
    expect(outcome.applied).toEqual([ours.id]);
    expect(outcome.skipped.map((s) => [s.id, s.code])).toEqual([
      [gone.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
      [moved.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
      [plain.id, 'SS12000_DEPENDENCY_NOT_APPLIED'],
    ]);
    expect(marked()).toEqual([{ userId: loc(2), schoolId: SCHOOL, source: 'SS12000', kind: null }]);
    expect(tx.user.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL, id: { in: [loc(2), loc(3), loc(5)] } }, select: { id: true, email: true } });
  });

  it('PROTECTION END by address lifts the sync\'s mark on the unlinked row it names, and only the sync\'s', async () => {
    tx.user.findMany.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
      args.where.id ? [{ id: loc(2), email: 'lisa@skola.se' }] : [],
    );
    const end = change({ entity: 'PROTECTION', op: 'END', after: { personExternalId: null, userLocalId: loc(2), byAddress: true } });
    const outcome = await run([end]);
    expect(outcome.applied).toEqual([end.id]);
    expect(tx.personProtection.deleteMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL, userId: { in: [loc(2)] }, source: 'SS12000' } });
  });

  it('PROTECTION END the database did not let through (only those who decide lift a mark) is skipped, not counted as made', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    tx.personProtection.findMany.mockResolvedValue([{ userId: loc(1) }]);
    const end = change({ entity: 'PROTECTION', op: 'END', after: { personExternalId: ext(1), userLocalId: loc(1) } });
    const outcome = await run([end]);
    expect(outcome.applied).toEqual([]);
    expect(outcome.skipped).toEqual([{ id: end.id, code: 'SS12000_PROTECTION_NOT_LIFTED', entity: 'PROTECTION', externalId: null }]);
  });

  it('writes no mark for a change about a protected person that is not a create, link or relink', async () => {
    tx.user.findMany.mockResolvedValue([{ id: loc(1), ss12000Id: ext(1) }]);
    const name = change({ entity: 'PERSON', op: 'UPDATE', externalId: ext(1), localId: loc(1), protectedIdentity: true, after: { firstName: 'A', lastName: 'B' } });
    await run([name]);
    expect(tx.personProtection.createMany).not.toHaveBeenCalled();
    expect(tx.personProtection.deleteMany).not.toHaveBeenCalled();
  });
});

describe('nothing is deleted', () => {
  // The one row the consumer removes: a mark of a protected identity the sync
  // itself wrote, when the register lifts the protection (PROTECTION END).
  const LIFT = "await tx.personProtection.deleteMany({ where: { schoolId, userId: { in: rows }, source: 'SS12000' } });";

  it('no statement in the consumer module removes a row, but the lift of a mark the sync wrote', () => {
    const dir = __dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))) {
      const text = readFileSync(join(dir, file), 'utf8').split(LIFT).join('');
      // A Prisma model's delete / deleteMany (tx.user.delete, this.prisma.x.deleteMany, ...),
      // or raw SQL. Map and Set deletes (the in-memory token cache) are not rows.
      const prismaDelete = /\b(tx|db|prisma|this\.prisma)\.\w+\.delete(Many)?\s*\(/;
      if (prismaDelete.test(text) || /\bDELETE\s+FROM\b/i.test(text) || /\bTRUNCATE\b/i.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    expect(readFileSync(join(dir, 'apply.ts'), 'utf8').split(LIFT)).toHaveLength(2);
  });

  it('would catch one (the grep is not vacuous)', () => {
    const prismaDelete = /\b(tx|db|prisma|this\.prisma)\.\w+\.delete(Many)?\s*\(/;
    expect(prismaDelete.test('await tx.guardianStudent.deleteMany({ where })')).toBe(true);
    expect(prismaDelete.test('this.prisma.user.delete({ where })')).toBe(true);
    expect(/\bDELETE\s+FROM\b/i.test('Prisma.sql`DELETE FROM "Users"`')).toBe(true);
  });
});
