-- En skola sparar kolumnmallar för sina importer (Kolumnmappning, omgång 12, X2).
--
-- A school's own file rarely has Rastra's headers. X2 lets the person importing point out which column is which
-- field once, and this table keeps that under a name, per school and per kind of import, so that the next file
-- with the same columns is read the same way. The mapping itself is applied in the browser, before anything is
-- sent: the table is only what the browser reads back.
--
-- ## What a row is
--
-- "kind" is one of thirteen: the eleven CSV imports of the import dialog (students, guardians, teachers, classes,
-- teachingGroups, roomTypes, rooms, subjects, requirements, teacherQualifications, teacherDuties), the lokal
-- timplan's own (timplan) and the table of Schemat som tabell (scheduleLessons). It is TEXT with a CHECK and not an
-- enum: the next kinds (X3, S1-S3) replace a CHECK in a short lock, where ALTER TYPE ... ADD VALUE cannot be
-- used in the transaction that first uses the value.
--
-- "placements" is a JSON array of { key, label, field }. "key" is the header with case, spaces, punctuation and
-- diacritics dropped (what the importers already compare headers by), "label" is the header as written, and "field"
-- is one of the kind's fields, or null for a column the school chose not to read. The gateway checks every field
-- against the kind's list (src/import-templates/import-fields.ts) and refuses a header that looks like a
-- personnummer; the database holds the bounds that need no list: an array, at most 200 posts, at most 40 000 bytes.
--
-- A template holds HEADERS, never a value: nothing in a row is about a person, so the table has no key to Users
-- (no inventory kind for the removal dialogs, no gallring) and goes with its school (ON DELETE CASCADE).
--
-- ## The keys
--
-- ("schoolId") -> "Schools" ("id"), CASCADE, as the other school-wide settings. UNIQUE ("schoolId", "kind", "name")
-- (two templates of a kind never share a name) and UNIQUE ("id", "schoolId"), the target a tenant-scoped composite
-- key needs (20270115090000); nothing points at it yet.
--
-- ## Who reads, who writes
--
-- Every administrator of the school reads (as the preview and the export do: a läsare too). Planering writes:
-- the arms ask app.current_user_may('PLANERING', true), as the supervision areas and the lokal timplan do. A
-- teacher, a pupil, a guardian and anon have no arm at all, and nobody but the gateway reaches the table
-- (PostgREST's roles have nothing on it). The update arm's USING admits every administrator so that a row lock for a
-- read keeps working (the area matrix, section 116); its WITH CHECK asks the area and the school, so a row cannot be
-- moved to another school.
--
-- One closing guard (KM_REACH) holds the arms to those four.

CREATE TABLE "ImportMappingTemplates" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"   UUID NOT NULL,
    "kind"       TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "headerRow"  SMALLINT,
    "placements" JSONB NOT NULL,
    "createdAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updatedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "ImportMappingTemplates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportMappingTemplates_kind_check" CHECK ("kind" IN (
        'students', 'guardians', 'teachers', 'classes', 'teachingGroups', 'roomTypes', 'rooms', 'subjects',
        'requirements', 'teacherQualifications', 'teacherDuties', 'timplan', 'scheduleLessons')),
    CONSTRAINT "ImportMappingTemplates_name_check"
        CHECK (char_length(btrim("name")) BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'),
    CONSTRAINT "ImportMappingTemplates_headerRow_check" CHECK ("headerRow" IS NULL OR "headerRow" BETWEEN 1 AND 20),
    CONSTRAINT "ImportMappingTemplates_placements_check" CHECK (
        jsonb_typeof("placements") = 'array'
        AND jsonb_array_length("placements") <= 200
        AND octet_length("placements"::text) <= 40000),
    CONSTRAINT "ImportMappingTemplates_schoolId_kind_name_key" UNIQUE ("schoolId", "kind", "name"),
    CONSTRAINT "ImportMappingTemplates_id_schoolId_key" UNIQUE ("id", "schoolId")
);

CREATE INDEX "ImportMappingTemplates_schoolId_kind_idx" ON "ImportMappingTemplates"("schoolId", "kind");

ALTER TABLE "ImportMappingTemplates"
    ADD CONSTRAINT "ImportMappingTemplates_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ImportMappingTemplates" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    CREATE POLICY "import_mapping_templates_admin_select" ON "ImportMappingTemplates"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "import_mapping_templates_admin_insert" ON "ImportMappingTemplates"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "import_mapping_templates_admin_update" ON "ImportMappingTemplates"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "import_mapping_templates_admin_delete" ON "ImportMappingTemplates"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));

    REVOKE ALL ON "ImportMappingTemplates" FROM app_authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ImportMappingTemplates" TO app_authenticated;
  END IF;

  FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON "ImportMappingTemplates" FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "ImportMappingTemplates" FROM service_role;
  END IF;
  -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
  IF current_setting('server_version_num')::int >= 170000 THEN
    FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE MAINTAIN ON "ImportMappingTemplates" FROM %I', r);
      END IF;
    END LOOP;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- KM_REACH: the arms above and no other. Each names the caller's school and the administrator's role, has no OR
-- and no NOT, and a write asks the area; a name and a command alone would let `USING (true)` through.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  bad text;
  expected constant text[] := ARRAY[
    'import_mapping_templates_admin_select:SELECT', 'import_mapping_templates_admin_insert:INSERT',
    'import_mapping_templates_admin_update:UPDATE', 'import_mapping_templates_admin_delete:DELETE'];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    RETURN;
  END IF;
  SELECT string_agg(p.policyname || ' ' || p.cmd || ' ' || p.roles::text, ', ' ORDER BY p.policyname) INTO bad
    FROM pg_policies p
   WHERE p.schemaname = 'public' AND p.tablename = 'ImportMappingTemplates'
     AND NOT coalesce(
           p.roles = '{app_authenticated}'::name[]
           AND p.permissive = 'PERMISSIVE'
           AND (p.policyname || ':' || p.cmd) = ANY (expected)
           AND (SELECT bool_and(
                         e LIKE '%current_school_id()%'
                         AND e NOT LIKE '% OR %'
                         AND e NOT LIKE '%NOT %'
                         AND e LIKE '%current_user_role()%= ''SCHOOL_ADMIN''::"UserRole"%')
                  FROM unnest(ARRAY[p.qual, p.with_check]) e
                 WHERE e IS NOT NULL)
           AND (p.cmd = 'SELECT' OR coalesce(p.with_check, p.qual) LIKE '%current_user_may(''PLANERING''%true)%'),
         false);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'KM_REACH: these arms reach ImportMappingTemplates beyond the administrators'' read and Planering''s write: %', bad;
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ImportMappingTemplates') <> 4 THEN
    RAISE EXCEPTION 'KM_REACH: ImportMappingTemplates has % arms, not the four above',
      (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ImportMappingTemplates');
  END IF;
END
$$;
