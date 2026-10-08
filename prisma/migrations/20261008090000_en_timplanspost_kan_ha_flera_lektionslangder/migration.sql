-- En timplanspost kan ha flera lektionslängder.
--
-- A TeachingRequirement says lessonsPerWeek × minutesPerLesson: one length for
-- every lesson a class has in a subject. That is the first wall a grundskola
-- schemaläggare hits. Idrott is 1 × 80 + 1 × 40 in most schools, matematik
-- 2 × 60 + 1 × 40 in many, and the timplan's 175 min/vecka has no uniform
-- answer at all: generate-requirements rounds it up to 3 × 60 and reports a
-- five-minute surplus the school never asked for. Every leader states it on
-- the post (Skola24's längduppdelning, Untis' double periods, aSc's
-- single/double, Lectio's dobbeltlektion). This migration lets one row say it.
--
-- ## One column: the lessons' lengths, longest first, empty when uniform
--
-- "lessonLengths" INTEGER[] NOT NULL DEFAULT '{}'. {80,40} is 1 × 80 + 1 × 40,
-- {60,60,55} is 2 × 60 + 1 × 55. A row whose lessons are all one length — every
-- row that exists today — keeps '{}' and is said by its two scalars exactly as
-- before. ADD COLUMN with a constant default rewrites no table (PostgreSQL 11+
-- keeps it in the catalog), and no backfill is needed: '{}' is the truth for
-- every row, since nobody has been able to say otherwise.
--
-- THE SCALARS KEEP THEIR MEANING. lessonsPerWeek stays the number of lessons,
-- which is what it always meant, and minutesPerLesson becomes the LONGEST
-- length on a split row. So every reader that counts lessons (the solver's
-- demand, the peak week, "N lektioner") stays exactly right without a change,
-- and every reader that asks whether a lesson fits somewhere (a frame, a rast,
-- a day) sees the length that binds and stays on the safe side. Only the
-- product lessonsPerWeek × minutesPerLesson over-counts a split row, and every
-- reader of the product now reads src/common/lesson-lengths.ts instead.
--
-- Why one row with a list, and not the alternatives:
--
--   * Two linked rows (idrott 80 and idrott 40) break the unique (school, year,
--     group, subject) slot, and with it everything keyed on it: locked-lesson
--     coverage, the solver's previous-lesson hints, CSV upsert, the rollover's
--     keys. And the engine's spread penalty is keyed on the requirement, so
--     two ids would let 80 and 40 land on the same day for free — the one
--     thing the school wants spread.
--   * A child table of (minutes, count) needs three policies, a composite
--     (requirementId, schoolId) key, the RLS sweep and the probe; and its
--     counts agreeing with the parent's lessonsPerWeek needs a deferred
--     constraint trigger, because a PostgREST writer reaches the two tables in
--     two requests that can leave them disagreeing in between.
--   * Two extra columns (a second length and its count) are plain CHECKs, but
--     bake "two lengths" into the schema, and still need the cross-column
--     agreement below.
--
-- The list is one column on a table whose policies are row predicates on
-- schoolId and a role, none naming a column (20260930090000's paragraph
-- applies verbatim): no new policy, no new key, no new grant — the column
-- inherits the table's. One PATCH writes the list and the scalars at once.
--
-- ## Canonical form, by CHECK
--
-- The DTO and the service write a canonical row, but PostgREST writes reach the
-- table without meeting either: a SCHOOL_ADMIN's own key can PATCH
-- "TeachingRequirements" directly. A list that contradicts its scalars is not
-- a cosmetic error — the solver is sent the list and the load report charges
-- the list, while every untouched reader trusts the scalars — so the row is
-- refused unless it has exactly one representation per meaning:
--
--   * '{}' always passes: the row is uniform and the scalars say it.
--   * Otherwise the list is one-dimensional, starts at subscript 1, holds no
--     NULL, has exactly lessonsPerWeek entries (at most 40, the DTO's bound),
--     starts with minutesPerLesson, is sorted longest first, every entry is
--     15..240 on the five-minute grid, and it has two or three DIFFERENT
--     lengths. {60,60} is refused: it is a uniform row written the other way,
--     and two spellings of one row are two answers to "is this row split?".
--
-- 15..240 and the grid are the engine's AnonymousRequirement bounds and its
-- SLOT_MINUTES; src/common/solver-grid.ts names this function as the third
-- place the grid lives. Three distinct lengths admit the 80 + 60 + 40 schemes;
-- more is a list of lessons rather than a split of one, and the matrix cell
-- "a×b+c×d+e×f" is already as wide as a cell gets. The uniform scalars get no
-- CHECK here: there is none today, only the DTO, and adding one needs an audit
-- of live rows first.
--
-- THE CHECK CALLS A FUNCTION, because sortedness and the distinct count need
-- unnest, and a CHECK cannot hold a subquery. app.lesson_lengths_are_canonical
-- is LANGUAGE sql IMMUTABLE PARALLEL SAFE with a pinned search_path, reads no
-- table, and is wrapped in coalesce(…, false): a CHECK passes on NULL, and
-- bool_and and count(DISTINCT) ignore NULL elements, so without the explicit
-- array_position(…, NULL) test and the coalesce {80,40,NULL} at (3, 80) would
-- pass as two distinct lengths. It is deliberately NOT STRICT for the same
-- reason: a STRICT function answers NULL to a NULL argument, and NULL passes.
--
-- EXECUTE STAYS WITH PUBLIC, unlike the trigger functions of 20261006120000
-- onwards, and on purpose. Those are fired, never called, and revoking EXECUTE
-- costs nothing; a CHECK's function is executed AS THE WRITER, so revoking it
-- would turn every admin PostgREST write and every gateway write of the table
-- into "permission denied for function" — a 500 for every school. It is not
-- SECURITY DEFINER, so it runs with the writer's rights and reads nothing; its
-- answer is computable from its own three arguments, so calling it directly
-- reveals nothing a caller did not hand it. It lives in "app" beside the
-- identity helpers, where every API role already has USAGE.
--
-- A violation is SQLSTATE 23514, which rethrowPrismaError's NAMED_CHECKS turns
-- into a 400 naming the field. The CHECK validates the existing rows as it is
-- added; they are all '{}', so the first arm answers each at once.
--
-- ## Deploy order
--
-- 1. This migration. A database with the column under the old gateway is
--    safe: the old gateway writes no list, every row stays '{}', and no split
--    row can exist until the new API writes one.
-- 2. The engine. The gateway sends "lessonLengths" on a requirement only when
--    its remaining lessons have two or more lengths, and the engine's Pydantic
--    base is extra="forbid", so an old engine refuses such a payload with a 422
--    rather than placing every lesson at the longest length.
-- 3. The gateway and the web.
--
-- ## Rolling the gateway back
--
-- Safe only while no row is split. Once one is, the old gateway reads the
-- scalars alone: its proxy selects no "lessonLengths" and sends idrott
-- 1 × 80 + 1 × 40 as 2 × 80, its count-only guard accepts the 160 minutes,
-- and an old PATCH of lessonsPerWeek alone on that row fails this CHECK with a
-- 23514 its NAMED_CHECKS does not know (an unmapped error, not a 400). Before
-- rolling back, list the split rows (WHERE cardinality("lessonLengths") > 0),
-- decide each one's uniform scalars, and write them together with
-- "lessonLengths" = '{}'. The column and the CHECK can stay: the old gateway
-- never writes the list, so '{}' keeps every row valid.

ALTER TABLE "TeachingRequirements"
    ADD COLUMN "lessonLengths" INTEGER[] NOT NULL DEFAULT '{}';

CREATE FUNCTION app.lesson_lengths_are_canonical(lengths integer[], lessons integer, longest integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(
    cardinality(lengths) = 0
    OR (
      array_ndims(lengths) = 1
      AND array_lower(lengths, 1) = 1
      AND array_position(lengths, NULL) IS NULL
      AND cardinality(lengths) = lessons
      AND lessons <= 40
      AND lengths[1] = longest
      AND (SELECT bool_and(x BETWEEN 15 AND 240 AND x % 5 = 0) FROM unnest(lengths) AS u(x))
      AND (SELECT bool_and(a >= b)
             FROM unnest(lengths[1:cardinality(lengths) - 1], lengths[2:]) AS p(a, b))
      AND (SELECT count(DISTINCT x) BETWEEN 2 AND 3 FROM unnest(lengths) AS u(x))
    ),
    false
  )
$$;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_lesson_lengths_are_canonical"
    CHECK (app.lesson_lengths_are_canonical("lessonLengths", "lessonsPerWeek", "minutesPerLesson"));
