import type { Prisma } from '@prisma/client';

/**
 * Master lessons a regeneration leaves alone, expressed once.
 *
 * The first shape is the whole rule: `isGenerated` is false on everything the
 * optimizer did not produce, and nothing else in the timetable is the
 * machine's to replace. The other three are what a human has since done to a
 * lesson the machine did produce — locked it into place, opened it to a second
 * class, filled it with named students — each an intent the solver cannot
 * express and therefore could never put back.
 *
 * Ownership used to be inferred from the row looking untouched: default
 * recurrence and no dates, so nobody has been here, so it is ours. That held
 * only while nothing but a human ever set those columns. A generated lesson
 * now inherits its requirement's window, so "kemi bara på vårterminen"
 * describes the optimizer's own output exactly as well as a handmade lesson —
 * and read as handmade it was preserved, its requirement still counted as
 * unmet, and the next run stacked a second copy on top of it. Every press of
 * generate added another layer. The three window conditions are gone from this
 * list for that reason, and a handmade lesson carrying a window is caught by
 * `isGenerated: false` like every other handmade lesson.
 *
 * FÖRLAGDA POSTER: A LOCK GENERERA WROTE ITSELF IS NOT KEPT. A förläggning on
 * a timplanspost (TeachingRequirementPlacement) reaches the grundschema as a
 * lesson that is locked, generated and marked (`fromPlacement`): locked so
 * that a swap, Optimera salar and the klasslärare leave it where the school
 * placed it, marked so that the next Generera writes it again from the post's
 * förläggningar as they then stand. Kept as a lock, it would stand beside the
 * förläggning sent again — the same lesson twice, and a post with more
 * lessons placed than it has. So the lock arm asks for no mark. A placed
 * lesson somebody has since given a second class or named pupils, or a window
 * (which hands it over, isGenerated false), is kept by that arm as any lesson
 * is; its förläggning is then judged against it at Generera, and a post that
 * has both is refused by name (placement-judge.ts) rather than laid twice.
 * Removing a förläggning reaches the grundschema at the next Generera too:
 * the marked lesson goes with the draft, and nothing pins its lesson.
 *
 * Referenced from every place that must agree exactly: the fetch that
 * forwards these to the engine as immovable placements, the delete that
 * clears the machine-owned remainder, a schemaförslag's counts, and the judge
 * of a förläggning (src/requirement-placements/placement-judge.ts), which
 * holds a placed lesson against the same lessons Generera will keep. One
 * constant, because a lesson that is in one list and not the other is either
 * sent twice or thrown away.
 */
export const PRESERVED_FROM_REGENERATION: Prisma.MasterLessonWhereInput[] = [
  { isGenerated: false },
  { isLocked: true, fromPlacement: false },
  { extraGroups: { some: {} } },
  { participants: { some: {} } },
];
