import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  SUBJECT_QUALIFICATION_IS_INHERITED,
  SUBJECT_QUALIFICATION_IS_ITSELF,
  SUBJECT_QUALIFICATION_SOURCE_INHERITS,
  listNames,
} from '../common/utils/prisma-errors';

/** What a source subject that is not one of the school's answers with, for a client that tells it from another 400. */
export const SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND = 'SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND';

/**
 * Refuses a "behörighet som i ämnet" the database would refuse, with the
 * subjects named (migration 20270225090000). Absent or null is no pointer and
 * passes. `selfId` is the subject being written, null for a subject being
 * created, which nobody can have pointed at yet.
 *
 * Asked inside the writing transaction, under the caller's RLS context: the
 * source is read as the school's own subject, so another school's reads exactly
 * as one that does not exist. The composite key and the trigger are the second
 * line, for a writer that did not ask (and for two that ask at once).
 *
 *   - the subject itself: SUBJECT_QUALIFICATION_IS_ITSELF;
 *   - a source that itself inherits, which would make a chain:
 *     SUBJECT_QUALIFICATION_SOURCE_INHERITS, naming both;
 *   - a subject that others inherit from taking a pointer of its own, which
 *     would make it a link in a chain: SUBJECT_QUALIFICATION_IS_INHERITED,
 *     naming the subjects that use it.
 */
export async function assertQualificationSourceIsAllowed(
  tx: PrismaClient,
  sourceId: string | null | undefined,
  selfId: string | null,
): Promise<void> {
  if (sourceId == null) return;
  if (selfId !== null && sourceId === selfId) {
    throw new ConflictException({
      message: 'Ett ämne kan inte ta sin behörighet från sig självt. Välj ett annat ämne, eller lämna fältet tomt.',
      code: SUBJECT_QUALIFICATION_IS_ITSELF,
      params: { subjectId: selfId },
    });
  }
  const source = await tx.subject.findFirst({
    where: { id: sourceId },
    select: { id: true, name: true, qualificationSubjectId: true },
  });
  if (!source) {
    throw new BadRequestException({
      message: 'Ämnet som behörigheten ska gälla som i finns inte bland skolans egna ämnen.',
      code: SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND,
    });
  }
  if (source.qualificationSubjectId !== null) {
    const further = await tx.subject.findFirst({
      where: { id: source.qualificationSubjectId },
      select: { name: true },
    });
    const sourcesSource = further ? listNames([further.name]) : 'ett annat ämne';
    throw new ConflictException({
      message:
        `Ämnet ${listNames([source.name])} har själv behörighet som i ${sourcesSource}. ` +
        `Välj ${sourcesSource} i stället: behörighet följer bara ett steg.`,
      code: SUBJECT_QUALIFICATION_SOURCE_INHERITS,
      params: { ...(selfId !== null ? { subjectId: selfId } : {}), sourceId: source.id },
    });
  }
  if (selfId !== null) {
    const heirs = await tx.subject.findMany({
      where: { qualificationSubjectId: selfId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    if (heirs.length > 0) {
      const names = listNames(heirs.map((heir) => heir.name));
      throw new ConflictException({
        message:
          `${heirs.length === 1 ? 'Ämnet' : 'Ämnena'} ${names} har behörighet som i det här ämnet, ` +
          `så det kan inte självt ta sin behörighet från ett annat. Ta bort ${heirs.length === 1 ? 'det andra ämnets' : 'de andra ämnenas'} val först.`,
        code: SUBJECT_QUALIFICATION_IS_INHERITED,
        params: { subjectId: selfId, inheritorId: heirs[0].id },
      });
    }
  }
}
