import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRoomDto, UpdateRoomDto } from './room.dto';

/** The properties that failed validation. */
const failing = async (cls: typeof CreateRoomDto | typeof UpdateRoomDto, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  ['CreateRoomDto', CreateRoomDto, { name: 'Sal 1' }],
  ['UpdateRoomDto', UpdateRoomDto, {}],
] as const)('%s location', (_name, cls, base) => {
  it('accepts a building and a floor, and null for either', async () => {
    await expect(failing(cls, { ...base, building: 'Hus B', floor: 2 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, building: null, floor: null })).resolves.toEqual([]);
  });

  it('accepts the floors the database allows, basement to tower', async () => {
    await expect(failing(cls, { ...base, floor: -5 })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, floor: 50 })).resolves.toEqual([]);
  });

  it('refuses a floor the database would refuse with a 500', async () => {
    await expect(failing(cls, { ...base, floor: -6 })).resolves.toEqual(['floor']);
    await expect(failing(cls, { ...base, floor: 51 })).resolves.toEqual(['floor']);
    await expect(failing(cls, { ...base, floor: 1.5 })).resolves.toEqual(['floor']);
  });

  it('refuses a building name longer than the database holds', async () => {
    await expect(failing(cls, { ...base, building: 'x'.repeat(60) })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, building: 'x'.repeat(61) })).resolves.toEqual([
      'building',
    ]);
  });
});

describe.each([
  ['CreateRoomDto', CreateRoomDto, { name: 'Sal 1' }],
  ['UpdateRoomDto', UpdateRoomDto, {}],
] as const)('%s canBeShared (Placeringsregler, regel 3)', (_name, cls, base) => {
  it('accepts true, false and an absence', async () => {
    await expect(failing(cls, { ...base, canBeShared: true })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, canBeShared: false })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
  });

  it('refuses null and a string, which a NOT NULL mark with a default has no meaning for', async () => {
    await expect(failing(cls, { ...base, canBeShared: null })).resolves.toEqual(['canBeShared']);
    await expect(failing(cls, { ...base, canBeShared: 'true' })).resolves.toEqual(['canBeShared']);
    await expect(failing(cls, { ...base, canBeShared: 0 })).resolves.toEqual(['canBeShared']);
  });

  it('names the field in Swedish', async () => {
    const errors = await validate(plainToInstance(cls, { ...base, canBeShared: 'ja' }));
    expect(Object.values(errors[0]!.constraints ?? {})[0]).toMatch(/^canBeShared: /);
  });
});

