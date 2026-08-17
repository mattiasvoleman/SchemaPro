-- School-owned room types.
--
-- Room type was a fixed Prisma enum (CLASSROOM, LABORATORY, GYMNASIUM,
-- AUDITORIUM, WORKSHOP, OTHER). Swedish schools need types the enum never had
-- — hemkunskapssal, trä- och metallslöjd, textilslöjd, musiksal — and every
-- addition required a developer, a migration and a deploy. Types are now rows
-- a school owns and edits itself.
--
-- The scheduler matches room type EXACTLY (room.type == requirement type), so
-- a mistyped free-text label would silently make a subject unschedulable and
-- surface as "No room satisfies capacity/type". A referenced row makes that
-- failure impossible by construction, which is why this is a table and not a
-- string column.
--
-- Existing data is preserved: every enum value actually IN USE at a school
-- becomes a row for that school, and Rooms/Subjects are repointed at it before
-- the old columns are dropped.

-- ---------------------------------------------------------------- table ----
CREATE TABLE "RoomTypes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    -- Stable identity for the six values that used to be enum members, so a
    -- renamed "Klassrum" is still recognisable as the classroom type. NULL
    -- for types a school creates itself.
    "legacyKey" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoomTypes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RoomTypes_schoolId_name_key" ON "RoomTypes"("schoolId", "name");
CREATE INDEX "RoomTypes_schoolId_idx" ON "RoomTypes"("schoolId");

ALTER TABLE "RoomTypes"
    ADD CONSTRAINT "RoomTypes_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ------------------------------------------------------------- backfill ----
-- Swedish labels, because the product is Swedish-first and these strings are
-- what an administrator sees in the picker from day one.
INSERT INTO "RoomTypes" ("schoolId", "name", "legacyKey")
SELECT DISTINCT
    s."id",
    CASE t.key
        WHEN 'CLASSROOM'  THEN 'Klassrum'
        WHEN 'LABORATORY' THEN 'Laborationssal'
        WHEN 'GYMNASIUM'  THEN 'Gymnastiksal'
        WHEN 'AUDITORIUM' THEN 'Aula'
        WHEN 'WORKSHOP'   THEN 'Verkstad'
        ELSE 'Övrigt'
    END,
    t.key
FROM "Schools" s
CROSS JOIN (
    VALUES ('CLASSROOM'), ('LABORATORY'), ('GYMNASIUM'),
           ('AUDITORIUM'), ('WORKSHOP'), ('OTHER')
) AS t(key)
WHERE
    -- Only materialise a legacy type the school actually uses, so nobody
    -- inherits five irrelevant rows. CLASSROOM is always created: it is the
    -- column default and the natural starting point for a new room.
    t.key = 'CLASSROOM'
    OR EXISTS (
        SELECT 1 FROM "Rooms" r
        WHERE r."schoolId" = s."id" AND r."type"::text = t.key
    )
    OR EXISTS (
        SELECT 1 FROM "Subjects" sub
        WHERE sub."schoolId" = s."id" AND sub."requiredRoomType"::text = t.key
    );

-- The types Swedish compulsory schools actually need, seeded for every school
-- so the gap that prompted this change is closed on upgrade, not only for new
-- schools. Skipped where a school already coined the same name.
INSERT INTO "RoomTypes" ("schoolId", "name", "legacyKey")
SELECT s."id", v.name, NULL
FROM "Schools" s
CROSS JOIN (
    VALUES ('Hemkunskapssal'), ('Trä- och metallslöjd'), ('Textilslöjd'),
           ('Musiksal'), ('Bildsal')
) AS v(name)
ON CONFLICT ("schoolId", "name") DO NOTHING;

-- ------------------------------------------------------------- repoint ----
ALTER TABLE "Rooms" ADD COLUMN "roomTypeId" UUID;
ALTER TABLE "Subjects" ADD COLUMN "requiredRoomTypeId" UUID;

UPDATE "Rooms" r
SET "roomTypeId" = rt."id"
FROM "RoomTypes" rt
WHERE rt."schoolId" = r."schoolId" AND rt."legacyKey" = r."type"::text;

UPDATE "Subjects" sub
SET "requiredRoomTypeId" = rt."id"
FROM "RoomTypes" rt
WHERE rt."schoolId" = sub."schoolId"
  AND sub."requiredRoomType" IS NOT NULL
  AND rt."legacyKey" = sub."requiredRoomType"::text;

ALTER TABLE "Rooms"
    ADD CONSTRAINT "Rooms_roomTypeId_fkey"
    FOREIGN KEY ("roomTypeId") REFERENCES "RoomTypes"("id")
    -- A type still used by a room must not vanish under the scheduler.
    ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Subjects"
    ADD CONSTRAINT "Subjects_requiredRoomTypeId_fkey"
    FOREIGN KEY ("requiredRoomTypeId") REFERENCES "RoomTypes"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Rooms_roomTypeId_idx" ON "Rooms"("roomTypeId");
CREATE INDEX "Subjects_requiredRoomTypeId_idx" ON "Subjects"("requiredRoomTypeId");

-- --------------------------------------------------------- drop the enum ----
ALTER TABLE "Rooms" DROP COLUMN "type";
ALTER TABLE "Subjects" DROP COLUMN "requiredRoomType";
DROP TYPE "RoomType";

-- ------------------------------------------------------------------ RLS ----
ALTER TABLE "RoomTypes" ENABLE ROW LEVEL SECURITY;

-- Every member reads them: a teacher's room picker and the timetable views
-- render type names.
CREATE POLICY "room_types_member_select" ON "RoomTypes"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()));

CREATE POLICY "room_types_admin_all" ON "RoomTypes"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- The API connects as a non-owner role, which inherits nothing automatically.
GRANT SELECT, INSERT, UPDATE, DELETE ON "RoomTypes" TO "app_authenticated";
