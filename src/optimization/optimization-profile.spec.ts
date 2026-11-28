import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { SaveOptimizationProfileDto } from './dto/optimization-profile.dto';
import { DEFAULT_PROFILE_WEIGHTS, PROFILE_WEIGHT_KEYS, profileView } from './optimization-profile';
import { OptimizationProfileService } from './optimization-profile.service';

/*
 * Optimeringsprofilen (P5): the five weights of Generera's sliders as the school's. The defaults are the ones the page has always started
 * from, so a school that never saves a profile sends what it always sent.
 */

const failures = async (body: unknown) => {
  const errors = await validate(plainToInstance(SaveOptimizationProfileDto, body) as object);
  return errors.filter((error) => error.constraints).map((error) => error.property).sort();
};

const WHOLE = { preferredFree: 10, preferredBusy: 5, disruption: 8, spread: 3, teacherGap: 2 };

describe('the defaults', () => {
  it('are the values the page always started from, for the five weights the engine takes and no more', () => {
    expect(DEFAULT_PROFILE_WEIGHTS).toEqual(WHOLE);
    expect([...PROFILE_WEIGHT_KEYS].sort()).toEqual(Object.keys(WHOLE).sort());
  });

  it('are what a school with no row is told, stored as false and with no time', () => {
    expect(profileView(null)).toEqual({ weights: WHOLE, stored: false, updatedAt: null });
  });

  it("are, as the JSON body of a run, byte for byte what the page sent for a school that never touched the sliders", () => {
    // The literal the page held in useState before P5 part 3, in its key order: a school with no row must send the engine exactly this.
    const BEFORE = '{"preferredFree":10,"preferredBusy":5,"disruption":8,"spread":3,"teacherGap":2}';
    expect(JSON.stringify(profileView(null).weights)).toBe(BEFORE);
    expect(JSON.stringify(DEFAULT_PROFILE_WEIGHTS)).toBe(BEFORE);
  });

  it('is a copy: what a caller does to the answer does not change the defaults', () => {
    profileView(null).weights.spread = 99;
    expect(DEFAULT_PROFILE_WEIGHTS.spread).toBe(3);
  });
});

describe('profileView', () => {
  it('says the five weights of a row and when it was saved, and nothing else of it', () => {
    const row = { schoolId: 'x', preferredFree: 0, preferredBusy: 1000, disruption: 20, spread: 4, teacherGap: 7, updatedAt: new Date('2026-11-26T08:00:00Z') };
    expect(profileView(row)).toEqual({
      weights: { preferredFree: 0, preferredBusy: 1000, disruption: 20, spread: 4, teacherGap: 7 },
      stored: true,
      updatedAt: '2026-11-26T08:00:00.000Z',
    });
  });
});

describe('SaveOptimizationProfileDto', () => {
  it('takes the five weights, 0 and 1000 included', async () => {
    await expect(failures(WHOLE)).resolves.toEqual([]);
    await expect(failures({ preferredFree: 0, preferredBusy: 1000, disruption: 0, spread: 1000, teacherGap: 0 })).resolves.toEqual([]);
  });

  it.each([[-1], [1001], [2.5], ['7'], [null], [undefined], [true]])('refuses a weight of %p', async (value) => {
    await expect(failures({ ...WHOLE, spread: value })).resolves.toEqual(['spread']);
  });

  it('wants all five: the profile is replaced as it stands on the page, and a missing weight is no "leave it"', async () => {
    const { teacherGap: _left, ...four } = WHOLE;
    await expect(failures(four)).resolves.toEqual(['teacherGap']);
    await expect(failures({})).resolves.toEqual([...PROFILE_WEIGHT_KEYS].sort());
  });
});

describe('OptimizationProfileService', () => {
  let tx: TxMock;
  let service: OptimizationProfileService;
  const user = testUser();
  beforeEach(() => {
    tx = createTxMock();
    service = new OptimizationProfileService(createPrismaMock(tx) as unknown as PrismaService);
  });

  it('answers the defaults for a school with no row, and reads the row of the caller\'s own school', async () => {
    tx['optimizationProfile']!['findUnique']!.mockResolvedValue(null);
    await expect(service.read(user)).resolves.toEqual({ weights: WHOLE, stored: false, updatedAt: null });
    expect(tx['optimizationProfile']!['findUnique']).toHaveBeenCalledWith({ where: { schoolId: user.schoolId } });
  });

  it('saves the whole profile for the caller\'s school, as an upsert whose two halves are the same five weights, and answers with the row', async () => {
    const saved = { schoolId: user.schoolId, preferredFree: 1, preferredBusy: 2, disruption: 3, spread: 4, teacherGap: 5, updatedAt: new Date('2026-11-26T08:00:00Z') };
    tx['optimizationProfile']!['upsert']!.mockResolvedValue(saved);
    const weights = { preferredFree: 1, preferredBusy: 2, disruption: 3, spread: 4, teacherGap: 5 };
    // Whatever else a body carries is not the service's to write: the DTO whitelists, and the service takes the five fields by name.
    await expect(service.save({ ...weights, schoolId: 'another-school' } as never, user)).resolves.toEqual({ weights, stored: true, updatedAt: '2026-11-26T08:00:00.000Z' });
    expect(tx['optimizationProfile']!['upsert']).toHaveBeenCalledWith({ where: { schoolId: user.schoolId }, create: { schoolId: user.schoolId, ...weights }, update: weights });
  });
});
