import type { PlannedVerdict } from '../common/timplan-planned';

/*
 * The Swedish sentence for each layer-1 verdict (planerat mot timplan), as the
 * API states it beside the codes and figures the web formats under its own
 * i18n keys. Same rules as timplan-verdict-messages.ts: "under mål", never
 * "fel" — the law lets a pupil's studiegång deviate — and NO PUPIL'S NAME: the
 * module hands out ids only, and a pupil sentence says "en elev i 7A".
 */

const min = (value: string | number | undefined): string => `${Number(value ?? 0)} min/vecka`;
const grade = (value: string | number | undefined): string =>
  Number(value) === 0 ? 'förskoleklass' : `åk ${value}`;

export function describePlannedVerdict(verdict: PlannedVerdict): string {
  const p = verdict.params;
  switch (verdict.code) {
    case 'TIMPLAN_YEAR_GRADE_UNATTACHED':
      return (
        `Läsåret följer ingen lokal timplan i ${grade(p.gradeLevel)} (${p.groupNames}). ` +
        'Välj en under läsårets "Timplan per årskurs" för att jämföra klassernas timplansposter med den.'
      );
    case 'TIMPLAN_ATTACHED_DRAFT':
      return (
        `${String(p.gradeLevels).includes(',') ? 'Årskurserna' : 'Årskurs'} ${p.gradeLevels} följer ` +
        `"${p.planName}", som är ett utkast — inte beslutad. Jämförelsen gäller utkastet.`
      );
    case 'TIMPLAN_ATTACHED_PLAN_EMPTY':
      return (
        `Klasserna i ${grade(p.gradeLevel)} (${p.groupNames}) följer "${p.planName}", som inte ger ` +
        'årskursen någon tid, så de har inga mål. Välj rätt plan under läsårets "Timplan per årskurs".'
      );
    case 'TIMPLAN_GROUP_UNPLANNED':
      return (
        `${p.groupName}: ${p.subjectName} har inga timplansposter, och timplanen säger ` +
        `${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`
      );
    case 'TIMPLAN_GROUP_UNDERPLANNED':
      return (
        `${p.groupName}: ${p.subjectName} är planerat till ${min(p.plannedMinutesPerWeek)}, ` +
        `${p.deficitMinutesPerWeek} under målet ${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`
      );
    case 'TIMPLAN_GROUP_OVERPLANNED':
      return (
        `${p.groupName}: ${p.subjectName} är planerat till ${min(p.plannedMinutesPerWeek)}, ` +
        `${p.surplusMinutesPerWeek} över målet ${min(p.targetMinutesPerWeek)} — minst en hel lektion mer än timplanen säger.`
      );
    case 'TIMPLAN_PUPIL_UNDERPLANNED':
      return (
        `En elev i ${p.groupName} får ${min(p.plannedMinutesPerWeek)} ${p.subjectName}, ` +
        `${p.deficitMinutesPerWeek} under målet ${min(p.targetMinutesPerWeek)} för ${grade(p.gradeLevel)}.`
      );
    case 'TIMPLAN_PUPIL_DOUBLE_PLANNED':
      return (
        `En elev i ${p.groupName} får ${p.subjectName} från flera grupper (${p.groupNames}), ` +
        `${min(p.plannedMinutesPerWeek)} sammanlagt. Kontrollera att det är avsett.`
      );
  }
}
