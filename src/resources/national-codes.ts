import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/**
 * The national ämneskod a school subject is mapped to, as the client wrote it,
 * made into what the reference table holds — or into "no mapping".
 *
 * Trimmed and UPPER-CASED, which is lossless: NationalSubjects.code is checked
 * `^[A-Z][A-Z0-9_]*$` by the migration, so no two codes differ only in case and
 * "ma" can only ever have meant MA. The database refuses 'ma' (the FK is
 * case-exact), and the point of normalising here is that a CSV a school typed
 * by hand lands instead of failing a row on the one letter nobody meant.
 *
 * An empty or blank cell is null, like `code` and `color` on the same row: the
 * subjects form's "Utanför timplanen" option and an empty CSV column are the
 * same statement, and `''` is not a code the table could hold.
 */
export function normalizeNationalCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed.toUpperCase();
}

/**
 * The one sentence every writer uses for a code the reference table does not
 * know, so the form and the import report say the same thing.
 *
 * Names the field, because the database's own refusal would not: a foreign
 * key violation reaches the client as a 409 that says a record does not exist,
 * without saying which, and an admin reading that beside a subject form has
 * five fields to guess between.
 */
export function unknownNationalCodeMessage(code: string): string {
  return (
    `nationalCode: "${code}" är ingen känd nationell ämneskod. ` +
    'Välj en kod ur timplanens lista, eller lämna fältet tomt för ett ämne utanför timplanen.'
  );
}

/**
 * Refuses a code the reference table does not hold, with the field named.
 *
 * Asked inside the writing transaction, under the caller's RLS context. The
 * reference tables grant SELECT to every active signed-in user, so the read
 * cannot be what hides a code; a null here means the code is not in the
 * statute. The FK on Subjects.nationalCode is the second line, for the writers
 * that never pass through here — this is what turns its 409 into a 400 that
 * says which field and which value.
 */
export async function assertNationalCodeIsKnown(
  tx: PrismaClient,
  code: string,
): Promise<void> {
  const known = await tx.nationalSubject.findUnique({
    where: { code },
    select: { code: true },
  });
  if (!known) {
    throw new BadRequestException(unknownNationalCodeMessage(code));
  }
}
