import { BadRequestException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/**
 * Refuses a room type that is not one of the school's own, with the field
 * named. Absent or null is no type and passes.
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
 * `field` is the name the client sent, so a form with two such fields is told
 * which one.
 */
export async function assertRoomTypeIsTheSchools(
  tx: PrismaClient,
  roomTypeId: string | null | undefined,
  field: 'roomTypeId' | 'requiredRoomTypeId',
): Promise<void> {
  if (roomTypeId == null) return;
  const own = await tx.roomType.findFirst({ where: { id: roomTypeId }, select: { id: true } });
  if (!own) {
    throw new BadRequestException(`${field}: rumstypen finns inte bland skolans rumstyper.`);
  }
}
