-- Ett block kan ligga på ett annat blocks tider.
--
-- "Dela terminsvis i halvklass" (TermHalvesService) replaces 7A's slöjd with
-- four posts on the class's halves: in the autumn 7A:1 reads textilslöjd and
-- 7A:2 trä- och metallslöjd, in the spring the other way round. The autumn's
-- two posts are one parallel block and the spring's another, because a
-- block's posts have the same weeks (TB409). The generator plans one week and
-- has no terms, so it gave each block its own times and held both all year:
-- 7A had slöjd twice a week, and one of the two stood empty each term. The
-- manual told the school to drag the spring block onto the autumn's times and
-- lock both.
--
-- ## TeachingBlocks."sameTimesAsBlockId"
--
-- The block whose times this one takes: the spring block names the autumn
-- block. Null, the default, is a block placed on its own, which is every
-- block of every school until a term split writes one. The generator sends
-- only the named block's posts and writes each of this block's posts at the
-- times the named block's post IN THE SAME SUBJECT got, in its own weeks,
-- with its own group and teachers (optimization-proxy.service.ts,
-- same-times.ts). Whether the two still fit together — the same subjects on
-- the same groups, the same lessons, weeks that never meet — is judged where
-- the week is generated, as a block's teachers and pupils are: rosters,
-- teachers and periods change after a block is written.
--
-- THE SAME YEAR AND SCHOOL, by the composite key the requirements' "blockId"
-- uses, (sameTimesAsBlockId, academicYearId, schoolId) onto (id,
-- academicYearId, schoolId): a foreign-key check runs as the referenced
-- table's owner with row security off, so a key on the id alone would accept
-- another school's block, or last year's.
--
-- ON DELETE SET NULL ("sameTimesAsBlockId"): deleting the named block leaves
-- this one placed on its own, as deleting a block leaves its posts. The
-- column list, because the plain SET NULL would null all three columns of the
-- key and two of them are NOT NULL; Prisma cannot say it (schema.prisma says
-- SetNull), as for "blockId" in 20261024090000.
--
-- NOT ITSELF, and ONE BLOCK ON A BLOCK'S TIMES (a unique index): a term split
-- pairs one spring with one autumn. A chain — a block on the times of a block
-- that is on a third's — is refused where the week is generated
-- (BLOCK_SAME_TIMES_DIFFER), since no writer of the API makes one.
--
-- ## Who may read and write
--
-- Unchanged: table grants reach a new column, and the policies are the
-- table's. The web reads TeachingBlocks through PostgREST (authenticated
-- SELECT) and writes through the gateway.
--
-- ## Beside the live API
--
-- The API before this names its columns and never this one, so it writes
-- blocks placed on their own and generates every block as it always did. ADD
-- COLUMN (nullable, no default: nothing is rewritten), the key, the check and
-- the index take TeachingBlocks ACCESS EXCLUSIVE, and the table is live: a
-- post joining a block locks its block's row in the TB409 trigger. The lock is
-- taken NOWAIT, again 50 ms later while a request holds it, and after 30 s the
-- migration stops with nothing done (policy-migration-lock-order). Prisma
-- then records it as failed (P3018, and P3009 at every deploy after), and
-- `prisma migrate resolve --rolled-back
-- 20261128090000_ett_block_kan_ligga_pa_ett_annat_blocks_tider` comes before
-- it is run again. The table holds a school's handful of blocks.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "TeachingBlocks" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'TeachingBlocks was not free in 30 s: nothing is changed, run the migration again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

ALTER TABLE "TeachingBlocks" ADD COLUMN "sameTimesAsBlockId" UUID;

ALTER TABLE "TeachingBlocks"
    ADD CONSTRAINT "TeachingBlocks_sameTimesAsBlockId_academicYearId_schoolId_fkey"
    FOREIGN KEY ("sameTimesAsBlockId", "academicYearId", "schoolId")
    REFERENCES "TeachingBlocks"("id", "academicYearId", "schoolId")
    ON DELETE SET NULL ("sameTimesAsBlockId") ON UPDATE NO ACTION;

ALTER TABLE "TeachingBlocks"
    ADD CONSTRAINT "TeachingBlocks_sameTimesAs_is_another_block"
    CHECK ("sameTimesAsBlockId" IS NULL OR "sameTimesAsBlockId" <> "id");

-- Also the index the key's SET NULL scans when a named block is deleted.
CREATE UNIQUE INDEX "TeachingBlocks_sameTimesAsBlockId_key" ON "TeachingBlocks"("sameTimesAsBlockId");
