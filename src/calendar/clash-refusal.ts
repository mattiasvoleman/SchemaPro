import type { ConflictException } from '@nestjs/common';
import { clashRefusalOf, type NamedLesson } from './lesson-judge';
import { lessonRefusedConflict } from './lesson-refusal';
import type { MasterLessonConflict } from './master-lessons.service';

/**
 * A clash a swap's apply found, as the hand edit's refusal is told: the same code, the same reason and the other lesson by class,
 * subject, day and clock, so that no write path of the grundschema's lessons answers 409 with a bare sentence
 * (lesson-write-refusals.inventory.spec.ts). Each conflict carries the lesson that would be moved onto it (`requirement`,
 * "Kemi för 8B"), its classes and where it would stand, and `otherOf` says the lesson it clashes with where THAT stands.
 */
export function clashRefusedConflict(
  conflicts: ReadonlyArray<MasterLessonConflict & { requirement: string; groupIds: readonly string[]; slot: { startMinutes: number; endMinutes: number } }>,
  otherOf: (lessonId: string) => NamedLesson | undefined,
): ConflictException {
  return lessonRefusedConflict(
    conflicts.map((conflict) => ({
      requirement: conflict.requirement,
      verdict: {
        ok: false,
        refusals: [clashRefusalOf(conflict, conflict.masterLessonId === undefined ? undefined : otherOf(conflict.masterLessonId), new Set(conflict.groupIds), conflict.slot)],
      },
    })),
  );
}
