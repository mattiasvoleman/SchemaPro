// `@Type(() => …)` on the entries reads design-time metadata; without this the
// module cannot even be loaded.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CopyLocalTimplanDto,
  CreateLocalTimplanDto,
  DecideLocalTimplanDto,
  ReplaceLocalTimplanEntriesDto,
  UpdateLocalTimplanDto,
} from './local-timplan.dto';

const VERSION_ID = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';

/** The properties that failed validation, nested ones as `entries.N.field`. */
const failing = async (cls: new () => object, body: object): Promise<string[]> => {
  const errors = await validate(plainToInstance(cls, body));
  const flatten = (
    list: { property: string; children?: unknown[]; constraints?: unknown }[],
    prefix: string,
  ): string[] =>
    list.flatMap((error) => {
      const name = `${prefix}${error.property}`;
      const nested = (error.children ?? []) as typeof list;
      return nested.length > 0 && !error.constraints ? flatten(nested, `${name}.`) : [name];
    });
  return flatten(errors as never, '');
};

const messagesOf = async (cls: new () => object, body: object): Promise<string> =>
  JSON.stringify(await validate(plainToInstance(cls, body)));

const plan = (overrides: object = {}) => ({
  name: 'Grundskolan 2024',
  schoolForm: 'GRUNDSKOLA',
  nationalTimplanVersionId: VERSION_ID,
  ...overrides,
});

const cell = (overrides: object = {}) => ({
  subjectId: SUBJECT_ID,
  gradeLevel: 4,
  minutesPerWeek: 180,
  ...overrides,
});

describe('CreateLocalTimplanDto mirrors LocalTimplans’ CHECKs', () => {
  it('accepts a plan with and without weeks', async () => {
    await expect(failing(CreateLocalTimplanDto, plan())).resolves.toEqual([]);
    await expect(failing(CreateLocalTimplanDto, plan({ planningWeeks: 35.6 }))).resolves.toEqual([]);
  });

  it('holds the weeks to 20.0..40.0 with one decimal, as NUMERIC(4,1) does', async () => {
    for (const ok of [20, 20.0, 35.6, 40]) {
      await expect(failing(CreateLocalTimplanDto, plan({ planningWeeks: ok }))).resolves.toEqual([]);
    }
    // null on a create is the default, like an absent field; the service writes 35.6.
    for (const bad of [19.9, 40.1, 35.65, '35.6', Number.NaN]) {
      await expect(failing(CreateLocalTimplanDto, plan({ planningWeeks: bad }))).resolves.toEqual([
        'planningWeeks',
      ]);
    }
    await expect(messagesOf(CreateLocalTimplanDto, plan({ planningWeeks: 41 }))).resolves.toContain(
      'högst 40,0 veckor',
    );
  });

  it('refuses a blank or over-long name, naming the field', async () => {
    for (const bad of ['', '   ', 'x'.repeat(101), 7]) {
      await expect(failing(CreateLocalTimplanDto, plan({ name: bad }))).resolves.toEqual(['name']);
    }
    await expect(failing(CreateLocalTimplanDto, plan({ name: 'x'.repeat(100) }))).resolves.toEqual([]);
  });

  it('refuses a school form the enum does not have, and a version that is not an id', async () => {
    await expect(failing(CreateLocalTimplanDto, plan({ schoolForm: 'GYMNASIUM' }))).resolves.toEqual([
      'schoolForm',
    ]);
    await expect(
      failing(CreateLocalTimplanDto, plan({ nationalTimplanVersionId: 'SFS2023:945/B1' })),
    ).resolves.toEqual(['nationalTimplanVersionId']);
  });
});

describe('UpdateLocalTimplanDto', () => {
  it('accepts any subset, and an empty body', async () => {
    await expect(failing(UpdateLocalTimplanDto, {})).resolves.toEqual([]);
    await expect(failing(UpdateLocalTimplanDto, { planningWeeks: 36 })).resolves.toEqual([]);
  });

  it('refuses null on the three NOT NULL columns rather than waving it past', async () => {
    await expect(
      failing(UpdateLocalTimplanDto, { name: null, planningWeeks: null, nationalTimplanVersionId: null }),
    ).resolves.toEqual(['name', 'planningWeeks', 'nationalTimplanVersionId']);
  });

  it('has no schoolForm: changing the form is a new plan, and the pipe refuses the field', async () => {
    const errors = await validate(plainToInstance(UpdateLocalTimplanDto, { schoolForm: 'SAMESKOLA' }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(['schoolForm']);
  });
});

describe('ReplaceLocalTimplanEntriesDto mirrors LocalTimplanEntries’ CHECKs', () => {
  it('accepts 0 minutes, F-klass, åk 10 and an empty list', async () => {
    await expect(
      failing(ReplaceLocalTimplanEntriesDto, {
        entries: [cell({ minutesPerWeek: 0 }), cell({ gradeLevel: 0 }), cell({ gradeLevel: 10, minutesPerWeek: 1200 })],
      }),
    ).resolves.toEqual([]);
    await expect(failing(ReplaceLocalTimplanEntriesDto, { entries: [] })).resolves.toEqual([]);
  });

  it('accepts minutes off the five-minute grid — a target is not a lesson', async () => {
    await expect(
      failing(ReplaceLocalTimplanEntriesDto, { entries: [cell({ minutesPerWeek: 177 })] }),
    ).resolves.toEqual([]);
  });

  it('refuses each bound by field and row', async () => {
    await expect(
      failing(ReplaceLocalTimplanEntriesDto, {
        entries: [
          cell({ gradeLevel: 11 }),
          cell({ gradeLevel: -1 }),
          cell({ minutesPerWeek: 1201 }),
          cell({ minutesPerWeek: 12.5 }),
          cell({ note: 'n'.repeat(501) }),
          cell({ subjectId: 'MA' }),
        ],
      }),
    ).resolves.toEqual([
      'entries.0.gradeLevel',
      'entries.1.gradeLevel',
      'entries.2.minutesPerWeek',
      'entries.3.minutesPerWeek',
      'entries.4.note',
      'entries.5.subjectId',
    ]);
  });

  it('caps the list at 400 rows', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => cell({ gradeLevel: i % 11 }));
    await expect(failing(ReplaceLocalTimplanEntriesDto, { entries: rows(400) })).resolves.toEqual([]);
    await expect(failing(ReplaceLocalTimplanEntriesDto, { entries: rows(401) })).resolves.toEqual(['entries']);
  });
});

describe('DecideLocalTimplanDto and CopyLocalTimplanDto', () => {
  it('requires a non-blank note of at most 500 characters', async () => {
    await expect(failing(DecideLocalTimplanDto, { decisionNote: 'dnr 2026/17' })).resolves.toEqual([]);
    for (const bad of [undefined, '', '  ', 'x'.repeat(501)]) {
      await expect(failing(DecideLocalTimplanDto, { decisionNote: bad })).resolves.toEqual(['decisionNote']);
    }
  });

  it('lets a copy go unnamed, and refuses a blank name', async () => {
    await expect(failing(CopyLocalTimplanDto, {})).resolves.toEqual([]);
    await expect(failing(CopyLocalTimplanDto, { name: ' ' })).resolves.toEqual(['name']);
  });
});

describe('the DTOs count what the CHECKs count, and refuse what the service cannot read', () => {
  // U+FE0F after a letter: validator's isLength subtracts the selector,
  // PostgreSQL's char_length counts it. 100 of them is 200 code points.
  const selected = (n: number) => 'a\uFE0F'.repeat(n);

  it('measures a name, a decision note and an entry note in code points, as char_length does', async () => {
    await expect(failing(CreateLocalTimplanDto, plan({ name: selected(50) }))).resolves.toEqual([]);
    await expect(failing(CreateLocalTimplanDto, plan({ name: selected(51) }))).resolves.toEqual(['name']);
    await expect(failing(UpdateLocalTimplanDto, { name: selected(51) })).resolves.toEqual(['name']);
    await expect(failing(CopyLocalTimplanDto, { name: selected(51) })).resolves.toEqual(['name']);
    await expect(failing(DecideLocalTimplanDto, { decisionNote: selected(251) })).resolves.toEqual([
      'decisionNote',
    ]);
    await expect(
      failing(ReplaceLocalTimplanEntriesDto, { entries: [cell({ note: selected(251) })] }),
    ).resolves.toEqual(['entries.0.note']);
    // An astral character is one code point, as it is to the column.
    await expect(failing(CreateLocalTimplanDto, plan({ name: '\u{1F4DA}'.repeat(100) }))).resolves.toEqual([]);
  });

  it('refuses a list of lists instead of descending into it', async () => {
    await expect(failing(ReplaceLocalTimplanEntriesDto, { entries: [[cell()]] })).resolves.toEqual(['entries']);
    const wrapped = [Array.from({ length: 401 }, (_, i) => cell({ gradeLevel: i % 11 }))];
    await expect(failing(ReplaceLocalTimplanEntriesDto, { entries: wrapped })).resolves.toEqual(['entries']);
  });

  it('reads a subject id in capitals as the same id', async () => {
    const lower = 'abcdef12-3456-4789-8abc-def012345678';
    const dto = plainToInstance(ReplaceLocalTimplanEntriesDto, {
      entries: [cell({ subjectId: lower.toUpperCase() })],
    });
    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.entries[0]!.subjectId).toBe(lower);
  });
});
