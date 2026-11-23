/**
 * Demo-school seed for staging / local testing.
 *
 * Creates one fully configured school ("Demo Skola") with subjects, rooms,
 * classes, a nivågrupp cut across two of them, teachers, students, a current
 * academic year, the teaching requirements matrix, lunch settings and a few
 * availability constraints — everything the AI engine needs to generate a
 * schedule. The content is prisma/demo-school.ts's.
 *
 * Usage:
 *   npm run db:seed
 *   npm run db:seed -- --reset      delete the demo school and make it again
 *   npm run db:reset-demo           what a reset would do, without doing it
 *
 * Notes
 * - Connects via DIRECT_URL (table owner) because seeding intentionally
 *   bypasses RLS; never run this with production credentials.
 * - Made only in a database that holds no real school: where the demo school
 *   is not there and any person in the database has an address outside the
 *   names reserved for examples (example.com, .invalid, …), the script prints
 *   NOT SEEDED and makes nothing (docs/DEPLOYMENT.md §37).
 * - Idempotent: if the demo school already exists the script stops. Pass
 *   `--reset` to delete and recreate it, which prisma/demo-reset.ts does in one
 *   transaction and ONLY if the school is the demo school: every person at the
 *   demo's reserved address, nothing tied to a huvudman or another school. A
 *   school with the demo's slug and a real person in it is refused, and nothing
 *   is deleted. A login only the demo school held is kept (docs/DEPLOYMENT.md §37).
 * - All people are fictional. Their `authId`s are random UUIDs that are NOT
 *   linked to Supabase Auth; to sign in as one of them, create the Supabase
 *   user and update the row's authId (see docs/DEPLOYMENT.md §7).
 */
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../src/database/pool-config';
import { DEMO } from '../src/demo-school/demo-guard';
import { describeResult, resetDemoSchool } from './demo-reset';

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('Set DIRECT_URL (or DATABASE_URL) before seeding.');
  process.exit(1);
}

// Prisma 7 takes the connection from a driver adapter; the `datasources`
// override is gone. The API's own helper builds it, so the seed qualifies
// tables with the same schema the API does.
const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset');
  const existing = await prisma.school.findUnique({ where: { slug: DEMO.slug } });
  if (existing && !reset) {
    console.log(`Demo school already exists (${existing.id}). Use --reset to recreate it.`);
    return;
  }
  const result = await resetDemoSchool(prisma);
  console.log(describeResult(result));
  if (result.kind === 'REFUSED') process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
