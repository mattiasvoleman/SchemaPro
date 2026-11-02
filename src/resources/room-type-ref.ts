import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/** What a refused room type answers with, for a client that tells it from another 400. */
export const ROOM_TYPE_NOT_FOUND = 'ROOM_TYPE_NOT_FOUND';

/**
 * Refuses a room type that is not one of the school's own. Absent or null is
 * no type and passes.
 *
 * Asked inside the writing transaction, under the caller's RLS context: the
 * policies on RoomTypes show a school its own rows and no others, so a type
 * of another school reads exactly as one that does not exist, and the
 * answer for both is the same sentence. That is the point of asking here and
 * not leaving it to the foreign key. The key from Rooms, Subjects and
 * RoomPreferences to RoomTypes is a single-column one, so it accepts a type of
 * ANY school, and the other school's delete of it is then refused (RESTRICT)
 * or, for a room rule, cascades through this school's rule (CASCADE). A
 * composite key is a migration's decision and not this one's.
 *
 * The sentence and the word are the room loan's own for its local room's type
 * (ROOM_LOAN_LOCAL_ROOM_TYPE_NOT_FOUND, sharing-errors.ts): the school calls
 * them salstyper, and the same refusal reads the same wherever it is made. It
 * is a 400 where the loan's is a 404, because here the id is a field of the
 * body being written and not the thing asked for.
 */
export async function assertRoomTypeIsTheSchools(tx: PrismaClient, roomTypeId: string | null | undefined): Promise<void> {
  if (roomTypeId == null) return;
  const own = await tx.roomType.findFirst({ where: { id: roomTypeId }, select: { id: true } });
  if (!own) {
    throw new BadRequestException({ message: 'Salstypen finns inte bland skolans egna salstyper.', code: ROOM_TYPE_NOT_FOUND });
  }
}
