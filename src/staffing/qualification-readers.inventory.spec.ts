import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * WHO READS A BEHÖRIGHET, AND WHETHER THEY READ THE DERIVED ROWS.
 *
 * A subject may use another's behörighet since migration 20270225090000
 * ("SO WS" -> "SO", Subjects."qualificationSubjectId"): the rows a teacher
 * holds in SO count for SO WS too, and the one reader that adds them is
 * readHeldQualifications (qualification-inheritance.ts). The model is additive
 * on purpose, and that is also its risk: a reader of the table nobody moved
 * silently judges "who is qualified" by the stored rows alone, and the school
 * that made SO WS sees the staffing report flag every SO teacher, the proposal
 * offer nobody and the substitute picker rank nobody — in one screen and not
 * another, with nothing failing. So this spec reads src/ (not the specs) and
 * fails on
 *
 *  1. a file that reads the table — a model delegate call that returns rows
 *     (findMany, findFirst, findUnique, groupBy, aggregate), raw SQL naming it,
 *     or a relation include of it — that nobody has classified below;
 *  2. a file classified THROUGH that does not import the reader, or that reads
 *     the delegate itself: it was classified as asking who is qualified, and
 *     that question has one reader;
 *  3. a file classified STORED that imports the reader: it was classified as
 *     listing, writing or counting the stored rows (the register extract, the
 *     school export, the person's own form, the import), where a derived row
 *     would be printed or written back as if a teacher held it twice;
 *  4. a classified file that no longer reads the table at all.
 *
 * `count` is not a read of the rows and is left out of 1: it asks only whether
 * anything is recorded, which a derived row cannot change (it needs a stored
 * one), and the picker's "recorded" test keeps it for that reason.
 *
 * The web half, for the screens that judge by the rows they fetch, is
 * web/lib/qualification-readers.inventory.test.ts.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

type Basis = 'READER' | 'THROUGH' | 'STORED';

const CLASSIFIED: Record<string, { basis: Basis; why: string }> = {
  'src/staffing/qualification-inheritance.ts': {
    basis: 'READER',
    why: 'the one reader that asks who is qualified: the stored rows and the derived ones',
  },
  'src/staffing/load-input.ts': {
    basis: 'THROUGH',
    why: 'the report, the staffing checks, the picker’s ranking and the proposal all read this input',
  },
  'src/staffing/staffing-enforcement.ts': {
    basis: 'THROUGH',
    why: 'the warning a hand edit or an assignment gets, which must agree with the report',
  },
  'src/year-rollover/rollover-source.ts': {
    basis: 'THROUGH',
    why: 'the rollover judges the successor year’s teachers as the report does',
  },
  'src/cover/cover-suggestions.service.ts': {
    basis: 'THROUGH',
    why: 'the cover board’s ranking of a day’s candidates',
  },
  'src/calendar/calendar-lessons.service.ts': {
    basis: 'THROUGH',
    why: 'the substitute picker of one lesson; its `count` only asks whether any behörighet is recorded',
  },
  'src/staffing/teacher-qualifications.service.ts': {
    basis: 'STORED',
    why: 'the list the form edits and saves whole; `?inherited=true` expands the stored rows with the same function, for the screens that judge',
  },
  'src/import/import.service.ts': {
    basis: 'STORED',
    why: 'the behörigheter import upserts the stored rows by teacher and subject',
  },
  'src/school-export/lists.ts': {
    basis: 'STORED',
    why: 'the school export lists what the table holds, so the file imports back to the same table',
  },
};

/** Files that name the table without reading it as rows to judge by (a key list, an area map, a comment). */
const NAMES_ONLY = new Set([
  'src/access-log/access-log.ts',
  'src/auth/admin-areas.ts',
  'src/common/removal-inventory.ts',
  'src/school-export/person-tables.ts',
  'src/school-export/csv-files.ts',
  'src/import-templates/import-fields.ts',
]);

const READS_ROWS =
  /teacherSubjectQualification\s*\.\s*(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|groupBy|aggregate)\b|(?:FROM|JOIN)\s+"TeacherSubjectQualifications"|\bteacherQualifications\s*:\s*\{/;
const IMPORTS_READER = /from\s+'[^']*qualification-inheritance'/;
const CALLS_READER = /\breadHeldQualifications\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

const FILES = sources(SRC).map((path) => ({
  path: relative(ROOT, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}));
const textOf = (path: string) => FILES.find((file) => file.path === path)?.text ?? '';

describe('who reads a behörighet', () => {
  it('has every reader of the table classified', () => {
    const unclassified = FILES.filter(
      (file) => READS_ROWS.test(file.text) && !(file.path in CLASSIFIED) && !NAMES_ONLY.has(file.path),
    ).map((file) => file.path);
    expect(unclassified).toEqual([]);
  });

  it('has THROUGH files that import the reader, call it, and never read the delegate themselves', () => {
    const through = Object.entries(CLASSIFIED).filter(([, { basis }]) => basis === 'THROUGH');
    expect(through.length).toBeGreaterThan(0);
    for (const [path] of through) {
      const text = textOf(path);
      expect({ path, imports: IMPORTS_READER.test(text) }).toEqual({ path, imports: true });
      expect({ path, calls: CALLS_READER.test(text) }).toEqual({ path, calls: true });
      expect({ path, readsDelegate: READS_ROWS.test(text) }).toEqual({ path, readsDelegate: false });
    }
  });

  it('has STORED files that read the table and never import the reader', () => {
    const stored = Object.entries(CLASSIFIED).filter(([, { basis }]) => basis === 'STORED');
    for (const [path] of stored) {
      const text = textOf(path);
      expect({ path, reads: READS_ROWS.test(text) }).toEqual({ path, reads: true });
      // The list endpoint expands the stored rows it has read with the pure function, not with the reader.
      expect({ path, importsReader: /\breadHeldQualifications\b/.test(text) }).toEqual({ path, importsReader: false });
    }
  });

  it('has no classified file that is gone or no longer names the table', () => {
    for (const [path, { basis }] of Object.entries(CLASSIFIED)) {
      expect({ path, exists: FILES.some((file) => file.path === path) }).toEqual({ path, exists: true });
      if (basis === 'THROUGH') continue;
      expect({ path, reads: READS_ROWS.test(textOf(path)) }).toEqual({ path, reads: true });
    }
    for (const path of NAMES_ONLY) {
      expect({ path, exists: FILES.some((file) => file.path === path) }).toEqual({ path, exists: true });
    }
  });

  it('keeps the read of the school’s own rows (the extract, the export) away from the derived ones', () => {
    // 3 above, said for the two the register and the export are built from.
    for (const path of ['src/school-export/lists.ts', 'src/school-export/person-tables.ts']) {
      expect({ path, derived: /expandInheritedQualifications|readHeldQualifications/.test(textOf(path)) }).toEqual({
        path,
        derived: false,
      });
    }
  });
});
