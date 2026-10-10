import { getSupabase } from './supabase';
import { fetchNotifications, markAllRead } from './notifications';

jest.mock('./supabase', () => ({ getSupabase: jest.fn() }));

/**
 * The inbox is the reader's own. RLS alone does not make it so: a
 * SCHOOL_ADMIN's notifications_admin_select reads every row of the school,
 * so the admin's Notiser tab listed guardians' absence notices and other
 * staff's cover bookings as if addressed to the admin, and "mark all read"
 * (own rows only under RLS) could never clear the count. Both queries name
 * the recipient.
 */
function stub(rows: unknown[] | null, error: string | null = null) {
  const calls: Array<[string, unknown[]]> = [];
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'order', 'limit', 'update', 'is']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder['then'] = (resolve: (value: unknown) => unknown) => resolve({ data: rows, error: error ? { message: error } : null });
  (getSupabase as jest.Mock).mockReturnValue({
    from: (table: string) => {
      calls.push(['from', [table]]);
      return builder;
    },
  });
  return calls;
}

describe('the inbox', () => {
  it('reads only the signed-in person’s own rows, newest first, 50 at most', async () => {
    const calls = stub([{ id: 'n-1', type: 'LESSON_CANCELLED', meta: null, readAt: null, createdAt: '2026-10-10T08:00:00Z' }]);
    const rows = await fetchNotifications('u-admin');
    expect(rows).toHaveLength(1);
    expect(calls).toEqual([
      ['from', ['Notifications']],
      ['select', ['id, type, meta, readAt, createdAt']],
      ['eq', ['userId', 'u-admin']],
      ['order', ['createdAt', { ascending: false }]],
      ['limit', [50]],
    ]);
  });

  it('marks only the person’s own unread rows read', async () => {
    const calls = stub(null);
    await markAllRead('u-admin');
    expect(calls.filter(([method]) => method === 'eq')).toEqual([['eq', ['userId', 'u-admin']]]);
    expect(calls).toContainEqual(['is', ['readAt', null]]);
  });

  it('throws what the database said', async () => {
    stub(null, 'permission denied');
    await expect(fetchNotifications('u-1')).rejects.toThrow('permission denied');
    await expect(markAllRead('u-1')).rejects.toThrow('permission denied');
  });
});
