import type { PrismaClient } from '@prisma/client';
import { listFiles, readLists } from './lists';

/**
 * lärare.csv takes an administrator who teaches (teachesLike), which reads `teaches` off the person: the select that
 * feeds it must name the column, or the row is read as an administrator who does not teach and leaves the file with no
 * error. Nothing else holds that select (the unit specs of csv-files.ts hand it the rows).
 */
describe('readLists feeds lärare.csv the mark', () => {
  it('asks Users for teaches, and writes a teaching administrator into lärare.csv', async () => {
    let asked: { select?: Record<string, unknown> } | undefined;
    const rows = [
      { id: 'u1', role: 'SCHOOL_ADMIN', teaches: true, firstName: 'Rut', lastName: 'Rektor', email: 'rut@example.invalid', phone: null, studentGroupId: null, isActive: true },
    ];
    const none = { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null) };
    const tx = new Proxy(
      {},
      {
        get: (_target, model: string) =>
          model === 'user'
            ? {
                findMany: jest.fn((args: { select?: Record<string, unknown> }) => {
                  asked = args;
                  return Promise.resolve(args.select && 'teaches' in args.select ? rows : rows.map(({ teaches: _teaches, ...rest }) => rest));
                }),
              }
            : none,
      },
    ) as unknown as PrismaClient;
    const lists = await readLists(tx, 's1');
    expect(asked?.select).toMatchObject({ teaches: true });
    const csv = listFiles(lists, new Set(), []).find((file) => file.path.endsWith('larare.csv'))?.content ?? '';
    expect(csv).toContain('rut@example.invalid');
  });
});
