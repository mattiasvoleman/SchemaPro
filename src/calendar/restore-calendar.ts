import { Prisma, type LessonRecurrence, type PrismaClient } from '@prisma/client';

/**
 * ÅTERSTÄLLNING I DIREKT: VAD SOM HÄNDER MED DE PUBLICERADE LEKTIONERNA (E9, g520 M-3).
 *
 * En återställning raderar årets alla grundschemalektioner och skapar versionens på nytt, med nya id. CalendarLessons.masterLessonId är
 * ON DELETE SET NULL, och publiceringen nycklar på (masterLessonId, datum): en lektion i kalendern vars mall är borta matchar ingen nyckel.
 * Efter en återställning i Direkt stod därför varje publicerad lektion kvar som en föräldralös rad, och nästa publicering lade ut samma vecka
 * en gång till (sex lektioner blev tolv, två på varje tid). Generera undviker det genom att ta bort de framtida lektionerna i samma
 * transaktion; ett utkast genom att anta de föräldralösa vid nästa publicering. Direkt hade ingetdera.
 *
 * VAD ÅTERSTÄLLNINGEN GÖR NU, i samma transaktion som den byter ut grundschemat:
 *
 *   1. En lektion vars mall versionen håller oförändrad behåller sina publicerade rader. Raderna flyttas över till den nya mallen (en
 *      UPDATE), så en vikarie, en ändrad sal, en anteckning och en lektionslogg på en av dem följer med, och nästa publicering finner
 *      nyckeln (ny mall, datum) och lägger inget till. "Oförändrad" är allt kalenderraden görs av: ämne, klass, lärare, medlärare, sal,
 *      veckodag, tider, veckor och datum, de andra grupperna och de namngivna eleverna, och om lektionen står på brickan.
 *   2. En lektion vars mall återställningen ändrar eller tar bort förlorar sina framtida rader: still-SCHEDULED, från skolans i dag, utan
 *      närvaro, som Generera och E4b:s inskrivning tar dem (calendarSweepWhere). Det som redan har hänt står kvar som det hände, och
 *      förlorar sin mall (SET NULL) som när en lektion tas bort för hand. Nästa publicering lägger ut den nya mallens veckor.
 *   3. Det som tas bort är publicerade lektioner som når elever och vårdnadshavare, så skolan frågas som varje annan ändring i Direkt
 *      (requireDirectReachAnswered), med antalet, efter att raderna har tagits och i transaktionen: nekas frågan rullas allt tillbaka.
 *
 * Så görs det inte i Utkast: där är grundschemat ett utkast och de publicerade raderna står kvar tills en publicering antar eller tar bort
 * dem (draft-publish.ts, settlePendingRemovals).
 *
 * VAD SOM HÅLLS FAST: att "oförändrad" är allt kalenderraden görs av. Tas ett fält bort ur nyckeln (en lektions sal, en medlärare) följer
 * raderna med till en mall som säger något annat än de, och ingenting i kalendern visar det. Bevakas av restore-calendar.spec.ts.
 */

/** What a master lesson's calendar rows are made of (CalendarService.materialise), as a restore reads it from the table and from a version. */
export interface TemplateFields {
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  /** `HH:MM`. */
  startTime: string;
  endTime: string;
  isParked: boolean;
  recurrence: LessonRecurrence;
  /** `YYYY-MM-DD`, or null for "from the start of the year". */
  startDate: string | null;
  endDate: string | null;
  extraGroupIds: readonly string[];
  studentIds: readonly string[];
}

/**
 * One string for "the same template": equal exactly when the calendar rows made from the two would be the same rows. What does not make a
 * row (the lock, who owns the lesson, a förläggning, an exemption) is not in it, so restoring a lock or an owner moves nothing in the calendar.
 */
export function templateKey(template: TemplateFields): string {
  return JSON.stringify([
    template.subjectId,
    template.studentGroupId,
    template.teacherId,
    template.coTeacherId,
    template.roomId,
    template.dayOfWeek,
    template.startTime,
    template.endTime,
    template.isParked,
    template.recurrence,
    template.startDate,
    template.endDate,
    [...template.extraGroupIds].sort(),
    [...template.studentIds].sort(),
  ]);
}

export interface TemplatePairing {
  /** For each restored lesson, in order: the id of the current lesson whose rows it takes over, or null. */
  from: Array<string | null>;
  /** The current lessons no restored lesson takes over: their future rows go. */
  replaced: string[];
}

/**
 * Pairs the lessons the year holds with the lessons the version holds, one to one, by template. Two lessons with the same template (a
 * lesson twice over, or one the optimiser put twice) are taken in the order of their ids, so the pairing is the same every time.
 */
export function pairTemplates(
  current: ReadonlyArray<{ id: string } & TemplateFields>,
  restored: ReadonlyArray<TemplateFields>,
): TemplatePairing {
  const waiting = new Map<string, string[]>();
  for (const lesson of [...current].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = templateKey(lesson);
    const queue = waiting.get(key);
    if (queue) queue.push(lesson.id);
    else waiting.set(key, [lesson.id]);
  }
  const taken = new Set<string>();
  const from = restored.map((lesson) => {
    const id = waiting.get(templateKey(lesson))?.shift() ?? null;
    if (id !== null) taken.add(id);
    return id;
  });
  return { from, replaced: current.map((lesson) => lesson.id).filter((id) => !taken.has(id)) };
}

/** Whether any calendar row hangs on a lesson of the year: with none, a restore has nothing to carry and asks nobody. */
export async function yearHasCalendarRows(tx: PrismaClient, academicYearId: string): Promise<boolean> {
  const row = await tx.calendarLesson.findFirst({
    where: { masterLesson: { is: { academicYearId } } },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * The year's lessons, held FOR UPDATE before the restore moves a single row (g522).
 *
 * The rows of the calendar hang on a lesson by a key that is checked FOR KEY SHARE, and nothing a publication in Direkt takes stops it
 * from inserting rows under a lesson the restore is about to delete: a publication takes no lock on the year, only the shared publication
 * lock the restore takes too. A publication whose rows land between the restore's relink and its delete of the old lessons was never seen by
 * the relink, and the delete (SET NULL) strands every one of them: the restore leaves the orphans it set out not to leave, and the next
 * publication lays the same weeks out again. FOR UPDATE conflicts with the key lock: a publication that has rows in flight makes the
 * restore wait (and answer 409 SCHEDULE_BUSY after 5 s, as for any other writer of the year), and one that comes after waits for the
 * restore and is refused by the key when it commits, as it always was when the lessons it meant are gone.
 */
export async function lockYearLessons(tx: PrismaClient, academicYearId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "MasterLessons" WHERE "academicYearId" = ${academicYearId}::uuid ORDER BY "id" FOR UPDATE`);
}

/** The rows of the lessons that stay, put under the lessons that replace them. Returns how many rows moved over. */
export async function relinkCalendarRows(
  tx: PrismaClient,
  pairs: ReadonlyArray<{ from: string; to: string }>,
): Promise<number> {
  if (pairs.length === 0) return 0;
  return tx.$executeRaw(Prisma.sql`
    UPDATE "CalendarLessons" c
       SET "masterLessonId" = p."to"
      FROM unnest(${pairs.map((pair) => pair.from)}::uuid[], ${pairs.map((pair) => pair.to)}::uuid[]) AS p("from", "to")
     WHERE c."masterLessonId" = p."from"
  `);
}

/** The rows a restore takes off the calendar: the replaced lessons' still-SCHEDULED rows from the school's today on that carry no attendance. */
export const sweptRows = (replaced: readonly string[], today: Date): Prisma.CalendarLessonWhereInput => ({
  masterLessonId: { in: [...replaced] },
  status: 'SCHEDULED',
  date: { gte: today },
  attendanceRecords: { none: {} },
});

export interface SweepCount {
  /** Rows that go. */
  removed: number;
  /**
   * Of them, rows the school has worked on since the publication: a vikarie, another room than the template's, a note, a lesson log, a note to the
   * substitute, a pupil moved to or from the lesson for the day (Elevens lektion för dagen), or a decision on a teacher's absence (a co-teacher
   * who takes the lesson leaves no vikarie and no note behind). Each of them goes with the row (the keys are ON DELETE CASCADE), and a family
   * or a colleague has been told of most of them.
   */
  handChanged: number;
}

/**
 * What the sweep would take, counted before it does: how many rows, and how many of them carry something somebody did by hand. The count
 * reads the same rows sweptRows deletes. The note to the substitute is asked of app.substitute_noted_lessons, as the publish asks it
 * (no administrator reads that table).
 */
export async function countSweep(tx: PrismaClient, replaced: readonly string[], today: Date): Promise<SweepCount> {
  if (replaced.length === 0) return { removed: 0, handChanged: 0 };
  const rows = await tx.$queryRaw<Array<{ removed: number; handChanged: number }>>(Prisma.sql`
    WITH swept AS (
      SELECT c."id",
             (   EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = c."id" AND t."role" = 'SUBSTITUTE')
              OR COALESCE(c."note", '') <> ''
              OR c."roomId" IS DISTINCT FROM m."roomId"
              OR EXISTS (SELECT 1 FROM "LessonLogs" l WHERE l."calendarLessonId" = c."id")
              OR EXISTS (SELECT 1 FROM "LessonPupilMoves" mv WHERE mv."fromLessonId" = c."id" OR mv."toLessonId" = c."id")
              OR EXISTS (SELECT 1 FROM "TeacherAbsenceCovers" ac WHERE ac."calendarLessonId" = c."id")) AS "operated"
        FROM "CalendarLessons" c
        JOIN "MasterLessons" m ON m."id" = c."masterLessonId" AND m."schoolId" = c."schoolId"
       WHERE c."masterLessonId" = ANY(${[...replaced]}::uuid[])
         AND c."status" = 'SCHEDULED'
         AND c."date" >= ${today}::date
         AND NOT EXISTS (SELECT 1 FROM "AttendanceRecords" a WHERE a."calendarLessonId" = c."id")
    ), noted AS (
      SELECT n AS "id" FROM app.substitute_noted_lessons(ARRAY(SELECT "id" FROM swept)) AS n
    )
    SELECT count(*)::int AS "removed",
           (count(*) FILTER (WHERE s."operated" OR s."id" IN (SELECT "id" FROM noted)))::int AS "handChanged"
      FROM swept s
  `);
  const row = rows?.[0];
  return { removed: Number(row?.removed ?? 0), handChanged: Number(row?.handChanged ?? 0) };
}

export async function sweepCalendarRows(tx: PrismaClient, replaced: readonly string[], today: Date): Promise<number> {
  if (replaced.length === 0) return 0;
  const { count } = await tx.calendarLesson.deleteMany({ where: sweptRows(replaced, today) });
  return count;
}
