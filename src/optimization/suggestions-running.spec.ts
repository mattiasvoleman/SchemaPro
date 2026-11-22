import type { PrismaClient } from '@prisma/client';
import { STALE_AFTER_MS } from './suggestions';
import { ANALYSIS_ALIVE_SECONDS, SUGGESTIONS_RUNNING, suggestionsRunning, yearHasRunningSuggestions } from './suggestions-running';
import { SUGGEST_WAIT_MS } from './suggestions.service';

const YEAR = '44444444-4444-4444-8444-444444444444';

const txAnswering = (rows: unknown) => ({ $queryRaw: jest.fn(async () => rows) }) as unknown as PrismaClient & { $queryRaw: jest.Mock };

describe('the analysis as a solve stream of the year', () => {
  it('is alive for longer than it can wait for the engine and for shorter than a read waits before it gives it up', () => {
    // A live analysis is never read as dead by a start; an analysis nobody runs does not hold Generera off for the whole of a read's six minutes.
    expect(ANALYSIS_ALIVE_SECONDS * 1000).toBeGreaterThan(SUGGEST_WAIT_MS);
    expect(ANALYSIS_ALIVE_SECONDS * 1000).toBeLessThan(STALE_AFTER_MS);
  });

  it('asks the column for a RUNNING analysis of the year that began inside the alive window, by text, so that no value can fail a cast', async () => {
    const tx = txAnswering([{ active: 1 }]);
    await expect(yearHasRunningSuggestions(tx, YEAR)).resolves.toBe(true);
    const sql = (tx.$queryRaw.mock.calls[0] as unknown as [{ strings: string[]; values: unknown[] }])[0];
    const text = sql.strings.join('?');
    expect(sql.values).toEqual([YEAR, ANALYSIS_ALIVE_SECONDS]);
    expect(text).toContain(`"suggestions"->>'state' = 'RUNNING'`);
    expect(text).toContain(`("suggestions"->>'startedAt') COLLATE "C"`);
    expect(text).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
    expect(text).not.toContain('::timestamptz');
  });

  it.each([[[{ active: 0 }]], [[]], [undefined]])('is false for an answer of %j', async (rows) => {
    await expect(yearHasRunningSuggestions(txAnswering(rows), YEAR)).resolves.toBe(false);
  });

  it('is a 409 with its code flat', () => {
    expect(suggestionsRunning().getStatus()).toBe(409);
    expect(suggestionsRunning().getResponse()).toMatchObject({ code: SUGGESTIONS_RUNNING });
  });
});
