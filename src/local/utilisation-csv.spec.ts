import { percentCell, UTILISATION_HEADERS, utilisationCsv, utilisationFilename } from './utilisation-csv';
import type { UtilisationBucket, UtilisationResponse } from './local-types';

const bucket = (over: Partial<UtilisationBucket> = {}): UtilisationBucket => ({
  schoolMinutes: 2400,
  bookedSchoolMinutes: 600,
  schoolShare: 0.25,
  outsideMinutes: 2100,
  bookedOutsideMinutes: 105,
  outsideShare: 0.05,
  ...over,
});

const report = (): UtilisationResponse => ({
  from: '2027-02-01',
  to: '2027-02-07',
  timezone: 'Europe/Stockholm',
  openFrom: '07:00',
  openTo: '22:00',
  framesMissing: false,
  weekStarts: ['2027-02-01'],
  rows: [
    { kind: 'ROOM', id: 'r1', name: 'Idrottshallen', unit: 'MINUTES', total: bucket(), weeks: [{ weekStart: '2027-02-01', ...bucket() }] },
    { kind: 'RESOURCE', id: 'x1', name: '=Surfplattor', unit: 'UNIT_MINUTES', total: bucket({ schoolShare: null, schoolMinutes: 0 }), weeks: [] },
  ],
});

describe('the utilisation CSV', () => {
  it('writes a share as a percentage with a decimal comma', () => {
    expect(percentCell(0.25)).toBe('25,0');
    expect(percentCell(0.12345)).toBe('12,3');
    expect(percentCell(0)).toBe('0,0');
    expect(percentCell(null)).toBe('');
  });

  it('writes the whole period and each week of every room and resource, in the school dialect', () => {
    const lines = utilisationCsv(report()).split('\r\n');
    expect(lines[0]).toBe('﻿' + UTILISATION_HEADERS.join(';'));
    expect(lines[1]).toBe('Sal;Idrottshallen;Hela perioden;2400;600;25,0;2100;105;5,0');
    expect(lines[2]).toBe('Sal;Idrottshallen;2027-02-01;2400;600;25,0;2100;105;5,0');
    // A name that would be a formula is made text; an empty share is an empty cell.
    expect(lines[3]).toBe("Resurs;'=Surfplattor;Hela perioden;0;600;;2100;105;5,0");
    expect(lines[4]).toBe('');
    expect(lines).toHaveLength(5);
  });

  it('names the file by its period', () => {
    expect(utilisationFilename(report())).toBe('utnyttjande-2027-02-01-2027-02-07.csv');
  });
});
