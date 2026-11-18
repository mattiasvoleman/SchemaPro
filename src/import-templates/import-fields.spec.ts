import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import fixture from './__fixtures__/import-fields.json';
import { REQUIREMENT_FILE_COLUMNS } from '../import/dto/import.dto';
import { IMPORT_TEMPLATE_CONFLICTS, IMPORT_TEMPLATE_FIELDS, IMPORT_TEMPLATE_KINDS, IMPORT_TEMPLATE_LIMIT } from './import-fields';

/**
 * The fields a template may name (Kolumnmappning, X2), held to three things that cannot see each other: the
 * fixture the web reads (web/lib/column-fields.test.ts), the CHECK of "ImportMappingTemplates" in its
 * migration, and the importers' own column names.
 *
 * The fixture is generated from import-fields.ts: change the list, then regenerate the fixture with
 *   npx ts-node --transpile-only <a script that writes {kinds, fields, conflicts, limit} to it>
 * (the shape is the object below), and never edit it by hand.
 */
describe('the import template fields', () => {
  it('are what the fixture the web reads says, kind by kind and field by field', () => {
    expect({
      kinds: IMPORT_TEMPLATE_KINDS,
      fields: IMPORT_TEMPLATE_FIELDS,
      conflicts: IMPORT_TEMPLATE_CONFLICTS,
      limit: IMPORT_TEMPLATE_LIMIT,
    }).toEqual(fixture);
  });

  it('name no field twice in a kind, and no kind without a field', () => {
    for (const kind of IMPORT_TEMPLATE_KINDS) {
      const fields: readonly string[] = IMPORT_TEMPLATE_FIELDS[kind];
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  it('hold only conflicts between two fields of the kind', () => {
    for (const [kind, pairs] of Object.entries(IMPORT_TEMPLATE_CONFLICTS)) {
      const fields: readonly string[] = IMPORT_TEMPLATE_FIELDS[kind as keyof typeof IMPORT_TEMPLATE_FIELDS];
      for (const [a, b] of pairs ?? []) {
        expect(fields).toContain(a);
        expect(fields).toContain(b);
      }
    }
  });

  it('are the kinds of the migration\'s CHECK, in its order', () => {
    const migrations = join(__dirname, '..', '..', 'prisma', 'migrations');
    const folder = readdirSync(migrations).find((name) => name.endsWith('_en_skola_sparar_kolumnmallar_for_sina_importer'));
    expect(folder).toBeDefined();
    const sql = readFileSync(join(migrations, folder!, 'migration.sql'), 'utf8');
    const check = /"ImportMappingTemplates_kind_check" CHECK \("kind" IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    const kinds = [...check![1]!.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual(IMPORT_TEMPLATE_KINDS);
  });

  it('give the requirements import every field of its row that names a teacher', () => {
    // The importer's own column list (ImportRequirementsDto.columns) and the template's fields are one vocabulary
    // for this kind, so a field a template can place is a column the import takes.
    expect(REQUIREMENT_FILE_COLUMNS.filter((column) => !(IMPORT_TEMPLATE_FIELDS.requirements as readonly string[]).includes(column))).toEqual([]);
    expect(IMPORT_TEMPLATE_FIELDS.requirements.filter((field) => !(REQUIREMENT_FILE_COLUMNS as readonly string[]).includes(field))).toEqual([]);
  });
});
