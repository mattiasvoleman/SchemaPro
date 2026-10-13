import type { TxMock } from './prisma-mock';

/** One app.personal_data_read statement a service sent: what recordRead put in it. */
export interface RecordedRead {
  kind: string;
  channel: string | null;
  ids: string[];
}

/**
 * The läslogg statements sent on `tx` (src/access-log/access-log.ts), in
 * order, read off the raw-statement mock: recordRead hands $executeRaw one
 * Prisma.Sql whose values are the kind, the channel and the ids.
 */
export function recordedReads(tx: TxMock): RecordedRead[] {
  const executeRaw = (tx as unknown as { $executeRaw: jest.Mock }).$executeRaw;
  return executeRaw.mock.calls
    .map(([statement]) => statement as { strings?: readonly string[]; values?: unknown[] })
    .filter((statement) => (statement.strings ?? []).join('?').includes('app.personal_data_read('))
    .map((statement) => {
      const [kind, channel, ids] = statement.values ?? [];
      return { kind: kind as string, channel: (channel ?? null) as string | null, ids: ids as string[] };
    });
}
