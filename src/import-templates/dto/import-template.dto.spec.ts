// `@Type(() => …)` on the placements reads design-time metadata.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateImportTemplateDto, ListImportTemplatesQueryDto, UpdateImportTemplateDto } from './import-template.dto';

/** The properties that failed validation, nested ones as `placements.N.field`. */
const failing = async (cls: new () => object, body: object): Promise<string[]> => {
  const flatten = (list: { property: string; children?: unknown[]; constraints?: unknown }[], prefix: string): string[] =>
    list.flatMap((error) => {
      const name = `${prefix}${error.property}`;
      const nested = (error.children ?? []) as typeof list;
      return nested.length > 0 && !error.constraints ? flatten(nested, `${name}.`) : [name];
    });
  return flatten((await validate(plainToInstance(cls, body))) as never, '');
};

const post = { key: 'grupp', label: 'Grupp', field: 'groupName' };
const create = { kind: 'requirements', name: 'Höst', placements: [post] };

describe('CreateImportTemplateDto', () => {
  it('accepts a template with a kind, a name and posts, and a null or numbered header row', async () => {
    await expect(failing(CreateImportTemplateDto, create)).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, headerRow: null })).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, headerRow: 20 })).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [] })).resolves.toEqual([]);
  });

  it('refuses a kind that is none of the thirteen', async () => {
    await expect(failing(CreateImportTemplateDto, { ...create, kind: 'untis' })).resolves.toEqual(['kind']);
    await expect(failing(CreateImportTemplateDto, { name: 'x', placements: [] })).resolves.toEqual(['kind']);
  });

  it('holds the header row to 1..20 and a whole number', async () => {
    for (const headerRow of [0, 21, 1.5, '3']) {
      await expect(failing(CreateImportTemplateDto, { ...create, headerRow })).resolves.toEqual(['headerRow']);
    }
  });

  it('holds the posts to a normalised key, a label of at most 120 characters and a field that is a name or null', async () => {
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, key: 'Grupp' }] })).resolves.toEqual(['placements.0.key']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, key: 'grupp#2' }, { ...post, key: 'kolumn3', field: null }] })).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, key: '' }] })).resolves.toEqual(['placements.0.key']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, key: 'a'.repeat(101) }] })).resolves.toEqual(['placements.0.key']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, label: 'x'.repeat(121) }] })).resolves.toEqual(['placements.0.label']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, label: '' }] })).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, field: 'group name' }] })).resolves.toEqual(['placements.0.field']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, field: undefined }] })).resolves.toEqual(['placements.0.field']);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: [{ ...post, field: 7 }] })).resolves.toEqual(['placements.0.field']);
  });

  it('takes at most 200 posts', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: '', field: null }));
    await expect(failing(CreateImportTemplateDto, { ...create, placements: many(200) })).resolves.toEqual([]);
    await expect(failing(CreateImportTemplateDto, { ...create, placements: many(201) })).resolves.toEqual(['placements']);
  });
});

describe('UpdateImportTemplateDto', () => {
  it('takes any part of a template, or none', async () => {
    await expect(failing(UpdateImportTemplateDto, {})).resolves.toEqual([]);
    await expect(failing(UpdateImportTemplateDto, { name: 'Ny', headerRow: null, placements: [post] })).resolves.toEqual([]);
  });

  it('has no kind: a mapping stays with the fields of the kind it was made for, and the pipe refuses one', async () => {
    // The app's ValidationPipe runs with whitelist and forbidNonWhitelisted (src/main.ts).
    const errors = await validate(plainToInstance(UpdateImportTemplateDto, { kind: 'rooms', name: 'Ny' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(['kind']);
  });

  it('refuses an empty name, which the service would refuse as well', async () => {
    await expect(failing(UpdateImportTemplateDto, { name: '' })).resolves.toEqual(['name']);
  });
});

describe('ListImportTemplatesQueryDto', () => {
  it('takes no kind, or one of the thirteen', async () => {
    await expect(failing(ListImportTemplatesQueryDto, {})).resolves.toEqual([]);
    await expect(failing(ListImportTemplatesQueryDto, { kind: 'rooms' })).resolves.toEqual([]);
    await expect(failing(ListImportTemplatesQueryDto, { kind: 'nope' })).resolves.toEqual(['kind']);
  });
});
