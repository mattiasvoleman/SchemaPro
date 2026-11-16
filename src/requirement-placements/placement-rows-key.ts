import { createHash } from 'node:crypto';
import { placementsKeyOf } from '../optimization/placed-lessons';

/** One stored row as the key reads it: the columns Generera's own staleness key reads, with the row's id. */
type KeyedRow = Parameters<typeof placementsKeyOf>[0][number];

/** Hex characters kept of the hash: 64 bits, a token to compare and never a secret. */
export const ROWS_KEY_LENGTH = 16;

/** What a request's `baseKey` may look like (the DTO says the same). */
export const ROWS_KEY_PATTERN = /^[0-9a-f]{16}$/;

/**
 * THE KEY OF A POST'S FÖRLÄGGNINGAR: what a client read, said in a few
 * characters, so that its write can say "on top of this" (`baseKey` on the PUT)
 * and the server can tell whether somebody wrote the list in between.
 *
 * It is a hash of placementsKeyOf, the string Generera compares to know whether
 * the rows moved while the solver ran: the same columns, and the row's id. The
 * ids are what make it a key of a SAVE and not only of the list's content: every
 * save replaces the whole list with new ids (DELETE and INSERT), so two writers
 * who both read the list and both write the same rows still leave the second
 * one's key different from what it read, and the second is refused.
 *
 * A post with no rows has a key of its own, the same for every post: two
 * people who both read the empty list and both write the first rows get one
 * answer each, and the second is told the list is no longer empty.
 */
export function rowsKeyOf(rows: readonly KeyedRow[]): string {
  return createHash('sha256').update(placementsKeyOf(rows)).digest('hex').slice(0, ROWS_KEY_LENGTH);
}
