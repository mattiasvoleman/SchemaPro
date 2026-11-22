/**
 * Demoskolans återställning: delete the demo school and make it again, in one transaction, and only if it is the demo school.
 *
 *   npm run db:reset-demo                 what it would do, and whether it may (nothing is written)
 *   npm run db:reset-demo -- --yes        do it
 *   npm run db:seed -- --reset            the same as --yes, for the way it has always been run
 *
 * Connects via DIRECT_URL (table owner), as the seed does. It is the operator's: there is no button in the product, no role and
 * no route that can reach it (docs/DEPLOYMENT.md §37).
 *
 * WHAT STANDS BETWEEN IT AND A REAL SCHOOL. `db:seed --reset` used to delete the school with the slug `demo-skola`, whatever was in
 * it. The slug is unique, so a real school that had been given it would have gone, with its people and its schedule. Now the school's
 * row is locked (`FOR UPDATE`) in the transaction that deletes it, its facts are read after the lock, and src/demo-school/demo-guard.ts
 * judges them: the demo school is the school whose every person, active or not, has an address at the demo's domain (which has no
 * mailbox behind it) and which no huvudman and no other school is tied to. A person added between the reading and the delete cannot
 * be missed: adding one takes a lock on the school's row, which waits for this transaction, and then finds the school gone.
 * Nothing is deleted outside the school: a refusal is a return with nothing written, and a failure rolls the whole thing back.
 *
 * LOGINS. The seed's people have no login. A tester who has linked the demo's administrator to a Supabase user (docs/DEPLOYMENT.md
 * §15.6) would lose it with the row: the Supabase user would stay, with no profile. So a login that only the demo school holds is
 * written back to the new row with the same address, `authId` and `invitedAt`. A login that another school also holds is not: a row
 * takes a login another row holds only through the gateway's invitation (Users_a_login_joins_another_school_by_invitation), and a
 * script that went round that would open the door the invitation is for. That person is invited again at /admin/people, and the
 * other school's row is not touched (the key is (authId, schoolId)). The Supabase user is never deleted.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../src/database/pool-config';
import { DEMO, isDemoAddress, judgeDemoSchool, refusalText, type DemoSpec, type Refusal, type SchoolFacts } from '../src/demo-school/demo-guard';
import { createDemoSchool, describeDemoSchool, type Db, type DemoSummary } from './demo-school';

export interface LoginReport {
  /** Logins written back to the new school's rows. */
  kept: number;
  /** Logins that were not: held by another school too, or on an address the demo does not make. Counts, never who. */
  dropped: number;
}

export type ResetResult =
  | { kind: 'CREATED'; schoolId: string; summary: DemoSummary }
  | { kind: 'RESET'; oldSchoolId: string; schoolId: string; summary: DemoSummary; logins: LoginReport }
  | { kind: 'REFUSED'; schoolId: string; refusal: Refusal }
  /** A dry run: the school exists and may be reset. */
  | { kind: 'MAY_BE_RESET'; schoolId: string; people: number; logins: number };

export interface ResetOptions {
  spec?: DemoSpec;
  /** False to read and judge only: nothing is written. */
  write?: boolean;
  /**
   * Test seams, and nothing else: run inside the transaction, after the school is locked and judged (`afterJudged`) and after it is
   * deleted (`afterDeleted`). A hook that throws rolls the reset back.
   */
  afterJudged?: () => Promise<void>;
  afterDeleted?: () => Promise<void>;
}

const count = (rows: readonly { n: bigint | number }[]): number => Number(rows[0]?.n ?? 0);

/** The facts the guard judges, read after the school's row is locked. */
async function readFacts(tx: Db, spec: DemoSpec, schoolId: string, name: string): Promise<SchoolFacts> {
  const people = await tx.$queryRaw<{ email: string }[]>(Prisma.sql`SELECT "email" FROM "Users" WHERE "schoolId" = ${schoolId}::uuid`);
  const huvudman = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT (SELECT count(*) FROM "HuvudmanSchools" WHERE "schoolId" = ${schoolId}::uuid)
         + (SELECT count(*) FROM "HuvudmanSchoolRequests" WHERE "schoolId" = ${schoolId}::uuid)
         + (SELECT count(*) FROM "HuvudmanSchoolEvents" WHERE "schoolId" = ${schoolId}::uuid) AS n`);
  const others = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT (SELECT count(*) FROM "SchoolTravelTimes" WHERE ("schoolAId" = ${schoolId}::uuid AND "schoolBId" <> ${schoolId}::uuid) OR ("schoolBId" = ${schoolId}::uuid AND "schoolAId" <> ${schoolId}::uuid))
         + (SELECT count(*) FROM "RoomLoans" WHERE ("ownerSchoolId" = ${schoolId}::uuid AND "borrowerSchoolId" <> ${schoolId}::uuid) OR ("borrowerSchoolId" = ${schoolId}::uuid AND "ownerSchoolId" <> ${schoolId}::uuid))
         + (SELECT count(*) FROM "SharedTeacherMarks" WHERE ("schoolId" = ${schoolId}::uuid AND "withSchoolId" <> ${schoolId}::uuid) OR ("withSchoolId" = ${schoolId}::uuid AND "schoolId" <> ${schoolId}::uuid)) AS n`);
  return { slug: spec.slug, name, emails: people.map((row) => row.email), huvudmanTies: count(huvudman), otherSchoolTies: count(others) };
}

interface Login {
  email: string;
  authId: string;
  invitedAt: Date;
}

/** The demo school's own logins: a row with an `invitedAt` has one. Those a second school also holds are counted apart. */
async function readLogins(tx: Db, schoolId: string): Promise<{ own: Login[]; shared: number }> {
  const rows = await tx.$queryRaw<{ email: string; authId: string; invitedAt: Date; elsewhere: bigint }[]>(Prisma.sql`
    SELECT u."email", u."authId"::text AS "authId", u."invitedAt",
           (SELECT count(*) FROM "Users" o WHERE o."authId" = u."authId" AND o."schoolId" <> u."schoolId") AS elsewhere
    FROM "Users" u
    WHERE u."schoolId" = ${schoolId}::uuid AND u."invitedAt" IS NOT NULL`);
  return {
    own: rows.filter((row) => Number(row.elsewhere) === 0).map((row) => ({ email: row.email, authId: row.authId, invitedAt: row.invitedAt })),
    shared: rows.filter((row) => Number(row.elsewhere) > 0).length,
  };
}

export async function resetDemoSchool(client: PrismaClient, options: ResetOptions = {}): Promise<ResetResult> {
  const spec = options.spec ?? DEMO;
  const write = options.write ?? true;
  return client.$transaction(
    async (tx) => {
      // The lock first, the facts after it: a person added by another connection waits for this transaction, and finds the school gone.
      const found = await tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`SELECT "id"::text AS id, "name" FROM "Schools" WHERE "slug" = ${spec.slug} FOR UPDATE`);
      const school = found[0];
      if (school === undefined) {
        if (!write) throw new Error(`There is no school with the slug ${spec.slug}: nothing to reset. Run db:seed to make it.`);
        const summary = await createDemoSchool(tx, spec);
        return { kind: 'CREATED' as const, schoolId: summary.schoolId, summary };
      }

      const refusal = judgeDemoSchool(await readFacts(tx, spec, school.id, school.name), spec);
      if (refusal !== null) return { kind: 'REFUSED' as const, schoolId: school.id, refusal };

      const logins = await readLogins(tx, school.id);
      if (!write) {
        const people = await tx.user.count({ where: { schoolId: school.id } });
        return { kind: 'MAY_BE_RESET' as const, schoolId: school.id, people, logins: logins.own.length + logins.shared };
      }

      await options.afterJudged?.();
      await tx.school.delete({ where: { id: school.id } });
      await options.afterDeleted?.();
      const summary = await createDemoSchool(tx, spec);

      // The logins only the demo held, back on the same address. An address the demo does not make (a tester's own, on the demo's
      // domain) has no row to go back to.
      let kept = 0;
      let dropped = logins.shared;
      for (const login of logins.own) {
        if (!isDemoAddress(login.email, spec.domain)) {
          dropped += 1;
          continue;
        }
        const updated = await tx.$executeRaw(Prisma.sql`
          UPDATE "Users" SET "authId" = ${login.authId}::uuid, "invitedAt" = ${login.invitedAt}
          WHERE "schoolId" = ${summary.schoolId}::uuid AND lower("email") = lower(${login.email})`);
        if (updated > 0) kept += 1;
        else dropped += 1;
      }
      return { kind: 'RESET' as const, oldSchoolId: school.id, schoolId: summary.schoolId, summary, logins: { kept, dropped } };
    },
    // 80 pupils and 33 posts are some three hundred statements, one at a time: a minute is plenty and a hung lock is not waited for for ever.
    { timeout: 120_000, maxWait: 30_000 },
  );
}

/** The sentences a person reads of a result. Counts, never an address and never a name. */
export function describeResult(result: ResetResult, spec: DemoSpec = DEMO): string {
  switch (result.kind) {
    case 'CREATED':
      return describeDemoSchool(result.summary);
    case 'RESET':
      return [
        `Deleted the demo school (${result.oldSchoolId}) and made it again (${result.schoolId}).`,
        `Logins kept: ${result.logins.kept}. Logins not kept: ${result.logins.dropped} (a login another school also holds, or one on an address the demo does not make: invite the person again at /admin/people).`,
        'No Supabase user was touched.',
        '',
        describeDemoSchool(result.summary),
      ].join('\n');
    case 'REFUSED':
      return `NOT RESET. ${refusalText(result.refusal, spec)}`;
    case 'MAY_BE_RESET':
      return [
        `The demo school (${result.schoolId}) has ${result.people} people, ${result.logins} of them with a login, and nothing ties it to a huvudman or another school.`,
        'It may be reset. Nothing was written: run it again with --yes to delete it and make it again.',
      ].join('\n');
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env['DIRECT_URL'] ?? process.env['DATABASE_URL'];
  if (!databaseUrl) {
    console.error('Set DIRECT_URL (or DATABASE_URL) before resetting.');
    process.exit(1);
  }
  const write = process.argv.includes('--yes');
  const client = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
  try {
    const result = await resetDemoSchool(client, { write });
    console.log(describeResult(result));
    if (result.kind === 'REFUSED') process.exitCode = 1;
  } catch (error) {
    console.error('Reset failed, and nothing was changed:', error);
    process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

if (require.main === module) void main();
