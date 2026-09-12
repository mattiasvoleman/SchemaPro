import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRastDto, UpdateRastDto } from './rast.dto';

/**
 * The properties that failed validation, under the whitelist the global
 * ValidationPipe enforces — so a field the page sends and the DTO forgot to
 * declare fails here as it would on the wire, instead of passing unread.
 */
const failing = async (cls: typeof CreateRastDto | typeof UpdateRastDto, body: object) =>
  (
    await validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true })
  ).map((error) => error.property);

describe.each([
  [
    'CreateRastDto',
    CreateRastDto,
    {
      name: 'Förmiddagsrast',
      minGradeLevel: 0,
      maxGradeLevel: 6,
      startTime: '09:40',
      endTime: '10:00',
    },
  ],
  ['UpdateRastDto', UpdateRastDto, {}],
] as const)('%s weekday', (_name, cls, base) => {
  it('reads an explicit null as the rast every teaching day holds, not as not-an-integer', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts the ISO weekdays and refuses a day the week does not have', async () => {
    // The engine's DayOfWeek is 1-7 and its models forbid anything else, so a
    // 0 or an 8 let through here would fail the whole generation run later —
    // far from the form that could have said so.
    await expect(failing(cls, { ...base, dayOfWeek: 1 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 7 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, dayOfWeek: 0 })).resolves.toEqual(['dayOfWeek']);
    await expect(failing(cls, { ...base, dayOfWeek: 8 })).resolves.toEqual(['dayOfWeek']);
  });

  it('still refuses a weekday that is not a whole number, so null is the only special value', async () => {
    await expect(failing(cls, { ...base, dayOfWeek: 'onsdag' })).resolves.toEqual([
      'dayOfWeek',
    ]);
    await expect(failing(cls, { ...base, dayOfWeek: 3.5 })).resolves.toEqual(['dayOfWeek']);
  });
});

/**
 * The body the admin page sends, field for field, for a create and an edit
 * alike: web/app/[locale]/(app)/admin/rasts/page.tsx builds one object from the
 * whole form and hands it to either mutation.
 */
const PAGE_BODY = {
  name: 'Förmiddagsrast',
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: null,
  startTime: '09:40',
  endTime: '10:00',
  requiresLessonBefore: false,
};

describe.each([
  ['CreateRastDto', CreateRastDto],
  ['UpdateRastDto', UpdateRastDto],
] as const)('%s, as the admin page fills it in', (_name, cls) => {
  it('accepts the whole form, the every-day rast and the lesson-before rule included', async () => {
    await expect(failing(cls, PAGE_BODY)).resolves.toEqual([]);
    await expect(failing(cls, { ...PAGE_BODY, requiresLessonBefore: true })).resolves.toEqual([]);
  });

  it('refuses a lesson-before flag that is not a boolean', async () => {
    // The service writes `requiresLessonBefore ?? false`. The string "false"
    // is not nullish, so it would be handed to Prisma's Boolean column as a
    // string and fail there, where no message can name the field.
    await expect(
      failing(cls, { ...PAGE_BODY, requiresLessonBefore: 'false' }),
    ).resolves.toEqual(['requiresLessonBefore']);
  });

  it('takes a clock with or without seconds, and nothing looser', async () => {
    await expect(
      failing(cls, { ...PAGE_BODY, startTime: '09:40:00', endTime: '10:00:00' }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...PAGE_BODY, startTime: '9:40' })).resolves.toEqual([
      'startTime',
    ]);
  });
});
