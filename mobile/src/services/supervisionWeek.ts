import { ApiError, apiRequest } from './api';

/**
 * The signed-in teacher's rastvaktspass over a few days (Rastvakt i vardagen,
 * 20261210090000) — GET /api/v1/supervision/week, the read the web's own week
 * makes, as themself.
 *
 * Their own passes on the dates they run, with what the school's board
 * decided while they were away (a vikarie takes it, or nobody does), and the
 * passes they take as vikarie for somebody else. The answer names the place
 * and the time, never whose pass it is and never why anybody is away.
 *
 * Through the gateway and not PostgREST: the tables have no arm for a
 * PostgREST session (20261207090000), and the dates a pass runs (its weekday,
 * its Från and Till, the lov) are the gateway's to work out.
 *
 * The screen merges these with the lessons it reads itself; this module holds
 * the read and the mapping, where jest can reach them (jest.config.js renders
 * no screens).
 */

export interface WeekPass {
  readonly kind: 'OWN' | 'COVER';
  readonly shiftId: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly areaName: string;
  readonly siteName: string | null;
  /** OWN only: a vikarie takes it that day, or it is left without one; null when it is theirs. */
  readonly handover: 'SUBSTITUTE' | 'NO_COVER' | null;
}

/** The pass's card on the schedule: its own key, never a lesson's, and what to say under the place. */
export interface PassCard {
  readonly key: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly areaName: string;
  readonly siteName: string | null;
  /** The catalogue key of the line under the place, or null when the pass is simply theirs. */
  readonly marker: 'schedule.passCover' | 'schedule.passHandedOver' | 'schedule.passNoCover' | null;
  /** Their own pass that somebody else has that day, or nobody: drawn as nothing to stand at. */
  readonly relieved: boolean;
}

/**
 * A 404 WITHOUT a code is a gateway that has no such route — one from before
 * Rastvakt i vardagen, or rolled back past it — and it has no passes to give:
 * an empty week, not an error on every load. The route's own refusals carry
 * a code.
 */
export async function fetchSupervisionWeek(from: string, to: string): Promise<WeekPass[]> {
  const query = new URLSearchParams({ from, to }).toString();
  try {
    const answer = await apiRequest<{ from: string; to: string; passes: WeekPass[] }>(`/api/v1/supervision/week?${query}`);
    return answer?.passes ?? [];
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return [];
    throw error;
  }
}

export function passCardsOf(passes: readonly WeekPass[]): PassCard[] {
  return passes.map((pass) => ({
    key: `pass:${pass.kind}:${pass.shiftId}:${pass.date}`,
    date: pass.date,
    startsAt: pass.startsAt,
    endsAt: pass.endsAt,
    areaName: pass.areaName,
    siteName: pass.siteName,
    marker:
      pass.kind === 'COVER'
        ? 'schedule.passCover'
        : pass.handover === 'SUBSTITUTE'
          ? 'schedule.passHandedOver'
          : pass.handover === 'NO_COVER'
            ? 'schedule.passNoCover'
            : null,
    relieved: pass.kind === 'OWN' && pass.handover !== null,
  }));
}
