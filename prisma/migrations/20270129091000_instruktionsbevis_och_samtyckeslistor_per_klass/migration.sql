-- Instruktionsbevis och samtyckeslistor per klass.
--
-- Checklistor (F5) ger skolan två listor som lärare och mentorer idag för på
-- papper och i egna kalkylblad:
--
--   * Instruktionsbevis. Skolan har mallar per ämne och moment (slöjdens
--     maskiner, NO:s laborationssäkerhet, idrottens moment). Läraren bockar per
--     elev med datum och vem som gav instruktionen. Ett bevis gäller eleven och
--     inte klassen: det följer eleven när hen byter klass och genom årsrullningen.
--   * Samtyckeslistor per klass (fotografering, publicering, utflykter).
--     Samtycket kommer från vårdnadshavaren. Personal skriver in det från papper
--     (vem och när), eller ber om det i appen och på webben genom Kvittens
--     (F4, 20270117091000) med regeln ALL. Det finns inget andra
--     bekräftelseflöde här: en vårdnadshavare bekräftar i Kvittens, och när den
--     sista som frågades bekräftat skriver en trigger in samtycket.
--     Ett samtycke kan återkallas, och återkallandet gäller från det ögonblick
--     det skrivs.
--
-- ## Fem tabeller
--
--   InstructionTemplates  skolans mallar: ämne (valfritt) och moment. Inga
--                         personuppgifter. Har en mall bevis avvecklas den
--                         (active = false), aldrig raderas: ingen roll har DELETE.
--   InstructionProofs     att en elev fått instruktion i en mall, ett datum, av en
--                         person. Skrivs en gång. En bock som gjorts fel upphävs
--                         (voidedAt) och står kvar som bevis för vad som skrevs.
--   ConsentLists          en lista för en klass: vad vårdnadshavarna ombeds samtycka
--                         till, i de ord de ser. Klassens namn stämplas, så listan
--                         går att läsa när klassen inte finns.
--   ConsentEntries        ett svar om en elev på en lista, i den ordning de gavs:
--                         GRANTED, DECLINED (vårdnadshavaren sa nej) eller WITHDRAWN
--                         (ett samtycke som tagits tillbaka). Bara tillägg: vad som
--                         gäller nu är det senaste svaret, de tidigare är historiken.
--   ConsentAsks           en Kvittensförfrågan (regel ALL) som bad om en listas samtycke.
--
-- ## Vem som är klar lagras inte; vad som gäller nu är det senaste svaret
--
-- En elev har samtycke när det senaste svaret på listan är GRANTED. Ett svar skrivs
-- på två sätt: av personal (source REGISTERED, med recordedById och recordedAt satta av
-- databasen, och givenOn: datumet på pappret) eller av app.consent_from_kvittens när
-- den sista vårdnadshavare som en Kvittensförfrågan frågade bekräftat den (source
-- KVITTENS). Kvittensens svar skrivs alltså ner vid bekräftelsen och är inte något som
-- räknas fram senare: förfrågan gallras med skolans val för NOTIFICATIONS, och samtycket
-- får inte försvinna med den. En vårdnadshavare vars vårdnad upphört håller inte upp
-- ALL (F4:s regel, app.ack_status_raw); en bekräftelse som bara är "klar" för att den
-- andra vårdnadshavarens koppling tagits bort skrivs inte in: det är en bekräftelse
-- som ingen gjorde. Och en återkallelse eller ett nej som personal skrivit efter att
-- förfrågan gjordes (WITHDRAWN, DECLINED) upphävs inte av den sista bekräftelsen av
-- den förfrågan: "alla har någon gång bekräftat" är inte "alla samtycker nu". Eleven
-- står som återkallad tills skolan frågar om, med en ny förfrågan.
--
-- ## Vem som får vad
--
--   Administratör med Drift   mallar, bevis och listor för skolans alla elever.
--   Lärare                    bockar bevis för elever i sina egna grupper och
--                             lektioner (app.checklist_taught_ids: lektionerna i det
--                             aktiva läsåret där hen är lärare eller medlärare, med
--                             deras klasser, undervisningsgrupper och namngivna
--                             elever), och ser dem och sina mentorselevers.
--                             Samtycken skriver en lärare bara för sina
--                             mentorselever (samma mentorsdefinition som Kvittens
--                             och frånvarobevakningen, app.ack_mentee_ids), och ser
--                             dem för elever hen undervisar eller är mentor för.
--   Vårdnadshavare, elev      ingenting: ingen policy ger dem en rad. Ett samtycke
--                             en vårdnadshavare gett syns för dem som
--                             kvittensen i Meddelanden, inte som en lista.
--
-- Allt går genom gatewayen, som loggar läsningen; ingen arm är öppen för PostgREST
-- (bara app_authenticated). Policyerna jämför mot id-matriser som byggs en gång per
-- uttalande, som initplan (`"studentId" = ANY ((select app.f())::uuid[])`), och inte
-- en funktion per rad.
--
-- Skyddad identitet: a teacher cannot read the marks (they are the administrators' register), so the sheet for paper is built by
-- the gateway, which asks app.checklist_protected_ids, leaves the marked pupils out of the sheet and counts them. The screen names them.
--
-- ## Gallring: CHECKLISTS
--
-- Beslut: bevisen och samtyckena sparas så länge eleven går på skolan och därefter den tid
-- skolan väljer (en ny gallringstyp, 20270129090000). Förvalet är "ej beslutat", och då
-- gallras ingenting. Med en tid gallras det som hör till en elev som slutat för mer än
-- den tiden sedan (Users.deactivatedAt), och en lista när den är äldre än tiden och
-- tom. En elev som går kvar har aldrig något som förfaller, hur lång tid som än valts.
-- Ett instruktionsbevis kan behövas för arbetsmiljöansvaret efter att eleven slutat;
-- därför är förvalet att behålla. Tiden för "Avgångna personer" avgör hur länge en
-- bock går att knyta till en person: sedan eleven pseudonymiserats finns beviset kvar
-- men namnet är borta. En skola som vill kunna visa vem som fick instruktion väljer
-- därför minst lika lång tid för båda.
--
-- app.gallring_due och app.gallring_purge nedan är kropparna som Elevens lektion för dagen
-- (D7, 20270122091000) lämnade (som bär Kvittens, Krisläges, Rapporteringsgrads,
-- Frånvarobevakningens, Vikariefrågans, Skyddad identitets och elevflyttarnas
-- LessonPupilMoves grenar) med en gren märkt "checklistor"; en senare release som
-- skriver om funktionerna igen måste bära varje gren. app.gallring_pseudonymise är orörd.
--
-- ## Vid sidan av det API som körs
--
-- Produktionen kör migreringen medan API:et före den betjänar förfrågningar. Ingen
-- befintlig tabell får en kolumn. De nya nycklarna tar Schools, Users, StudentGroups,
-- Subjects och AckRequests i SHARE ROW EXCLUSIVE, och triggern på AckReceipts tar den
-- tabellen i samma läge: det blockerar skrivningar (inte läsningar och inte den KEY SHARE
-- en främmande nyckels kontroll tar) så länge filen går. Låsen tas tillsammans, NOWAIT, i en
-- loop: en vägran rullar tillbaka delbehandlingen med vad den fått och försöker igen
-- 50 ms senare, och den väntar aldrig med ett lås i handen. Efter 30 s stannar den med
-- ingenting gjort och kan köras om (prisma migrate resolve --rolled-back, sedan deploy).
-- lock_timeout begränsar varje väntan ingen räknat med. Det gamla API:et känner ingen av
-- tabellerna. Triggern på AckReceipts körs vid varje UPDATE av den (bekräftelse och
-- påminnelse); den gör ingenting för en förfrågan som inte hör till en lista.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "StudentGroups" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Subjects" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AckRequests" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "AckReceipts" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, StudentGroups, Subjects, AckRequests and AckReceipts were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270129091000_instruktionsbevis_och_samtyckeslistor_per_klass" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

CREATE TYPE "ConsentEntryKind" AS ENUM ('GRANTED', 'DECLINED', 'WITHDRAWN');
CREATE TYPE "ConsentEntrySource" AS ENUM ('REGISTERED', 'KVITTENS');

-- ---------------------------------------------------------------------------
-- InstructionTemplates
-- ---------------------------------------------------------------------------

CREATE TABLE "InstructionTemplates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    -- Ämnet mallen hör till; NULL för en mall som inte hör till något (eller när ämnet tagits bort).
    "subjectId" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstructionTemplates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InstructionTemplates_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "InstructionTemplates_a_title_is_one_to_120_characters" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "InstructionTemplates_a_description_is_one_to_2000_characters" CHECK ("description" IS NULL OR char_length(btrim("description")) BETWEEN 1 AND 2000)
);

-- Ett moment heter en sak i ett ämne.
CREATE UNIQUE INDEX "InstructionTemplates_one_title_per_subject"
    ON "InstructionTemplates"("schoolId", coalesce("subjectId", '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim("title")));
CREATE INDEX "InstructionTemplates_subjectId_schoolId_idx" ON "InstructionTemplates"("subjectId", "schoolId");

ALTER TABLE "InstructionTemplates"
    ADD CONSTRAINT "InstructionTemplates_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- SET NULL på kolumnen ensam: en vanlig SET NULL på nyckeln (subjectId, schoolId) skulle tömma schoolId också.
ALTER TABLE "InstructionTemplates"
    ADD CONSTRAINT "InstructionTemplates_subjectId_schoolId_fkey" FOREIGN KEY ("subjectId", "schoolId")
    REFERENCES "Subjects"("id", "schoolId") ON DELETE SET NULL ("subjectId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- InstructionProofs
-- ---------------------------------------------------------------------------

CREATE TABLE "InstructionProofs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    -- Dagen instruktionen gavs, i skolans dygn. Inte i framtiden (triggern).
    "instructedOn" DATE NOT NULL,
    -- Den som gav instruktionen: den som bockar, om hen inte anger en kollega (triggern).
    "instructorId" UUID,
    -- Den som skrev bocken och när: databasens, inte skrivarens.
    "recordedById" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    -- Upphävd: skriven av app.checklist_void_proof och inget annat.
    "voidedAt" TIMESTAMPTZ(6),
    "voidedById" UUID,
    "voidReason" TEXT,

    CONSTRAINT "InstructionProofs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "InstructionProofs_the_date_is_this_century" CHECK ("instructedOn" >= DATE '2000-01-01'),
    CONSTRAINT "InstructionProofs_a_note_is_one_to_500_characters" CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 500),
    CONSTRAINT "InstructionProofs_a_reason_is_one_to_300_characters" CHECK ("voidReason" IS NULL OR char_length(btrim("voidReason")) BETWEEN 1 AND 300),
    CONSTRAINT "InstructionProofs_only_a_voided_proof_has_a_reason" CHECK ("voidReason" IS NULL OR "voidedAt" IS NOT NULL)
);

-- En bock per elev, mall och dag. En ny instruktion en annan dag är ett nytt bevis; en upphävd bock hindrar ingen ny.
-- Nyckeln börjar med (templateId, schoolId), nyckelns kolumner, så borttagningar och mallens läsning hittar den.
CREATE UNIQUE INDEX "InstructionProofs_one_per_day"
    ON "InstructionProofs"("templateId", "schoolId", "studentId", "instructedOn") WHERE "voidedAt" IS NULL;
-- The school's key, and a school's proofs by the day they were given.
CREATE INDEX "InstructionProofs_schoolId_instructedOn_idx" ON "InstructionProofs"("schoolId", "instructedOn");
CREATE INDEX "InstructionProofs_studentId_schoolId_idx" ON "InstructionProofs"("studentId", "schoolId");
CREATE INDEX "InstructionProofs_instructorId_schoolId_idx" ON "InstructionProofs"("instructorId", "schoolId");
CREATE INDEX "InstructionProofs_recordedById_schoolId_idx" ON "InstructionProofs"("recordedById", "schoolId");
CREATE INDEX "InstructionProofs_voidedById_schoolId_idx" ON "InstructionProofs"("voidedById", "schoolId");

ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_templateId_schoolId_fkey" FOREIGN KEY ("templateId", "schoolId")
    REFERENCES "InstructionTemplates"("id", "schoolId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_instructorId_schoolId_fkey" FOREIGN KEY ("instructorId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("instructorId") ON UPDATE NO ACTION;
ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_recordedById_schoolId_fkey" FOREIGN KEY ("recordedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("recordedById") ON UPDATE NO ACTION;
ALTER TABLE "InstructionProofs"
    ADD CONSTRAINT "InstructionProofs_voidedById_schoolId_fkey" FOREIGN KEY ("voidedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("voidedById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ConsentLists
-- ---------------------------------------------------------------------------

CREATE TABLE "ConsentLists" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    -- Klassen; NULL sedan klassen tagits bort (listan står kvar med groupName).
    "studentGroupId" UUID,
    -- Klassens namn när listan skrevs, stämplat av triggern.
    "groupName" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    -- Det vårdnadshavarna ombeds samtycka till, i de ord de ser; ändras aldrig.
    "body" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Avslutad: skriven av app.checklist_close_list och inget annat. Inget skrivs mer till en avslutad lista.
    "closedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ConsentLists_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConsentLists_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "ConsentLists_a_title_is_one_to_120_characters" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "ConsentLists_a_text_is_one_to_2000_characters" CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000),
    CONSTRAINT "ConsentLists_a_group_name_is_at_most_200_characters" CHECK (char_length("groupName") <= 200)
);

-- En öppen lista per klass och namn.
CREATE UNIQUE INDEX "ConsentLists_one_open_title_per_class"
    ON "ConsentLists"("schoolId", "studentGroupId", lower(btrim("title"))) WHERE "closedAt" IS NULL AND "studentGroupId" IS NOT NULL;
CREATE INDEX "ConsentLists_studentGroupId_schoolId_idx" ON "ConsentLists"("studentGroupId", "schoolId");
CREATE INDEX "ConsentLists_createdById_schoolId_idx" ON "ConsentLists"("createdById", "schoolId");
-- Gallringens villkor och skolans lista.
CREATE INDEX "ConsentLists_schoolId_createdAt_idx" ON "ConsentLists"("schoolId", "createdAt");

ALTER TABLE "ConsentLists"
    ADD CONSTRAINT "ConsentLists_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentLists"
    ADD CONSTRAINT "ConsentLists_studentGroupId_schoolId_fkey" FOREIGN KEY ("studentGroupId", "schoolId")
    REFERENCES "StudentGroups"("id", "schoolId") ON DELETE SET NULL ("studentGroupId") ON UPDATE NO ACTION;
ALTER TABLE "ConsentLists"
    ADD CONSTRAINT "ConsentLists_createdById_schoolId_fkey" FOREIGN KEY ("createdById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("createdById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ConsentEntries
-- ---------------------------------------------------------------------------

CREATE TABLE "ConsentEntries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "kind" "ConsentEntryKind" NOT NULL,
    "source" "ConsentEntrySource" NOT NULL DEFAULT 'REGISTERED',
    -- Dagen svaret gavs (datumet på pappret, eller dagen vårdnadshavaren bekräftade), i skolans dygn. Inte i framtiden.
    "givenOn" DATE NOT NULL,
    -- Vem som lämnat svaret, fritt ("mamma Anna"); skrivs av personal.
    "givenBy" TEXT,
    "note" TEXT,
    -- Kvittensförfrågan som gav ett KVITTENS-svar. Ingen nyckel: förfrågan gallras före svaret.
    "ackRequestId" UUID,
    -- Den som skrev ner svaret och när: databasens. NULL för ett KVITTENS-svar.
    "recordedById" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentEntries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ConsentEntries_the_date_is_this_century" CHECK ("givenOn" >= DATE '2000-01-01'),
    CONSTRAINT "ConsentEntries_a_giver_is_one_to_120_characters" CHECK ("givenBy" IS NULL OR char_length(btrim("givenBy")) BETWEEN 1 AND 120),
    CONSTRAINT "ConsentEntries_a_note_is_one_to_300_characters" CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 300),
    CONSTRAINT "ConsentEntries_a_kvittens_entry_names_its_request" CHECK ("source" <> 'KVITTENS' OR ("ackRequestId" IS NOT NULL AND "kind" = 'GRANTED'))
);

-- Ett KVITTENS-svar per elev, lista och förfrågan: en omkörning av triggern skriver inte två.
CREATE UNIQUE INDEX "ConsentEntries_one_per_request"
    ON "ConsentEntries"("listId", "schoolId", "studentId", "ackRequestId") WHERE "ackRequestId" IS NOT NULL;
-- Listans svar per elev i den ordning de gavs, och nyckelns kolumner först.
CREATE INDEX "ConsentEntries_listId_schoolId_studentId_recordedAt_idx" ON "ConsentEntries"("listId", "schoolId", "studentId", "recordedAt");
-- The school's key.
CREATE INDEX "ConsentEntries_schoolId_recordedAt_idx" ON "ConsentEntries"("schoolId", "recordedAt");
CREATE INDEX "ConsentEntries_studentId_schoolId_idx" ON "ConsentEntries"("studentId", "schoolId");
CREATE INDEX "ConsentEntries_recordedById_schoolId_idx" ON "ConsentEntries"("recordedById", "schoolId");

ALTER TABLE "ConsentEntries"
    ADD CONSTRAINT "ConsentEntries_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentEntries"
    ADD CONSTRAINT "ConsentEntries_listId_schoolId_fkey" FOREIGN KEY ("listId", "schoolId")
    REFERENCES "ConsentLists"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ConsentEntries"
    ADD CONSTRAINT "ConsentEntries_studentId_schoolId_fkey" FOREIGN KEY ("studentId", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ConsentEntries"
    ADD CONSTRAINT "ConsentEntries_recordedById_schoolId_fkey" FOREIGN KEY ("recordedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("recordedById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ConsentAsks
-- ---------------------------------------------------------------------------

CREATE TABLE "ConsentAsks" (
    "ackRequestId" UUID NOT NULL,
    "schoolId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentAsks_pkey" PRIMARY KEY ("ackRequestId", "schoolId")
);

CREATE INDEX "ConsentAsks_listId_schoolId_idx" ON "ConsentAsks"("listId", "schoolId");
-- The school's key.
CREATE INDEX "ConsentAsks_schoolId_idx" ON "ConsentAsks"("schoolId");

ALTER TABLE "ConsentAsks"
    ADD CONSTRAINT "ConsentAsks_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsentAsks"
    ADD CONSTRAINT "ConsentAsks_ackRequestId_schoolId_fkey" FOREIGN KEY ("ackRequestId", "schoolId")
    REFERENCES "AckRequests"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ConsentAsks"
    ADD CONSTRAINT "ConsentAsks_listId_schoolId_fkey" FOREIGN KEY ("listId", "schoolId")
    REFERENCES "ConsentLists"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Who may be ticked: the one definition each, as initplan arrays.
-- ---------------------------------------------------------------------------

-- The pupils the calling teacher teaches: the lessons of the school's active
-- year where they are the teacher or the co-teacher (a parked lesson occupies
-- nothing), with the lesson's class and its extra classes (the pupils whose
-- home class that is), the members of the lesson's teaching groups, and the
-- pupils named on it. Empty for anyone but a teacher. A cover lesson of a single
-- date (CalendarLessonTeachers) does not make a pupil the substitute's: the
-- tick is the regular teacher's, or an administrator's.
CREATE FUNCTION app.checklist_taught_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  WITH me AS (
    SELECT app.current_school_id() AS school, app.current_user_id() AS id
     WHERE app.current_user_role() = 'TEACHER'
  ),
  lessons AS (
    SELECT l."id", l."studentGroupId"
      FROM me
      JOIN "MasterLessons" l ON l."schoolId" = me.school
      JOIN "AcademicYears" y ON y."id" = l."academicYearId" AND y."schoolId" = l."schoolId" AND y."isActive"
     WHERE NOT l."isParked" AND (l."teacherId" = me.id OR l."coTeacherId" = me.id)
  ),
  groups AS (
    SELECT l."studentGroupId" AS id FROM lessons l
    UNION
    SELECT g."studentGroupId" FROM me JOIN "MasterLessonGroups" g ON g."schoolId" = me.school JOIN lessons l ON l."id" = g."masterLessonId"
  ),
  pupils AS (
    SELECT u."id" FROM me JOIN "Users" u ON u."schoolId" = me.school WHERE u."studentGroupId" IN (SELECT id FROM groups)
    UNION
    SELECT m."studentId" FROM me JOIN "StudentGroupMembers" m ON m."schoolId" = me.school WHERE m."studentGroupId" IN (SELECT id FROM groups)
    UNION
    SELECT s."studentId" FROM me JOIN "MasterLessonStudents" s ON s."schoolId" = me.school JOIN lessons l ON l."id" = s."masterLessonId"
  )
  SELECT coalesce(array_agg(u."id" ORDER BY u."id"), '{}'::uuid[])
    FROM me
    JOIN "Users" u ON u."schoolId" = me.school
   WHERE u."id" IN (SELECT id FROM pupils) AND u."role" = 'STUDENT' AND u."isActive"
$$;

-- The pupils a teacher may see the checklists of: the ones they teach and their mentees.
CREATE FUNCTION app.checklist_visible_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT p.id ORDER BY p.id), '{}'::uuid[])
    FROM (SELECT unnest(app.checklist_taught_ids()) AS id
          UNION
          SELECT unnest(app.ack_mentee_ids())) p
$$;

-- The home classes of the pupils a teacher may see: the lists they may read.
CREATE FUNCTION app.checklist_class_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT u."studentGroupId" ORDER BY u."studentGroupId"), '{}'::uuid[])
    FROM "Users" u
   WHERE u."schoolId" = app.current_school_id() AND u."studentGroupId" IS NOT NULL
     AND u."id" = ANY ((SELECT app.checklist_visible_ids())::uuid[])
$$;

-- The home classes of a teacher's mentees: the lists they may write.
CREATE FUNCTION app.checklist_mentee_class_ids() RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT u."studentGroupId" ORDER BY u."studentGroupId"), '{}'::uuid[])
    FROM "Users" u
   WHERE u."schoolId" = app.current_school_id() AND u."studentGroupId" IS NOT NULL
     AND u."id" = ANY ((SELECT app.ack_mentee_ids())::uuid[])
$$;

-- The pupils among the given ids whom the school has marked as having a protected identity (skyddad identitet). The register
-- is the administrators' to read, and a teacher prints a list too: the gateway asks this when it builds a sheet for paper,
-- leaves the marked out of the sheet and says how many, and hands the ids to nobody. An administrator is told about any pupil
-- of the school; a teacher only about the pupils the teacher reads (app.checklist_visible_ids: the ones they teach or mentor),
-- since the gateway asks about no others and the answer must not tell a teacher who is marked among the pupils they cannot see.
-- Empty for anyone else, and for ids of another school.
CREATE FUNCTION app.checklist_protected_ids(p_ids uuid[]) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
  SELECT coalesce(array_agg(DISTINCT p."userId" ORDER BY p."userId"), '{}'::uuid[])
    FROM "PersonProtections" p
   WHERE p."schoolId" = app.current_school_id() AND p."userId" = ANY (p_ids)
     AND (app.current_user_role() = 'SCHOOL_ADMIN'
          OR (app.current_user_role() = 'TEACHER' AND p."userId" = ANY ((SELECT app.checklist_visible_ids())::uuid[])))
$$;

-- ---------------------------------------------------------------------------
-- Stamps and guards: what the database decides, whatever the row says.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.checklist_templates_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  NEW."updatedAt" := clock_timestamp();
  RETURN NEW;
END
$$;

CREATE TRIGGER "InstructionTemplates_stamp"
    BEFORE INSERT OR UPDATE ON "InstructionTemplates"
    FOR EACH ROW EXECUTE FUNCTION app.checklist_templates_stamp();

-- A proof is written by the caller, at the database's clock, for an active pupil of the
-- school, in a template that is not retired, and not for a day that has not come. The
-- instructor is the caller unless they name an active colleague on the staff. A writer with no
-- login (the owner: a migration, provdata) keeps what it gives. The template row is taken FOR
-- SHARE, so a template that is being retired finishes first and this then refuses.
CREATE FUNCTION app.instruction_proofs_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  live boolean;
  today date;
BEGIN
  SELECT t."active" INTO live
    FROM "InstructionTemplates" t WHERE t."id" = NEW."templateId" AND t."schoolId" = NEW."schoolId" FOR SHARE;
  IF FOUND AND NOT live THEN
    RAISE EXCEPTION 'CHECKLIST_TEMPLATE_RETIRED' USING ERRCODE = 'CL409';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = NEW."studentId" AND u."schoolId" = NEW."schoolId" AND u."role" = 'STUDENT' AND u."isActive") THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_A_PUPIL' USING ERRCODE = 'CL422';
  END IF;
  SELECT (clock_timestamp() AT TIME ZONE s."timezone")::date INTO today FROM "Schools" s WHERE s."id" = NEW."schoolId";
  IF NEW."instructedOn" > today THEN
    RAISE EXCEPTION 'CHECKLIST_DATE_IN_THE_FUTURE' USING ERRCODE = 'CL422';
  END IF;
  IF app.current_user_id() IS NOT NULL THEN
    NEW."recordedById" := app.current_user_id();
    NEW."recordedAt" := clock_timestamp();
    NEW."instructorId" := coalesce(NEW."instructorId", NEW."recordedById");
  END IF;
  IF NEW."instructorId" IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM "Users" u
        WHERE u."id" = NEW."instructorId" AND u."schoolId" = NEW."schoolId" AND u."isActive" AND u."role" IN ('TEACHER', 'SCHOOL_ADMIN')) THEN
    RAISE EXCEPTION 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF' USING ERRCODE = 'CL422';
  END IF;
  NEW."voidedAt" := NULL;
  NEW."voidedById" := NULL;
  NEW."voidReason" := NULL;
  RETURN NEW;
END
$$;

CREATE TRIGGER "InstructionProofs_stamp"
    BEFORE INSERT ON "InstructionProofs"
    FOR EACH ROW EXECUTE FUNCTION app.instruction_proofs_stamp();

-- A list is written by the caller, born open, for a class of the school (a class, not a
-- teaching group), and carries the class's name.
CREATE FUNCTION app.consent_lists_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  named text;
BEGIN
  IF app.current_user_id() IS NOT NULL THEN
    NEW."createdById" := app.current_user_id();
    NEW."createdAt" := clock_timestamp();
  END IF;
  NEW."closedAt" := NULL;
  SELECT g."name" INTO named
    FROM "StudentGroups" g
   WHERE g."id" = NEW."studentGroupId" AND g."schoolId" = NEW."schoolId" AND g."kind" = 'CLASS';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONSENT_NOT_A_CLASS' USING ERRCODE = 'CL422';
  END IF;
  NEW."groupName" := left(named, 200);
  RETURN NEW;
END
$$;

CREATE TRIGGER "ConsentLists_stamp"
    BEFORE INSERT ON "ConsentLists"
    FOR EACH ROW EXECUTE FUNCTION app.consent_lists_stamp();

-- An answer is written to an open list, for an active pupil of the school, not for a day that
-- has not come. Staff's answers carry the caller and the clock; a KVITTENS answer is the
-- trigger's own (no login on it, the guardian's login is the one confirming) and is dropped
-- silently, not refused, when the list has been closed or the pupil has left, so that
-- a guardian's confirmation is never turned down for a list's sake. The list's row is taken FOR
-- SHARE: a list being closed finishes first, and the answer then sees it closed.
CREATE FUNCTION app.consent_entries_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  closed timestamptz;
  listed boolean;
  today date;
  pupil boolean;
BEGIN
  SELECT c."closedAt" INTO closed
    FROM "ConsentLists" c WHERE c."id" = NEW."listId" AND c."schoolId" = NEW."schoolId" FOR SHARE;
  listed := FOUND;
  SELECT EXISTS (SELECT 1 FROM "Users" u WHERE u."id" = NEW."studentId" AND u."schoolId" = NEW."schoolId" AND u."role" = 'STUDENT' AND u."isActive") INTO pupil;
  IF NEW."source" = 'KVITTENS' THEN
    IF NOT listed OR closed IS NOT NULL OR NOT pupil THEN
      RETURN NULL;
    END IF;
    -- The instant of the confirmation and not of the transaction's start, so that a withdrawal written
    -- while the guardian's transaction was open is not taken for later than the confirmation.
    NEW."recordedAt" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF listed AND closed IS NOT NULL THEN
    RAISE EXCEPTION 'CONSENT_LIST_CLOSED' USING ERRCODE = 'CL409';
  END IF;
  IF NOT pupil THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_A_PUPIL' USING ERRCODE = 'CL422';
  END IF;
  SELECT (clock_timestamp() AT TIME ZONE s."timezone")::date INTO today FROM "Schools" s WHERE s."id" = NEW."schoolId";
  IF NEW."givenOn" > today THEN
    RAISE EXCEPTION 'CHECKLIST_DATE_IN_THE_FUTURE' USING ERRCODE = 'CL422';
  END IF;
  IF app.current_user_id() IS NOT NULL THEN
    NEW."recordedById" := app.current_user_id();
    NEW."recordedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ConsentEntries_stamp"
    BEFORE INSERT ON "ConsentEntries"
    FOR EACH ROW EXECUTE FUNCTION app.consent_entries_stamp();

-- A Kvittens request that asks for a list's consent must be the rule ALL: with ANY one guardian's
-- confirmation would be written down as the consent of both. It must be unanswered: a request
-- a guardian has already confirmed was written for something else, and linking it afterwards
-- would turn that confirmation into a consent nobody gave. The list must be open.
CREATE FUNCTION app.consent_asks_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  closed timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AckRequests" q WHERE q."id" = NEW."ackRequestId" AND q."schoolId" = NEW."schoolId" AND q."rule" = 'ALL') THEN
    RAISE EXCEPTION 'CONSENT_ASK_NEEDS_ALL' USING ERRCODE = 'CL422';
  END IF;
  IF EXISTS (SELECT 1 FROM "AckReceipts" r WHERE r."requestId" = NEW."ackRequestId" AND r."schoolId" = NEW."schoolId" AND r."ackedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CONSENT_ASK_ALREADY_ANSWERED' USING ERRCODE = 'CL422';
  END IF;
  SELECT c."closedAt" INTO closed
    FROM "ConsentLists" c WHERE c."id" = NEW."listId" AND c."schoolId" = NEW."schoolId" FOR SHARE;
  IF FOUND AND closed IS NOT NULL THEN
    RAISE EXCEPTION 'CONSENT_LIST_CLOSED' USING ERRCODE = 'CL409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ConsentAsks_guard"
    BEFORE INSERT ON "ConsentAsks"
    FOR EACH ROW EXECUTE FUNCTION app.consent_asks_guard();

-- ---------------------------------------------------------------------------
-- The Kvittens bridge: the last guardian's confirmation is the consent.
-- ---------------------------------------------------------------------------

-- Runs after every UPDATE of AckReceipts (a statement trigger with transition tables takes no
-- column list). For each (request, pupil) whose receipt just went from unconfirmed to confirmed,
-- when the request belongs to a consent list and app.ack_status_raw now says the pupil is met
-- (ALL: someone confirmed and nobody who still can is waiting), writes one GRANTED answer
-- from KVITTENS dated the school's day. Nothing for a request that belongs to no list, which is
-- every request but a consent's. The unique index on (list, pupil, request) makes a second run
-- harmless. The entries' own guard drops the answer for a closed list or a pupil who has left.
-- And nothing for a pupil whose list holds a WITHDRAWN or a DECLINED written after the request was made:
-- "met" says that everyone has at some time confirmed, not that everyone consents now, and the latest
-- answer is what counts (consent-state.ts). A guardian who takes the consent back by telephone, and a
-- second guardian who then taps the still open request, leave the pupil withdrawn; only a request made
-- after the withdrawal (the school asking again) can grant it again.
CREATE FUNCTION app.consent_from_kvittens() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  -- Two guardians who confirm at the same moment each see the other's receipt as unconfirmed (their
  -- transactions have not committed), and neither would find the pupil met. The confirmations of one request
  -- that belongs to a list therefore take a lock of their own, per request, in the id's order, to the
  -- commit: the second waits for the first, and its statement below, which takes its snapshot after the wait,
  -- sees the first's confirmation. The lock is on a key of this trigger's own, which no other statement
  -- takes; the confirmation holds the request FOR SHARE and the links FOR KEY SHARE, which the writer of the
  -- answers (FOR SHARE on the list, KEY SHARE on the pupil) does not conflict with. A request that belongs to no
  -- list takes no lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-ask:' || x."requestId"::text, 0))
    FROM (SELECT DISTINCT n."requestId"
            FROM nw n
            JOIN "ConsentAsks" a ON a."ackRequestId" = n."requestId" AND a."schoolId" = n."schoolId"
           WHERE n."ackedAt" IS NOT NULL
           ORDER BY n."requestId") x;
  INSERT INTO "ConsentEntries" ("schoolId", "listId", "studentId", "kind", "source", "givenOn", "ackRequestId")
  SELECT DISTINCT a."schoolId", a."listId", n."studentId", 'GRANTED'::"ConsentEntryKind", 'KVITTENS'::"ConsentEntrySource",
         (clock_timestamp() AT TIME ZONE sc."timezone")::date, n."requestId"
    FROM nw n
    JOIN od o ON o."requestId" = n."requestId" AND o."schoolId" = n."schoolId" AND o."studentId" = n."studentId" AND o."guardianId" = n."guardianId"
    JOIN "ConsentAsks" a ON a."ackRequestId" = n."requestId" AND a."schoolId" = n."schoolId"
    JOIN "Schools" sc ON sc."id" = n."schoolId"
   WHERE o."ackedAt" IS NULL AND n."ackedAt" IS NOT NULL
     AND EXISTS (SELECT 1 FROM app.ack_status_raw(ARRAY[n."requestId"]) s WHERE s.student_id = n."studentId" AND s.met)
     -- An answer staff wrote after the request was made, a withdrawal or a no, is not undone by the request's last confirmation.
     -- Read after the lock above, in a statement of its own, so a withdrawal that has committed is seen.
     AND NOT EXISTS (SELECT 1 FROM "ConsentEntries" e
                      WHERE e."listId" = a."listId" AND e."schoolId" = a."schoolId" AND e."studentId" = n."studentId"
                        AND e."kind" IN ('WITHDRAWN', 'DECLINED')
                        AND e."recordedAt" > (SELECT k."createdAt" FROM "AckRequests" k WHERE k."id" = n."requestId" AND k."schoolId" = n."schoolId"))
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;

CREATE TRIGGER "AckReceipts_consent"
    AFTER UPDATE ON "AckReceipts"
    REFERENCING OLD TABLE AS od NEW TABLE AS nw
    FOR EACH STATEMENT EXECUTE FUNCTION app.consent_from_kvittens();

-- ---------------------------------------------------------------------------
-- Voiding a tick and closing a list: the only two updates, and nobody's UPDATE.
-- ---------------------------------------------------------------------------

-- Voids a tick made in error: the person who wrote it, or an administrator under Drift. The tick
-- stays, with who voided it, when and why. Answers the time it was voided, or the earlier time when
-- it already was (a second call changes nothing). CL403: not staff who may. CL404: no such proof
-- for the caller. CL422: no reason (one to 300 characters).
CREATE FUNCTION app.checklist_void_proof(p_proof uuid, p_reason text) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  sch uuid := app.current_school_id();
  my_role text := app.current_user_role();
  was timestamptz;
  stamp timestamptz;
BEGIN
  IF me IS NULL OR NOT (my_role = 'TEACHER' OR (my_role = 'SCHOOL_ADMIN' AND app.current_user_may('DRIFT', true))) THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_STAFF' USING ERRCODE = 'CL403';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'CHECKLIST_REASON_NEEDED' USING ERRCODE = 'CL422';
  END IF;
  SELECT p."voidedAt" INTO was
    FROM "InstructionProofs" p
   WHERE p."id" = p_proof AND p."schoolId" = sch
     AND (my_role = 'SCHOOL_ADMIN' OR p."recordedById" = me)
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_FOUND' USING ERRCODE = 'CL404';
  END IF;
  IF was IS NOT NULL THEN
    RETURN was;
  END IF;
  stamp := clock_timestamp();
  UPDATE "InstructionProofs" p SET "voidedAt" = stamp, "voidedById" = me, "voidReason" = btrim(p_reason)
   WHERE p."id" = p_proof;
  RETURN stamp;
END
$$;

-- Ends a list: the person who made it, or an administrator under Drift. Nothing is written to it
-- afterwards, and what was written stays. Answers the time it was closed, or the earlier time
-- when it already was. CL403: not staff who may. CL404: no such list for the caller.
CREATE FUNCTION app.checklist_close_list(p_list uuid) RETURNS timestamptz
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  me uuid := app.current_user_id();
  sch uuid := app.current_school_id();
  my_role text := app.current_user_role();
  was timestamptz;
  stamp timestamptz;
BEGIN
  IF me IS NULL OR NOT (my_role = 'TEACHER' OR (my_role = 'SCHOOL_ADMIN' AND app.current_user_may('DRIFT', true))) THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_STAFF' USING ERRCODE = 'CL403';
  END IF;
  SELECT c."closedAt" INTO was
    FROM "ConsentLists" c
   WHERE c."id" = p_list AND c."schoolId" = sch
     AND (my_role = 'SCHOOL_ADMIN' OR c."createdById" = me)
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CHECKLIST_NOT_FOUND' USING ERRCODE = 'CL404';
  END IF;
  IF was IS NOT NULL THEN
    RETURN was;
  END IF;
  stamp := clock_timestamp();
  UPDATE "ConsentLists" c SET "closedAt" = stamp WHERE c."id" = p_list;
  RETURN stamp;
END
$$;

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "InstructionTemplates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "InstructionProofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsentLists" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsentEntries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConsentAsks" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Templates: every staff member reads them (a teacher needs them to tick); Drift writes.
    CREATE POLICY "checklist_templates_staff_select" ON "InstructionTemplates"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('SCHOOL_ADMIN', 'TEACHER'));
    CREATE POLICY "checklist_templates_admin_insert" ON "InstructionTemplates"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "checklist_templates_admin_update" ON "InstructionTemplates"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));

    -- Proofs: an administrator reads the school's; a teacher the ones about the pupils they teach
    -- and mentor. Written by an administrator under Drift for any pupil, and by a teacher for the
    -- pupils they teach; a proof is born unvoided. Nobody changes or removes one.
    CREATE POLICY "checklist_proofs_admin_select" ON "InstructionProofs"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "checklist_proofs_teacher_select" ON "InstructionProofs"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "studentId" = ANY ((select app.checklist_visible_ids())::uuid[]));
    CREATE POLICY "checklist_proofs_admin_insert" ON "InstructionProofs"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL);
    CREATE POLICY "checklist_proofs_teacher_insert" ON "InstructionProofs"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "voidedAt" IS NULL AND "voidedById" IS NULL AND "voidReason" IS NULL
                    AND "studentId" = ANY ((select app.checklist_taught_ids())::uuid[]));

    -- Lists: an administrator reads the school's; a teacher those of the classes of the pupils they
    -- teach or mentor, and their own. Written by Drift for any class, and by a teacher for a class
    -- they have a mentee in.
    CREATE POLICY "consent_lists_admin_select" ON "ConsentLists"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "consent_lists_teacher_select" ON "ConsentLists"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND ("createdById" = (select app.current_user_id())
                    OR "studentGroupId" = ANY ((select app.checklist_class_ids())::uuid[])));
    CREATE POLICY "consent_lists_admin_insert" ON "ConsentLists"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND "closedAt" IS NULL);
    CREATE POLICY "consent_lists_teacher_insert" ON "ConsentLists"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "closedAt" IS NULL
                    AND "studentGroupId" = ANY ((select app.checklist_mentee_class_ids())::uuid[]));

    -- Answers: read as the proofs; written by Drift for any pupil and by a teacher for their mentees.
    -- Only REGISTERED, and never one that names a Kvittens request: those are the trigger's.
    CREATE POLICY "consent_entries_admin_select" ON "ConsentEntries"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "consent_entries_teacher_select" ON "ConsentEntries"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND "studentId" = ANY ((select app.checklist_visible_ids())::uuid[]));
    CREATE POLICY "consent_entries_admin_insert" ON "ConsentEntries"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true))
                    AND "source" = 'REGISTERED' AND "ackRequestId" IS NULL);
    CREATE POLICY "consent_entries_teacher_insert" ON "ConsentEntries"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND "source" = 'REGISTERED' AND "ackRequestId" IS NULL
                    AND "studentId" = ANY ((select app.ack_mentee_ids())::uuid[]));

    -- Asks: the link between a list and the Kvittens request the caller wrote for it.
    CREATE POLICY "consent_asks_admin_select" ON "ConsentAsks"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "consent_asks_teacher_select" ON "ConsentAsks"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'TEACHER'
               AND EXISTS (SELECT 1 FROM "ConsentLists" l WHERE l."id" = "ConsentAsks"."listId" AND l."schoolId" = "ConsentAsks"."schoolId"));
    CREATE POLICY "consent_asks_admin_insert" ON "ConsentAsks"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "consent_asks_teacher_insert" ON "ConsentAsks"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'TEACHER'
                    AND app.ack_is_author("ackRequestId")
                    AND EXISTS (SELECT 1 FROM "ConsentLists" l
                                 WHERE l."id" = "ConsentAsks"."listId" AND l."schoolId" = "ConsentAsks"."schoolId"
                                   AND l."studentGroupId" = ANY ((select app.checklist_mentee_class_ids())::uuid[])));

    FOREACH tbl IN ARRAY ARRAY['InstructionTemplates', 'InstructionProofs', 'ConsentLists', 'ConsentEntries', 'ConsentAsks'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE ON "InstructionTemplates" TO "app_authenticated";
    GRANT SELECT, INSERT ON "InstructionProofs" TO "app_authenticated";
    GRANT SELECT, INSERT ON "ConsentLists" TO "app_authenticated";
    GRANT SELECT, INSERT ON "ConsentEntries" TO "app_authenticated";
    GRANT SELECT, INSERT ON "ConsentAsks" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['InstructionTemplates', 'InstructionProofs', 'ConsentLists', 'ConsentEntries', 'ConsentAsks'] LOOP
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON %I FROM %I', tbl, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM "service_role"', tbl);
    END IF;
    -- PostgreSQL 17's MAINTAIN (REINDEX, CLUSTER, VACUUM, LOCK): the owner's alone.
    IF current_setting('server_version_num')::int >= 170000 THEN
      FOREACH r IN ARRAY ARRAY['authenticated', 'app_authenticated', 'service_role', 'anon'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE MAINTAIN ON %I FROM %I', tbl, r);
        END IF;
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- Gallring: CHECKLISTS. Both bodies are the ones 20270122091000 (Elevens lektion för dagen,
-- D7) left (prod md5 before: due a7b1da58…, purge b23e04ae…) plus the branches marked
-- "checklistor", so none of Kvittens', Krisläges, Rapporteringsgrads, Frånvarobevakningens,
-- Vikariefrågans, Skyddad identitets or the pupil moves' LessonPupilMoves is lost (an earlier
-- version of this file was built on 20270117091000's bodies and would have dropped that last
-- one: the order of the stamps puts this file after D7's). A later release that restates the
-- functions again must carry every branch (RLS sections 350, 374, 397 and 433 fail on a
-- branch that is gone).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.gallring_due(p_school uuid, p_type "RetentionDataType", p_before date, p_today date)
RETURNS TABLE (tbl text, id uuid)
LANGUAGE sql STABLE AS $$
  WITH school AS (
    SELECT s."id", (p_before::timestamp AT TIME ZONE s."timezone") AS before_at
      FROM "public"."Schools" s WHERE s."id" = p_school AND p_before IS NOT NULL
  )
  SELECT 'AttendanceRecords', a."id"
    FROM school, "public"."AttendanceRecords" a
    JOIN "public"."CalendarLessons" l ON l."id" = a."calendarLessonId"
   WHERE p_type = 'ATTENDANCE' AND a."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  -- frånvarobevakning
  SELECT 'AbsenceWatchFindings', w."id"
    FROM school, "public"."AbsenceWatchFindings" w
   WHERE p_type = 'ATTENDANCE' AND w."schoolId" = school."id" AND w."lastSeenOn" < p_before
  UNION ALL
  -- rapporteringsgrad
  SELECT 'TeacherReportingDays', d."id"
    FROM school, "public"."TeacherReportingDays" d
   WHERE p_type = 'ATTENDANCE' AND d."schoolId" = school."id" AND d."day" < p_before
  UNION ALL
  SELECT 'ReportingReminders', r."id"
    FROM school, "public"."ReportingReminders" r
   WHERE p_type = 'ATTENDANCE' AND r."schoolId" = school."id" AND r."lessonDate" < p_before
  UNION ALL
  -- elevens lektion: a move goes with the register of the day it took a pupil out of
  SELECT 'LessonPupilMoves', mv."id"
    FROM school, "public"."LessonPupilMoves" mv
    JOIN "public"."CalendarLessons" l ON l."id" = mv."fromLessonId" AND l."schoolId" = mv."schoolId"
   WHERE p_type = 'ATTENDANCE' AND mv."schoolId" = school."id" AND l."date" < p_before
  UNION ALL
  SELECT 'AbsenceReports', r."id"
    FROM school, "public"."AbsenceReports" r
   WHERE p_type = 'ABSENCE_REPORTS' AND r."schoolId" = school."id" AND r."date" < p_before
  UNION ALL
  SELECT 'LeaveRequests', r."id"
    FROM school, "public"."LeaveRequests" r
   WHERE p_type = 'LEAVE_REQUESTS' AND r."schoolId" = school."id" AND r."endDate" < p_before
  UNION ALL
  SELECT 'Notifications', n."id"
    FROM school, "public"."Notifications" n
   WHERE p_type = 'NOTIFICATIONS' AND n."schoolId" = school."id" AND n."createdAt" < school.before_at
  UNION ALL
  -- kvittens
  SELECT 'AckRequests', k."id"
    FROM school, "public"."AckRequests" k
   WHERE p_type = 'NOTIFICATIONS' AND k."schoolId" = school."id" AND k."createdAt" < school.before_at
  UNION ALL
  -- checklistor: what belongs to a pupil who has left, and the lists that are old and empty
  SELECT 'InstructionProofs', p."id"
    FROM school, "public"."InstructionProofs" p
    JOIN "public"."Users" s ON s."id" = p."studentId" AND s."schoolId" = p."schoolId"
   WHERE p_type = 'CHECKLISTS' AND p."schoolId" = school."id"
     AND NOT s."isActive" AND s."deactivatedAt" < school.before_at
  UNION ALL
  SELECT 'ConsentEntries', e."id"
    FROM school, "public"."ConsentEntries" e
    JOIN "public"."Users" s ON s."id" = e."studentId" AND s."schoolId" = e."schoolId"
   WHERE p_type = 'CHECKLISTS' AND e."schoolId" = school."id"
     AND NOT s."isActive" AND s."deactivatedAt" < school.before_at
  UNION ALL
  SELECT 'ConsentLists', l."id"
    FROM school, "public"."ConsentLists" l
   WHERE p_type = 'CHECKLISTS' AND l."schoolId" = school."id" AND l."createdAt" < school.before_at
     AND NOT EXISTS (SELECT 1 FROM "public"."ConsentEntries" e WHERE e."listId" = l."id" AND e."schoolId" = l."schoolId")
  UNION ALL
  SELECT 'ScheduleChangeLogs', c."id"
    FROM school, "public"."ScheduleChangeLogs" c
   WHERE p_type = 'CHANGE_LOGS' AND c."schoolId" = school."id" AND c."createdAt" < school.before_at
  UNION ALL
  SELECT 'TeacherEmploymentLogs', g."id"
    FROM school, "public"."TeacherEmploymentLogs" g
    JOIN "public"."AcademicYears" y ON y."id" = g."academicYearId" AND y."schoolId" = g."schoolId"
   WHERE p_type = 'CHANGE_LOGS' AND g."schoolId" = school."id" AND y."endDate" < p_before
  UNION ALL
  SELECT 'GuardianStudentHistory', h."id"
    FROM school, "public"."GuardianStudentHistory" h
   WHERE p_type = 'CHANGE_LOGS' AND h."schoolId" = school."id" AND h."unlinkedAt" < school.before_at
  UNION ALL
  -- skyddad identitet
  SELECT 'PersonProtectionEvents', e."id"
    FROM school, "public"."PersonProtectionEvents" e
   WHERE p_type = 'CHANGE_LOGS' AND e."schoolId" = school."id" AND e."at" < school.before_at
  UNION ALL
  SELECT 'TeacherAbsences', t."id"
    FROM school, "public"."TeacherAbsences" t
   WHERE p_type = 'ABSENCE_REASONS' AND t."schoolId" = school."id" AND t."reasonId" IS NOT NULL
     AND t."endsAt" < school.before_at
  UNION ALL
  -- läslogg
  SELECT 'PersonalDataAccess', p."id"
    FROM school, "public"."PersonalDataAccess" p
   WHERE p_type = 'ACCESS_LOG' AND p."schoolId" = school."id" AND p."at" < school.before_at
  UNION ALL
  -- vikarieförfrågningar
  SELECT 'CoverRequests', q."id"
    FROM school, "public"."CoverRequests" q
   WHERE p_type = 'COVER_REQUESTS' AND q."schoolId" = school."id"
     AND ((q."status" <> 'OPEN' AND q."closedAt" < school.before_at)
          OR (q."status" = 'OPEN' AND q."expiresAt" < school.before_at))
  UNION ALL
  SELECT 'CoverConfirmations', c."id"
    FROM school, "public"."CoverConfirmations" c
   WHERE p_type = 'COVER_REQUESTS' AND c."schoolId" = school."id" AND c."confirmedAt" < school.before_at
  UNION ALL
  -- krisläge
  SELECT 'CrisisAlarms', k."id"
    FROM school, "public"."CrisisAlarms" k
   WHERE k."schoolId" = school."id" AND k."endedAt" < school.before_at
     AND ((p_type = 'CRISIS_DRILLS' AND k."mode" = 'DRILL')
          OR (p_type = 'CRISIS_ALARMS' AND k."mode" = 'LIVE'))
  UNION ALL
  SELECT 'Users', u."id"
    FROM school, "public"."Users" u
   WHERE p_type = 'DEPARTED_PEOPLE' AND u."schoolId" = school."id"
     AND NOT u."isActive" AND u."pseudonymisedAt" IS NULL
     AND u."deactivatedAt" < school.before_at
     AND NOT app.gallring_held_for_scb(u."id", u."schoolId", p_today);
$$;

CREATE OR REPLACE FUNCTION app.gallring_purge(p_run uuid, p_type "RetentionDataType", p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  r "GallringRuns";
  cutoff date;
  today date;
  budget integer := greatest(least(p_limit, 5000), 1);
  n integer := 0;
  step integer;
BEGIN
  IF p_type = 'DEPARTED_PEOPLE' THEN
    RAISE EXCEPTION 'GALLRING_PEOPLE_ARE_PSEUDONYMISED' USING ERRCODE = 'GL400';
  END IF;
  -- FOR UPDATE: one call of a run at a time.
  SELECT * INTO r FROM "GallringRuns" WHERE "id" = p_run AND "status" = 'RUNNING' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'GALLRING_RUN_NOT_RUNNING' USING ERRCODE = 'GL404';
  END IF;
  -- Both NULL when nothing of the kind may go: least() of a NULL is the other.
  IF r."cutoffs" ->> p_type::text IS NULL
     OR app.retention_months_in_force(r."schoolId", p_type, clock_timestamp()) IS NULL THEN
    RETURN 0;
  END IF;
  cutoff := app.gallring_run_cutoff(r."schoolId", r."startedAt", r."cutoffs", p_type);
  today := app.gallring_today(r."schoolId", r."startedAt");

  PERFORM set_config('app.gallring', r."schoolId"::text, true);
  CASE p_type
    WHEN 'ATTENDANCE' THEN
      DELETE FROM "AttendanceRecords" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AttendanceRecords' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- frånvarobevakning
      IF n < budget THEN
        DELETE FROM "AbsenceWatchFindings" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AbsenceWatchFindings' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- rapporteringsgrad
      IF n < budget THEN
        DELETE FROM "TeacherReportingDays" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherReportingDays' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ReportingReminders" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ReportingReminders' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- elevens lektion
      IF n < budget THEN
        DELETE FROM "LessonPupilMoves" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'LessonPupilMoves' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REPORTS' THEN
      DELETE FROM "AbsenceReports" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'AbsenceReports' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'LEAVE_REQUESTS' THEN
      DELETE FROM "LeaveRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'LeaveRequests' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    WHEN 'NOTIFICATIONS' THEN
      DELETE FROM "Notifications" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'Notifications' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      -- kvittens: a request goes with the rows under it, by their key
      IF n < budget THEN
        DELETE FROM "AckRequests" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'AckRequests' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- checklistor: the proofs and the answers of a pupil who has left, then the lists that are left empty
    WHEN 'CHECKLISTS' THEN
      DELETE FROM "InstructionProofs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'InstructionProofs' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
      IF n < budget THEN
        DELETE FROM "ConsentEntries" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentEntries' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "ConsentLists" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'ConsentLists' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'CHANGE_LOGS' THEN
      DELETE FROM "ScheduleChangeLogs" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ScheduleChangeLogs' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "TeacherEmploymentLogs" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'TeacherEmploymentLogs' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      IF n < budget THEN
        DELETE FROM "GuardianStudentHistory" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'GuardianStudentHistory' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
      -- skyddad identitet
      IF n < budget THEN
        DELETE FROM "PersonProtectionEvents" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'PersonProtectionEvents' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    WHEN 'ABSENCE_REASONS' THEN
      UPDATE "TeacherAbsences" SET "reasonId" = NULL WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'TeacherAbsences' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- läslogg
    WHEN 'ACCESS_LOG' THEN
      DELETE FROM "PersonalDataAccess" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'PersonalDataAccess' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
    -- vikarieförfrågningar
    WHEN 'COVER_REQUESTS' THEN
      DELETE FROM "CoverRequests" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CoverRequests' LIMIT budget);
      GET DIAGNOSTICS step = ROW_COUNT;
      n := step;
      IF n < budget THEN
        DELETE FROM "CoverConfirmations" WHERE "id" IN (
          SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
           WHERE d."tbl" = 'CoverConfirmations' LIMIT budget - n);
        GET DIAGNOSTICS step = ROW_COUNT;
        n := n + step;
      END IF;
    -- krisläge
    WHEN 'CRISIS_DRILLS', 'CRISIS_ALARMS' THEN
      DELETE FROM "CrisisAlarms" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'CrisisAlarms' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
  END CASE;
  PERFORM set_config('app.gallring', '', true);

  UPDATE "GallringRuns" SET
    "counts"   = "counts" || jsonb_build_object(p_type::text, COALESCE(("counts" ->> p_type::text)::bigint, 0) + n),
    "complete" = "complete" || jsonb_build_object(p_type::text, n < budget),
    "cutoffs"  = "cutoffs" || jsonb_build_object(p_type::text, cutoff::text)
   WHERE "id" = p_run;
  RETURN n;
END
$$;


-- ---------------------------------------------------------------------------
-- Function grants: the gateway's role alone, and not through PostgREST.
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION app.checklist_taught_ids() IS
  'Checklistor: the pupils the calling teacher teaches (the lessons of the active year where they are teacher or co-teacher, with classes, teaching groups and named pupils); empty for anyone else.';
COMMENT ON FUNCTION app.checklist_visible_ids() IS
  'Checklistor: the pupils a teacher may see the checklists of: those they teach and their mentees.';
COMMENT ON FUNCTION app.checklist_class_ids() IS
  'Checklistor: the home classes of the pupils a teacher may see, for the policy of the lists.';
COMMENT ON FUNCTION app.checklist_mentee_class_ids() IS
  'Checklistor: the home classes of the calling teacher''s mentees, for the policies that let a teacher make a list.';
COMMENT ON FUNCTION app.checklist_protected_ids(uuid[]) IS
  'Checklistor: the pupils among the given ids the school has marked as having a protected identity, for the gateway that builds a sheet for paper (it leaves them out and counts them); an administrator is told about any pupil of the school, a teacher about the pupils they read; empty for anyone else.';
COMMENT ON FUNCTION app.checklist_void_proof(uuid, text) IS
  'Checklistor: voids a tick made in error (the writer, or an administrator under Drift); the tick stays with who, when and why; idempotent; CL403 not staff who may, CL404 no such proof, CL422 no reason.';
COMMENT ON FUNCTION app.checklist_close_list(uuid) IS
  'Checklistor: ends a consent list (its maker, or an administrator under Drift); nothing is written to it afterwards; idempotent; CL403, CL404.';
COMMENT ON FUNCTION app.consent_from_kvittens() IS
  'Checklistor: when the last guardian a Kvittens request asked has confirmed, and the request belongs to a consent list, writes the pupil''s GRANTED answer from KVITTENS, unless staff wrote a WITHDRAWN or a DECLINED after the request was made.';
COMMENT ON FUNCTION app.instruction_proofs_stamp() IS
  'Checklistor: the caller, the clock and the instructor of a proof; refuses a retired template, a non-pupil, a future date and an instructor who is not staff.';
COMMENT ON FUNCTION app.consent_entries_stamp() IS
  'Checklistor: the caller and the clock of an answer; refuses a closed list, a non-pupil and a future date; drops a KVITTENS answer for a closed list or a departed pupil.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.checklist_templates_stamp()',
    'app.instruction_proofs_stamp()',
    'app.consent_lists_stamp()',
    'app.consent_entries_stamp()',
    'app.consent_asks_guard()',
    'app.consent_from_kvittens()',
    'app.checklist_taught_ids()',
    'app.checklist_visible_ids()',
    'app.checklist_class_ids()',
    'app.checklist_mentee_class_ids()',
    'app.checklist_protected_ids(uuid[])',
    'app.checklist_void_proof(uuid, text)',
    'app.checklist_close_list(uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The API role runs the policies' questions and the two updates. The triggers' functions are the
  -- owner's: a trigger needs no grant.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    FOREACH fn IN ARRAY ARRAY[
      'app.checklist_taught_ids()',
      'app.checklist_visible_ids()',
      'app.checklist_class_ids()',
      'app.checklist_mentee_class_ids()',
      'app.checklist_protected_ids(uuid[])',
      'app.checklist_void_proof(uuid, text)',
      'app.checklist_close_list(uuid)'
    ] LOOP
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO "app_authenticated"', fn);
    END LOOP;
  END IF;
END
$$;
