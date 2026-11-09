import { ConflictException } from '@nestjs/common';
import type { PlacementParams, PlacementRefusalReason, PlacementVerdict } from './placement-judge';

/** The problem `code` of a förläggning that stands where the week does not hold it. */
export const REQUIREMENT_PLACEMENT_REFUSED = 'REQUIREMENT_PLACEMENT_REFUSED';

const DAYS: Readonly<Record<number, string>> = { 1: 'måndag', 2: 'tisdag', 3: 'onsdag', 4: 'torsdag', 5: 'fredag' };

/** The other lesson of a clash as a phrase: "Idrott och hälsa 7B tisdag 10:00–11:00". Never a person. */
function otherText(params: PlacementParams | undefined): string {
  if (!params || params['className'] === undefined) return 'en annan lektion';
  const where = `${params['subjectName']} ${params['className']} ${DAYS[Number(params['day'])] ?? ''} ${params['start']}–${params['end']}`;
  return params['otherKind'] === 'PLACEMENT' ? `förläggningen för ${where}` : where;
}

const RESOURCES: Readonly<Record<string, string>> = { TEACHER: 'Läraren', ROOM: 'Salen', GROUP: 'Klassen' };

/**
 * The sentence a refused row is told in: the fallback a client without the
 * code's translation shows (the web renders `code` and `params` itself). The
 * clash names the other lesson by class and subject, never by person.
 */
export function placementRefusalText(reason: PlacementRefusalReason, params?: PlacementParams): string {
  switch (reason) {
    case 'SCHOOL_DAY':
      return 'Lektionen ligger utanför skoldagen: måndag till fredag 08:00–18:00, på hel femminutersruta.';
    case 'OVER_DEMAND':
      return 'Postens lektioner är redan lagda av låsta lektioner i grundschemat. Ta bort en förläggning eller lås upp lektionen.';
    case 'TEACHER':
      return `Läraren har redan ${otherText(params)}.`;
    case 'ROOM':
      return `Salen är redan upptagen av ${otherText(params)}.`;
    case 'GROUP':
      return `Klassen har redan ${otherText(params)}.`;
    case 'PUPILS':
      return `Elever i klassen har redan ${otherText(params)}.`;
    case 'AVAILABILITY':
      return `${RESOURCES[String(params?.['resource'])] ?? 'Läraren, salen eller klassen'} är inte tillgänglig den här tiden.`;
    case 'FRAME':
      return 'Lektionen ligger utanför klassens ramtid.';
    case 'LUNCH':
      return 'Lektionen ligger på klassens lunch.';
    case 'GRADE_RULE':
      return 'Skolan har stängt den här tiden för klassens årskurs.';
    case 'OTHER_SCHOOL':
      return `Läraren eller salen är upptagen vid ${params?.['schools'] ?? 'en annan skola'} den här tiden.`;
  }
}

/**
 * The 409 for the first row that does not hold. Everything a client needs is
 * in `params`, flat (the exception filter forwards only the code and flat
 * `params`): the row's `index` in the request, the `reason`, and the reason's
 * own figures, so the dialog can put the sentence at the row.
 */
export function placementRefusedConflict(verdict: PlacementVerdict): ConflictException {
  const reason = verdict.reason ?? 'SCHOOL_DAY';
  return new ConflictException({
    message: `Förläggning ${verdict.index + 1}: ${placementRefusalText(reason, verdict.params)}`,
    code: REQUIREMENT_PLACEMENT_REFUSED,
    params: { index: verdict.index, reason, ...(verdict.params ?? {}) },
  });
}
