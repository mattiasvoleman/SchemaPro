// `@Type(() => …)` on the rows reads design-time metadata; without this the
// module cannot even be loaded. The sibling DTO specs get away without it
// because none of them nests.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ImportRequirementRowDto,
  ImportRequirementsDto,
  OPTIONAL_REQUIREMENT_COLUMNS,
  REQUIREMENT_FILE_COLUMNS,
} from './import.dto';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';

/**
 * A valid row; each case patches the one field it is about.
 *
 * `recurrence` is in here although it is not one of the four columns a file must
 * HAVE: the browser answers a missing veckor column with ALL_WEEKS before
 * posting, so a row always carries one. See REQUIREMENT_COLUMNS in web/lib/csv.ts.
 */
const base = {
  groupName: '7A',
  subject: 'IDH',
  lessonsPerWeek: 2,
  minutesPerLesson: 60,
  recurrence: 'ALL_WEEKS',
};

/** The properties that failed validation, as the ValidationPipe would find them. */
const failing = async (body: object) =>
  (await validate(plainToInstance(ImportRequirementRowDto, body))).map(
    (error) => error.property,
  );

/**
 * The timplan row, at the wire.
 *
 * These are the ombyte columns' half of the CSV round trip, and the reason the
 * round trip had to start in the API at all: the header set is validated with
 * `forbidNonWhitelisted`, so a column this DTO does not know is a 400 for the
 * whole upload no matter what the browser does with it.
 *
 * What an empty CELL becomes is not decided here. The browser parses the file
 * (web/lib/csv.ts) and this DTO validates typed fields, so "empty" reaches the
 * API as an omitted key or a null — never as `''`, which is refused below
 * exactly as `'20'` is on the two required numbers beside it. The 0 itself is
 * written by ImportService.importRequirements, whose spec pins it.
 */
describe('ImportRequirementRowDto', () => {
  it('accepts a row that states both buffers', async () => {
    await expect(
      failing({ ...base, minutesBefore: 10, minutesAfter: 20 }),
    ).resolves.toEqual([]);
  });

  it('accepts a row that states neither — a file without the columns at all', async () => {
    // The overwhelmingly common file, and every timplan a school wrote before
    // these two columns existed. Required columns would have made both a 400.
    await expect(failing({ ...base })).resolves.toEqual([]);
  });

  it.each([0, 60])('accepts %s minutes, the bounds the CHECK allows', async (minutes) => {
    await expect(
      failing({ ...base, minutesBefore: minutes, minutesAfter: minutes }),
    ).resolves.toEqual([]);
  });

  it.each<[string, object, string[]]>([
    ['past the hour the CHECK stops at', { minutesAfter: 61 }, ['minutesAfter']],
    ['a negative buffer', { minutesBefore: -1 }, ['minutesBefore']],
    ['half a minute', { minutesBefore: 10.5 }, ['minutesBefore']],
    // The same refusal the two required numbers give an unconverted cell: the
    // ValidationPipe runs with `enableImplicitConversion: false`, and the
    // browser is what turns a cell into a number. An empty cell included — it
    // arrives as an omitted key, not as ''.
    ['a cell that never became a number', { minutesAfter: '20' }, ['minutesAfter']],
    ['an empty cell passed through raw', { minutesBefore: '' }, ['minutesBefore']],
    // 1200 is the misreading the CHECK exists for: twenty hours, entered as if
    // the column took seconds. Named here rather than arriving as a raw
    // constraint violation about a column the school never typed.
    ['an hour of shower time in seconds', { minutesAfter: 1200 }, ['minutesAfter']],
  ])('refuses %s', async (_case, patch, expected) => {
    await expect(failing({ ...base, ...patch })).resolves.toEqual(expected);
  });

  it('lets a null buffer through, as @IsOptional reads it: absence', async () => {
    // A record of the neighbours' behaviour, not a separate rule — `@IsOptional`
    // skips every validator for null as it already does on `teacherEmail` and
    // the dates, which is how the browser spells an empty cell in a column the
    // file HAS. The service answers it with 0, and its spec is where that is
    // pinned; refusing it here would 400 a file for a cell a school left blank.
    await expect(failing({ ...base, minutesBefore: null })).resolves.toEqual([]);
  });

  it('still refuses the row on the numbers that are not optional', async () => {
    // The buffers being optional must not have loosened the two beside them.
    await expect(
      failing({ groupName: '7A', subject: 'IDH', recurrence: 'ALL_WEEKS' }),
    ).resolves.toEqual(['lessonsPerWeek', 'minutesPerLesson']);
  });
});

describe('the timplan column lists', () => {
  it('knows both ombyte columns, spelled as the API fields are', () => {
    // The CSV header and the API field are ONE name on purpose: an admin who
    // reads a refusal about `minutesBefore` has to be able to find that word in
    // the header row of their own file.
    expect(REQUIREMENT_FILE_COLUMNS).toContain('minutesBefore');
    expect(REQUIREMENT_FILE_COLUMNS).toContain('minutesAfter');
  });

  it('counts both as columns a file may leave out', () => {
    // In this list rather than among the four required ones: a four-column
    // spreadsheet uploaded to fix a lesson count must not zero an ombyte
    // somebody entered in the app. See importRequirements.
    expect(OPTIONAL_REQUIREMENT_COLUMNS).toContain('minutesBefore');
    expect(OPTIONAL_REQUIREMENT_COLUMNS).toContain('minutesAfter');
    expect(
      OPTIONAL_REQUIREMENT_COLUMNS.every((column) =>
        (REQUIREMENT_FILE_COLUMNS as readonly string[]).includes(column),
      ),
    ).toBe(true);
  });

  it('accepts the whole header a file with the ombyte columns reports', async () => {
    // What the dialog posts beside the rows. `forbidNonWhitelisted` is on the
    // pipe, so this is the check that used to make the web unable to add a
    // column on its own.
    const errors = await validate(
      plainToInstance(ImportRequirementsDto, {
        academicYearId: YEAR_ID,
        columns: [...REQUIREMENT_FILE_COLUMNS],
        rows: [{ ...base, minutesBefore: 10, minutesAfter: 20 }],
      }),
    );

    expect(errors).toEqual([]);
  });

  it('still refuses a column name nothing in the file list matches', async () => {
    const errors = await validate(
      plainToInstance(ImportRequirementsDto, {
        academicYearId: YEAR_ID,
        columns: ['minutesBefore', 'minutesDuring'],
        rows: [base],
      }),
    );

    expect(errors.map((error) => error.property)).toEqual(['columns']);
  });
});
