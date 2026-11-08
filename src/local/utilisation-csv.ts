import { serializeCsv } from '../school-export/csv-writer';
import type { UtilisationBucket, UtilisationResponse } from './local-types';

/*
 * The utilisation report as the school's CSV dialect (school-export/csv-writer.ts:
 * `;`, CRLF, a BOM, a cell that would be a formula made text): one line for each
 * room or resource over the whole period and one for each week of it. A share is
 * a percentage with a decimal comma, empty where there is no time to divide by.
 * The headers are the school's Swedish, without letters outside ASCII, as the
 * importable lists have them.
 */

export const UTILISATION_HEADERS = [
  'typ',
  'namn',
  'vecka',
  'skoltid_minuter',
  'bokat_skoltid_minuter',
  'andel_skoltid_procent',
  'utanfor_skoltid_minuter',
  'bokat_utanfor_skoltid_minuter',
  'andel_utanfor_skoltid_procent',
] as const;

const KIND: Record<'ROOM' | 'RESOURCE', string> = { ROOM: 'Sal', RESOURCE: 'Resurs' };

/** 0.1234 as "12,3". */
export function percentCell(share: number | null): string {
  return share === null ? '' : (Math.round(share * 1000) / 10).toFixed(1).replace('.', ',');
}

function cells(kind: string, name: string, week: string, bucket: UtilisationBucket): string[] {
  return [
    kind,
    name,
    week,
    String(bucket.schoolMinutes),
    String(bucket.bookedSchoolMinutes),
    percentCell(bucket.schoolShare),
    String(bucket.outsideMinutes),
    String(bucket.bookedOutsideMinutes),
    percentCell(bucket.outsideShare),
  ];
}

export function utilisationCsv(report: UtilisationResponse): string {
  const rows: string[][] = [];
  for (const row of report.rows) {
    rows.push(cells(KIND[row.kind], row.name, 'Hela perioden', row.total));
    for (const week of row.weeks) rows.push(cells(KIND[row.kind], row.name, week.weekStart, week));
  }
  return serializeCsv(UTILISATION_HEADERS, rows);
}

export function utilisationFilename(report: Pick<UtilisationResponse, 'from' | 'to'>): string {
  return `utnyttjande-${report.from}-${report.to}.csv`;
}
