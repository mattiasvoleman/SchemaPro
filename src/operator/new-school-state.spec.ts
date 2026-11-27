import { readSchoolState } from '../../scripts/operator/new-school';
import { parseNewSchoolArgs } from './new-school-args';

const parsed = parseNewSchoolArgs([
  '--name', 'Ekeby skola',
  '--slug', 'ekeby-skola',
  '--admin-email', 'rektor@ekeby.example',
  '--admin-first-name', 'Anna',
  '--admin-last-name', 'Andersson',
]);
if (!parsed.ok) throw new Error(parsed.problems.join('; '));
const ARGS = parsed.args;

const dbWith = (users: Array<Record<string, unknown>>) =>
  ({ school: { findUnique: jest.fn().mockResolvedValue({ id: 'school-1', name: 'Ekeby skola', users }) } }) as never;

describe('readSchoolState', () => {
  it('finds the administrator it made, by the address in any case, and says whether the login is on the row', async () => {
    const waiting = await readSchoolState(dbWith([{ id: 'u1', email: 'Rektor@Ekeby.example', role: 'SCHOOL_ADMIN', invitedAt: null }]), ARGS);
    expect(waiting).toEqual({ kind: 'ADMIN_WAITING', schoolId: 'school-1', adminId: 'u1' });
    const at = new Date('2026-11-26T08:00:00Z');
    const done = await readSchoolState(dbWith([{ id: 'u1', email: 'rektor@ekeby.example', role: 'SCHOOL_ADMIN', invitedAt: at }]), ARGS);
    expect(done).toEqual({ kind: 'DONE', schoolId: 'school-1', adminId: 'u1', invitedAt: at });
  });

  // From the migration that lets a pupil or a guardian have no address, a row's address is `string | null`. The script was written
  // against `string`: on the merged tree it did not compile (typecheck:scripts), and a row with none would have been a TypeError.
  it('a school whose only person has no address is not the one this command made, and is no TypeError', async () => {
    const state = await readSchoolState(dbWith([{ id: 'u2', email: null, role: 'SCHOOL_ADMIN', invitedAt: null }]), ARGS);
    expect(state.kind).toBe('OCCUPIED');
  });

  it('a school with another person in it, or none of the administrators named, is occupied', async () => {
    expect((await readSchoolState(dbWith([{ id: 'u3', email: 'rektor@ekeby.example', role: 'TEACHER', invitedAt: null }]), ARGS)).kind).toBe('OCCUPIED');
    expect((await readSchoolState(dbWith([{ id: 'u4', email: 'annan@ekeby.example', role: 'SCHOOL_ADMIN', invitedAt: null }]), ARGS)).kind).toBe('OCCUPIED');
  });
});
