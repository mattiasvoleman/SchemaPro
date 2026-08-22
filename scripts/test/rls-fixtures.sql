-- Fixtures for scripts/test/rls-policies.sql. Run as the database OWNER, since
-- it must create rows across two tenants:
--
--   docker compose exec -T db psql -U postgres -d schemapro \
--     -v ON_ERROR_STOP=1 -f scripts/test/rls-fixtures.sql
--
-- Assumes `npm run db:seed` has already created the demo school. Adds a second
-- school plus one user, so the policy tests can prove a principal scoped to the
-- first school cannot see the second. Without a second tenant, every isolation
-- assertion would pass vacuously.
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

INSERT INTO "Schools" (name, slug, timezone, "updatedAt")
VALUES ('RLS Fixture School', 'rls-fixture-school', 'Europe/Stockholm', now())
ON CONFLICT (slug) DO NOTHING;

-- Users has no unique constraint beyond the primary key, so guard with NOT
-- EXISTS rather than ON CONFLICT to stay idempotent.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture@example.invalid', 'Fixture', 'User', 'TEACHER',
       '00000000-0000-4000-8000-000000000001', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000001'
  );

-- A PUPIL in the second school. The cross-tenant guardian assertion needs a
-- real child to try to claim; without one it would pass while proving nothing,
-- which is the failure mode every fixture here exists to avoid.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-pupil@example.invalid', 'Fixture', 'Pupil', 'STUDENT',
       '00000000-0000-4000-8000-000000000002', true, now()
FROM "Schools" s
WHERE s.slug = 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000002'
  );

-- A DEACTIVATED SCHOOL_ADMIN in the FIRST school — the principal the identity
-- helpers must now resolve to nothing. An admin rather than a teacher because
-- an admin is the worst case: before the helpers required `isActive`, a
-- deactivated one kept full read and write access to the school and could set
-- their own `isActive` back to true through `users_admin_all`.
--
-- They belong to the first school on purpose. The assertions also prove the
-- other half — that an ACTIVE admin of that same school still sees this row
-- and can still reactivate it, which is the only way back for a locked-out
-- colleague.
INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
SELECT s.id, 'rls-fixture-inactive@example.invalid', 'Fixture', 'Inactive', 'SCHOOL_ADMIN',
       '00000000-0000-4000-8000-000000000003', false, now()
FROM "Schools" s
WHERE s.slug <> 'rls-fixture-school'
  AND NOT EXISTS (
    SELECT 1 FROM "Users" WHERE "authId" = '00000000-0000-4000-8000-000000000003'
  )
ORDER BY s."createdAt" LIMIT 1;

-- The reactivation assertion flips this row and rolls back, so a completed run
-- leaves it inactive. A run killed mid-transaction would not, and the next run
-- would then assert "an inactive principal sees nothing" against an active
-- user and pass while proving nothing. Repair it rather than assume it.
UPDATE "Users" SET "isActive" = false, "updatedAt" = now()
 WHERE "authId" = '00000000-0000-4000-8000-000000000003' AND "isActive";

-- An active key for the FIRST school, so the key-lookup assertions have
-- something to find, and a revoked one so revocation can be asserted.
INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", "createdAt")
SELECT id, 'rls-fixture-active',
       encode(sha256('rls-fixture-active-key'::bytea), 'hex'), now()
FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1
ON CONFLICT ("keyHash") DO NOTHING;

INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", "createdAt", "revokedAt")
SELECT id, 'rls-fixture-revoked',
       encode(sha256('rls-fixture-revoked-key'::bytea), 'hex'), now(), now()
FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1
ON CONFLICT ("keyHash") DO NOTHING;

-- The policy tests run as the unprivileged role, which by design cannot see
-- any school until a principal is set — so it cannot discover these ids for
-- itself. The runner reads them here (as owner) and passes them in with -v.
\pset tuples_only on
\pset format unaligned
SELECT id FROM "Schools" WHERE slug <> 'rls-fixture-school' ORDER BY "createdAt" LIMIT 1;
