import type { ScheduledVerdict } from '../common/timplan-scheduled';

/*
 * The Swedish sentence for each layer-2 verdict (schemalagt mot planerat), as
 * the API states it beside the codes and figures the web formats under its
 * own i18n keys. Layer 1's rules: "under planerat", never "fel" — the
 * grundschema may deliberately differ from the posts for a while — and NO
 * PUPIL'S NAME: the module hands out ids only, and a pupil sentence says "en
 * elev i 7A".
 */

const min = (value: string | number | undefined): string => `${Number(value ?? 0)} min/vecka`;

export function describeScheduledVerdict(verdict: ScheduledVerdict): string {
  const p = verdict.params;
  switch (verdict.code) {
    case 'TIMPLAN_SCHEDULE_NONE':
      return 'Läsåret har timplansposter men inget grundschema ännu, så schemalagd tid kan inte jämföras.';
    case 'TIMPLAN_SCHEDULE_UNSCHEDULED':
      return `${p.groupName}: ${p.subjectName} har ${min(p.plannedMinutesPerWeek)} i timplansposterna och ingen lektion i grundschemat.`;
    case 'TIMPLAN_SCHEDULE_SHORT':
      return (
        `${p.groupName}: ${p.subjectName} har ${min(p.scheduledMinutesPerWeek)} i grundschemat, ` +
        `${-Number(p.deltaMinutesPerWeek)} under planerade ${min(p.plannedMinutesPerWeek)}.`
      );
    case 'TIMPLAN_SCHEDULE_PARKED':
      return (
        `${p.groupName}: ${p.subjectName} har ${min(p.scheduledMinutesPerWeek)} i grundschemat av planerade ` +
        `${min(p.plannedMinutesPerWeek)}; ${min(p.parkedMinutesPerWeek)} ligger parkerade.`
      );
    case 'TIMPLAN_SCHEDULE_EXTRA':
      return (
        `${p.groupName}: ${p.subjectName} har ${min(p.scheduledMinutesPerWeek)} i grundschemat, ` +
        `${p.deltaMinutesPerWeek} mer än planerade ${min(p.plannedMinutesPerWeek)}.`
      );
    case 'TIMPLAN_SCHEDULE_UNPLANNED':
      return `${p.groupName}: ${p.subjectName} har ${min(p.scheduledMinutesPerWeek)} i grundschemat och ingen timplanspost.`;
    case 'TIMPLAN_PUPIL_SCHEDULE_SHORT':
      return (
        `En elev i ${p.groupName} får ${min(p.scheduledMinutesPerWeek)} ${p.subjectName} i grundschemat, ` +
        `${p.deficitMinutesPerWeek} under elevens planerade ${min(p.plannedMinutesPerWeek)} — mer än elevens grupper ` +
        'saknar. Ofta räknas samma lektion för två av elevens grupper.'
      );
  }
}
