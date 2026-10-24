import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Which of `lessonIds` have a note to the substitute, as the school's
 * administrators may know it: that one exists, never what it says.
 *
 * No administrator reads LessonSubstituteNotes (20261203090000: no arm), so
 * an administrator's query of the table finds nothing.
 * app.substitute_noted_lessons answers a SCHOOL_ADMIN of the caller's school
 * with the ids alone, and every other caller with none. The cover board's
 * mark, the booking's e-mail ("there is a note, read it signed in") and a
 * publish's warning that a lesson would take its log with it ask it here.
 */
export async function substituteNotedLessons(tx: PrismaClient, lessonIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(lessonIds)];
  if (ids.length === 0) return new Set();
  const rows = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM app.substitute_noted_lessons(${ids}::uuid[]) AS id`,
  );
  return new Set((rows ?? []).map((row) => row.id));
}
