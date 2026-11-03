import type { TimplanVerdict } from '../common/timplan-coverage';
import { describeVerdict } from './timplan-verdict-messages';

const NAMES = new Map([
  ['MA', 'Matematik'],
  ['NO', 'Naturorienterande ämnen'],
  ['KE', 'Kemi'],
  ['BL', 'Bild'],
]);

const ONE_OF_EACH: TimplanVerdict[] = [
  { code: 'TIMPLAN_NATIONAL_DISTRIBUTION_UNPUBLISHED', severity: 'notice', params: { versionCode: 'SFS2025:729', totalHours: 7424 } },
  { code: 'TIMPLAN_SUBJECT_UNMAPPED', severity: 'notice', params: { subjectId: 's', subjectName: 'Programmering', plannedHours: 53.4 } },
  { code: 'TIMPLAN_PROTECTED_SUBJECT_REDUCED', severity: 'warning', subjectCode: 'MA', stage: 'LAG', params: { nationalHours: 420, plannedHours: 419.4, deficitHours: 0.6, reducedPercent: 0.2 } },
  { code: 'TIMPLAN_REDUCTION_OVER_CAP', severity: 'warning', subjectCode: 'BL', stage: 'LAG', params: { nationalHours: 60, plannedHours: 47.3, deficitHours: 12.7, reducedPercent: 21.2, capPercent: 20 } },
  { code: 'TIMPLAN_GROUP_MINIMUM_UNMET', severity: 'warning', subjectCode: 'NO', stage: 'MELLAN', childCode: 'KE', params: { childCode: 'KE', minimumHours: 60, plannedHours: 50, deficitHours: 10 } },
  { code: 'TIMPLAN_STAGE_BELOW_NATIONAL', severity: 'notice', subjectCode: 'BL', stage: 'LAG_MELLAN', params: { nationalHours: 60, plannedHours: 48, deficitHours: 12, reducedPercent: 20 } },
  { code: 'TIMPLAN_SKOLANS_VAL_OVERSPENT', severity: 'warning', params: { takenHours: 600.5, availableHours: 600, overspentHours: 0.5 } },
  { code: 'TIMPLAN_TOTAL_BELOW_GUARANTEE', severity: 'warning', params: { plannedHours: 6889.5, guaranteedHours: 6890, deficitHours: 0.5 } },
  { code: 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE', severity: 'notice', subjectCode: 'MA', stage: 'MELLAN', params: { nationalHours: 273.3, plannedHours: 250, deficitHours: 23.3, reducedPercent: 8.6, heldGrades: 2, ofGrades: 3 } },
  { code: 'TIMPLAN_PARTIAL_STAGE_BELOW_SHARE', severity: 'notice', subjectCode: 'NO', stage: 'MELLAN', childCode: 'KE', params: { childCode: 'KE', minimumHours: 40, plannedHours: 30, deficitHours: 10, heldGrades: 2, ofGrades: 3 } },
  { code: 'TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN', severity: 'notice', params: { totalHours: 7424, gradeFrom: 4, gradeTo: 10 } },
];

describe('describeVerdict', () => {
  it('has a sentence for every code, in Swedish with a decimal comma', () => {
    const sentences = ONE_OF_EACH.map((verdict) => describeVerdict(verdict, NAMES));
    expect(sentences).toEqual([
      'Fördelningen mellan ämnen och stadier för SFS2025:729 är inte publicerad ännu. Planen jämförs bara mot den garanterade totalen 7 424 h, inte ämne för ämne.',
      'Programmering har ingen nationell ämneskod, och dess 53,4 h räknas som skolans val. Ange en ämneskod om ämnet hör till timplanen, eller markera att det inte räknas som undervisningstid.',
      'Matematik i lågstadiet: 419,4 h planerat, 0,6 h under målet 420 h. Ämnet får inte minskas för skolans val.',
      'Bild i lågstadiet: 47,3 h planerat, 21,2 % under målet 60 h. Skolans val får minska ett ämne med högst 20 % per stadium.',
      'Kemi i mellanstadiet: 50 h planerat, under minsta tiden 60 h inom naturorienterande ämnen.',
      'Bild i låg- och mellanstadiet: 48 h planerat, 12 h (20 %) under målet 60 h. Tiden räknas mot skolans val.',
      'Skolans val: 600,5 h har tagits från ämnena, 0,5 h mer än de 600 h timplanen medger.',
      'Totalt 6 889,5 h planerat, 0,5 h under den garanterade undervisningstiden 6 890 h.',
      'Matematik i mellanstadiet: skolan har 2 av 3 årskurser i stadiet. 250 h planerat, 23,3 h (8,6 %) under andelen 273,3 h av stadiets timmar. ' +
        'Andelen är en uppskattning, eftersom huvudmannen fördelar tiden fritt mellan årskurserna.',
      'Kemi i mellanstadiet: skolan har 2 av 3 årskurser i stadiet. 30 h planerat, under andelen 40 h av minsta tiden inom naturorienterande ämnen. Andelen är en uppskattning.',
      'Planen gäller årskurs 4–10, och den garanterade totalen 7 424 h gäller hela skolformen. Totalen jämförs därför inte.',
    ]);
  });

  it('says "under mål", never "fel" — every verdict is a warning the law lets a school stand behind', () => {
    for (const verdict of ONE_OF_EACH) {
      expect(describeVerdict(verdict, NAMES)).not.toMatch(/\bfel/i);
    }
  });

  it('claims skolans val only where the bilaga prints one', () => {
    // Ämnesområden (B2B) and the unpublished 2028 law print no pool: a reduced
    // cell's time goes nowhere a sentence may name, and an own subject is the
    // school's own time, or belongs in "Fördelningsbar undervisningstid".
    const below = ONE_OF_EACH[5]!;
    const unmapped = ONE_OF_EACH[1]!;
    const said = (verdict: TimplanVerdict, timeCountsAs: string) =>
      describeVerdict({ ...verdict, params: { ...verdict.params, timeCountsAs } }, NAMES);

    expect(said(below, 'skolansVal')).toMatch(/Tiden räknas mot skolans val\.$/);
    expect(said(below, 'none')).toBe('Bild i låg- och mellanstadiet: 48 h planerat, 12 h (20 %) under målet 60 h.');
    expect(said(unmapped, 'own')).toBe(
      'Programmering har ingen nationell ämneskod, och dess 53,4 h räknas som skolans egen tid. ' +
        'Ange en ämneskod om ämnet hör till timplanen, eller markera att det inte räknas som undervisningstid.',
    );
    expect(said(unmapped, 'fordelningsbar')).toBe(
      'Programmering har ingen nationell ämneskod, och dess 53,4 h räknas som skolans egen tid. ' +
        'Hör ämnet till den fördelningsbara undervisningstiden, ange koden för Fördelningsbar undervisningstid; ' +
        'annars en ämneskod, eller markera att det inte räknas som undervisningstid.',
    );
    for (const value of ['none', 'own', 'fordelningsbar']) {
      expect(said(unmapped, value)).not.toContain('skolans val');
      expect(said(below, value)).not.toContain('skolans val');
    }
  });

  it('calls a pool and a guarantee derived from a span an estimate, and a whole form not', () => {
    const overspent = ONE_OF_EACH[6]!;
    const guarantee = ONE_OF_EACH[7]!;
    const estimated = (verdict: TimplanVerdict) =>
      describeVerdict({ ...verdict, params: { ...verdict.params, estimated: 1 } }, NAMES);

    expect(estimated(overspent)).toBe(
      'Skolans val: 600,5 h har tagits från ämnena, 0,5 h mer än de 600 h timplanen medger (en uppskattning efter planens årskurser).',
    );
    expect(estimated(guarantee)).toBe(
      'Totalt 6 889,5 h planerat, 0,5 h under den garanterade undervisningstiden 6 890 h (en uppskattning efter planens årskurser).',
    );
    expect(describeVerdict(overspent, NAMES)).not.toContain('uppskattning');
    expect(describeVerdict(guarantee, NAMES)).not.toContain('uppskattning');
  });

  it('says why a pool or a total is only a notice when the partly held stadier are what breach it', () => {
    const overspent = ONE_OF_EACH[6]!;
    const guarantee = ONE_OF_EACH[7]!;
    const fromShares = (verdict: TimplanVerdict) =>
      describeVerdict({ ...verdict, severity: 'notice', params: { ...verdict.params, estimated: 1, fromShares: 1 } }, NAMES);

    for (const sentence of [fromShares(overspent), fromShares(guarantee)]) {
      expect(sentence).toMatch(/ Det ligger helt i stadier som skolan bara har delvis, där andelen är en uppskattning, och är därför bara en notis\.$/);
      expect(sentence).not.toMatch(/\bfel/i);
    }
    expect(fromShares(overspent)).toContain('timplanen medger (en uppskattning efter planens årskurser). Det ligger');
    // The sentence of a warning never carries it.
    expect(describeVerdict({ ...overspent, params: { ...overspent.params, estimated: 1 } }, NAMES)).not.toContain('notis');
  });

  it('falls back to the code for a subject it has no name for', () => {
    expect(
      describeVerdict({ ...ONE_OF_EACH[2]!, subjectCode: 'TSP' }, NAMES),
    ).toMatch(/^TSP i lågstadiet/);
  });
});
