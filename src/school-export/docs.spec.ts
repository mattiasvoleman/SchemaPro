import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_FILES } from './data-files';
import { READ_BACK_ORDER, formatDocument, readmeText } from './docs';
import { CSV_TEMPLATES } from './csv-files';
import { tableFiles } from './person-tables';

/**
 * The format document is generated from the column lists the files are written
 * from, and docs/school-export-format.md is the same text, so a column cannot
 * be added without its line and the repository's copy cannot go stale.
 * Regenerate after a change:  UPDATE_SCHOOL_EXPORT_FORMAT=1 npx jest src/school-export/docs.spec.ts
 */
const COMMITTED = join(__dirname, '..', '..', 'docs', 'school-export-format.md');

describe('the format document', () => {
  it('is the committed docs/school-export-format.md', () => {
    const fresh = formatDocument(DATA_FILES, tableFiles());
    if (process.env['UPDATE_SCHOOL_EXPORT_FORMAT'] === '1') writeFileSync(COMMITTED, fresh);
    expect(readFileSync(COMMITTED, 'utf8')).toBe(fresh);
  });

  it('names every column of every data file, and every list file with its header', () => {
    const text = formatDocument(DATA_FILES, []);
    for (const file of DATA_FILES) for (const column of file.columns) expect(text).toContain(`| \`${column.name}\` |`);
    for (const file of Object.values(CSV_TEMPLATES)) expect(text).toContain(`\`${file.filename}\``);
  });
});

describe('the format document and the hirer of an external booking (Lokal)', () => {
  it('says that the hirer’s name and contact are written (dold) in ExternalBookings, and that the registrar stays', () => {
    const text = formatDocument(DATA_FILES, tableFiles());

    expect(text).toContain('och det gör också namnet och kontaktuppgifterna hos en extern hyrande i `ExternalBookings`');
    expect(text).toContain('kvar står att personen registrerat serien');
    expect(text).toMatch(/Tabellerna: .*`ExternalBookings`/);
  });

  it('writes nothing of the person tables for an extract that has none', () => {
    expect(formatDocument(DATA_FILES, [])).not.toContain('ExternalBookings');
  });
});

describe('the README', () => {
  const at = new Date('2026-11-05T12:00:00.000Z');

  it('says how many protected persons are left out, in the singular and the plural, and none when none', () => {
    expect(readmeText({ schoolName: 'S', createdAt: at, kind: 'school', markedPeople: 0 })).toContain('inte markerat någon person');
    expect(readmeText({ schoolName: 'S', createdAt: at, kind: 'school', markedPeople: 1 })).toContain('1 person med skyddad identitet finns inte i filen');
    expect(readmeText({ schoolName: 'S', createdAt: at, kind: 'school', markedPeople: 3 })).toContain('3 personer med skyddad identitet finns inte i filen');
  });

  it('lists the lists in the order they read back in, names what the file leaves out, and the three days', () => {
    const text = readmeText({ schoolName: 'Provskolan', createdAt: at, kind: 'school', markedPeople: 0 });
    const positions = READ_BACK_ORDER.map((file) => text.indexOf(`csv/${file}`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('Personnummer. Rastra lagrar inga.');
    expect(text).toContain('72 timmar');
    expect(text).toContain('Provskolan');
    expect(text).toContain('\r\n');
  });

  it('is a registerutdrag\'s own: no lists to read back, and what no administrator can read', () => {
    const text = readmeText({ schoolName: 'S', createdAt: at, kind: 'person', markedPeople: 0 });
    expect(text).toContain('registerutdrag (GDPR artikel 15)');
    expect(text).not.toContain('Läs in listorna igen');
    expect(text).toContain('Enheter som tar emot push-notiser');
    expect(text).not.toContain('72 timmar');
  });
});
