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
export type MotorOwner = "HANDMADE" | "LOCKED" | "PUPILS" | "PLACED" | "FREE";

export function motorOwner(lesson: Pick<MasterLesson, "isLocked" | "fromPlacement" | "extraGroupIds" | "studentIds"> & { isGenerated?: boolean }): MotorOwner | null {
  if (lesson.isGenerated === undefined) return null;
  if (!lesson.isGenerated) return "HANDMADE";
  if (lesson.isLocked && !lesson.fromPlacement) return "LOCKED";
  if (lesson.extraGroupIds.length > 0 || lesson.studentIds.length > 0) return "PUPILS";
  return lesson.fromPlacement ? "PLACED" : "FREE";
}

/** The two words the reader sees: a lesson the run keeps, or one it may lay again. */
export const keptByMotor = (owner: MotorOwner): boolean => owner === "HANDMADE" || owner === "LOCKED" || owner === "PUPILS";
