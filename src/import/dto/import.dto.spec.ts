// `@Type(() => …)` on the rows reads design-time metadata; without this the
// module cannot even be loaded. The sibling DTO specs get away without it
// because none of them nests.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ImportRequirementRowDto,
  ImportRequirementsDto,
  ImportSubjectRowDto,
  ImportTeacherQualificationRowDto,
  ImportTeacherRowDto,
  ImportTimplanDto,
  ImportTimplanRowDto,
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

/**
 * The subject row's two timplan columns, at the wire. Same reason as above:
 * `forbidNonWhitelisted` makes a column this DTO does not know a 400 for the
 * whole upload, so the columns the subjects CSV may carry are pinned here.
 */
describe('ImportSubjectRowDto', () => {
  const failingSubject = async (body: object) =>
    (await validate(plainToInstance(ImportSubjectRowDto, body))).map(
      (error) => error.property,
    );

  it('accepts a row with both timplan columns, and one with neither', async () => {
    await expect(
      failingSubject({ name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true }),
    ).resolves.toEqual([]);
    await expect(failingSubject({ name: 'Matematik' })).resolves.toEqual([]);
  });

  it('accepts an empty cell in either column as null', async () => {
    // A CSV column is filled or empty; the browser posts an empty cell as
    // null, and the service writes the default for it.
    await expect(
      failingSubject({ name: 'Bild', nationalCode: null, countsTowardTimplan: null }),
    ).resolves.toEqual([]);
  });

  it('passes an unknown code — the reference table, not this class, knows the codes', async () => {
    await expect(failingSubject({ name: 'Bild', nationalCode: 'NOTACODE' })).resolves.toEqual(
      [],
    );
  });

  it('refuses a flag that is not a boolean, so "ja" cannot land as truthy', async () => {
    await expect(
      failingSubject({ name: 'Bild', countsTowardTimplan: 'ja' }),
    ).resolves.toEqual(['countsTowardTimplan']);
  });

  it('refuses a code longer than the column allows', async () => {
    await expect(
      failingSubject({ name: 'Bild', nationalCode: 'X'.repeat(21) }),
    ).resolves.toEqual(['nationalCode']);
  });
});

describe('ImportTeacherRowDto with the post columns', () => {
  const teacher = { firstName: 'Karin', lastName: 'Ek', email: 'karin@example.com' };
  const failingTeacher = async (body: object) =>
    (await validate(plainToInstance(ImportTeacherRowDto, body))).map((error) => error.property);

  it('accepts the three-column row a staff list has always been', async () => {
    await expect(failingTeacher(teacher)).resolves.toEqual([]);
  });

  it('accepts a post with three decimals, a nedsättning, an avtalsform and a signature', async () => {
    await expect(
      failingTeacher({
        ...teacher,
        employmentPercent: 66.667,
        reductionPercent: 16.667,
        contractKind: 'SEMESTER',
        signature: 'KE',
      }),
    ).resolves.toEqual([]);
  });

  it('mirrors UpsertTeacherEmploymentDto bound for bound', async () => {
    await expect(failingTeacher({ ...teacher, employmentPercent: 0 })).resolves.toEqual([
      'employmentPercent',
    ]);
    await expect(failingTeacher({ ...teacher, employmentPercent: 100.001 })).resolves.toEqual([
      'employmentPercent',
    ]);
    await expect(failingTeacher({ ...teacher, employmentPercent: 66.6667 })).resolves.toEqual([
      'employmentPercent',
    ]);
    await expect(failingTeacher({ ...teacher, reductionPercent: -1 })).resolves.toEqual([
      'reductionPercent',
    ]);
    await expect(failingTeacher({ ...teacher, contractKind: 'TIMLÄRARE' })).resolves.toEqual([
      'contractKind',
    ]);
    await expect(failingTeacher({ ...teacher, signature: 'ABCDEFGHI' })).resolves.toEqual([
      'signature',
    ]);
    await expect(failingTeacher({ ...teacher, signature: '  ' })).resolves.toEqual(['signature']);
  });

  it('reads an empty cell posted as null as absence', async () => {
    await expect(
      failingTeacher({
        ...teacher,
        employmentPercent: null,
        reductionPercent: null,
        contractKind: null,
        signature: null,
      }),
    ).resolves.toEqual([]);
  });
});

describe('ImportTeacherQualificationRowDto', () => {
  const failingRow = async (body: object) =>
    (await validate(plainToInstance(ImportTeacherQualificationRowDto, body))).map(
      (error) => error.property,
    );
  const row = {
    teacherEmail: 'karin@example.com',
    subject: 'MA',
    minGrade: 7,
    maxGrade: 9,
    kind: 'LEGITIMATION',
  };

  it('accepts a row, with the kind spelled as the enum', async () => {
    await expect(failingRow(row)).resolves.toEqual([]);
    await expect(failingRow({ ...row, kind: 'TILLATEN' })).resolves.toEqual([]);
  });

  it('requires every column — a kind is stated, never presumed', async () => {
    await expect(failingRow({ ...row, kind: undefined })).resolves.toEqual(['kind']);
    await expect(failingRow({ ...row, kind: 'legitimation' })).resolves.toEqual(['kind']);
    await expect(failingRow({ ...row, teacherEmail: 'karin' })).resolves.toEqual(['teacherEmail']);
    await expect(failingRow({ ...row, subject: '' })).resolves.toEqual(['subject']);
  });

  it('holds both grades to 0..12 and leaves the order to the service', async () => {
    await expect(failingRow({ ...row, minGrade: -1 })).resolves.toEqual(['minGrade']);
    await expect(failingRow({ ...row, maxGrade: 13 })).resolves.toEqual(['maxGrade']);
    await expect(failingRow({ ...row, minGrade: 7.5 })).resolves.toEqual(['minGrade']);
    await expect(failingRow({ ...row, minGrade: 9, maxGrade: 7 })).resolves.toEqual([]);
  });
});

describe('ImportTimplanRowDto — a lokal timplan file’s row', () => {
  const PLAN = 'abababab-0000-4000-8000-000000000001';
  const parse = (body: object) => plainToInstance(ImportTimplanRowDto, body);
  const errorsOf = async (body: object) => (await validate(parse(body))).map((e) => e.property);
  const row = (overrides: object = {}) => ({ subject: 'MA', gradeLevel: '4', minutesPerWeek: 180, ...overrides });

  it('reads årskurs F as förskoleklass and a number as written, from the cell’s text or a parsed number', async () => {
    expect(parse(row({ gradeLevel: 'F' })).gradeLevel).toBe(0);
    expect(parse(row({ gradeLevel: ' f ' })).gradeLevel).toBe(0);
    expect(parse(row({ gradeLevel: '10' })).gradeLevel).toBe(10);
    expect(parse(row({ gradeLevel: 7 })).gradeLevel).toBe(7);
    await expect(errorsOf(row({ gradeLevel: 'F' }))).resolves.toEqual([]);
  });

  it('refuses an årskurs outside F..10 with the one sentence that says what is allowed', async () => {
    for (const bad of ['11', 'Fk', 'åk 4', '', '-1', 4.5]) {
      await expect(errorsOf(row({ gradeLevel: bad }))).resolves.toEqual(['gradeLevel']);
    }
    expect(JSON.stringify(await validate(parse(row({ gradeLevel: 'åk 4' }))))).toContain(
      'årskurs: anges som F (förskoleklass) eller ett heltal 0–10.',
    );
  });

  it('holds minutes to 0..1200 whole minutes, and a note to 500 characters', async () => {
    await expect(errorsOf(row({ minutesPerWeek: 0 }))).resolves.toEqual([]);
    await expect(errorsOf(row({ minutesPerWeek: 177 }))).resolves.toEqual([]);
    for (const bad of [-1, 1201, 12.5, '180']) {
      await expect(errorsOf(row({ minutesPerWeek: bad }))).resolves.toEqual(['minutesPerWeek']);
    }
    await expect(errorsOf(row({ note: 'n'.repeat(501) }))).resolves.toEqual(['note']);
  });

  it('wants a plan id and between 1 and 400 rows, and knows the four columns only', async () => {
    const file = (body: object) =>
      validate(plainToInstance(ImportTimplanDto, { localTimplanId: PLAN, rows: [row()], ...body }));
    await expect(file({})).resolves.toEqual([]);
    await expect(file({ columns: ['subject', 'gradeLevel', 'minutesPerWeek', 'note'] })).resolves.toEqual([]);
    expect((await file({ columns: ['teacherEmail'] })).map((e) => e.property)).toEqual(['columns']);
    expect((await file({ localTimplanId: 'Grundskolan' })).map((e) => e.property)).toEqual(['localTimplanId']);
    expect((await file({ rows: [] })).map((e) => e.property)).toEqual(['rows']);
    expect(
      (await file({ rows: Array.from({ length: 401 }, () => row()) })).map((e) => e.property),
    ).toEqual(['rows']);
  });
});

