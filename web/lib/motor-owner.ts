import type { MasterLesson } from "@/lib/types";

/*
 * LÅST ELLER FRI FÖR MOTORN (E4): what the next Generera does with a lesson, read off the lesson's own columns.
 *
 * The gateway's one rule (src/optimization/preserved-lessons.ts, PRESERVED_FROM_REGENERATION) keeps a lesson that was made by hand
 * (`isGenerated` false), one that is locked and was not written from a förläggning, one that has an extra class, and one that names
 * pupils; every other lesson is replaced by the next run. A lesson written from a förläggning is replaced and written again from its row.
 * This only says that rule in words for the reader; it decides nothing (a lesson read without `isGenerated`, by a gateway or a cache that
 * does not send it, says nothing).
 */
export type MotorOwner = "HANDMADE" | "WEEKS" | "LOCKED" | "MOVED" | "PUPILS" | "PLACED" | "FREE";

/**
 * What Spara is about to do to the lesson's owner, from what the fields say: weeks that are not the lesson's own are written, which hands a
 * generated lesson to whoever wrote them (a window cannot be reproduced by the engine), and a lesson that is moved is locked in the same save
 * (beslut 2), both unless it is a förläggning's, where the gateway refuses either. Restating the weeks or the place a lesson has is neither
 * (granskaren g511, L-3: the sentence read the lock as it was stored and said "Fri" under a save that handed the lesson over).
 */
export interface Saving {
  weeks?: boolean;
  moves?: boolean;
}

export function motorOwner(lesson: Pick<MasterLesson, "isLocked" | "fromPlacement" | "extraGroupIds" | "studentIds"> & { isGenerated?: boolean }, saving: Saving = {}): MotorOwner | null {
  if (lesson.isGenerated === undefined) return null;
  if (!lesson.isGenerated) return "HANDMADE";
  if (!lesson.fromPlacement && saving.weeks) return "WEEKS";
  if (lesson.isLocked && !lesson.fromPlacement) return "LOCKED";
  if (lesson.extraGroupIds.length > 0 || lesson.studentIds.length > 0) return "PUPILS";
  if (!lesson.fromPlacement && saving.moves) return "MOVED";
  return lesson.fromPlacement ? "PLACED" : "FREE";
}

/** The two words the reader sees: a lesson the run keeps, or one it may lay again. */
export const keptByMotor = (owner: MotorOwner): boolean => owner !== "PLACED" && owner !== "FREE";
