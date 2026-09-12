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
});
