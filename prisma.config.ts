import { defineConfig } from 'prisma/config';

// Prisma 7 reads Migrate's connection only from here; the CLI no longer loads .env.
// DIRECT_URL is the owner/direct connection (docs/DEPLOYMENT.md §2), used by
// `prisma migrate` and the seed and never by the API at runtime.
// No env(): it throws when unset, which would break `prisma generate` in the
// Docker builder and CI. No dotenv: a stray .env must never become a migrate target.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DIRECT_URL ?? '' },
});
