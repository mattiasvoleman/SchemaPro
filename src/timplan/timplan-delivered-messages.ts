import type { DeliveredVerdict } from '../common/timplan-delivered';

/*
 * The Swedish sentence for each layer-3 verdict (genomfört mot schemalagt).
 * The layers' rules: "under planerat", never "fel"; NO PUPIL'S NAME ("en elev
 * i 7A"); hours to the tenth with a decimal comma where a year is spoken of,
 * minutes where a day or a lesson is.
 */

const hours = (minutes: string | number | undefined): string =>
  `${(Math.round(Number(minutes ?? 0) / 6) / 10).toLocaleString('sv-SE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`;
const min = (value: string | number | undefined): string => `${Number(value ?? 0)} min`;

export function describeDeliveredVerdict(verdict: DeliveredVerdict): string {
  const p = verdict.params;
  switch (verdict.code) {
    case 'TIMPLAN_NOT_PUBLISHED':
      return 'Inget schema är publicerat till kalendern för läsåret, så ingen tid är genomförd ännu.';
    case 'TIMPLAN_PUBLISHED_LATE':
      return (
        `Kalendern börjar ${p.from}, men läsåret ${p.yearStart}. Dagarna före räknas varken som genomförda ` +
        `eller förlorade (${hours(p.unrecordedMinutes)} planerad tid för klasserna).`
      );
    case 'TIMPLAN_PUBLISHED_BEHIND':
      return (
        `Kalendern är publicerad till och med ${p.through}. Dagarna därefter fram till i dag räknas varken ` +
        'som genomförda eller förlorade — publicera vidare för att de ska räknas.'
      );
    case 'TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS':
      return (
        `Läsåret slutade ${p.yearEnd}. Eleverna räknas efter dagens klasser och grupper, så ett avslutat ` +
        'läsårs klasser kan sakna elever.'
      );
    case 'TIMPLAN_CALENDAR_DRIFT':
      return (
        `Kalendern framåt skiljer sig från grundschemat med ${Math.abs(Number(p.minutes))} min ` +
        `(${p.lessons} ${Number(p.lessons) === 1 ? 'lektion' : 'lektioner'} i grundschemat). Publicera igen för att kalendern ska följa det.`
      );
    case 'TIMPLAN_DELIVERED_TEACHERLESS':
      return `${p.groupName}: ${min(p.minutes)} har legat i kalendern utan lärare och räknas som förlorad tid.`;
    case 'TIMPLAN_PROJECTION_SHORT':
      return (
        `${p.groupName}: ${p.subjectName} beräknas få ${hours(p.projectedMinutes)} i år, ` +
        `${hours(p.deficitMinutes)} under planerade ${hours(p.plannedYearMinutes)}. ` +
        `Inställt och utan lärare: ${hours(p.lostMinutes)}.`
      );
    case 'TIMPLAN_PUPIL_PROJECTION_SHORT':
      return (
        `En elev i ${p.groupName} beräknas få ${hours(p.projectedMinutes)} ${p.subjectName} i år, ` +
        `${hours(p.deficitMinutes)} under elevens planerade ${hours(p.plannedYearMinutes)} — mer än elevens grupper saknar.`
      );
    case 'TIMPLAN_PUPIL_NOTHING_DELIVERED':
      return `En elev i ${p.groupName} har inte fått någon genomförd tid i ${p.subjectName}, medan klassen har fått ${min(p.classMedianMinutes)}.`;
    case 'TIMPLAN_CREDIT_OUTSIDE_YEAR':
      return `"${p.creditName}" (${p.date}) ligger utanför läsåret (${p.yearStart}–${p.yearEnd}) och räknas inte.`;
    case 'TIMPLAN_CREDIT_REACHES_NOBODY':
      return p.reason === 'SUBJECT'
        ? `"${p.creditName}" (${p.date}) gäller ett ämne som inte räknas mot timplanen och räknas inte.`
        : `"${p.creditName}" (${p.date}) gäller ingen klass eller grupp i läsåret och räknas inte.`;
    case 'TIMPLAN_CREDIT_OVERLAPS_DELIVERED':
      return (
        `"${p.creditName}" (${p.date}) tillgodoräknas ${min(p.minutes)}, och samma dag hölls ${min(p.deliveredMinutes)} ` +
        'lektioner som också räknas. Ställ in dem, eller lägg dagen som lov, om aktiviteten ersatte dem.'
      );
    case 'TIMPLAN_CALENDAR_ON_BREAK':
      return `${p.groupName}: ${min(p.minutes)} lektioner hölls på lov- eller studiedagar (${p.dates}) och räknas som genomförda.`;
  }
}
