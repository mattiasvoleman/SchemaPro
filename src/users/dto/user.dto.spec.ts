import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto, UpdateUserDto } from './user.dto';

const GROUP_ID = '66666666-6666-4666-8666-666666666666';

/** The properties that failed validation. */
const failing = async (cls: ClassConstructor<CreateUserDto | UpdateUserDto>, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  [
    'CreateUserDto',
    CreateUserDto,
    { role: 'TEACHER', firstName: 'Anna', lastName: 'Ek', email: 'anna.ek@skola.se' },
  ],
  ['UpdateUserDto', UpdateUserDto, {}],
] as const)('%s optional identity fields', (_name, cls, base) => {
  it('reads an explicit null as clearing the phone number and the class', async () => {
    await expect(
      failing(cls, { ...base, phone: null, studentGroupId: null }),
    ).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('accepts a phone number and a class the person belongs to', async () => {
    await expect(
      failing(cls, { ...base, phone: '+46 70 123 45 67', studentGroupId: GROUP_ID }),
    ).resolves.toEqual([]);
  });

  it('refuses a class id that is not a v4 uuid, so a typo cannot read as clearing it', async () => {
    await expect(failing(cls, { ...base, studentGroupId: '7A' })).resolves.toEqual([
      'studentGroupId',
    ]);
  });

  it('refuses a phone number that is not text, or longer than the column holds', async () => {
    await expect(failing(cls, { ...base, phone: 46701234567 })).resolves.toEqual(['phone']);
    await expect(failing(cls, { ...base, phone: 'x'.repeat(40) })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, phone: 'x'.repeat(41) })).resolves.toEqual([
      'phone',
    ]);
  });
});

describe('UpdateUserDto leftOn (sista arbetsdag)', () => {
  it('takes a date that exists and nothing else: not an instant, not a rolled-over day, not a number', async () => {
    await expect(failing(UpdateUserDto, { isActive: false, leftOn: '2026-11-10' })).resolves.toEqual([]);
    await expect(failing(UpdateUserDto, { leftOn: '2026-02-30' })).resolves.toEqual(['leftOn']);
    await expect(failing(UpdateUserDto, { leftOn: '2026-11-10T12:00:00Z' })).resolves.toEqual(['leftOn']);
    await expect(failing(UpdateUserDto, { leftOn: '10 november' })).resolves.toEqual(['leftOn']);
    await expect(failing(UpdateUserDto, { leftOn: 20261110 })).resolves.toEqual(['leftOn']);
  });

  it('is optional, and is not a field of a new person', async () => {
    await expect(failing(UpdateUserDto, {})).resolves.toEqual([]);
    // null passes IsOptional as it does for the phone number and the class; UsersService.update reads it as no day (the review of #308, MEDEL-1).
    await expect(failing(UpdateUserDto, { isActive: false, leftOn: null })).resolves.toEqual([]);
    expect('leftOn' in plainToInstance(CreateUserDto, { role: 'TEACHER', firstName: 'A', lastName: 'B', email: 'a@b.se' })).toBe(false);
  });
});

describe('the address (Personer utan e-postadress)', () => {
  const person = { role: 'STUDENT', firstName: 'Alva', lastName: 'Ek' };

  it('is optional for a new person: left out or null is a pupil or a guardian with no address, and the service says who may', async () => {
    await expect(failing(CreateUserDto, { ...person })).resolves.toEqual([]);
    await expect(failing(CreateUserDto, { ...person, email: null })).resolves.toEqual([]);
  });

  it('is an address when it is given: an empty string is not one, and a typo is not either', async () => {
    await expect(failing(CreateUserDto, { ...person, email: '' })).resolves.toEqual(['email']);
    await expect(failing(CreateUserDto, { ...person, email: 'alva@' })).resolves.toEqual(['email']);
    await expect(failing(CreateUserDto, { ...person, email: 'alva@skolan.se' })).resolves.toEqual([]);
    await expect(failing(CreateUserDto, { ...person, email: `${'a'.repeat(250)}@b.se` })).resolves.toEqual(['email']);
  });

  it('can be set on a person, and is not taken away: null on an update is a 400, as is an empty string', async () => {
    await expect(failing(UpdateUserDto, { email: 'alva@skolan.se' })).resolves.toEqual([]);
    await expect(failing(UpdateUserDto, {})).resolves.toEqual([]);
    await expect(failing(UpdateUserDto, { email: null })).resolves.toEqual(['email']);
    await expect(failing(UpdateUserDto, { email: '' })).resolves.toEqual(['email']);
    await expect(failing(UpdateUserDto, { email: 'not an address' })).resolves.toEqual(['email']);
  });
});
