import { getSupabase } from './supabase';
import { fetchChildren } from './children';

jest.mock('./supabase', () => ({ getSupabase: jest.fn() }));

describe('fetchChildren', () => {
  function stub(rows: unknown[] | null, error: string | null = null) {
    const calls: Array<[string, unknown[]]> = [];
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) {
      builder[method] = (...args: unknown[]) => {
        calls.push([method, args]);
        return builder;
      };
    }
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      resolve({ data: rows, error: error ? { message: error } : null });
    (getSupabase as jest.Mock).mockReturnValue({
      from: (table: string) => {
        calls.push(['from', [table]]);
        return builder;
      },
    });
    return calls;
  }

  it('asks GuardianStudents for this guardian’s own links, and orders the children Swedishly', async () => {
    const calls = stub([
      { id: 'link-2', student: { id: 'c-2', firstName: 'Örjan', lastName: 'Elev' } },
      { id: 'link-1', student: { id: 'c-1', firstName: 'Åsa', lastName: 'Elev' } },
      { id: 'link-3', student: { id: 'c-3', firstName: 'Bo', lastName: 'Elev' } },
      { id: 'link-4', student: null },
    ]);
    const children = await fetchChildren('g-1');
    expect(calls[0]).toEqual(['from', ['GuardianStudents']]);
    expect(calls).toContainEqual(['eq', ['guardianId', 'g-1']]);
    expect(children.map((child) => child.firstName)).toEqual(['Bo', 'Åsa', 'Örjan']);
    expect(children[0]).toEqual({ linkId: 'link-3', id: 'c-3', firstName: 'Bo', lastName: 'Elev' });
  });

  it('throws what the database said', async () => {
    stub(null, 'permission denied');
    await expect(fetchChildren('g-1')).rejects.toThrow('permission denied');
  });
});
