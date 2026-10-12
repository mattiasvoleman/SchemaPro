-- En avbokning minns om den berättade.
--
-- A bulk avbokning (20261011110000) sends no notice per lesson, by design:
-- a week of prao is thirty notices per pupil. Since Notiser som når fram the
-- admin may tick one digest per person in the preview (CANCELLATION_DIGEST,
-- 20261018090000), unticked by default — every cancelled lesson already
-- carries "Inställd: <namn>". When such an avbokning is taken back, the
-- people who were told get a second digest, and the people who were not are
-- not told about a cancellation they never heard of. So the batch records
-- whether it told anybody.
--
-- "notifies": false for every existing batch (none sent a digest) and for a
-- batch made by a gateway that predates the column, which never sends one.
-- Covered by the table's *_admin_all arm like every other column; no new
-- grant, no new policy.

ALTER TABLE "CancellationBatches" ADD COLUMN "notifies" BOOLEAN NOT NULL DEFAULT false;
