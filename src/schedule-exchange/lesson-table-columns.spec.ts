import fixture from './__fixtures__/lesson-table-columns.json';
import { LESSON_TABLE_COLUMNS, LESSON_TABLE_HEADER, LESSON_TABLE_HEADER_EN } from './lesson-table';

/**
 * The flat table's columns, as the web's mapping catalogue copies them (Kolumnmappning, X2).
 *
 * A foreign table is mapped to these in the browser and written back under the Swedish headers, so that the reader below
 * reads it as it reads its own export. The web's list (web/lib/column-fields.ts, scheduleLessons) is held to this fixture
 * by web/lib/column-fields.test.ts; this side proves the fixture says what lesson-table.ts says. Regenerate the fixture
 * from LESSON_TABLE_COLUMNS when a column or a spelling is added, and never edit it by hand.
 */
describe('the flat table\'s columns the web copies', () => {
  it('are what the fixture says, column by column and spelling by spelling', () => {
    expect({ columns: LESSON_TABLE_COLUMNS }).toEqual(fixture);
  });

  it('write the same Swedish and English header rows as the writer and the reader know', () => {
    expect(LESSON_TABLE_COLUMNS.map((column) => column.sv)).toEqual([...LESSON_TABLE_HEADER]);
    expect(LESSON_TABLE_COLUMNS.map((column) => column.en)).toEqual([...LESSON_TABLE_HEADER_EN]);
  });

  it('have 28 columns with a key each, and no key twice', () => {
    expect(LESSON_TABLE_COLUMNS).toHaveLength(28);
    expect(new Set(LESSON_TABLE_COLUMNS.map((column) => column.key)).size).toBe(28);
  });
});
