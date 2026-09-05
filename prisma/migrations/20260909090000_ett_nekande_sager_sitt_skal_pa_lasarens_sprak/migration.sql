-- A refusal says its reason in the reader's language.
--
-- The solver's refusals are the most important sentences this product writes:
-- a week was not generated, and what the school reads is the whole of what it
-- has to act on. They were English, in a Swedish screen, because the engine
-- wrote them as prose and every layer below carried the prose along.
--
-- The engine now names each sentence with a stable code and sends the values
-- beside it, so the reader renders its own language
-- (optimization-engine/app/messages.py, web/messages/sv.json). The details
-- already ride in a Json column and need nothing here; the SUMMARY and the
-- REFUSED-INPUT error are plain strings, and their code and values need
-- somewhere to sit.
--
-- All four are nullable and nothing is backfilled, deliberately. A run stored
-- before this migration keeps the English it was written with, and the screen
-- falls back to exactly that when a code is missing — which is the same path a
-- sentence takes when the engine ships one the web has not translated yet.
-- Backfilling would mean re-deriving a code from prose, and a code guessed
-- from a sentence is a translation that says something the solver never did.

ALTER TABLE "OptimizationJobs"
    ADD COLUMN "conflictSummaryCode"   TEXT,
    ADD COLUMN "conflictSummaryParams" JSONB,
    ADD COLUMN "errorCode"             TEXT,
    ADD COLUMN "errorParams"           JSONB;
