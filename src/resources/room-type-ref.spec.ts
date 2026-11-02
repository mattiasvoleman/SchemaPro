import { BadRequestException } from '@nestjs/common';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { assertRoomTypeIsTheSchools, ROOM_TYPE_NOT_FOUND } from './room-type-ref';

const TYPE_ID = 'a0000000-0000-4000-8000-000000000001';

describe('assertRoomTypeIsTheSchools', () => {
  let tx: TxMock;
  const assert = (id: string | null | undefined) => assertRoomTypeIsTheSchools(tx as unknown as PrismaClient, id);

  beforeEach(() => {
    tx = createTxMock();
  });

  it('lets a type of the school pass, asked by its id and nothing else', async () => {
    tx.roomType.findFirst.mockResolvedValue({ id: TYPE_ID });

    await expect(assert(TYPE_ID)).resolves.toBeUndefined();

    expect(tx.roomType.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.roomType.findFirst).toHaveBeenCalledWith({ where: { id: TYPE_ID }, select: { id: true } });
  });

  it('refuses a type the school does not see with a 400, a code of its own and the room loan’s sentence', async () => {
    tx.roomType.findFirst.mockResolvedValue(null);

    const refused = assert(TYPE_ID);

    await expect(refused).rejects.toThrow(BadRequestException);
    await expect(refused).rejects.toMatchObject({
      status: 400,
      // The sentence of ROOM_LOAN_LOCAL_ROOM_TYPE_NOT_FOUND (sharing-errors.ts),
      // which sharing-errors.spec pins as well: it is salstyper to the school
      // wherever the refusal is made.
      response: { code: ROOM_TYPE_NOT_FOUND, message: 'Salstypen finns inte bland skolans egna salstyper.' },
    });
    expect(ROOM_TYPE_NOT_FOUND).toBe('ROOM_TYPE_NOT_FOUND');
  });

  it.each([null, undefined])('asks nothing for %s, which is no type', async (none) => {
    await expect(assert(none)).resolves.toBeUndefined();

    expect(tx.roomType.findFirst).not.toHaveBeenCalled();
  });
});
