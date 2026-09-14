import type { PrismaMock } from './prisma-mock';

/*
 * For a spec whose service reads a row under a lock and then writes it.
 *
 * The frame-time, lunch-serving and rast specs carry their own copies of these
 * (#56), each bound to FOR UPDATE and to its own row fixture. The copies here
 * take the table and the lock as arguments, so a read that takes a different
 * lock is pinned to that lock and not to FOR UPDATE.
 */

/** Reconstructs the SQL text of a tagged-template $queryRaw call. */
export const rawSql = (call: unknown[]): string =>
  (call[0] as readonly string[]).join('?');

/** A table as a locking read of one of its rows has to name it. */
export interface LockedTable {
  /** The table's name in the database, unquoted: `Users`, not `user`. */
  name: string;
  /** Every column the table has. A SELECT naming any other column throws. */
  columns: readonly string[];
  /** The lock clause the statement has to end in. */
  lock: 'FOR UPDATE' | 'FOR NO KEY UPDATE';
}

/**
 * What the table answers a locking read with: the rows whose id is the one
 * value bound into the statement, each carrying the columns the SELECT names
 * and no others. A statement that is not `SELECT ... FROM "<table>" WHERE "id" =
 * $1::uuid <lock>`, that takes another lock or none, or that names a column the
 * table lacks, throws instead of being answered, so a read that drops or changes
 * its lock, its key or a column fails the test rather than passing on a row it
 * never asked for.
 */
export function lockingRead(
  table: LockedTable,
  rows: readonly Record<string, unknown>[],
  call: unknown[],
): Record<string, unknown>[] {
  const sql = rawSql(call).replace(/\s+/g, ' ').trim();
  const read = /^SELECT (.+) FROM "(\w+)" WHERE "id" = \?::uuid (FOR (?:NO KEY )?UPDATE)$/.exec(sql);
  const values = call.slice(1);
  if (
    read === null ||
    read[2] !== table.name ||
    read[3] !== table.lock ||
    values.length !== 1
  ) {
    throw new Error(`Not a ${table.lock} read of one "${table.name}" row: ${sql}`);
  }
  const columns = read[1].split(',').map((column) => {
    const name = /^"(\w+)"$/.exec(column.trim())?.[1];
    if (name === undefined || !table.columns.includes(name)) {
      throw new Error(`"${table.name}" has no column ${column.trim()}`);
    }
    return name;
  });
  return rows
    .filter((row) => row.id === values[0])
    .map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
}

/**
 * Names the transaction each call of a mock ran in. createPrismaMock hands every
 * helper's callback the one shared `tx`, so a read in withRls and a read in
 * withVerifiedSubject's batch reach the same `$queryRaw` and look alike to a
 * spec. Here each call to a helper is a transaction of its own, `<helper>#<n>`,
 * open from the moment the helper is called until its promise settles. The
 * function returned wraps a mock so that each of its calls notes the innermost
 * transaction open at that moment, undefined outside them all, and answers as
 * the mock already did.
 */
export function transactionsOf(
  prisma: PrismaMock,
): (mock: jest.Mock) => (string | undefined)[] {
  const open: string[] = [];
  let opened = 0;
  for (const [helper, method] of Object.entries(prisma) as [string, jest.Mock][]) {
    const run = method.getMockImplementation();
    if (run === undefined) continue;
    method.mockImplementation(async (...args: unknown[]) => {
      opened += 1;
      const transaction = `${helper}#${opened}`;
      open.push(transaction);
      try {
        return await run(...args);
      } finally {
        open.splice(open.lastIndexOf(transaction), 1);
      }
    });
  }
  return (mock) => {
    const ranIn: (string | undefined)[] = [];
    const answer = mock.getMockImplementation();
    mock.mockImplementation((...args: unknown[]) => {
      ranIn.push(open[open.length - 1]);
      return answer?.(...args);
    });
    return ranIn;
  };
}
