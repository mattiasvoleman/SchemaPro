import { ForbiddenException, SetMetadata } from '@nestjs/common';
import type { HuvudmanRole, PrismaClient } from '@prisma/client';
import type { PrismaService, SubjectSession } from '../database/prisma.service';

/**
 * Huvudman (20261212090000): a member of a huvudman reads every school it
 * owns as that school's läsare, with no Users row there. The database
 * resolves the reader itself (the second branch of app.current_school_id,
 * current_user_role and current_user_may, for a school the request names
 * where the login has no active row of its own); this is the gateway's view
 * of the same answer, so that the two always agree on who a request is.
 *
 * The reader has no user id: app.current_user_id() is NULL for them, as for
 * anybody without a row, so every arm keyed on the caller's own row matches
 * nothing and every write that records an actor is refused.
 */
export interface HuvudmanReader {
  /** The huvudman. */
  id: string;
  name: string;
  /** The reader's HuvudmanMembers row, which the read log names. */
  memberId: string;
  role: HuvudmanRole;
  firstName: string;
  lastName: string;
}

/** A write by the huvudman's reader, or by a member with no school named, outside the huvudman's own routes. */
export const HUVUDMAN_READS_ONLY = 'HUVUDMAN_READS_ONLY';

export function huvudmanReadsOnly(reader: Pick<HuvudmanReader, 'name'> | undefined): ForbiddenException {
  return new ForbiddenException({
    message: reader
      ? `Du läser skolan för ${reader.name} och ändrar ingenting här. Den som ska ändra något på skolan bjuds in av skolan.`
      : 'Välj en skola för att läsa den. Huvudmannens sidor ändrar bara huvudmannens egna uppgifter.',
    code: HUVUDMAN_READS_ONLY,
  });
}

/**
 * A route that writes the huvudman's own tables (its members, schools, keys),
 * held to the membership by the database, not to a school: the huvudman's
 * reader and a member at no school may call it. Every other write is
 * refused them (RolesGuard).
 */
export const HUVUDMAN_ROUTE_KEY = 'huvudmanRoute';
export const HuvudmanRoute = (): MethodDecorator & ClassDecorator => SetMetadata(HUVUDMAN_ROUTE_KEY, true);

/**
 * A POST that only reads (Läsbehörighet's activation preview): the reader may
 * call it as the läsare does. Say why.
 */
export const READS_ONLY_KEY = 'readsOnly';
export const ReadsOnly = (reason: string): MethodDecorator & ClassDecorator => SetMetadata(READS_ONLY_KEY, reason);

interface ReaderRow {
  member_id: string;
  huvudman_id: string;
  huvudman_name: string;
  member_role: HuvudmanRole;
  first_name: string;
  last_name: string;
  school_id: string;
}

/**
 * The huvudman's reader the subject is at the school `session` names, or
 * null: asked only when the login has no active row there (JwtStrategy and
 * the realtime gateway), so a session's ordinary request stays one lookup.
 * Under the subject's own claims and the same choice, so the answer is the
 * database's (app.huvudman_reader).
 */
export async function huvudmanReaderOf(
  prisma: Pick<PrismaService, 'withVerifiedSubject'>,
  authId: string,
  session: SubjectSession,
): Promise<(HuvudmanReader & { schoolId: string }) | null> {
  if (!session.school) return null;
  const rows = await prisma.withVerifiedSubject(
    authId,
    (db: PrismaClient) =>
      db.$queryRaw<ReaderRow[]>`
        SELECT member_id, huvudman_id, huvudman_name, member_role, first_name, last_name, school_id
          FROM app.huvudman_reader()`,
    session,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.huvudman_id,
    name: row.huvudman_name,
    memberId: row.member_id,
    role: row.member_role,
    firstName: row.first_name,
    lastName: row.last_name,
    schoolId: row.school_id,
  };
}

/** Whether the subject is an active member of any huvudman (their own rows only, under RLS). */
export async function isHuvudmanMember(
  prisma: Pick<PrismaService, 'withVerifiedSubject'>,
  authId: string,
): Promise<boolean> {
  const found = await prisma.withVerifiedSubject(authId, (db: PrismaClient) =>
    db.huvudmanMember.findFirst({ where: { authId, isActive: true }, select: { id: true } }),
  );
  return Boolean(found);
}
