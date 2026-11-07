import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  PLACE_LIMIT_FIELDS,
  PLACEMENT_PLACES_NEEDS_A_LIMIT,
  PLACEMENT_FIELDS,
  assertPlacesHaveALimit,
  placesNeedALimit,
  isPlacesNeedALimitCheck,
  placementDataOf,
  touchesPlacesRule,
  type StoredPlacesRule,
} from './placement-rules';

const stored = (overrides: Partial<StoredPlacesRule> = {}): StoredPlacesRule => ({
  placementPlacesMode: 'OFF',
  maxClassRoomsPerDay: null,
  maxTeacherRoomsPerDay: null,
  maxClassBuildingsPerDay: null,
  maxTeacherBuildingsPerDay: null,
  ...overrides,
});

describe('placementDataOf', () => {
  it('names nothing a request does not name: absent leaves the column as it is', () => {
    expect(placementDataOf({})).toEqual({});
    expect(placementDataOf({ placementEdgeMode: 'HARD' })).toEqual({ placementEdgeMode: 'HARD' });
  });

  it('carries a null limit, which is how a limit is cleared, and a weight or a mode as named', () => {
    expect(placementDataOf({ maxClassRoomsPerDay: null, maxTeacherBuildingsPerDay: 1, placementSharedWeight: 40, placementPlacesMode: 'SOFT' })).toEqual({
      maxClassRoomsPerDay: null,
      maxTeacherBuildingsPerDay: 1,
      placementSharedWeight: 40,
      placementPlacesMode: 'SOFT',
    });
  });

  it('reads all ten columns and no other', () => {
    expect(PLACEMENT_FIELDS).toHaveLength(10);
    const everything = Object.fromEntries(PLACEMENT_FIELDS.map((field) => [field, field.endsWith('Mode') ? 'SOFT' : 3]));
    expect(placementDataOf({ ...everything, lunchMinutes: 30 } as never)).toEqual(everything);
  });
});

describe('touchesPlacesRule', () => {
  it('is true for the mode or any of the four limits, null included', () => {
    expect(touchesPlacesRule({ placementPlacesMode: 'OFF' })).toBe(true);
    for (const field of PLACE_LIMIT_FIELDS) {
      expect(touchesPlacesRule({ [field]: null })).toBe(true);
      expect(touchesPlacesRule({ [field]: 1 })).toBe(true);
    }
  });

  it('is false for a request that says nothing of rule 2, the weight included: a weight needs no limit', () => {
    expect(touchesPlacesRule({})).toBe(false);
    expect(touchesPlacesRule({ placementEdgeMode: 'HARD', placementSharedMode: 'SOFT', placementPlacesWeight: 10 })).toBe(false);
  });
});

describe('assertPlacesHaveALimit', () => {
  const refused = (dto: Parameters<typeof assertPlacesHaveALimit>[0], row: StoredPlacesRule | null) => {
    try {
      assertPlacesHaveALimit(dto, row);
    } catch (error) {
      return error;
    }
    return null;
  };

  it('refuses turning the rule on with no limit anywhere, by name, with the field and a code', () => {
    for (const mode of ['SOFT', 'HARD'] as const) {
      const error = refused({ placementPlacesMode: mode }, null) as BadRequestException;
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: PLACEMENT_PLACES_NEEDS_A_LIMIT, message: expect.stringContaining('placementPlacesMode:') });
    }
    expect(refused({ placementPlacesMode: 'SOFT' }, stored())).toBeInstanceOf(BadRequestException);
    // Limits named as null are none.
    expect(refused({ placementPlacesMode: 'HARD', maxClassRoomsPerDay: null, maxTeacherRoomsPerDay: null }, stored())).toBeInstanceOf(BadRequestException);
  });

  it('admits turning it on with a limit in the request or in the row, whichever limit it is, 1 (a single place) included', () => {
    for (const field of PLACE_LIMIT_FIELDS) {
      expect(refused({ placementPlacesMode: 'SOFT', [field]: 1 }, null)).toBeNull();
      expect(refused({ placementPlacesMode: 'HARD' }, stored({ [field]: 2 }))).toBeNull();
    }
  });

  it('refuses clearing the last limit of a rule that is on, and admits clearing one of two', () => {
    const on = stored({ placementPlacesMode: 'SOFT', maxClassRoomsPerDay: 2 });
    expect(refused({ maxClassRoomsPerDay: null }, on)).toBeInstanceOf(BadRequestException);
    expect(refused({ maxClassRoomsPerDay: null }, { ...on, maxTeacherRoomsPerDay: 3 })).toBeNull();
    // Moving the limit is not clearing it.
    expect(refused({ maxClassRoomsPerDay: null, maxTeacherBuildingsPerDay: 1 }, on)).toBeNull();
  });

  it('admits clearing every limit when the same request turns the rule off, and a rule that is off needs none', () => {
    const on = stored({ placementPlacesMode: 'HARD', maxClassRoomsPerDay: 2 });
    expect(refused({ placementPlacesMode: 'OFF', maxClassRoomsPerDay: null }, on)).toBeNull();
    expect(refused({ maxClassRoomsPerDay: null }, stored({ maxClassRoomsPerDay: 2 }))).toBeNull();
    expect(refused({ placementPlacesMode: 'OFF' }, null)).toBeNull();
    expect(refused({}, null)).toBeNull();
  });

  it('judges a mode left alone by the row’s: a limit cannot be cleared under a rule the row holds on', () => {
    expect(refused({ maxTeacherRoomsPerDay: null }, stored({ placementPlacesMode: 'HARD', maxTeacherRoomsPerDay: 4 }))).toBeInstanceOf(BadRequestException);
  });
});

describe('placesNeedALimit', () => {
  it('is a 400 whose code the web renders from its catalogue', () => {
    const error = placesNeedALimit();
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({ code: 'PLACEMENT_PLACES_NEEDS_A_LIMIT' });
  });
});

describe('isPlacesNeedALimitCheck', () => {
  const failure = (meta: unknown, message = 'Unique constraint failed') =>
    new Prisma.PrismaClientKnownRequestError(message, { code: 'P2039', clientVersion: Prisma.prismaVersion.client, meta: meta as Record<string, unknown> });

  it('recognises the database’s own CHECK by the constraint’s name, in the driver’s message or in the rendered one', () => {
    expect(
      isPlacesNeedALimitCheck(
        failure({ driverAdapterError: { cause: { originalMessage: 'new row for relation "LunchSettings" violates check constraint "LunchSettings_placementPlaces_needs_a_limit_check"' } } }),
      ),
    ).toBe(true);
    expect(isPlacesNeedALimitCheck(failure(undefined, 'violates check constraint "LunchSettings_placementPlaces_needs_a_limit_check"'))).toBe(true);
  });

  it('does not take another refusal for it', () => {
    expect(isPlacesNeedALimitCheck(failure({ driverAdapterError: { cause: { originalMessage: 'violates check constraint "LunchSettings_placementEdgeWeight_check"' } } }))).toBe(false);
    expect(isPlacesNeedALimitCheck(failure(undefined))).toBe(false);
    expect(isPlacesNeedALimitCheck(new Error('LunchSettings_placementPlaces_needs_a_limit_check'))).toBe(false);
    expect(isPlacesNeedALimitCheck(null)).toBe(false);
  });
});
