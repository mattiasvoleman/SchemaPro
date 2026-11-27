import type { OptimizationProfile } from '@prisma/client';

/**
 * OPTIMERINGSPROFILEN (P5, 20270313090000): the five weights Generera's sliders set, as the school's.
 *
 * They are relative (only the ratios between them reach the objective), whole numbers 0..1000 as the engine's request takes them
 * (ObjectiveWeightsDto). A school that has saved none has the defaults below: the values the page has always started from, so a school
 * that never touches the sliders sends what it always sent. The page sends the profile with each run; the engine's own defaults
 * apply only to a caller that sends none.
 */
export interface ProfileWeights {
  preferredFree: number;
  preferredBusy: number;
  disruption: number;
  spread: number;
  teacherGap: number;
}

export const PROFILE_WEIGHT_KEYS = ['preferredFree', 'preferredBusy', 'disruption', 'spread', 'teacherGap'] as const;

export const DEFAULT_PROFILE_WEIGHTS: Readonly<ProfileWeights> = {
  preferredFree: 10,
  preferredBusy: 5,
  disruption: 8,
  spread: 3,
  teacherGap: 2,
};

export const PROFILE_WEIGHT_MIN = 0;
export const PROFILE_WEIGHT_MAX = 1000;

/** What GET answers: the weights, whether the school has saved them, and when. */
export interface OptimizationProfileView {
  weights: ProfileWeights;
  /** False: no row, the defaults. */
  stored: boolean;
  updatedAt: string | null;
}

/** The view of a row, or of no row. Only the five weights leave the row. */
export function profileView(row: Pick<OptimizationProfile, 'updatedAt' | 'preferredFree' | 'preferredBusy' | 'disruption' | 'spread' | 'teacherGap'> | null): OptimizationProfileView {
  if (!row) return { weights: { ...DEFAULT_PROFILE_WEIGHTS }, stored: false, updatedAt: null };
  return {
    weights: {
      preferredFree: row.preferredFree,
      preferredBusy: row.preferredBusy,
      disruption: row.disruption,
      spread: row.spread,
      teacherGap: row.teacherGap,
    },
    stored: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}
