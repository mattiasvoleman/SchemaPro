import type { StageVerdict } from '../common/timplan-stage';

/*
 * The Swedish sentence for each stage verdict (timplan P4). The rules of the
 * other layers: "under timplanens timmar", never "fel"; no pupil's name ("en
 * elev"); hours with a decimal comma. Every national figure is the reference
 * data's — "enligt referensdata (SFS …)" — never "lagen säger".
 */

const STAGE_SV: Record<string, string> = {
  LAG: 'lågstadiet',
  MELLAN: 'mellanstadiet',
  HOG: 'högstadiet',
  LAG_MELLAN: 'låg- och mellanstadiet',
};

const h = (value: string | number | undefined): string =>
  `${Number(value ?? 0).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} h`;

const grades = (value: string | number | undefined): string => {
  const list = String(value ?? '').split(', ').filter((entry) => entry !== '');
  if (list.length === 0) return '';
  return list.length === 1 ? `åk ${list[0]}` : `åk ${list.slice(0, -1).join(', ')} och ${list[list.length - 1]}`;
};

export function describeStageVerdict(verdict: StageVerdict, subjectNames: ReadonlyMap<string, string>): string {
  const p = verdict.params;
  const stage = verdict.stage ? STAGE_SV[verdict.stage] : '';
  const subject = verdict.subjectCode ? (subjectNames.get(verdict.subjectCode) ?? verdict.subjectCode) : '';
  switch (verdict.code) {
    case 'TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL':
    case 'TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL': {
      const what = verdict.code === 'TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL' ? 'har planerat' : 'beräknas få';
      const within = Number(p.withinCap) === 1
        ? ` Det ryms inom ${p.capPercent} % och kan vara skolans val.`
        : '';
      return (
        `En elev ${what} ${h(p.hours)} ${subject} i ${stage}, ${h(p.shortfallHours)} under timplanens ${h(p.nationalHours)} ` +
        `(enligt referensdata, ${p.versionCode}).${within}`
      );
    }
    case 'TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET':
      return (
        `En elev har planerat ${h(p.plannedHours)} ${subjectNames.get(String(p.childCode)) ?? p.childCode} i ${stage}, ` +
        `${h(p.shortfallHours)} under minsta tiden ${h(p.minimumHours)} inom ${subject}.`
      );
    case 'TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED': {
      const parts = [
        p.unrecordedGrades ? `${grades(p.unrecordedGrades)} saknar klasshistorik` : null,
        p.partlyRecordedGrades ? `${grades(p.partlyRecordedGrades)} är bara delvis registrerad` : null,
        p.unplannedGrades ? `${grades(p.unplannedGrades)} har ingen timplan ännu` : null,
        Number(p.classDeleted) === 1 ? 'en klass eleven gick i har tagits bort' : null,
      ].filter((part): part is string => part !== null);
      return (
        `${stage.charAt(0).toUpperCase()}${stage.slice(1)} är inte registrerat i sin helhet: ${parts.join(', ')}. ` +
        `Timmarna visas som registrerat sedan ${p.recordedFrom || 'okänt datum'} och jämförs inte med timplanen.`
      );
    }
    case 'TIMPLAN_PUPIL_STAGE_BACKFILLED':
      return (
        `Klassen före ${p.recordedFrom} är enligt läget när klasshistoriken började föras; ` +
        'en flytt före dess syns inte.'
      );
    case 'TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE':
      return `Den timplan som gäller för ${stage} för den här eleven är äldre än SchemaPros referensdata, så ingen nationell jämförelse görs.`;
    case 'TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED':
      return (
        `Enligt referensdata (${p.versionCode}) är totalen ${h(p.totalHours)}, men fördelningen på ämnen är inte publicerad; ` +
        `${stage} jämförs därför inte ämne för ämne.`
      );
    case 'TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED':
      return (
        `Från hösten 2028 jämförs ${stage} med ${p.versionCode} enligt referensdata; fördelningen för äldre årskullar ` +
        'efter 2028 är inte publicerad (SFS 2025:729 behåller bara totalen).'
      );
    case 'TIMPLAN_PUPIL_STAGE_FORM_CHANGED':
      return `Stadiets läsår följer timplaner för olika skolformer; jämförelsen görs med den senaste.`;
    case 'TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN':
      return `Klassen eleven gick i läsåret som började ${p.yearStartHT} har ingen årskurs, så året räknas inte till något stadium.`;
    case 'TIMPLAN_PUPIL_STAGE_GRADE_REPEATED':
      return `Eleven har gått åk ${p.gradeLevel} två gånger; båda läsåren räknas.`;
    case 'TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS':
      return (
        `Läsåret som började ${p.yearStartHT} hade eleven en undervisningsgrupp i stället för en klass som hemgrupp; ` +
        'de dagarna räknas som oregistrerade, inte som noll timmar.'
      );
    case 'TIMPLAN_PUPIL_STAGE_PRESCHOOL_AFTER_2028':
      return `En klass med årskurs 0 läsåret som började ${p.yearStartHT}: förskoleklassen upphör 2028, så året räknas inte.`;
    case 'TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED':
      return `Inget av elevens ämnen i ${stage} har en nationell ämneskod (${h(p.plannedHours)} planerat), så ingen nationell jämförelse görs.`;
  }
}
