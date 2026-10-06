import type { TimplanStage, TimplanVerdict } from '../common/timplan-coverage';

/*
 * The Swedish sentence for each TIMPLAN_* verdict, as the API states it.
 *
 * The pure module hands out codes and figures only, so the web can format the
 * same verdict under its own i18n keys (sv and en) from the same numbers. The
 * gateway's check document carries a sentence too, for whoever reads the API
 * without the web — an SS12000 consumer, a rektor's export, a support ticket.
 *
 * THE WORDING IS "UNDER MÅL", NEVER "FEL". Every verdict is a warning the law
 * allows a school to stand behind — anpassad studiegång, prioriterad timplan,
 * a rektor's decision in anpassade grundskolan — and a product that calls
 * those errors teaches schools to hide them. The spec asserts the word does
 * not occur.
 */

const STAGE: Record<TimplanStage, string> = {
  LAG: 'lågstadiet',
  MELLAN: 'mellanstadiet',
  HOG: 'högstadiet',
  LAG_MELLAN: 'låg- och mellanstadiet',
};

const number = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 1 });
const h = (value: string | number | undefined): string => `${number.format(Number(value ?? 0))} h`;
const pct = (value: string | number | undefined): string => `${number.format(Number(value ?? 0))} %`;

/**
 * @param subjectNames national code → Swedish name ("MA" → "Matematik"), from
 *   NationalSubjects; a code missing from it is shown as the code.
 */
export function describeVerdict(
  verdict: TimplanVerdict,
  subjectNames: ReadonlyMap<string, string>,
): string {
  const p = verdict.params;
  const name = (code: string | undefined) => (code ? (subjectNames.get(code) ?? code) : '');
  const where = `${name(verdict.subjectCode)} i ${verdict.stage ? STAGE[verdict.stage] : ''}`;

  switch (verdict.code) {
    case 'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED':
      return (
        `Fördelningen mellan ämnen och stadier för ${p.versionCode} är inte publicerad ännu. ` +
        `Planen jämförs bara mot den garanterade totalen ${h(p.totalHours)}, inte ämne för ämne.`
      );
    case 'TIMPLAN_SUBJECT_UNMAPPED':
      return (
        `${p.subjectName} har ingen nationell ämneskod, och dess ${h(p.plannedHours)} räknas som skolans val. ` +
        'Ange en ämneskod om ämnet hör till timplanen, eller markera att det inte räknas som undervisningstid.'
      );
    case 'TIMPLAN_PROTECTED_SUBJECT_REDUCED':
      return (
        `${where}: ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} under målet ${h(p.nationalHours)}. ` +
        'Ämnet får inte minskas för skolans val.'
      );
    case 'TIMPLAN_REDUCTION_OVER_CAP':
      return (
        `${where}: ${h(p.plannedHours)} planerat, ${pct(p.reducedPercent)} under målet ${h(p.nationalHours)}. ` +
        `Skolans val får minska ett ämne med högst ${pct(p.capPercent)} per stadium.`
      );
    case 'TIMPLAN_GROUP_MINIMUM_UNMET':
      return (
        `${name(verdict.childCode)} i ${verdict.stage ? STAGE[verdict.stage] : ''}: ${h(p.plannedHours)} planerat, ` +
        `under minsta tiden ${h(p.minimumHours)} inom ${name(verdict.subjectCode).toLowerCase()}.`
      );
    case 'TIMPLAN_STAGE_BELOW_NATIONAL':
      return (
        `${where}: ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} (${pct(p.reducedPercent)}) under målet ` +
        `${h(p.nationalHours)}. Tiden räknas mot skolans val.`
      );
    case 'TIMPLAN_SKOLANS_VAL_OVERSPENT':
      return (
        `Skolans val: ${h(p.takenHours)} har tagits från ämnena, ${h(p.overspentHours)} mer än de ` +
        `${h(p.availableHours)} timplanen medger.`
      );
    case 'TIMPLAN_TOTAL_BELOW_GUARANTEE':
      return (
        `Totalt ${h(p.plannedHours)} planerat, ${h(p.deficitHours)} under den garanterade ` +
        `undervisningstiden ${h(p.guaranteedHours)}.`
      );
  }
}
