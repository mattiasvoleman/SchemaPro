-- Deferred invitations.
--
-- Creating a person used to send them an invitation email as a side effect,
-- because the Supabase identity was fetched first and its id became authId.
-- That made "add 300 students" and "email 300 students" the same act, with no
-- way to prepare a roster before term starts. Sending is now a separate,
-- explicit action.
--
-- A person created without an invitation keeps a placeholder authId (a random
-- uuid matching no Supabase identity), so every RLS policy that resolves a
-- principal through auth.uid() simply finds nothing for them: they exist in
-- the catalog, and they cannot sign in. Inviting later replaces the
-- placeholder with the real identity id.

ALTER TABLE "Users" ADD COLUMN "invitedAt" TIMESTAMPTZ;

-- Everyone who exists today was invited at the moment they were created —
-- that was the only way to create them. Backfilling from createdAt keeps the
-- UI honest for existing schools instead of showing the whole roster as
-- "never invited".
UPDATE "Users" SET "invitedAt" = "createdAt" WHERE "invitedAt" IS NULL;
