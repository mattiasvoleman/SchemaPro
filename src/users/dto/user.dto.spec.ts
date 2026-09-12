import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateUserDto, UpdateUserDto } from './user.dto';

const GROUP_ID = '66666666-6666-4666-8666-666666666666';

/** The properties that failed validation. */
const failing = async (cls: typeof CreateUserDto | typeof UpdateUserDto, body: object) =>
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
