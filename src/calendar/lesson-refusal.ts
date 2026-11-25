import { ConflictException } from '@nestjs/common';
import { placementRefusalText } from '../requirement-placements/placement-refusal';
import type { LessonRefusal, LessonVerdict } from './lesson-judge';

/** The problem `code` of a lesson that may not stand where a hand edit put it. */
export const MASTER_LESSON_REFUSED = 'MASTER_LESSON_REFUSED';

/**
 * The sentence a refusal is told in: the förläggning's own, so that one reason is one sentence wherever it is said, except
 * a clash the pupils' ombyte or dusch made alone, whose own sentence (`note`) says whose ombyte and how long.
 */
export const lessonRefusalText = (refusal: LessonRefusal): string =>
  typeof refusal.params['note'] === 'string' ? refusal.params['note'] : placementRefusalText(refusal.reason, refusal.params);

/** A lesson the edit named, with what the judge found of it: `requirement` is "Idrott för 7A" (requirementName) on a block's card. */
export interface RefusedLesson {
  requirement?: string;
  verdict: LessonVerdict;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/**
 * The 409 of an edit that breaks a rule. Everything a client needs is in `params`, flat (the exception filter
 * forwards only the code and flat `params`): the heaviest `reason`, every reason found as `reasons` (comma-joined),
 * the reason's own figures (the other lesson's class, subject, day and time; the schools; the resource), and on a
 * block's card the member it is about (`requirement`).
 *
 * `message` is a sentence, the fallback a client without the code's translation shows: the mobile app and an older
 * web read `detail` and nothing else. It says every reason, each once.
 */
export function lessonRefusedConflict(refused: readonly RefusedLesson[]): ConflictException {
  const all = refused.flatMap(({ requirement, verdict }) => verdict.refusals.map((refusal) => ({ requirement, refusal })));
  const first = all[0];
  if (!first) throw new Error('lessonRefusedConflict: nothing was refused');
  const message = unique(all.map(({ requirement, refusal }) => `${requirement ? `${requirement}: ` : ''}${lessonRefusalText(refusal)}`)).join(' ');
  const reasons = unique(all.map(({ refusal }) => refusal.reason)).join(',');
  return new ConflictException({
    message,
    code: MASTER_LESSON_REFUSED,
    params: {
      reason: first.refusal.reason,
      reasons,
      ...(first.requirement ? { requirement: first.requirement.length <= 200 ? first.requirement : `${first.requirement.slice(0, 199)}…` } : {}),
      ...first.refusal.params,
    },
  });
}
