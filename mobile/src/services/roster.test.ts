import { getSupabase } from './supabase';
import { fetchRoster } from './roster';

jest.mock('./supabase', () => ({ getSupabase: jest.fn() }));

/**
 * A chainable stub shaped like the PostgREST builder: every call returns itself
 * until the query is awaited, at which point it resolves to whatever the table
 * was seeded with. Recording the calls is the point — this is a test about
 * which questions get asked.
 */
function supabaseStub(tables: Record<string, unknown[]>) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

  const from = jest.fn((table: string) => {
    const builder: Record<string, unknown> = {};
    const record = (method: string) =>
      jest.fn((...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      });
    for (const method of ['select', 'eq', 'in', 'or', 'order']) {
      builder[method] = record(method);
    }
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      resolve({ data: tables[table] ?? [], error: null });
    return builder;
  });

  (getSupabase as jest.Mock).mockReturnValue({ from });
  return { calls, argsFor: (table: string, method: string) =>
    calls.filter((c) => c.table === table && c.method === method).map((c) => c.args) };
}

const LESSON = 'lesson-1';
const CLASS_7A = 'group-7a';
const MA71 = 'group-ma71';

describe('the roster of a lesson', () => {
  it('asks StudentGroupMembers, which is where a teaching group keeps its pupils', async () => {
    // A home class holds its pupils through Users.studentGroupId; a teaching
    // group holds none at all by construction. Asking only the first question
    // returned nothing for every nivågrupp, so a teacher opening such a lesson
    // to take attendance met an empty list and could not report.
    const stub = supabaseStub({ StudentGroupMembers: [{ studentId: 'sara' }] });

    await fetchRoster(LESSON, MA71);

    expect(stub.argsFor('StudentGroupMembers', 'in')).toEqual([
      ['studentGroupId', [MA71]],
    ]);
  });

  it('covers every class attending, not only the lesson’s own', async () => {
    const stub = supabaseStub({
      CalendarLessonGroups: [{ studentGroupId: 'group-7b' }],
    });

    await fetchRoster(LESSON, CLASS_7A);

    expect(stub.argsFor('StudentGroupMembers', 'in')).toEqual([
      ['studentGroupId', [CLASS_7A, 'group-7b']],
    ]);
  });

  it('picks up a pupil named individually on the lesson', async () => {
    const stub = supabaseStub({
      CalendarLessonStudents: [{ studentId: 'elev-5' }],
    });

    await fetchRoster(LESSON, CLASS_7A);

    const [filter] = stub.argsFor('Users', 'or')[0] as [string];
    expect(filter).toContain('id.in.(elev-5)');
    expect(filter).toContain(`studentGroupId.in.(${CLASS_7A})`);
  });

  it('counts a pupil once when two sources name them', async () => {
    const stub = supabaseStub({
      CalendarLessonStudents: [{ studentId: 'sara' }],
      StudentGroupMembers: [{ studentId: 'sara' }],
    });

    await fetchRoster(LESSON, MA71);

    const [filter] = stub.argsFor('Users', 'or')[0] as [string];
    expect(filter).toContain('id.in.(sara)');
  });

  it('omits the id filter when no individual pupil is involved', async () => {
    // An `id.in.()` with nothing in it is not an empty set to PostgREST — it is
    // a syntax error, and it would take the whole roster down with it.
    const stub = supabaseStub({});

    await fetchRoster(LESSON, CLASS_7A);

    const [filter] = stub.argsFor('Users', 'or')[0] as [string];
    expect(filter).toBe(`studentGroupId.in.(${CLASS_7A})`);
  });

  it('asks only for active pupils', async () => {
    const stub = supabaseStub({});

    await fetchRoster(LESSON, CLASS_7A);

    expect(stub.argsFor('Users', 'eq')).toEqual([
      ['role', 'STUDENT'],
      ['isActive', true],
    ]);
  });
});
