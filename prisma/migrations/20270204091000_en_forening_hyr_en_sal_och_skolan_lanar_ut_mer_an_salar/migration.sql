-- Lokal: resurser som inte är salar, och externa som hyr en sal efter skoltid.
--
-- Skolan har salar och rumsbokningar med godkännande. Det saknas två saker:
-- det en skola lånar ut som inte är en sal (30 surfplattor, minibussen, aulan
-- som ingen undervisar i), och föreningen som hyr idrottshallen varje tisdag
-- 18-20 en termin. Den här migreringen lägger grunden för båda.
--
-- ## Fyra tabeller
--
--   ResourceTypes     skolans egna slag av resurser (Surfplattor, Minibuss), rader
--                     och inte fri text, som salstyperna. Inga personuppgifter.
--   Resources         en resurs: slag, namn, antal (1..1000), en plats (ett
--                     skolområde och/eller en rad text) och om en bokning av
--                     personal väntar på ett beslut som en sals.
--   ResourceBookings  en bokning av några av en resurs, med rumsbokningens
--                     status, beslut och anteckning. Samma enum
--                     (RoomBookingStatus), så samma godkännandeflöde på samma kod.
--   ExternalBookings  en SERIE för en hyrande som inte är användare: organisation,
--                     kontaktperson, telefon och e-post, och en regel (veckodagar,
--                     klockslag, datum, varannan vecka). Personuppgifter om någon
--                     som inte har någon inloggning.
--
-- Serien är regeln och registret; dagarna är rader i RoomBookings eller
-- ResourceBookings (en ny kolumn externalBookingId). Det är medvetet: EN
-- uteslutningsregel (RoomBookings_room_is_held_once) avgör om en sal är ledig,
-- och varje läsare av bokningar (lärarens sök efter ledig sal, vikariernas
-- förslag, skolans dag, avbokningen) ser uthyrningen utan att ha lärt sig den.
-- Dagens rad bär rubriken "Extern bokning" och ingenting om den som hyr; namnet
-- och kontakten står bara i ExternalBookings, som bara en administratör läser.
--
-- ## Antal, och varför det är en trigger
--
-- En resurs har ett antal, och en bokning håller några av dem. En
-- uteslutningsregel kan inte summera, så en BEFORE-trigger tar resursens
-- rådgivande lås till commit (vår egen nyckel, ingen rad) och räknar: som mest
-- så många som finns får hållas vid samma minut av de aktiva bokningarna
-- (PENDING och APPROVED). Räknat vid varje start inom den nya bokningens tid,
-- eftersom det största antalet samtidiga alltid inträffar vid en start. Två
-- samtidiga bokningar tar samma lås och räknas efter varandra. Triggern är
-- SECURITY DEFINER: den läser alla bokningar av resursen, också dem en lärare
-- inte får läsa. Låset hålls över den insatta radens främmande
-- nyckelkontroller (KEY SHARE på Users): en skrivare som håller en Users-rad
-- FOR UPDATE och sedan bokar en resurs skulle gå i cirkel med en bokning, och
-- ingen sådan skrivare finns (e-postbytet rör inte bokningar).
--
-- ## Vem som läser och skriver
--
-- Allt går genom gatewayen (bara app_authenticated), ingenting genom PostgREST:
-- kontaktuppgifterna ska inte kunna nås på något annat sätt, och en
-- läsning av resurserna räknar tillgänglighet som en vy gör bättre än fyra
-- läsningar i webbläsaren. Resurser och slag är grunddata (Planering) och läses av
-- personal. Bokningar skrivs av personal (en lärares egen, en administratörs under
-- Drift) och avbokas av ägaren; en lärare kan bara ändra sin egen rad till
-- CANCELLED. En serie läses av administratörer, skrivs av Drift och tas bort av Drift när den slutat eller avbokats (den hyrande kan be att bli glömd före gallringen). Dagarna i
-- en serie skrivs bara av en administratör under Drift: en trigger vägrar en
-- lärare som sätter externalBookingId, och att peka på en serie som inte är
-- radens egen sal eller resurs.
--
-- En serie ändras bara i det som inte är regeln: regeln (sal, resurs, dagar,
-- klockslag, datum) är fryst av en trigger, för dagarna som skapats av den
-- skulle annars sluta stämma. Vill skolan något annat avbokas serien och en ny
-- registreras. Avbokning sätter cancelledAt en gång och kommer inte tillbaka.
--
-- ## Borttagning
--
-- Den som registrerat en serie kan tas bort: nyckeln (registeredById, schoolId)
-- är ON DELETE SET NULL (registeredById), och serien står kvar. Men dagens rader
-- har bookedById = den som registrerade, och nyckeln därifrån är CASCADE som varje
-- bokning: en sal skulle tyst bli ledig. Gatewayen vägrar därför att ta bort en
-- person som registrerat en pågående serie (EXTERNAL_BOOKINGS_REGISTERED) och
-- säger hur det löses. En sal eller en resurs som hyrs ut tas inte bort heller, så länge en serie för den finns
-- (RESTRICT).
--
-- ## Gallring
--
-- En extern bokning är personuppgifter om någon som inte är användare och har sin
-- egen gallringstyp, EXTERNAL_BOOKINGS (20270204090000): en serie gallras när den
-- slutat (slutdatum) eller avbokats för längre sedan än skolans tid, med sina dagar
-- genom nyckeln. app.gallring_due och app.gallring_purge nedan är 20270129091000:s
-- kroppar (Checklistors, som bär Elevens lektion för dagens, Kvittens', Krisläges,
-- Rapporteringsgrads, Frånvarobevakningens, Vikariefrågans och Skyddad identitets
-- grenar) med en gren märkt "extern bokning"; en senare release som skriver om
-- funktionerna igen måste bära varje gren (src/gallring/gallring-branches.spec.ts
-- fäller en som tappas).
--
-- ## Vid sidan av det API som körs
--
-- Produktionen kör migreringen medan API:et före den betjänar förfrågningar.
-- RoomBookings får en kolumn utan standardvärde (ingen omskrivning) och en nyckel;
-- de nya nycklarna tar Schools, Users, Rooms och Sites i SHARE ROW EXCLUSIVE, som
-- blockerar skrivningar (inte läsningar) så länge filen går. Tabellerna låses
-- tillsammans, NOWAIT, i en loop: en vägran rullar tillbaka delbehandlingen och
-- försöker igen 50 ms senare, och den väntar aldrig med ett lås i handen. Efter
-- 30 s stannar den med ingenting gjort och kan köras om (prisma migrate resolve
-- --rolled-back, sedan deploy). Det gamla API:et känner ingen av de nya tabellerna
-- eller kolumnen och skriver aldrig en notis av den nya typen.

DO $$
DECLARE
  give_up timestamptz := clock_timestamp() + interval '30 seconds';
BEGIN
  PERFORM set_config('lock_timeout', '5s', true);
  LOOP
    BEGIN
      LOCK TABLE "Schools" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Users" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Rooms" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "Sites" IN SHARE ROW EXCLUSIVE MODE NOWAIT;
      LOCK TABLE "RoomBookings" IN ACCESS EXCLUSIVE MODE NOWAIT;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF clock_timestamp() > give_up THEN
        RAISE EXCEPTION 'Schools, Users, Rooms, Sites and RoomBookings were not free at once in 30 s: nothing is changed. Prisma now holds this migration as failed, so run "prisma migrate resolve --rolled-back 20270204091000_en_forening_hyr_en_sal_och_skolan_lanar_ut_mer_an_salar" and then "prisma migrate deploy" again';
      END IF;
      PERFORM pg_sleep(0.05);
    END;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- ResourceTypes
-- ---------------------------------------------------------------------------

CREATE TABLE "ResourceTypes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceTypes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResourceTypes_schoolId_name_key" UNIQUE ("schoolId", "name"),
    -- The target of the key from Resources: a resource names a type of its own school only.
    CONSTRAINT "ResourceTypes_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "ResourceTypes_a_name_is_one_to_60_characters" CHECK (char_length(btrim("name")) BETWEEN 1 AND 60)
);

ALTER TABLE "ResourceTypes"
    ADD CONSTRAINT "ResourceTypes_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Resources
-- ---------------------------------------------------------------------------

CREATE TABLE "Resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "resourceTypeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "siteId" UUID,
    "place" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Resources_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Resources_schoolId_name_key" UNIQUE ("schoolId", "name"),
    CONSTRAINT "Resources_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "Resources_a_name_is_one_to_80_characters" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "Resources_the_quantity_is_one_to_1000" CHECK ("quantity" BETWEEN 1 AND 1000),
    CONSTRAINT "Resources_a_place_is_one_to_120_characters" CHECK ("place" IS NULL OR char_length(btrim("place")) BETWEEN 1 AND 120)
);

CREATE INDEX "Resources_resourceTypeId_schoolId_idx" ON "Resources"("resourceTypeId", "schoolId");
CREATE INDEX "Resources_siteId_schoolId_idx" ON "Resources"("siteId", "schoolId");

ALTER TABLE "Resources"
    ADD CONSTRAINT "Resources_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A type in use is not deleted from under its resources.
ALTER TABLE "Resources"
    ADD CONSTRAINT "Resources_resourceTypeId_schoolId_fkey" FOREIGN KEY ("resourceTypeId", "schoolId")
    REFERENCES "ResourceTypes"("id", "schoolId") ON DELETE RESTRICT ON UPDATE NO ACTION;
-- SET NULL on the column alone: a plain SET NULL on the key (siteId, schoolId)
-- would empty schoolId too and fail the delete of a site with 23502.
ALTER TABLE "Resources"
    ADD CONSTRAINT "Resources_siteId_schoolId_fkey" FOREIGN KEY ("siteId", "schoolId")
    REFERENCES "Sites"("id", "schoolId") ON DELETE SET NULL ("siteId") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ExternalBookings (before the bookings that point at it)
-- ---------------------------------------------------------------------------

-- 1..7, each at most once, at least one. A CHECK cannot hold a subquery; this can.
CREATE FUNCTION app.external_weekdays_are_valid(w smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(w) BETWEEN 1 AND 7
     AND NOT EXISTS (SELECT 1 FROM unnest(w) AS u(x) WHERE x IS NULL OR x NOT BETWEEN 1 AND 7)
     AND (SELECT count(DISTINCT u.x) FROM unnest(w) AS u(x)) = cardinality(w)
$$;

CREATE TABLE "ExternalBookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "roomId" UUID,
    "resourceId" UUID,
    "resourceQuantity" INTEGER,
    "organisation" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "purpose" TEXT,
    "note" TEXT,
    "weekdays" SMALLINT[] NOT NULL,
    "intervalWeeks" SMALLINT NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startTime" TIME(0) NOT NULL,
    "endTime" TIME(0) NOT NULL,
    "skippedDates" DATE[] NOT NULL DEFAULT ARRAY[]::date[],
    "cancelledAt" TIMESTAMPTZ(6),
    "registeredById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalBookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExternalBookings_id_schoolId_key" UNIQUE ("id", "schoolId"),
    CONSTRAINT "ExternalBookings_one_room_or_one_resource" CHECK (num_nonnulls("roomId", "resourceId") = 1),
    CONSTRAINT "ExternalBookings_only_a_resource_has_a_quantity" CHECK (("resourceId" IS NULL) = ("resourceQuantity" IS NULL)),
    CONSTRAINT "ExternalBookings_the_quantity_is_one_to_1000" CHECK ("resourceQuantity" IS NULL OR "resourceQuantity" BETWEEN 1 AND 1000),
    CONSTRAINT "ExternalBookings_an_organisation_is_one_to_120_characters" CHECK (char_length(btrim("organisation")) BETWEEN 1 AND 120),
    CONSTRAINT "ExternalBookings_a_contact_is_one_to_120_characters" CHECK (char_length(btrim("contactName")) BETWEEN 1 AND 120),
    CONSTRAINT "ExternalBookings_a_phone_is_three_to_40_characters" CHECK ("contactPhone" IS NULL OR char_length(btrim("contactPhone")) BETWEEN 3 AND 40),
    CONSTRAINT "ExternalBookings_an_address_has_an_at_sign" CHECK ("contactEmail" IS NULL OR (char_length("contactEmail") BETWEEN 3 AND 254 AND position('@' IN "contactEmail") > 1)),
    CONSTRAINT "ExternalBookings_a_contact_has_a_phone_or_an_address" CHECK ("contactPhone" IS NOT NULL OR "contactEmail" IS NOT NULL),
    CONSTRAINT "ExternalBookings_a_purpose_is_one_to_120_characters" CHECK ("purpose" IS NULL OR char_length(btrim("purpose")) BETWEEN 1 AND 120),
    CONSTRAINT "ExternalBookings_a_note_is_one_to_500_characters" CHECK ("note" IS NULL OR char_length(btrim("note")) BETWEEN 1 AND 500),
    CONSTRAINT "ExternalBookings_the_weekdays_are_valid" CHECK (app.external_weekdays_are_valid("weekdays")),
    CONSTRAINT "ExternalBookings_the_interval_is_one_to_four_weeks" CHECK ("intervalWeeks" BETWEEN 1 AND 4),
    CONSTRAINT "ExternalBookings_the_dates_are_ordered" CHECK ("endDate" >= "startDate"),
    -- As a room loan: a series is a term or a year, not a standing arrangement.
    CONSTRAINT "ExternalBookings_a_series_is_at_most_400_days" CHECK ("endDate" - "startDate" <= 400),
    CONSTRAINT "ExternalBookings_the_times_are_ordered" CHECK ("endTime" > "startTime"),
    CONSTRAINT "ExternalBookings_few_skipped_dates" CHECK (cardinality("skippedDates") <= 400)
);

CREATE INDEX "ExternalBookings_schoolId_endDate_idx" ON "ExternalBookings"("schoolId", "endDate");
CREATE INDEX "ExternalBookings_roomId_schoolId_idx" ON "ExternalBookings"("roomId", "schoolId");
CREATE INDEX "ExternalBookings_resourceId_schoolId_idx" ON "ExternalBookings"("resourceId", "schoolId");
-- A person removed finds the series they registered.
CREATE INDEX "ExternalBookings_registeredById_schoolId_idx" ON "ExternalBookings"("registeredById", "schoolId");

ALTER TABLE "ExternalBookings"
    ADD CONSTRAINT "ExternalBookings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- A room or a resource that is let out is not deleted from under its tenant.
ALTER TABLE "ExternalBookings"
    ADD CONSTRAINT "ExternalBookings_roomId_schoolId_fkey" FOREIGN KEY ("roomId", "schoolId")
    REFERENCES "Rooms"("id", "schoolId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ExternalBookings"
    ADD CONSTRAINT "ExternalBookings_resourceId_schoolId_fkey" FOREIGN KEY ("resourceId", "schoolId")
    REFERENCES "Resources"("id", "schoolId") ON DELETE RESTRICT ON UPDATE NO ACTION;
ALTER TABLE "ExternalBookings"
    ADD CONSTRAINT "ExternalBookings_registeredById_schoolId_fkey" FOREIGN KEY ("registeredById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("registeredById") ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- ResourceBookings
-- ---------------------------------------------------------------------------

CREATE TABLE "ResourceBookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "bookedById" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "startsAt" TIMESTAMPTZ(6) NOT NULL,
    "endsAt" TIMESTAMPTZ(6) NOT NULL,
    "status" "RoomBookingStatus" NOT NULL DEFAULT 'APPROVED',
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "externalBookingId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceBookings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResourceBookings_a_title_is_one_to_120_characters" CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
    CONSTRAINT "ResourceBookings_the_quantity_is_one_to_1000" CHECK ("quantity" BETWEEN 1 AND 1000),
    CONSTRAINT "ResourceBookings_the_times_are_ordered" CHECK ("endsAt" > "startsAt"),
    CONSTRAINT "ResourceBookings_a_note_is_at_most_500_characters" CHECK ("decisionNote" IS NULL OR char_length("decisionNote") <= 500)
);

CREATE INDEX "ResourceBookings_resourceId_startsAt_idx" ON "ResourceBookings"("resourceId", "startsAt");
CREATE INDEX "ResourceBookings_schoolId_startsAt_idx" ON "ResourceBookings"("schoolId", "startsAt");
CREATE INDEX "ResourceBookings_bookedById_schoolId_idx" ON "ResourceBookings"("bookedById", "schoolId");
CREATE INDEX "ResourceBookings_decidedById_schoolId_idx" ON "ResourceBookings"("decidedById", "schoolId");
CREATE INDEX "ResourceBookings_externalBookingId_schoolId_idx" ON "ResourceBookings"("externalBookingId", "schoolId");
CREATE INDEX "ResourceBookings_schoolId_status_createdAt_idx" ON "ResourceBookings"("schoolId", "status", "createdAt");

ALTER TABLE "ResourceBookings"
    ADD CONSTRAINT "ResourceBookings_schoolId_fkey" FOREIGN KEY ("schoolId")
    REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceBookings"
    ADD CONSTRAINT "ResourceBookings_resourceId_schoolId_fkey" FOREIGN KEY ("resourceId", "schoolId")
    REFERENCES "Resources"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ResourceBookings"
    ADD CONSTRAINT "ResourceBookings_bookedById_schoolId_fkey" FOREIGN KEY ("bookedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ResourceBookings"
    ADD CONSTRAINT "ResourceBookings_decidedById_schoolId_fkey" FOREIGN KEY ("decidedById", "schoolId")
    REFERENCES "Users"("id", "schoolId") ON DELETE SET NULL ("decidedById") ON UPDATE NO ACTION;
ALTER TABLE "ResourceBookings"
    ADD CONSTRAINT "ResourceBookings_externalBookingId_schoolId_fkey" FOREIGN KEY ("externalBookingId", "schoolId")
    REFERENCES "ExternalBookings"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- RoomBookings: a day of a series.
-- ---------------------------------------------------------------------------

ALTER TABLE "RoomBookings" ADD COLUMN "externalBookingId" UUID;
CREATE INDEX "RoomBookings_externalBookingId_schoolId_idx" ON "RoomBookings"("externalBookingId", "schoolId");
ALTER TABLE "RoomBookings"
    ADD CONSTRAINT "RoomBookings_externalBookingId_schoolId_fkey" FOREIGN KEY ("externalBookingId", "schoolId")
    REFERENCES "ExternalBookings"("id", "schoolId") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- The date of every change, and who registered a series: stamped here, so a
-- writer cannot choose it. A series written by a job or a migration (no signed-in
-- person) keeps what it was given.
CREATE FUNCTION app.external_bookings_stamp() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app.current_user_id() IS NOT NULL THEN
      NEW."registeredById" := app.current_user_id();
    END IF;
    RETURN NEW;
  END IF;

  NEW."updatedAt" := now();
  -- The rule is fixed: what the days were made from does not change under them.
  -- (A person removed empties registeredById through the key; nothing else moves it.)
  IF NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
     OR NEW."roomId" IS DISTINCT FROM OLD."roomId"
     OR NEW."resourceId" IS DISTINCT FROM OLD."resourceId"
     OR NEW."resourceQuantity" IS DISTINCT FROM OLD."resourceQuantity"
     OR NEW."weekdays" IS DISTINCT FROM OLD."weekdays"
     OR NEW."intervalWeeks" IS DISTINCT FROM OLD."intervalWeeks"
     OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
     OR NEW."endDate" IS DISTINCT FROM OLD."endDate"
     OR NEW."startTime" IS DISTINCT FROM OLD."startTime"
     OR NEW."endTime" IS DISTINCT FROM OLD."endTime"
     OR NEW."skippedDates" IS DISTINCT FROM OLD."skippedDates"
     OR (NEW."registeredById" IS DISTINCT FROM OLD."registeredById" AND NEW."registeredById" IS NOT NULL) THEN
    RAISE EXCEPTION 'EXTERNAL_BOOKING_RULE_IS_FIXED: en serie ändras inte; avboka den och registrera en ny'
      USING ERRCODE = 'XB409';
  END IF;
  -- A cancelled series stays cancelled.
  IF OLD."cancelledAt" IS NOT NULL AND NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" THEN
    RAISE EXCEPTION 'EXTERNAL_BOOKING_STAYS_CANCELLED: en avbokad serie kommer inte tillbaka'
      USING ERRCODE = 'XB409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ExternalBookings_stamp"
    BEFORE INSERT OR UPDATE ON "ExternalBookings"
    FOR EACH ROW EXECUTE FUNCTION app.external_bookings_stamp();

-- A day of a series is the series' own room or resource, and is written by an
-- administrator under Drift or by the owner. Judged for a signed-in person only
-- (the owner, jobs and migrations have none), as Users_administrators_are_decided is.
CREATE FUNCTION app.external_day_is_of_its_series() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  ok boolean;
  target uuid;
  old_target uuid;
BEGIN
  -- The hot path: every booking a member of staff makes for themselves.
  IF TG_OP = 'INSERT' AND NEW."externalBookingId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'RoomBookings' THEN
    target := NEW."roomId";
  ELSE
    target := NEW."resourceId";
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'RoomBookings' THEN
      old_target := OLD."roomId";
    ELSE
      old_target := OLD."resourceId";
    END IF;
    IF NEW."externalBookingId" IS NOT DISTINCT FROM OLD."externalBookingId"
       AND NEW."schoolId" = OLD."schoolId" AND target = old_target THEN
      RETURN NEW;
    END IF;
    -- A day does not leave its series by an update (the key's cascade deletes it).
    IF NEW."externalBookingId" IS NULL AND OLD."externalBookingId" IS NOT NULL AND app.current_user_id() IS NOT NULL THEN
      RAISE EXCEPTION 'EXTERNAL_DAY_STAYS_IN_ITS_SERIES: en dag lämnar inte sin serie'
        USING ERRCODE = 'XB409';
    END IF;
  END IF;
  IF NEW."externalBookingId" IS NULL THEN
    RETURN NEW;
  END IF;
  IF app.current_user_id() IS NOT NULL
     AND NOT (app.current_user_role() = 'SCHOOL_ADMIN' AND app.current_user_may('DRIFT', true)) THEN
    RAISE EXCEPTION 'EXTERNAL_DAY_IS_THE_EXPEDITIONS: en extern bokning skrivs av en administratör under Drift'
      USING ERRCODE = 'XB403';
  END IF;
  IF TG_TABLE_NAME = 'RoomBookings' THEN
    SELECT true INTO ok FROM "ExternalBookings" x
     WHERE x."id" = NEW."externalBookingId" AND x."schoolId" = NEW."schoolId" AND x."roomId" = target;
  ELSE
    SELECT true INTO ok FROM "ExternalBookings" x
     WHERE x."id" = NEW."externalBookingId" AND x."schoolId" = NEW."schoolId" AND x."resourceId" = target;
  END IF;
  IF ok IS NOT TRUE THEN
    RAISE EXCEPTION 'EXTERNAL_DAY_IS_OF_ITS_SERIES: dagen hör till en annan sal eller resurs än seriens'
      USING ERRCODE = 'XB409';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "RoomBookings_external_day"
    BEFORE INSERT OR UPDATE OF "externalBookingId", "schoolId", "roomId" ON "RoomBookings"
    FOR EACH ROW EXECUTE FUNCTION app.external_day_is_of_its_series();
CREATE TRIGGER "ResourceBookings_external_day"
    BEFORE INSERT OR UPDATE OF "externalBookingId", "schoolId", "resourceId" ON "ResourceBookings"
    FOR EACH ROW EXECUTE FUNCTION app.external_day_is_of_its_series();

-- Two active bookings of one resource hold no more than its quantity at one
-- minute. The error carries the constraint's name in its message and the
-- exclusion violation's SQLSTATE (23P01), so the gateway recognises it as it
-- does a room held twice.
CREATE FUNCTION app.resource_bookings_keep_quantity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = "public", "pg_temp" AS $$
DECLARE
  have integer;
  held integer;
BEGIN
  IF NEW."status" NOT IN ('PENDING', 'APPROVED') THEN
    RETURN NEW;
  END IF;
  -- One resource at a time: the count below is of what has been committed or is
  -- held by this transaction, and a second booking waits here for the first.
  PERFORM pg_advisory_xact_lock(hashtextextended('ResourceBookings:' || NEW."resourceId"::text, 0));
  SELECT r."quantity" INTO have
    FROM "Resources" r WHERE r."id" = NEW."resourceId" AND r."schoolId" = NEW."schoolId";
  IF have IS NULL THEN
    RETURN NEW; -- the key to Resources refuses it
  END IF;
  IF NEW."quantity" > have THEN
    RAISE EXCEPTION 'ResourceBookings_quantity_is_kept: det finns % av resursen, och bokningen vill ha %', have, NEW."quantity"
      USING ERRCODE = '23P01', CONSTRAINT = 'ResourceBookings_quantity_is_kept';
  END IF;
  -- The most the others hold at one minute inside [startsAt, endsAt): it is
  -- reached at a start, so look at this booking's start and at every start inside it.
  SELECT coalesce(max(s.held), 0) INTO held
    FROM (
      SELECT (SELECT coalesce(sum(o."quantity"), 0)
                FROM "ResourceBookings" o
               WHERE o."resourceId" = NEW."resourceId" AND o."id" <> NEW."id"
                 AND o."status" IN ('PENDING', 'APPROVED')
                 AND o."startsAt" <= t.at AND o."endsAt" > t.at) AS held
        FROM (SELECT NEW."startsAt" AS at
              UNION
              SELECT o."startsAt" FROM "ResourceBookings" o
               WHERE o."resourceId" = NEW."resourceId" AND o."id" <> NEW."id"
                 AND o."status" IN ('PENDING', 'APPROVED')
                 AND o."startsAt" > NEW."startsAt" AND o."startsAt" < NEW."endsAt") t
    ) s;
  IF held + NEW."quantity" > have THEN
    RAISE EXCEPTION 'ResourceBookings_quantity_is_kept: det finns % av resursen och % är redan bokade då', have, held
      USING ERRCODE = '23P01', CONSTRAINT = 'ResourceBookings_quantity_is_kept';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "ResourceBookings_quantity_is_kept"
    BEFORE INSERT OR UPDATE OF "status", "quantity", "startsAt", "endsAt", "resourceId" ON "ResourceBookings"
    FOR EACH ROW EXECUTE FUNCTION app.resource_bookings_keep_quantity();

-- ---------------------------------------------------------------------------
-- Row-level security and grants. See the preamble.
-- ---------------------------------------------------------------------------

ALTER TABLE "ResourceTypes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ResourceBookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ExternalBookings" ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  r text;
  tbl text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    -- Types and resources: personnel read, Planering writes (as the rooms).
    CREATE POLICY "resource_types_staff_select" ON "ResourceTypes"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN'));
    CREATE POLICY "resource_types_admin_insert" ON "ResourceTypes"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "resource_types_admin_update" ON "ResourceTypes"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "resource_types_admin_delete" ON "ResourceTypes"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));

    CREATE POLICY "resources_staff_select" ON "Resources"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN'));
    CREATE POLICY "resources_admin_insert" ON "Resources"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "resources_admin_update" ON "Resources"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('PLANERING', true)));
    CREATE POLICY "resources_admin_delete" ON "Resources"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('PLANERING', true)));

    -- Bookings: every teacher and administrator reads every booking of the
    -- school (so a free resource is one nobody holds); a teacher or an
    -- administrator under Drift books for themselves; the owner cancels and
    -- nothing else; Drift decides and removes.
    CREATE POLICY "resource_bookings_staff_select" ON "ResourceBookings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) IN ('TEACHER', 'SCHOOL_ADMIN'));
    CREATE POLICY "resource_bookings_staff_insert" ON "ResourceBookings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND "bookedById" = (select app.current_user_id())
                    AND ((select app.current_user_role()) = 'TEACHER'
                         OR ((select app.current_user_role()) = 'SCHOOL_ADMIN' AND (select app.current_user_may('DRIFT', true)))));
    -- An administrator under Drift books for anyone, as the rooms' admin arm does.
    CREATE POLICY "resource_bookings_admin_insert" ON "ResourceBookings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    -- Unlike the rooms' own arm, this one changes a booking to CANCELLED and to
    -- nothing else: a booking that waits for a decision cannot approve itself.
    CREATE POLICY "resource_bookings_own_update" ON "ResourceBookings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND "bookedById" = (select app.current_user_id()))
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND "bookedById" = (select app.current_user_id())
                    AND "status" = 'CANCELLED');
    CREATE POLICY "resource_bookings_admin_update" ON "ResourceBookings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "resource_bookings_admin_delete" ON "ResourceBookings"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('DRIFT', true)));

    -- Series: an administrator reads, Drift writes and removes a series that is over or
    -- cancelled; gallring removes one with its days at the school's time.
    CREATE POLICY "external_bookings_admin_select" ON "ExternalBookings"
        FOR SELECT TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
    CREATE POLICY "external_bookings_admin_insert" ON "ExternalBookings"
        FOR INSERT TO "app_authenticated"
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    CREATE POLICY "external_bookings_admin_update" ON "ExternalBookings"
        FOR UPDATE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
        WITH CHECK ("schoolId" = (select app.current_school_id())
                    AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
                    AND (select app.current_user_may('DRIFT', true)));
    -- A series that is over or cancelled can be removed with its days: the hirer asks to be
    -- forgotten before gallring would, and a room that was once let out is otherwise never deleted
    -- (the key from the series is RESTRICT). One that is running cannot: the hall would go free.
    CREATE POLICY "external_bookings_admin_delete" ON "ExternalBookings"
        FOR DELETE TO "app_authenticated"
        USING ("schoolId" = (select app.current_school_id())
               AND (select app.current_user_role()) = 'SCHOOL_ADMIN'
               AND (select app.current_user_may('DRIFT', true))
               AND ("cancelledAt" IS NOT NULL OR "endDate" < (select app.school_today())));

    FOREACH tbl IN ARRAY ARRAY['ResourceTypes', 'Resources', 'ResourceBookings', 'ExternalBookings'] LOOP
      EXECUTE format('REVOKE ALL ON %I FROM "app_authenticated"', tbl);
    END LOOP;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ResourceTypes" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "Resources" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ResourceBookings" TO "app_authenticated";
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ExternalBookings" TO "app_authenticated";
  END IF;

  FOREACH tbl IN ARRAY ARRAY['ResourceTypes', 'Resources', 'ResourceBookings', 'ExternalBookings'] LOOP
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
-- Gallring: a series goes with the school's choice for EXTERNAL_BOOKINGS, with
-- its days through the key. Both bodies are 20270129091000's (prod md5 before:
-- due 166943b0d5d22801fe9a1be96a722d95, purge 2390088f88e967fda35af6d56e63d3f9)
-- plus the one branch marked "extern bokning", so none of Checklistors, Elevens
-- lektion för dagens, Kvittens', Krisläges, Rapporteringsgrads,
-- Frånvarobevakningens, Vikariefrågans or Skyddad identitets is lost. A later
-- release that restates the functions again must carry every branch
-- (src/gallring/gallring-branches.spec.ts and RLS sections 350 and 374 fail on
-- a branch that is gone).
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
  -- extern bokning: a series that has ended, or was cancelled, longer ago than the school's time
  SELECT 'ExternalBookings', x."id"
    FROM school, "public"."ExternalBookings" x
   WHERE p_type = 'EXTERNAL_BOOKINGS' AND x."schoolId" = school."id"
     AND (x."endDate" < p_before OR x."cancelledAt" < school.before_at)
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
    -- extern bokning: a series goes with its days, by the key
    WHEN 'EXTERNAL_BOOKINGS' THEN
      DELETE FROM "ExternalBookings" WHERE "id" IN (
        SELECT d."id" FROM app.gallring_due(r."schoolId", p_type, cutoff, today) d
         WHERE d."tbl" = 'ExternalBookings' LIMIT budget);
      GET DIAGNOSTICS n = ROW_COUNT;
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
-- Function grants: the owner's alone. The trigger functions need none, and the
-- weekday check is a plain function of its argument.
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION app.external_weekdays_are_valid(smallint[]) IS
  'Lokal: ISO weekdays 1-7, each at most once and at least one; the CHECK of ExternalBookings.';
COMMENT ON FUNCTION app.external_bookings_stamp() IS
  'Lokal: stamps who registered a series and the time of a change, and refuses a change of its rule (XB409) or the return of a cancelled one.';
COMMENT ON FUNCTION app.external_day_is_of_its_series() IS
  'Lokal: a day of a series is its own room or resource, and is written by an administrator under Drift (XB403, XB409).';
COMMENT ON FUNCTION app.resource_bookings_keep_quantity() IS
  'Lokal: two active bookings of one resource hold no more than its quantity at one minute; takes the resource''s advisory lock and refuses with 23P01 and the constraint name ResourceBookings_quantity_is_kept.';

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app.external_weekdays_are_valid(smallint[])',
    'app.external_bookings_stamp()',
    'app.external_day_is_of_its_series()',
    'app.resource_bookings_keep_quantity()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;
  -- The CHECK on ExternalBookings calls the weekday function as the writer, so the
  -- API role runs it.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.external_weekdays_are_valid(smallint[]) TO "app_authenticated";
  END IF;
END
$$;
