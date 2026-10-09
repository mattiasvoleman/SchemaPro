import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSubjectDto, UpdateSubjectDto } from './subject.dto';

const ROOM_TYPE_ID = '77777777-7777-4777-8777-777777777777';

/** The properties that failed validation. */
const failing = async (cls: typeof CreateSubjectDto | typeof UpdateSubjectDto, body: object) =>
  (await validate(plainToInstance(cls, body))).map((error) => error.property);

describe.each([
  ['CreateSubjectDto', CreateSubjectDto, { name: 'Kemi' }],
  ['UpdateSubjectDto', UpdateSubjectDto, {}],
] as const)('%s', (_name, cls, base) => {
  it('reads a null room type as the subject fitting any room', async () => {
    await expect(failing(cls, { ...base, requiredRoomTypeId: null })).resolves.toEqual([]);
    await expect(failing(cls, { ...base })).resolves.toEqual([]);
    await expect(failing(cls, { ...base, requiredRoomTypeId: ROOM_TYPE_ID })).resolves.toEqual(
      [],
    );
  });

  it('refuses a room type that is not a v4 uuid, so a typo cannot lift the restriction', async () => {
    await expect(failing(cls, { ...base, requiredRoomTypeId: 'Labbsal' })).resolves.toEqual([
      'requiredRoomTypeId',
    ]);
  });

  describe('the national code', () => {
    it('accepts a code, a null and an absence alike — whether the code exists is the service’s question', async () => {
      // The reference table is the only thing that knows which codes exist,
      // so a shape-valid unknown passes here and is refused there in Swedish.
      await expect(failing(cls, { ...base, nationalCode: 'SV_SVA' })).resolves.toEqual([]);
      await expect(failing(cls, { ...base, nationalCode: 'NOTACODE' })).resolves.toEqual([]);
      await expect(failing(cls, { ...base, nationalCode: null })).resolves.toEqual([]);
    });

    it('refuses a code longer than the column beside it allows, and one that is not a string', async () => {
      await expect(
        failing(cls, { ...base, nationalCode: 'X'.repeat(21) }),
      ).resolves.toEqual(['nationalCode']);
      await expect(failing(cls, { ...base, nationalCode: 42 })).resolves.toEqual([
        'nationalCode',
      ]);
    });
  });

  describe('countsTowardTimplan', () => {
    it('accepts true, false and an absence', async () => {
      await expect(failing(cls, { ...base, countsTowardTimplan: true })).resolves.toEqual([]);
      await expect(failing(cls, { ...base, countsTowardTimplan: false })).resolves.toEqual([]);
      await expect(failing(cls, { ...base })).resolves.toEqual([]);
    });

    it('refuses null, which has no meaning for a NOT NULL flag with a default', async () => {
      // On a PATCH null could be read as "back to true" or as "false", and the
      // two readings differ for exactly the subjects the flag is for.
      await expect(failing(cls, { ...base, countsTowardTimplan: null })).resolves.toEqual([
        'countsTowardTimplan',
      ]);
    });

    it('refuses a string, so a CSV "ja" cannot land as truthy', async () => {
      await expect(failing(cls, { ...base, countsTowardTimplan: 'ja' })).resolves.toEqual([
        'countsTowardTimplan',
      ]);
    });
  });

  describe('the load factor (staffing Fas 3)', () => {
    it('accepts the bounds and three decimals, and an absence', async () => {
      for (const loadFactor of [0.5, 0.7, 1, 1.25, 1.333, 3]) {
        await expect(failing(cls, { ...base, loadFactor })).resolves.toEqual([]);
      }
      await expect(failing(cls, { ...base })).resolves.toEqual([]);
    });

    it('refuses below 0,5, above 3, four decimals, null and a string — the CHECK’s range, in Swedish', async () => {
      for (const loadFactor of [0.499, 3.001, 0, -1, 1.2345, null, '0.7', Number.NaN]) {
        const errors = await validate(plainToInstance(cls, { ...base, loadFactor }));
        expect(errors.map((error) => error.property)).toEqual(['loadFactor']);
        expect(Object.values(errors[0]!.constraints ?? {})).toContain(
          'loadFactor: faktorn är ett tal mellan 0,5 och 3 med högst tre decimaler.',
        );
      }
    });
  });
});
