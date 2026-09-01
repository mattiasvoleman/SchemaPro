-- A room rule gains a stage, and a way to be more than a wish.
--
-- Today a RoomPreference says "lessons of subject S should land in room set R,
-- at cost W per miss" — school-wide, every lesson of that subject, no scoping
-- of any kind. Two dimensions were missing and this migration adds both.
--
-- THE STAGE IS A FIX, NOT A FEATURE. Preferences bucket by subject alone, and
-- every match appends its own penalty term. A school writing "matte ->
-- Optimisten 4" and "matte -> Optimisten 4 + Bryggan 3" therefore makes EVERY
-- maths lesson in the building, år 9 included, pay both weights, and biases all
-- maths toward the intersection of the two. Two disjoint wishes leave a
-- guaranteed penalty floor, because the room-class encoding's AddExactlyOne
-- makes the two "satisfied" literals mutually exclusive. Adding the years is
-- what lets a rule mind its own business.
--
-- THE LOCK IS GENUINELY NEW. Nothing in this schema can say "år 4's maths
-- happens in Optimisten 4, full stop". `Subject.requiredRoomTypeId` is
-- school-wide and names a TYPE; `Room.minGradeLevel`/`maxGradeLevel` fences a
-- ROOM to a stage, which binds that room's every subject — so allowing år 5
-- into Optimisten 4 means widening the fence to 4-5, and the år-4 rule leaks
-- immediately.
--
-- MATCHING IS CONTAINMENT, not overlap. A rule reaches a requirement when the
-- requirement's WHOLE span sits inside the rule's. This copies _grade_allowed
-- rather than _grade_span_overlaps, and the two answer differently on purpose:
-- a room decides where a group may GO, a reservation only decides who must be
-- left alone. Under overlap an åk 7-9 lock would seize a teaching group
-- spanning 6-7 — a real shape, since spans come from members' home classes —
-- and drag year-6 pupils into a högstadie room. Not applying a rule is
-- survivable; applying it to a group half outside the span is not.
--
-- HOW TWO LOCKS COMPOSE: the narrowest span wins, and equally narrow rules are
-- alternatives (their room sets union). NOT intersection, which is what the
-- FrameTimes migration chose for its own kind of bound: a frame is an interval
-- and intersects continuously, while a room set goes empty in ONE step. "Matte
-- åk 4-6 -> Bryggan 3" plus "matte åk 4 -> Optimisten 4" would intersect to
-- nothing, and a whole subject x stage becomes unschedulable from two sentences
-- a school would reasonably write. Under specificity the second sentence reads
-- as what a school means by it: an exception to the first. NOT a plain union
-- either — that is the LunchServings rule — because one broad lock would then
-- silently weaken every narrow lock already written.
--
-- Wishes stay ADDITIVE and unchanged: each matching wish charges its own price.
-- Merging them would make the strength slider meaningless the moment two
-- overlap, and would change timetables for rows nobody edited.
--
-- NO UNIQUE KEY. Equal-width locks union, so duplicate rows are harmless — a
-- strict improvement over today, where a duplicate WISH silently doubles the
-- strength an admin set on the slider. A parent-only key could not see
-- RoomPreferenceRooms anyway.
--
-- EVERY EXISTING ROW IS UNTOUCHED: `kind` defaults to WISH, both span columns
-- are null, and null means "every year" — which is exactly what a row means
-- today.

CREATE TYPE "RoomRuleKind" AS ENUM ('WISH', 'LOCK');

ALTER TABLE "RoomPreferences"
    ADD COLUMN "kind" "RoomRuleKind" NOT NULL DEFAULT 'WISH',
    ADD COLUMN "minGradeLevel" INTEGER,
    ADD COLUMN "maxGradeLevel" INTEGER;

-- Both bounds or neither, ordered, and inside the years a school has. Copied
-- body and name from SchoolBreaks (20260825090000) rather than rewritten: the
-- shape guards the ordering test with `IS NULL OR (…)`, and copying only the
-- names is exactly the drift these constraints exist to prevent.
ALTER TABLE "RoomPreferences"
    ADD CONSTRAINT "RoomPreferences_grade_span_is_whole" CHECK (
        ("minGradeLevel" IS NULL) = ("maxGradeLevel" IS NULL)
    ),
    ADD CONSTRAINT "RoomPreferences_grade_span_is_ordered" CHECK (
        "minGradeLevel" IS NULL OR (
            "minGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" BETWEEN 0 AND 12
            AND "maxGradeLevel" >= "minGradeLevel"
        )
    );

-- Both are trivially true on every existing row, which is what makes adding
-- them to a populated table safe.

-- `weight` stays NOT NULL DEFAULT 5 and simply never reaches the objective for
-- a LOCK. Deliberately NOT made nullable to mean "hard": the engine reads
-- `preference.weight or weights.room_preference`, so any falsy weight would
-- silently become its WEAKEST wish rather than a restriction.

CREATE INDEX "RoomPreferences_schoolId_kind_idx" ON "RoomPreferences"("schoolId", "kind");
