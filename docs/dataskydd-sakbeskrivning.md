# Rastra Schema: vad systemet gör med personuppgifter

*Sakbeskrivning till en skolas dataskyddsombud. Läget är `main` vid commit `ca68298a2`, 2026-11-22.*

> **Det här är ingen avtalsmall, ingen registerförteckning och ingen rättslig bedömning.** Dokumentet beskriver vad koden och driftboken säger att systemet gör. Det som är en juridisk fråga eller ett beslut för den som driftar eller köper Rastra Schema står som en öppen punkt i avsnitt 13 och är inte ifyllt. Dokumentet säger ingenting om vem som är personuppgiftsansvarig eller personuppgiftsbiträde, ingenting om en SLA och ingenting om innehållet i ett biträdesavtal.

## Sammanfattning

1. **Delarna.** Rastra Schema är en webbapp, en gateway (API), en lösare (motor) och en databas hos Supabase. Databasen är den enda tillståndsbärande komponenten i driften; API, motor och webb är tillståndslösa (`docs/DEPLOYMENT.md:550-551`). Mobilapparna har dessutom ett lokalt, krypterat lager på telefonen (avsnitt 6.6).
2. **Motorn får inga personuppgifter.** Lösaren får ett problem i slumpade id:n, tal och tider: inga namn, inga adresser, inga elev-id och inga verkliga databas-id (avsnitt 9). Det är provat så att ett nytt fält fallerar provet, men det finns inget prov som söker igenom en hel nyttolast efter namn.
3. **Skolans data skiljs åt i databasen.** Varje tabell har radnivåskydd (RLS). API:t kör som en roll som inte kan kringgå det och vägrar starta om rollen kan det (avsnitt 6.2). HR-uppgifter skyddas däremot av gatewayen och inte av databasen (avsnitt 6.2–6.3).
4. **Uppgifter lämnar systemet till** Supabase (lagring och inloggning), Railway (drift), Vercel (webb), Resend (e-post) och, om skolan väljer det, Microsoft eller Google (skolkonto) och system skolan själv kopplar (SS12000). Push över Expo är **avstängd som standard** (avsnitt 4–5).
5. **E-posten är inte minimerad på samma sätt som push.** Tre brevtyper nämner ett barns fullständiga namn: oanmäld frånvaro, beslut om ledighet och ny ledighetsansökan. Push nämner aldrig en person (avsnitt 4.3–4.4).
6. **Läsloggen** skriver vem som läst om vem, utan innehåll, i läsningens egen transaktion. Den tar medvetet *inte* med schemalagret, som all personal läser direkt mot databasen (avsnitt 7).
7. **Gallring:** inget raderas förrän skolan har beslutat en period per slag. Därefter raderas eller anonymiseras tretton slag varje natt. Det går inte att ångra annat än ur en säkerhetskopia (avsnitt 8). Flera saker gallras inte alls, bland dem schemalagret (avsnitt 8.5).
8. **Registerutdrag och uttag av hela skolans data finns** för rektor och full administratör. Skyddad identitet hålls utanför och räknas (avsnitt 10).
9. **Ingen samlad revisionslogg, ingen integritetspolicy i produkten, inga uppgifter om regioner eller leverantörsloggar i repot** (avsnitt 5, 7, 10.5, 13).
10. **Lösaren är en CP-SAT-lösare utan inlärning.** Produktens egna texter kallar den fortfarande "AI-motorn". Om något i systemet omfattas av AI-förordningen är juristens bedömning (avsnitt 12).

## 1. Läsanvisning

**Vad som är belagt.** Varje påstående om vad systemet gör har en källa: en fil med radnummer, eller ett avsnitt i `docs/DEPLOYMENT.md` eller `docs/integration-api.md`. Radnumren gäller commit `ca68298a2`. Kod flyttar sig, så varje källa nämner också vad som står där, så att den går att hitta igen. Hänvisningar skrivs `fil:rad` eller `fil:första-sista`. En hänvisning till en migrering anger mappen under `prisma/migrations/`.

**Vad som inte är belagt** står som en öppen punkt: en fråga i avsnitt 13 med bokstaven B (beslut för användaren), F (fakta repot inte kan ge) eller K (kontroll som återstår i repot).

**Vad som har gjorts för dokumentet.** Koden och dokumenten i repot har lästs. Ingen produktionsdatabas, ingen produktionsmiljö och inga miljöfiler har öppnats, och inget har körts mot en databas (avsnitt 14). Att produktionen är inställd som koden och driftboken beskriver är därför inte kontrollerat.

**Namnen.** Produkten heter Rastra Schema (svenska) och Rastra timetable (engelska). Koden, databasen, miljövariablerna, API-vägarna och rubrikerna `X-SchemaPro-*` bär det gamla namnet och byter det inte, eftersom lagrade id:n och integrationer härleds ur dem (`docs/DEPLOYMENT.md:16-29`).

**Orden.** *Skolan* är den som använder Rastra Schema. *Huvudmannen* är kommunen eller den fristående skolans ägare. *Leverantören* är den som driftar det. Orden säger inget om vem som är personuppgiftsansvarig eller biträde (B1).

## 2. Systemet i korthet

| Del | Vad den är | Var den körs enligt driftboken | Källa |
|---|---|---|---|
| **Webben** | Next.js-app: alla roller använder den, och all planering och administration sker bara där. | Vercel eller annan Node-värd | `PRODUCT.md` (avsnittet Platform), `docs/DEPLOYMENT.md:362` |
| **Mobilapparna** | Rastra (personal och elever) och Rastra vårdnadshavare. Följeslagare för dagliga uppgifter; ingen administration. Inte distribuerade ännu. | Byggs separat (EAS eller lokalt) och distribueras inte genom driftsättningen | `PRODUCT.md`, `docs/DEPLOYMENT.md:16-23`, `:425-435` |
| **Gatewayen** | NestJS-API. All affärslogik, åtkomstkontroll och loggning av läsningar. | Railway | `docs/DEPLOYMENT.md:264-310`, `:290` |
| **Motorn** | Python-tjänst med OR-Tools CP-SAT. Genererar scheman och bemanningsförslag. Ingen databas. | Railway | `docs/DEPLOYMENT.md:241-262` |
| **Databasen** | Postgres hos Supabase, med radnivåskydd. Supabase Auth sköter inloggningen. | Supabase | `docs/DEPLOYMENT.md:73-103` |
| **E-post** | Resend, genom gatewayen. | Resend | `src/notifications/notification-delivery.service.ts:454` |
| **Push** | Expo, avstängd som standard. | – | `docs/DEPLOYMENT.md:291` |

**Användarna.** Skolans schemaläggare och administratörer (rektor, full, schemaläggare, expedition, läsare), lärare, vikarier i en pool, elever (F–9; vuxna elever kan anmäla egen frånvaro), vårdnadshavare, och den som har en länk till Schemavisaren. Huvudmannens centrala planerare är en egen sorts läsare (avsnitt 6.1). Skolan är en hyresgäst: en skola, en datamängd (`PRODUCT.md`, avsnitten Users och Operating Context).

**Vad Rastra Schema inte omfattar.** Gymnasium, förskola, fritids och betyg/omdöme (`PRODUCT.md`, avsnittet Capabilities and Constraints). PRODUCT.md anger att kunder, pilotskolor, en SLA, en DPA-mall och en registerförteckning saknas och inte får hittas på (`PRODUCT.md:200-209`, läget 2026-10-11). Inga sådana nämns här.


## 3. Vilka personuppgifter Rastra Schema håller

Det här avsnittet säger vad som finns i databasen om personer, och lika viktigt vad som *inte* finns. Det är en läsning av `prisma/schema.prisma` och migreringarna, inte av produktionen. "Tabell.kolumn" är databasens namn. En fullständig kolumnlista för det som skolan kan exportera finns i `docs/school-export-format.md`, och koden håller en egen lista över alla tabeller som innehåller rader om en person i `src/school-export/person-tables.ts:6-13` (registerutdraget, art. 15), där ett test fallerar när en tabell läggs till och ingen har bestämt vad som gäller för den (`docs/integration-api.md:1298-1300`).

### 3.1 Personer och kontaktuppgifter

| Tabell.kolumn | Innehåll | Källa |
|---|---|---|
| `Users.firstName`, `lastName` | Namn. Samma tabell för elever, lärare, administratörer och vårdnadshavare. | `prisma/schema.prisma:383-387` |
| `Users.email` | E-postadress. Obligatorisk, också för elever, och unik per skola. | `prisma/schema.prisma:388`, `:550` |
| `Users.phone` | Telefon, valfri. | `prisma/schema.prisma:389` |
| `Users.role`, `adminProfile`, `hrRead`, `teaches` | Roll, administratörsprofil, HR-läs-markering och om en administratör också undervisar. | `prisma/schema.prisma:383`, `:417`, `:421`, `:432` |
| `Users.studentGroupId` | En elevs klass. Bara på elever, vilket en CHECK hävdar. | `prisma/schema.prisma:441-448` |
| `Users.isActive`, `invitedAt`, `deactivatedAt`, `pseudonymisedAt`, `loginSince` | Livscykel: aktiv, när inbjudan skickades, när personen avaktiverades, när gallring pseudonymiserade personen, när raden tog sin inloggning. | `prisma/schema.prisma:392`, `:397`, `:407`, `:411`, `:437` |
| `Users.ss12000Id` | Personens id i skolans SS12000-källa (registret). | `prisma/schema.prisma:402` |
| `Users.authId` | Id för personens inloggning hos Supabase Auth. En person kan ha en rad per skola. Lösenordet, inloggningsadressen och leverantörens identitet ligger hos Supabase Auth, inte i Rastras tabeller. | `prisma/schema.prisma:377-382`, `:551` |
| `GuardianStudents.guardianId`, `studentId`, `origin` | Länken mellan vårdnadshavare och barn. Det är den enda representationen av vårdnad. Någon typ av vårdnad eller relation lagras inte. | `prisma/schema.prisma:3455-3458`, `src/integration/ss12000-v2/model.ts:39-40` |
| `StudentEnrollments`, `StudentGroupMembers`, `MasterLessonStudents`, `CalendarLessonStudents` | En elevs klasshistorik, gruppmedlemskap och vilka lektioner eleven står på. | `prisma/schema.prisma:1415-1428`, `:2933`, `:2953`, `:2990` |
| `HuvudmanMembers.email`, `firstName`, `lastName`, `authId` | Huvudmannens egna medlemmar (kommunadministratör, planerare). | `prisma/schema.prisma:6319-6322` |

**Tabellen `Users` är inte den enda som innehåller personuppgifter,** trots schemats rubrik "the ONLY table that stores PII" (`prisma/schema.prisma:370`), som är föråldrad. Även dessa har namn eller kontaktuppgifter:

| Tabell.kolumn | Innehåll | Källa |
|---|---|---|
| `ExternalBookings.organisation`, `contactName`, `contactPhone`, `contactEmail` | En extern hyresgäst som inte är användare (Lokal). Gallras som ett eget slag. | `prisma/schema.prisma:3720-3725` |
| `LeaveRequests.contactName`, `contactPhone`, `contactRelation` | En kontaktperson under en elevs ledighet. | `prisma/schema.prisma:3536-3538` |
| `AckRequests.authorName` | Avsändarens namn, stämplat när ett meddelande till vårdnadshavare skrevs. | `prisma/schema.prisma:6800` |
| `ConsentEntries.givenBy` | Fritext: vem som gav ett samtycke. | `prisma/schema.prisma:7136` |
| `Notifications.meta` | Det som en notis visas med: datum, namn, status. | `prisma/schema.prisma:3861` |
| `Ss12000SyncChanges.before`, `after` | Namn och e-post i en granskad synk. Nollas av en utlösare när körningen inte längre väntar på granskning. | `prisma/schema.prisma:5802-5803`, `:5813-5814` |
| `TeacherEmploymentLogs.before`, `after` | Ögonblicksbilder av en tjänst (signatur, anteckning, löne-id). | `prisma/schema.prisma:4673-4675` |
| `PublishedLessons.teacherId`, `coTeacherId`, `studentIds` | Kopior av lektioner med id på personer, vid publicering. | `prisma/schema.prisma:1702-1703`, `:1718` |

### 3.2 Uppgifter som är känsliga till sin art

Vad som följer är *fakta om vad som lagras*. Om en uppgift är en särskild kategori av personuppgifter enligt dataskyddsförordningen är skolans och juristens bedömning. Koden själv kallar vissa av dem "health data (GDPR art. 9)".

| Uppgift | Vad som lagras | Läser | Källa |
|---|---|---|---|
| **Elevens frånvaro** | Per lektion: `AttendanceRecords.status` (närvarande, frånvarande, sen, ursäktad) och en fri anteckning. | Personal som ser lektionen, vårdnadshavare för sitt barn | `prisma/schema.prisma:179-185`, `:3144-3148` |
| **Anmäld frånvaro** | `AbsenceReports.type` (sjuk, besök, annat; standardvärde *sjuk*), tid, fri anteckning. | Personal; vårdnadshavare för sitt barn | `prisma/schema.prisma:61-65`, `:3482-3493` |
| **Ledighetsansökan** | `LeaveRequests.reason` (obligatorisk fritext), beslut och beslutsanteckning. | Skolans administratörer och elevens mentor | `prisma/schema.prisma:3510-3518` |
| **Personalens frånvaro** | `TeacherAbsences.reasonId`: en grov kategori ur skolans egen lista (sjuk, vård av barn, tjänsteresa, kompetensutveckling, annat). Kan lämnas som "ej angiven". Orsaken är aldrig fritext. Migreringen kallar orsaken "health data" och "GDPR art. 9" och säger att den läses av administratören och den frånvarande läraren, ingen annan. | Administratör och den frånvarande själv | `prisma/schema.prisma:5229-5235`, `prisma/migrations/20261012090000_*/migration.sql:12-24` |
| **Tjänstens villkor** | Tjänstgöringsgrad, nedsättning, anställningsform, karriärtjänst, deltid i dagar, begränsning av undervisning i följd (kommenterad "may be an arbetsanpassning after sick leave"), anteckning (fritext, högst 500 tecken), löne-id. | Rektor och full administratör; andra administratörer bara med HR-läs (avsnitt 6.3) | `prisma/schema.prisma:4275-4322`, `:4304-4313` |
| **Behörighet och legitimation** | Art (legitimation, behörig, tillåten), tidsgränser, anteckning. | Skolans administratörer | `prisma/schema.prisma:4409-4418` |
| **Samtycken och instruktionsbevis** | Vårdnadshavares samtycke per elev (givet, nekat, återkallat) och bevis att en elev instruerats. | Personal med uppgiften | `prisma/schema.prisma:7072-7080`, `:7132-7137` |
| **Krisläge** | Namnupprop vid utrymning eller inlåsning: vilka elever som är funna, saknas eller är borta. | Personal under larmet | `prisma/schema.prisma:5549-5552`, `:5575-5576` |
| **Skyddad identitet** | Att en person är markerad, inte vilken skyddsform skolan känner till (utom synkens markering, avsnitt 6.4). | Skolans administratörer | `prisma/schema.prisma:831-846` |

**Uppgifter som skolan kan skriva in i fria textfält** och som därför kan innehålla vad som helst: `AttendanceRecords.note`, `AbsenceReports.note`, `LeaveRequests.reason` och `decisionNote`, `TeacherEmployments.note`, `TeacherDuties.label` och `note`, `TeacherSubjectQualifications.note`, `AvailabilityConstraints.reason`. Någon spärr mot personnummer i de fälten har inte hittats utanför filläsarna (avsnitt 4.5), och databasen har ingen (sökt i migreringarna 2026-11-22). Det finns heller ingen sökning efter diagnos eller annan känslig uppgift i fritext. Den enda fritext som hanteras särskilt är skyddad identitet i exporterna (avsnitt 10).

### 3.3 Det som inte lagras

Varje rad nedan är sökt i `prisma/schema.prisma` och migreringarna och inte funnen.

| Uppgift | Läget | Källa |
|---|---|---|
| **Personnummer** | Ingen kolumn, ingen hash. Beslutat 2026-11-05: "Rastra stores none, not even as a hash." Det genomförs i gatewayen och webbläsaren, inte i databasen (ingen CHECK mot formen). En fil med ett personnummer läses inte: raden hålls tillbaka eller kolumnen släpps i webbläsaren, och numret ekas inte i något felmeddelande. SS12000-synken kastar `civicNo`, `birthDate`, `sex`, adresser, telefonnummer, foto och externa identiteter vid tolkningen och sparar dem aldrig, inte i en logg eller i databasen. SS12000-leverantören skickar dem aldrig ut. | `src/schedule-exchange/file-safety.ts:9-14`, `web/lib/personal-number.ts:1-12`, `src/integration/ss12000-sync/s1.ts:31-34`, `src/integration/ss12000-v2/model.ts:35-36`, `docs/integration-api.md:1534`, `PRODUCT.md:72` |
| Födelsedatum, kön, nationalitet, hemspråk | Ingen kolumn. (`locale`-kolumnerna är gränssnittsspråk för push och flöden, inte en uppgift om personen.) | `prisma/schema.prisma:3909`, `:6126` |
| Postadress, hemadress | Ingen kolumn. Kontaktuppgifter för externa hyresgäster och ledighetskontakter är e-post och telefon. | `prisma/schema.prisma:3720-3725`, `:3536-3538` |
| Foto | Ingen databaskolumn. Appens lokala lager har ett fält `photo_uri` som sätts till `null`. | `mobile/src/services/database/localDatabase.ts:93-96`, `mobile/src/services/roster.ts:126` |
| Lön | Ingen individuell lön lagras. Bara löne-id (anställningsnumret i lönesystemet) och skolans timkostnad per personalkategori. | `prisma/schema.prisma:7178-7183`, `:4323-4329` |
| Funktionsnedsättning, diagnos, särskilt stöd, åtgärdsprogram, anpassningar | Ingen tabell eller kolumn. Skolans fria textfält kan i praktiken innehålla sådant (avsnitt 3.2). | schemat, sökt 2026-11-22 |
| Fackligt tillhörighet, samverkan på personnivå | Ingen kolumn. Uppdragsslaget `ANNAT` har en fri etikett. | `prisma/schema.prisma:4139-4149` |
| Allergier och dieter | Lagras med flit inte, för att Måltidskollen ska slippa namnge elever. | `src/common/people-files.ts:125-127` |
| Bankkonto, skatte-id, IP-adress, enhetens användaragent, plats | Ingen kolumn. | schemat, sökt 2026-11-22 |
| Individuell lön, personlig bedömning av en lärare | Ingen sådan lagras. Rapporteringsgraden räknar *sparade närvaroregister per hållen lektion*, inte kvalitet (avsnitt 12.3). | `prisma/schema.prisma:6691-6694` |

**Inloggningen hos Supabase Auth** ligger utanför det här schemat. Där finns e-postadress, lösenordets hash, leverantörsidentiteter vid skolkonto och tidpunkter. Vad Supabase Auth lagrar har inte kartlagts för det här dokumentet (F5).


## 4. Dataflöden

### 4.1 Bilden

```
                    (1) webbläsare / mobilapp
                     │        │         │
        sidor, JS    │        │ API-anrop│ direkta läsningar (RLS)       inloggning
                     ▼        ▼         ▼                               ▼
              ┌──────────┐ ┌────────────┐ ┌───────────────┐      ┌───────────────┐
              │  Vercel  │ │  Railway   │ │   Supabase    │      │ Supabase Auth │
              │ webben   │ │ gatewayen  │ │ PostgREST     │      │ (+ Microsoft/ │
              └────┬─────┘ │ (NestJS)   │ └───────┬───────┘      │  Google om    │
                   │       └──┬──┬──┬─┬─┘         │              │  skolkonto)   │
   egen profil,    │          │  │  │ └─ e-post ──┼──► Resend     └───────────────┘
   räknare ────────┴──────────┼──┼──┘              │
                              │  └── push (AV) ───┼──► Expo ► Apple/Google
                              │                   │
              ┌───────────────┘                   ▼
              ▼                         ┌─────────────────────┐
      ┌──────────────┐  anonymt          │ Supabase Postgres   │◄── gatewayen ansluter som
      │ Railway:     │◄────────          │ (all lagrad data)   │    app_authenticated (RLS)
      │ motorn       │  (avsnitt 9)      └─────────────────────┘
      │ (CP-SAT)     │
      └──────────────┘          SS12000: skolans register ──► gatewayen (hämtar)
                                          andra system ◄──── gatewayen (läser med nyckel)
```

Siffran (1) är bara en etikett. Pilarna visar vart personuppgifter kan gå, inte varje anrop. Motorn har ingen väg ut och ingen databas (avsnitt 9).

### 4.2 Flödena, ett i taget

"Standard" är vad koden gör om inget annat har ställts in. Att produktionen har samma inställningar är inte belagt i repot (avsnitt 13, F-punkterna).

| # | Från → till | Vad som går | Standard och villkor | Källa |
|---|---|---|---|---|
| 1 | Webbläsare → Vercel (webbservern) | Sidor och kod. Webbservern läser också den inloggade personens egen profil (namn, e-post, roll, skola) och sessionstoken ur kakor, förnyar sessionen och räknar rader på instrumentpanelen. Resten av personuppgifterna läser webbläsaren själv från gatewayen och Supabase. | Alltid | `web/lib/auth.ts:1-3`, `:182-210`, `web/utils/supabase/middleware.ts:5-38`, `web/app/[locale]/(app)/admin/page.tsx:35-50` |
| 2 | Webbläsare → gatewayen (Railway) | Alla API-anrop med personens JWT. Webben anropar gatewayen direkt från varje webbläsare, så en skolas personal delar en nätverksadress; begränsningarna nycklas därför på inloggningen. | Alltid | `docs/DEPLOYMENT.md:368`, `src/database/prisma.service.ts:93-99` |
| 3 | Webbläsare och mobil → Supabase (PostgREST) | Direkta läsningar under personens JWT och RLS. Det som läses direkt är personens **egna** rader och **schemalagret**: lektioner, vem som undervisar dem och vilka elever som står på dem, som all personal ser. Andra personers uppgifter (personlistor, närvaro, frånvaro, ledighet, vårdnadshavarlänkar, gruppmedlemskap, tjänster, personalens frånvaro) läses sedan migreringarna 20261026100000 och 20261028090000 bara genom gatewayen, där läsloggen skrivs. | Alltid | `web/lib/queries.ts:265`, `:385`, `:635-731`, `web/utils/supabase/client.ts:13-27`, `prisma/migrations/20261026100000_den_inloggade_laser_bara_sitt_eget_direkt/migration.sql:1-36`, `docs/DEPLOYMENT.md:574-592`, `src/access-log/access-log.ts:94-101` |
| 4 | Webbläsare och mobil → Supabase Auth | Inloggning (e-post och lösenord), återställning av lösenord (skickas från webbläsaren, inte genom gatewayen), förnyelse av session. | Alltid | `web/app/[locale]/(auth)/login/login-form.tsx:90`, `web/app/[locale]/(auth)/forgot-password/forgot-password-form.tsx:51`, `web/utils/supabase/middleware.ts:36` |
| 5 | Webbläsare och mobil → Microsoft Entra ID eller Google, via Supabase Auth | Vid "Logga in med skolkonto": den fullständiga e-postadressen som `login_hint`, domänen som `domain_hint` (Entra) och omfånget `email`. | Bara om skolan valt skolkonto | `web/app/[locale]/(auth)/login/login-form.tsx:134-141`, `web/lib/school-account.ts:100-113`, `docs/DEPLOYMENT.md:2917-2924` |
| 6 | Gatewayen → Supabase Postgres | All lagrad data, genom en poolad anslutning som rollen `app_authenticated` (RLS gäller, avsnitt 6.2). Anslutningen krypteras, men den dokumenterade strängen verifierar inte serverns certifikat (se 5.2). | Alltid | `docs/DEPLOYMENT.md:196-228` |
| 7 | Gatewayen → Supabase Auth (administratörs-API, nyckel med service role) | Inbjudningar (e-postadress), märkning av inloggningar, ändring av e-postadress, radering av inloggning när en person pseudonymiseras eller tas bort. Nyckelns roll skriver ingen tabell. | När en administratör bjuder in, ändrar eller tar bort, och i nattens gallring | `docs/DEPLOYMENT.md:80-83`, `src/users/supabase-admin.service.ts:123-167`, `:195-223`, `:267-293`, `src/gallring/gallring.job.ts:168-178` |
| 8 | Gatewayen → motorn (Railway) | Det anonyma schemaläggningsproblemet och ingenting annat (avsnitt 9). | När någon genererar, kontrollerar eller får förslag | `src/optimization/optimization-proxy.service.ts:4855-4867` |
| 9 | Gatewayen → Resend | E-post: mottagarnas adresser (på dold kopia, upp till 49 per brev, avsändarens egen adress som mottagare), ämne och brödtext i klartext. Brödtexten nämner namn i vissa brevtyper (4.3). | **Bara om `RESEND_API_KEY` är satt.** Annars skickas ingenting. | `src/notifications/notification-delivery.service.ts:63`, `:192-194`, `:440-468` |
| 10 | Gatewayen → Expo → Apple och Google | Push: Expo-token, rubrik, text, `{notificationId, type}`. Texterna är minimerade (4.4). | **Av som standard** (`PUSH_NOTIFICATIONS=off`); kräver enligt driftboken ett biträdesavtal som täcker Expo och en grund för tredjelandsöverföring *innan* den slås på | `src/config/env.validation.ts:21-24`, `docs/DEPLOYMENT.md:291`, `:480-487` |
| 11 | Skolans register (IST, Edlevo m.fl.) → gatewayen (SS12000, hämtning) | Personer, grupper, tjänster och markeringar om skyddad identitet. Gatewayen skickar bara källans egna id:n, organisationer och datum. Följande kasseras vid tolkningen och sparas aldrig: personnummer, födelsedatum, kön, adresser, telefon, foto, externa identiteter. | Bara om skolan lagt in en källa; nattlig körning bara om skolan slagit på schemat och tillämpning bara om skolan slagit på den | `src/integration/ss12000-sync/s1.ts:15-37`, `src/integration/ss12000-sync/fetch-plan.ts:14-47`, `docs/DEPLOYMENT.md:296` |
| 12 | Gatewayen → andra system som skolan kopplat (SS12000-leverantör v1 och v2.0) | Namn, e-postadress (typ efter roll), inskrivningar, grupper, publicerat schema. Närvaro och frånvaro bara medan skolans beslut om delning gäller. Aldrig personnummer, anledning till frånvaro eller anteckningar. | Bara med en nyckel som skolan gjort; v2.0 skickar registrets `securityMarking` vidare | `src/integration/ss12000-v2/model.ts:21-44`, `docs/integration-api.md:399-470`, `:663-700` |
| 13 | Gatewayen → en prenumerants adress (webhook) | `{"modifiedEntites":[<resursnamn>],"deletedEntities":<bool>}` och signatur. **Ingen data och inga id:n.** | Bara om en konsument har registrerat en prenumeration | `src/integration/ss12000-v2/webhook-delivery.service.ts:197-216` |
| 14 | Alla med en länk → Vercel → gatewayen (Schemavisaren, kalenderflöden) | Det publicerade schemat för en klass, lärare eller sal; en persons egen vecka eller ett barns vecka bakom en adress personen gjort. Webbservern skickar besökarens adress till gatewayen för begränsning. | Bara länkar skolan eller personen har gjort | `src/publication/public-timetable.controller.ts:34-103`, `src/calendar-feed/public-calendar-feed.controller.ts:42-72`, `web/lib/public-timetable.ts:152-163` |
| 15 | Filer in: Skola24, Untis, aSc, CSV, Excel | Se 4.5. Personnummer släpps eller hålls tillbaka innan något sparas. | När en administratör läser in en fil | avsnitt 4.5 |
| 16 | Gatewayen → administratörens webbläsare (hela skolans export, registerutdrag) | Ett zip med skolans data. Byggs av ett jobb, lagras i databasen i bitar i 72 timmar och raderas sedan. | Bara rektor och full administratör | `src/school-export/school-export.ts:13-17`, `docs/integration-api.md:1257-1264` |
| 17 | Gatewayen ↔ personalens och vårdnadshavares telefoner (mobilappen) | Schema, klasslistor och en kö av närvaromarkeringar. Telefonens lokala lager är krypterat med SQLCipher (avsnitt 6.6). Apparna är inte distribuerade. | Bara med en byggd app | `mobile/src/services/database/localDatabase.ts:72-150`, `docs/DEPLOYMENT.md:21` |

### 4.3 Vad e-posten innehåller

Det mesta i push är minimerat, men **e-posten är det inte**. Brödtexten skrivs av koden per brevtyp. Tre typer nämner ett barns namn, och några bär fri text som en administratör skrivit:

| Brevtyp | Mottagare | Innehåll | Källa |
|---|---|---|---|
| Oanmäld frånvaro (`ABSENCE_UNREPORTED`) | Barnets vårdnadshavare | **Barnets fullständiga namn**, ämnets namn och datum: "… markerades frånvarande från … den … utan föranmäld frånvaro". Går fram oavsett vårdnadshavarens val av notiser. | `src/attendance/attendance.service.ts:384-405`, `src/notifications/notification-types.ts:181-191` |
| Beslut om ledighet (`LEAVE_DECIDED`) | Den som ansökte | **Barnets fullständiga namn**, datum, beviljad eller avslagen, och beslutsanteckningen (fri text). | `src/family/leave.service.ts:466-492` |
| Ny ledighetsansökan (`LEAVE_REQUESTED`) | Barnets mentor | **Barnets namn**, datum, antal skoldagar. Anledningen lämnas medvetet ur: "The reason stays in SchemaPro". | `src/family/leave-notices.ts:36-52` |
| Samtycke till ledighet | Vårdnadshavare | Fast text. Inget namn, inga datum. | `src/family/leave-notices.ts:125-143` |
| Lektion inställd, vikarie, sal, självstudier | Elever, vårdnadshavare, lärare | Ämne och tid. Vid inställd lektion även administratörens fria *anledning*. Aldrig grupp, sal eller lärare. | `src/calendar/lesson-notices.ts:22-46` |
| Vikariepass och avbokat vikariepass | Vikarien | Ämne, **grupp**, **sal**, tid. | `src/cover/cover-notices.ts:63-79` |
| Vikarie tillsatt | Administratören som frågade | **Namnet på läraren som tackade ja**, tid. | `src/cover/cover-request-notices.ts:124-129` |
| Avbokningssammanfattning | Elever, vårdnadshavare, lärare | Avbokningens namn (administratörens fria text), antal lektioner, dagar. | `src/publication/cancellation-digest.ts:130-152` |
| Rumsbokning beslutad | Den som bokade | Rummets namn, bokningens titel, tid och en fri anteckning. | `src/room-bookings/booking-decision.ts:36-60` |
| Frånvarobevakning, rapporteringsgrad, kvittens, elevbyte, externa bokningar, larm | Olika | Bara antal, procent eller fast text. Kvittens nämner varken barn, rubrik eller text. Elevbyte säger "Ett barn byter lektion" utan namn. | `src/absence-watch/absence-watch-notices.ts:60-73`, `src/reporting-rate/reporting-rate-notices.ts:56-61`, `src/ack/ack-notices.ts:15-53`, `src/lesson-moves/lesson-move-notices.ts:52-69` |
| Kökets dagliga brev (Måltidskollen) | Skolans köksadress | Skolans namn, ätningstider, portioner, klassernas namn, antal elever och frånvaro. Aldrig en elevs namn eller diet. | `src/notifications/notification-delivery.service.ts:492-500`, `src/meal-counts/meal-counts.ts:314-338` |
| Läraren anmäld frånvarande (`TEACHER_ABSENCE_REPORTED`) | Skickas **aldrig** som e-post eller push, bara i inkorgen. | – | `src/notifications/notification-types.ts:194` |
| Inbjudan och återställning av lösenord | Personen | Skickas av Supabase Auth med mallar som ligger i Supabase, inte i repot. | `docs/DEPLOYMENT.md:35-37`, `:95-98` |

Brevens avsändare är `EMAIL_FROM` (standard `Rastra Schema <noreply@schemapro.app>`), och adresserna går på dold kopia så att mottagarna inte ser varandras (`src/notifications/notification-delivery.service.ts:454-468`). Ett brev som Resend avvisar loggas med statuskod och skickas inte om (`:470-476`). Resends egen lagring av brevens innehåll beskrivs inte i repot (F7).

### 4.4 Vad en push får säga

Pushen lämnar Rastra över Expo (650 Industries, USA), Apple och Google och landar på en låsskärm som alla i närheten kan läsa. Därför nämner en push **ingen person** (inte barnet, eleven, läraren eller vikarien), ingen fri text och inget ämne, ingen grupp eller sal, eftersom sådana namn kan vara särskilda kategorier av uppgifter ("Modersmål arabiska", "Anpassad grundskola 7"). Den säger vilken sorts sak som hände och när. `data` är bara `{ notificationId, type }` (`src/notifications/push-messages.ts:3-67`). Oanmäld frånvaro är i push "Oanmäld frånvaro {datum}", utan namn (`src/notifications/push-messages.ts:601-638`).

Ett test går igenom varje typ, språk och antal och kräver att rubrik och text inte innehåller något ord längre än tre tecken ur ett exempel på elevnamn, lärarnamn, ämne, grupp, sal och fri text (`src/notifications/push-messages.spec.ts:9-18`, `:50-64`, `:127-156`). Enligt driftboken är en enhetstoken och själva faktumet att en notis finns ändå personuppgifter (`docs/DEPLOYMENT.md:484-487`).

**Vad som stoppar push:** `PUSH_NOTIFICATIONS` har standardvärdet `off`. Av betyder att ingen begäran görs till Expo, att registrering av en enhet nekas med 409 `PUSH_DISABLED` (så ingen token sparas), att appen frågar `GET /api/v1/push/config` och aldrig ber om tillstånd av operativsystemet, och att kvittokontrollen inte startar (`src/config/env.validation.ts:21-24`, `src/notifications/devices.service.ts:36-43`, `src/notifications/devices.controller.ts:24-28`, `mobile/src/services/pushRegistration.ts:90-98`, `docs/DEPLOYMENT.md:291`). Att produktionen står på `off` är inte belagt i repot (F3).

### 4.5 Filer från Skola24 och andra system

| Väg | Var filen läses | Personnummer | Vad som sparas eller skickas | Källa |
|---|---|---|---|---|
| **Pseudonymiseraren** (`/pseudonymisera`, öppen sida för skolor som ännu inte är kunder) | Helt i webbläsaren. | Känner igen personnummer, samordningsnummer, TF-nummer, e-post och telefon och ersätter dem med märken; resultatet kontrolleras igen och hålls inne om något liknande finns kvar. | **Inget skickas, inget sparas.** Sidan har ett eget `Content-Security-Policy` med `connect-src 'none'` så att webbläsaren själv vägrar varje anrop. Test läser koden efter allt som skickar eller lagrar. | `web/lib/pseudonym-policy.ts:1-45`, `web/proxy.ts:112-117`, `web/lib/pseudonym-offline.test.ts:1-30` |
| **Kolumnmappning (X2) och formatbeskrivare för Skola24 (X3)** | Webbläsaren läser filen eller den inklistrade texten och mappar kolumner. | En kolumn som ser ut som personnummer **släpps i webbläsaren innan något skickas**; en rad som innehåller ett hålls tillbaka och nämns bara med radnummer. Skola24:s egna kolumner "Personnummer för elev" och "Personnummer för vårdnadshavare" är beskrivna som personnummerkolumner och släpps. | Bara den omkopplade tabellen går vidare till importen. | `web/lib/column-mapping.ts:1-18`, `web/lib/skola24-formats.ts:85-86`, `web/lib/personal-number.ts:1-50` |
| **CSV-import av personer, grupper m.m.** | Webbläsaren tolkar CSV; gatewayen får **typade JSON-rader, aldrig filen**. | Inget fält för personnummer finns i DTO:erna; en rubrik som ser ut som ett vägras. | Rader per elev: `firstName, lastName, email, phone, className`. Nya personer läggs in som katalogposter utan inloggning. | `src/import/import.controller.ts:27-45`, `src/import/dto/import.dto.ts:39-83` |
| **Schemautbyte: CSV, Excel, Untis GPU, aSc XML** | **Filen skickas till gatewayen** (base64 i JSON, högst fyra filer) och tolkas där. | Kolumn med personnummerrubrik släpps oläst; en cell som ser ut som ett gör raden oläsbar utan att numret ekas i felmeddelandet. | Förhandsgranskning, sedan tillämpning som skriver låsta lektioner. Exporten ger grundschemat till administratören (lärarens namn och e-post, inga elever). | `web/app/[locale]/(app)/admin/schedule-exchange/page.tsx:39-55`, `src/schedule-exchange/lesson-table.ts:40-78`, `src/schedule-exchange/asc-xml.ts:294-323` |
| **Sparade kolumnmallar** | Gatewayen sparar rubriker och vilket fält de hör till, aldrig ett värde. | En rubrik som ser ut som personnummer vägras. | `ImportTemplate`-rader | `src/import-templates/import-templates.service.ts:20-32`, `:125-140` |

Skola24 publicerar ingen fältspecifikation för något schemafil, och inga sidor anger fältens bredd eller filens teckenkodning. Beskrivningarna i `web/lib/skola24-formats.ts` bygger därför på åtta supportsidor och sju publicerade kursfiler, lästa 2026-11-21 och 2026-11-22, och ordningen på kolumnerna är den som supportsidorna skriver ut, inte en specifikation av vad plattformen exporterar (`web/lib/skola24-formats.ts:3-15`). Vad en skolas egen export innehåller kan därför skilja sig, och en fil används bara på exakta rubriker. Hur Skola24 själv behandlar de filer en skola exporterar ligger utanför Rastra.


## 5. Underbiträden och hosting

**Vem som är personuppgiftsansvarig och vem som är personuppgiftsbiträde för Rastra Schema är inte avgjort här (B1).** Driftboken talar om skolan som personuppgiftsansvarig när den beskriver ett avtal för push (`docs/DEPLOYMENT.md:482-483`), och handboken talar om "den som driftar Rastra Schema" utan att säga vem det är (`docs/manual/anvandarmanual.html`, avsnitt 7.4). Rubriken "underbiträden" används därför här för de *tjänster som koden anropar eller kör på*, utan att ta ställning till deras rättsliga roll. Om och hur de är underbiträden, och vad ett biträdesavtal ska säga om dem, avgörs i B3.

### 5.1 Vilka som är med och vad var och en ser

Referensuppsättningen i driftboken är: Supabase (inloggning och Postgres), API:t och lösaren på en containerplattform, och webben på Vercel eller en annan Node-värd (`docs/DEPLOYMENT.md:3-6`, `:49-53`). Driftboken nämner Railway för API:t och motorn (`docs/DEPLOYMENT.md:290`, `:294`, `:297`) och Vercel för webben (`docs/DEPLOYMENT.md:290`, `:362`). Resend är e-postleverantören (`src/notifications/notification-delivery.service.ts:454`).

| Tjänst | Vad den gör för Rastra | Vad den ser, enligt koden | Region |
|---|---|---|---|
| **Supabase** | Databasen (Postgres) med all lagrad data; Auth (inloggning, inbjudningar, skolkonto); PostgREST (direkta läsningar under RLS). | **All lagrad personuppgift** i avsnitt 3, i klartext för leverantören av databasen. Dessutom Auth-uppgifter: e-postadress, lösenordets hash, leverantörsidentiteter och tidpunkter, som inte ligger i Rastras tabeller och inte är kartlagda här (F5). Webbläsarens direkta läsningar (flöde 3) och inloggningar (flöde 4) går hit. | **Inte angiven i repot** (F1). Genomgången rekommenderar Frankfurt (`eu-central-1`) för en svensk skola, men det är en rekommendation och inte en uppgift om produktionen (`docs/deployment-walkthrough.md:113-115`). Driftboken skriver bara `<region>` i anslutningssträngen (`docs/DEPLOYMENT.md:211`). |
| **Railway** | Kör API:t (gatewayen) och motorn som containrar; håller miljövariablerna med hemligheterna; samlar containrarnas utskrifter (loggar). | I minnet under varje anrop: allt gatewayen läser och skriver för en person. Hemligheterna: databaslösenord, JWT-hemlighet, Supabase-nyckeln, e-postnyckeln, nyckeln som förseglar SS12000-uppgifter. Loggarna (avsnitt 7). **Motorn** ser bara det anonyma problemet (avsnitt 9). | **Inte angiven i repot** (F1). |
| **Vercel** | Serverar webbappen (Next.js) och kör dess serverdel. | Webbförfrågningar: besökarens adress, kakor med Supabase-sessionen, webbadresser, **Schemavisarens token** (den står i adressen `/v/<token>`). Serverdelen läser den inloggade personens egen profil, förnyar sessionen och för Schemavisaren hämtar den schemat från gatewayen och skickar besökarens adress vidare (flöde 1 och 14). Vercels egna loggar och hur länge de sparas beskrivs inte i repot. | **Inte angiven i repot** (F1). |
| **Resend** | Skickar e-post åt gatewayen. | Mottagarnas e-postadresser, avsändaradress, ämne och brödtext, i klartext. Tre brevtyper nämner ett barns namn, flera bär administratörers fria text (4.3). Resends lagringstid och region beskrivs inte i repot. | **Inte angiven i repot** (F1). |
| **Expo, Apple (APNs), Google (FCM)** | Push till mobilappen. | **Ingenting, eftersom push är avstängd som standard** (4.4). Om den slås på: enhetens token, rubrik och text (minimerade), `notificationId` och typ. Koden själv beskriver Expo som 650 Industries, USA (`src/notifications/push-messages.ts:5-7`), och driftboken kräver ett biträdesavtal och en grund för tredjelandsöverföring innan push slås på (`docs/DEPLOYMENT.md:480-487`). | USA enligt koden och driftboken. |
| **Microsoft (Entra ID) eller Google (Workspace)** | Skolans egen konto- och inloggningsleverantör, om skolan väljer "Logga in med skolkonto". | Att en person loggar in, och den e-postadress webbläsaren skickar som `login_hint`. Det är skolans egen leverantör och inte något Rastra väljer åt skolan; om den räknas som underbiträde är en bedömning för B1 och B3. | Beror på skolans egen kontoleverantör. |
| **Apple och Google (appbutiker), Expo (EAS)** | Bygger och distribuerar mobilapparna. | Programkod, inte persondata. Apparna är inte distribuerade ännu (`docs/DEPLOYMENT.md:21`), och byggena sker på EAS eller lokalt, aldrig i GitHub Actions (`docs/DEPLOYMENT.md:431-433`). | – |

Det finns **ingen analys-, spårnings- eller felrapporteringstjänst** i någon del av koden. Sökningen 2026-11-22 efter sentry, datadog, posthog, mixpanel, segment, logrocket, amplitude, bugsnag, rollbar, newrelic, fullstory, hotjar, plausible, `@vercel/analytics`, google-analytics och opentelemetry i beroendefilerna, i `src/`, `web/`, `mobile/src` och motorn gav inga träffar. Inga typsnitt, skript eller bilder hämtas från en tredje part (`web/next.config.mjs`, `web/app/globals.css`, `web/app/[locale]/layout.tsx`). Webben och appen skickar inga anrop till andra än gatewayen, Supabase och, vid skolkonto, kontoleverantören. Mobilappen frågar dessutom Expo om en enhetstoken, men bara när push är påslagen (`mobile/src/services/pushRegistration.ts:90-133`). Driftboken nämner spårning och en samlad revisionslogg som framtida förbättringar (`docs/DEPLOYMENT.md:3688-3691`).

### 5.2 Skyddet under transport och i vila, så långt koden säger det

| Sträcka | Vad koden eller driftboken säger | Källa |
|---|---|---|
| Webbläsare → webb, gateway, Supabase | HTTPS. Mobilappen vägrar annat än `https` och `wss` utom `localhost` i en utvecklingsbygge. | `docs/DEPLOYMENT.md:444-446`, `docs/SECURITY_AUDIT.md:272` |
| Gateway → databasen | Anslutningen *krypteras* bara om strängen säger det. Den dokumenterade strängen har `sslmode=require&uselibpqcompat=true`, som krypterar **utan att verifiera serverns certifikat**; `verify-full` med Supabases certifikat är ett val driftboken beskriver men inte kräver. Utan `sslmode` ansluter `pg` okrypterat, och inget säger det. | `docs/DEPLOYMENT.md:214-228` |
| Gateway → motorn | Gatewayen anropar `AI_ENGINE_URL`, som driftboken beskriver som en `https://`-adress, och följer ingen omdirigering. Motorn ska enligt driftboken ligga på ett privat nät som bara API:t når "if your host supports it". Hur det är i produktionen är inte belagt (F6). | `docs/DEPLOYMENT.md:259-262`, `:283`, `src/optimization/optimization-proxy.service.ts:4860-4867` |
| Hemligheter i vila | SS12000-källans uppgifter och integrationsnycklarnas signeringshemligheter förseglas med AES-256-GCM, bundna till skola, källa och typ, med en nyckel som bara ligger i Railways variabler. Integrationsnycklar och tjänstenycklar sparas som SHA-256, aldrig i klartext; Schemavisarens och kalenderflödenas token likaså. | `docs/DEPLOYMENT.md:294`, `prisma/schema.prisma:3768-3805`, `:2065-2075`, `:6117-6131` |
| Databasen i vila | **Inte belagt i repot.** Hur Supabase krypterar lagringen och backuperna är leverantörens uppgift. | – |
| Säkerhetskopior | Driftboken rekommenderar Supabase PITR eller dagliga kopior (kräver Pro-nivå) och konstaterar att databasen är det enda tillståndsbärande: API, motor och webb är tillståndslösa. Om och hur långt tillbaka de är på i produktionen är inte belagt (F2). Gallring går inte att ångra annat än genom att återställa databasen ur en säkerhetskopia inom dess tid. | `docs/DEPLOYMENT.md:49`, `:550-552`, `:552-559` |
| Mobilens lokala lager | SQLCipher med en slumpad 256-bitarsnyckel i enhetens nyckelring (avsnitt 6.6). | `mobile/src/services/database/localDatabase.ts:9-14`, `:51-60` |
| Motorn mot obehörig | Delad nyckel jämförd i konstant tid, 8 MB största förfrågan och en gräns för anrop per klient och minut (standard 120). Projektet har dessutom gjort en egen säkerhetsgranskning (2026-07-11) med elva fynd som alla är markerade som åtgärdade. Den är gjord av projektet självt och är ingen oberoende granskning. | `optimization-engine/app/dependencies.py:26-39`, `optimization-engine/app/main.py:41`, `:284-310`, `optimization-engine/app/config.py:32`, `docs/SECURITY_AUDIT.md:258-275` |

### 5.3 Det som en upphandling brukar be om och som inte finns här

Inga av följande finns i repot, och inget av dem skrivs här (B1–B4): ett biträdesavtal, en förteckning över underbiträden med deras avtal och regioner, en SLA, en registerförteckning, en konsekvensbedömning, ett incidentförfarande eller ett kundregister. Det finns inga kunder och inga pilotskolor att hänvisa till (`PRODUCT.md`).


## 6. Åtkomst

### 6.1 Roller

Rastra Schema har fyra inloggningsroller och, för administratörer, fem profiler. Rollerna står i `prisma/schema.prisma:26-31` (`UserRole`: `STUDENT`, `TEACHER`, `SCHOOL_ADMIN`, `GUARDIAN`) och profilerna i `prisma/schema.prisma:39-50` (`AdminProfile`: `FULL`, `REKTOR`, `SCHEMALAGGARE`, `EXPEDITION`, `LASARE`). En administratörs skrivrättigheter delas upp i sex områden (`prisma/schema.prisma:52-59`, `AdminArea`: planering, schemaläggning, publicering, drift, personal, integrationer). Varje profil läser alla områden; områdena avgör bara vem som skriver (`prisma/schema.prisma:52-54`).

| Roll eller profil | Vad den läser och gör, enligt koden | Källa |
|---|---|---|
| Elev | Det egna schemat och den egna närvaron. Verifieringssteget i driftboken kräver att en elev ser bara sitt eget. | `docs/DEPLOYMENT.md:542-543` |
| Vårdnadshavare | Barnens publicerade vecka, anmäler frånvaro och ansöker om ledighet. Länken mellan vårdnadshavare och barn är tabellen `GuardianStudents`. | `PRODUCT.md` (avsnittet Users), `prisma/schema.prisma` (`model GuardianStudent`) |
| Lärare | Det egna schemat, närvaroregistrering för de egna lektionerna, den egna tjänsten. | `PRODUCT.md` (avsnittet Users), `src/staffing/hr-visibility.ts:30-31` |
| Vikarie i poolen | Föreslås bara inom den tillgänglighet vikarien har angett. | `PRODUCT.md` (avsnittet Users) |
| Administratör, profilen `FULL` eller `REKTOR` | Läser och beslutar; läser tjänstens procentsatser och nedsättning (HR-data) utan särskilt tillstånd. | `src/staffing/hr-visibility.ts:5-9` |
| Administratör, profilen `SCHEMALAGGARE` eller `EXPEDITION` | Läser alla områden, skriver i sina områden. Läser HR-data bara om personen har fått HR-läs. | `prisma/schema.prisma:417-421`, `src/staffing/hr-visibility.ts:5-9` |
| Administratör, profilen `LASARE` | Läser allt en administratör läser, skriver inget och beslutar inget. Kan få HR-läs. | `prisma/schema.prisma:45-47` |
| Huvudmannens medlemmar (kommunadministratör, planerare) | Läser varje skola huvudmannen äger som den skolans läsare: alla områden, inget skrivet, inget beslutat, ingen HR-läs. De får ingen rad i skolans register. | `docs/DEPLOYMENT.md:3510-3516` |
| Alla med en länk | Schemavisaren och kalenderflöden, inloggningsfritt (avsnitt 6.5). | `src/common/people-files.ts:253-274` |

Skolan är hyresgäst (tenant): en skola, en uppsättning data (`PRODUCT.md`, avsnittet Operating Context, "Tenancy and time"). En person kan ha en rad per skola och loggar då in en gång (`src/database/prisma.service.ts:93-99`).

### 6.2 Radnivåskydd i databasen (RLS)

**Vad som är belagt.**

- Varje tabell i `prisma/schema.prisma` har ett `ALTER TABLE … ENABLE ROW LEVEL SECURITY` i någon migrering. Det här kontrollerades statiskt för det här dokumentet (2026-11-22): schemat har 183 modeller, migreringarna har 184 sådana satser, och alla 183 tabeller finns bland dem. Ingen migrering stänger av radnivåskyddet (`grep` efter `DISABLE ROW LEVEL SECURITY` ger inga träffar). Kontrollen läser filerna och har inte körts mot någon databas. Att *policyerna* släpper in rätt rader är något annat, och det är det som RLS-sviten prövar (nästa punkt).
- API:t ansluter till databasen som en inloggningsroll, `app_authenticated`, som ärver `authenticated` och inte äger tabellerna (`docs/DEPLOYMENT.md:196-212`). Ägaren hoppar över RLS och används därför aldrig av API:t (`docs/DEPLOYMENT.md:198-199`).
- Vid varje uppstart läser API:t sin egen roll ur katalogen och **vägrar starta** om rollen är superanvändare eller har `BYPASSRLS` (`src/database/prisma.service.ts:178-230`, villkoret på rad 220; `docs/DEPLOYMENT.md:233-237`).
- Varje anrop som verkar för en person körs i en transaktion som sätter personens claims med `SET LOCAL`, som gäller bara den transaktionen och därför inte kan följa med till nästa anrop på samma poolade anslutning (`src/database/prisma.service.ts:100-111`, `:372-375`). Poolen vägrar dessutom starta med inställningen `query_timeout`, eftersom den kan lämna en anslutning med föregående anrops claims kvar (`src/database/pool-config.ts:23-30`).
- Skolans tillhörighet avgörs i databasen: api:t skickar vilken skola anropet gäller (`app.chosen_school_id`), och policyerna frågar `app.current_school_id()` (`src/database/prisma.service.ts:93-99`, `:375`).
- Tjänster som verkar utan person, alltså bakgrundsjobb och integrationsnycklar, går genom egna dörrar med en egen skolgräns: `withServicePrincipal` sätter `app.service_school_id` (`src/database/prisma.service.ts:492-509`), och jobbens dörrar svarar ingenting åt en session som har inloggning (`docs/DEPLOYMENT.md:6444-6495`, avsnitt 26 och 29).
- **RLS-sviten** `scripts/test/rls-policies.sql` körs som den roll API:t använder, utan applikationskod emellan, och prövar framför allt det negativa fallet: att en roll *inte* ser annat än sitt eget, också när en fråga glömmer skolfiltret (`scripts/test/rls-policies.sql:14-18`). Den fullständiga sviten körs av CI:s Database-jobb (`.github/workflows/ci.yml`). Ägarsidans kontroller finns i `scripts/test/rls-owner-checks.sql`.

**Vad som inte är belagt, eller är en gräns.**

- Att produktionsdatabasen har samma policyer som migreringarna beskriver är inte kontrollerat i det här arbetet. Det vore en läsning av produktionen.
- RLS skyddar rader, inte kolumner. **HR-uppgifter ligger därför i gatewayen och inte i databasen:** tjänstens procentsatser, nedsättning, anställningsform, deltid i dagar, begränsning av undervisning i följd och löne-id ligger på samma rad som signaturen som alla administratörer behöver. Gatewayen lämnar ut dem som `null` med `hrHidden: true` till den som inte har HR-läs (`src/staffing/hr-visibility.ts:11-18`, `:59-92`). Att andra personers tjänster bara går att läsa genom gatewayen, och inte direkt mot databasens REST-gränssnitt (PostgREST), gäller sedan migreringen `20261028090000` (`src/staffing/hr-visibility.ts:15-17`, `docs/DEPLOYMENT.md:586-592`).
- Personal läser skolans lektioner, lärare och elever på en lektion **direkt** mot databasen genom PostgREST, där alla anställda ser dem. Den läsningen går inte genom gatewayen och skrivs därför inte i läsloggen (avsnitt 7.2; `src/access-log/access-log.ts:94-101`). Att en markerad person "utelämnas" från en sida är där en fråga om presentation, inte en gräns (`src/common/people-files.ts:78-98`).

### 6.3 HR-läs

HR-läs är en markering på personen (`Users.hrRead`, `prisma/schema.prisma:417-421`) som en schemaläggare, en expedition eller en läsare kan få, så att de läser tjänsters procentsatser och nedsättning. Rektor och full administratör läser dem utan markeringen. Reglerna står på ett ställe, `readsHr` och `mayReadHrOf` (`src/staffing/hr-visibility.ts:44-46`, `:60-65`): en person läser alltid sin egen tjänst, ingen annans utan HR-läs, och huvudmannens läsare, som saknar rad, läser ingen alls. Ändringar av roll, profil och HR-läs skrivs av en utlösare i `UserRoleChanges` (`prisma/schema.prisma:546-547`, `:562-578`) och kan bara göras av en person vars egen profil avgör, alltså rektor eller full administratör (`prisma/schema.prisma:412-417`).

Exempel på vad HR-läs styr utöver tjänstesidan: SCB-filen och löneunderlaget kräver rektor, full administratör eller HR-läs och svarar annars `HR_NOT_YOURS` innan något har lästs (`docs/DEPLOYMENT.md:620-623`, `src/common/people-files.ts:229-234`). Genereringens ord om en lärares deltid och begränsning av undervisning i följd skrivs om för den som saknar HR-läs, utan siffra, lärare och tjänst (`src/access-log/access-log.ts:139-148`).

### 6.4 Skyddad identitet

Skolan kan markera att en person har skyddad identitet. Markeringen säger *att* personen är skyddad och varifrån skolan fick veta det. En markering som en administratör satt för hand säger aldrig *vilken* skyddsform (`prisma/schema.prisma:839-846`, `PersonProtections`). Två källor finns: SS12000-synken, som läser registret, och en administratör för hand. Båda kan finnas samtidigt, och personen är markerad så länge någon av dem finns (`prisma/schema.prisma:837-846`). Synkens markering kan däremot bära registrets art (`SEKRETESSMARKERING` eller `SKYDDAD_FOLKBOKFORING`, kolumnen `PersonProtections.kind`), som SS12000-leverantören skickar vidare som `securityMarking`; ingen sida visar arten (`prisma/schema.prisma:873-878`, `:890-895`, `src/users/person-protections.ts:29-32`, `docs/integration-api.md:441-449`). Schemats kommentar vid modellen, "never which protection", gäller alltså bara markeringar för hand. Vem som satte eller tog bort en markering, och när, skrivs av en utlösare i `PersonProtectionEvents` (`prisma/schema.prisma:903-920`). Markeringen ger en kod, `SKYDDAD-<nummer>`, i löneunderlaget (`prisma/schema.prisma:848-862`).

Vad markeringen gör med filer och flöden är avgjort route för route i `src/common/people-files.ts` (och för webbens filer i `web/lib/people-files.ts`). Ett test, `test/route-guards.e2e-spec.ts`, läser routingtabellen och fallerar på en route som ser ut som en fil och inte är listad där (`src/common/people-files.ts:5-9`). Regeln per route är en av sex (`src/common/people-files.ts:155-176`):

| Regel | Betyder | Exempel |
|---|---|---|
| `HOLDS_OUT` | Markerade personer, och rader som nämner dem, finns inte i svaret, och antalet står i svaret. | Vårdnadshavar-CSV, hela skolans export, bocklistor för papper |
| `NEVER_SHOWN` | Markerade personer finns aldrig i svaret, och svaret räknar dem inte, för att mottagaren inte ska kunna se att någon hålls tillbaka. | Schemavisaren, utskriftsuppsättningen |
| `KEEPS_AND_SAYS` | Mottagaren ska ha alla; markerade finns med och antalet anges. | SCB-filen, löneunderlaget (en markerad person anges då med signatur och löne-id, utan namn och e-post, eller med koden `SKYDDAD-<n>`) |
| `NAMES_STAFF` | Filen nämner personal och ingen elev eller vårdnadshavare. Inte filtrerad. | Schemautbytet till Untis och aSc (en markerad lärare *finns kvar*), klassboken |
| `ONE_PERSON` | Om en enda person, för personens egen skull. | Registerutdrag, kalenderflöde |
| `INTEGRATION` | Ett system skolan har kopplat, under ett avtal. **Inte filtrerat.** | SS12000-leverantören |

Tre gränser som ett dataskyddsombud bör känna till, alla uttalade i koden:

1. **SS12000-leverantören lämnar ut markerade personer** till de system skolan kopplar, eftersom eleven annars förlorar sina lektioner och sin närvaro där. Version 2.0 skickar registrets markering vidare så att mottagaren kan skydda personen; version 1 har inget fält för det (`src/common/people-files.ts:275-292`, `docs/integration-api.md:441-449`).
2. **Utelämnandet i Skolans dag är presentation, inte en gräns.** En lärare ser inte en markerad kollega på sidan, men raderna går att läsa direkt genom PostgREST (`src/common/people-files.ts:78-98`).
3. **Krisläge och några andra listor nämner markerade elever med avsikt,** eftersom en elev som ingen kan se på listan är en elev som ingen letar efter (`src/common/people-files.ts:12-28`). Filerna av dem, protokollet som CSV och på papper, utelämnar den markerade och räknar den.

### 6.5 Dörrar utan inloggning

| Dörr | Vad den ger | Skydd som koden anger | Källa |
|---|---|---|---|
| Schemavisaren (`/v/<token>`) | Ett publicerat schema för en klass, lärare eller sal; en elevs egen vecka via en kod. Aldrig en markerad person, och inget om vem som hålls tillbaka. | Länken görs av skolan. Webbservern hämtar sidan, så alla besökare når API:t från webbserverns adress; med `PUBLIC_VIEWER_PROXY_KEY` får varje besökares adress en egen gräns: 60 länkar eller koder som inte finns per minut, sedan två minuters spärr. Svaret har `X-Robots-Tag: noindex, nofollow` och inget `Set-Cookie`. | `docs/DEPLOYMENT.md:290`, `:376-379`, `src/common/people-files.ts:259-274` |
| Kalenderflöde (`/public/v1/calendar-feeds/<fil>`) | En persons egen vecka, eller en vårdnadshavares barns vecka, bakom en adress personen gjort. | Skrivs i läsloggen en gång per flöde och skoldag, kanal `CALENDAR`, när det gäller en vårdnadshavares flöde för ett barn. | `src/common/people-files.ts:253-258`, `src/access-log/access-log.ts:75-90` |
| Pseudonymiseraren (`/pseudonymisera`) | Ett verktyg som tar bort personuppgifter ur en fil i webbläsaren. Skickar inget. | Sidan får ett eget `Content-Security-Policy` med `connect-src 'none'`, så att webbläsaren själv vägrar varje anrop. Kod och test läser efter allt som skickar eller lagrar. | `web/proxy.ts:112-117`, `web/app/[locale]/pseudonymisera/page.tsx:8-17` |
| Inloggning, glömt lösenord, tillgänglighetsredogörelsen | Sidor utan inloggning. | – | `web/proxy.ts:16` |

### 6.6 Inloggning

- E-post och lösenord hanteras av Supabase Auth. Öppen registrering är avstängd, och alla konton skapas genom inbjudan från en administratör (`docs/DEPLOYMENT.md:99-101`, `:421-423`).
- Skolan kan i stället välja "Logga in med skolkonto" (Microsoft Entra ID eller Google Workspace). Kopplingen görs mot en *inbjuden* person genom verifierad e-postadress. Åtkomsttokenkroken i databasen (`sign_in.custom_access_token_hook`) avgör vid varje inloggning och förnyelse vem som släpps in, och kräver ny inloggning hos leverantören efter 24 timmar, så att en person som kommunen stängt av i Entra eller Workspace är ute inom ett dygn (`docs/DEPLOYMENT.md:2917-2952`). Skolan kan dessutom kräva skolkonto för personal (`docs/DEPLOYMENT.md:2954-2957`).
- Sessionens token gäller en timme som standard (`docs/DEPLOYMENT.md:2940-2941`).
- Mobilappens lokala databas är krypterad med SQLCipher. Nyckeln skapas slumpmässigt på enheten och ligger i enhetens nyckelring, åtkomlig bara medan enheten är upplåst och aldrig flyttbar till en annan enhet (`mobile/src/services/database/localDatabase.ts:9-14`, `:21-24`, `:51-60`). Appen vägrar öppna sin databas utan SQLCipher (`docs/DEPLOYMENT.md:454-456`).

### 6.7 Det som skolan själv bestämmer över

Skolans rektor och full administratör, "de som avgör", sätter bland annat gallringsperioder (avsnitt 8), om integrationer får läsa elevers närvaro och frånvaro (ett beslut som sparas med en referens, till exempel diarienummer, och som är append-only, `prisma/schema.prisma:5989`, `model AttendanceSharingDecision`), om skolkonto krävs, och om skolan godkänner en huvudman (`docs/manual/anvandarmanual.html`, avsnitt 7.4, "Skolans huvudman"). Ett ägande av en skola kräver båda sidor och kan avslutas av någondera, direkt (`docs/DEPLOYMENT.md:3534-3536`). Det huvudmannens personer har läst står kvar i skolans läslogg (`docs/DEPLOYMENT.md:3530-3532`).


## 7. Loggning

Det finns fyra sorters loggar att hålla isär: **läsloggen** (vem som läst om vem, sparad i databasen), **applikationsloggarna** (vad API:t, motorn och webben skriver ut), **historiktabeller** (vem som ändrat vad) och **plattformarnas egna loggar** (Railway, Vercel, Supabase, Resend), som repot inte beskriver.

### 7.1 Läsloggen

Varje gång en inloggad person eller en nyckel läser en annan persons uppgifter genom gatewayen skrivs en rad i `PersonalDataAccess`: **vem** som läste, med vilken roll, **vad** (en av tolv sorter), **när**, **genom vilken kanal** (webben, appen, en integration, kalenderflöde eller annat) och **vilka personer** läsningen gällde. Loggen säger bara *att* något lästes, aldrig *vad* som stod där (`prisma/schema.prisma:6195-6223`, migrering `20261026091000`, `docs/DEPLOYMENT.md:564-576`).

| Egenskap | Vad koden gör | Källa |
|---|---|---|
| Sorter | `PEOPLE`, `ROSTER`, `ATTENDANCE`, `ABSENCE_REPORTS`, `LEAVE_REQUESTS`, `LEAVE_REASON_AS_MENTOR`, `GUARDIANS`, `EMPLOYMENT` (tjänst, och en lärares rapporteringsgrad), `STAFF_ABSENCES`, `ACCESS_LOG` (loggen själv), `SCHEDULE` (en elevs vecka, ett vårdnadshavarflöde), `TEACHING_TIME` | `prisma/schema.prisma:6170-6183`, `src/access-log/access-log.ts:262-275` |
| Kanaler | `WEB`, `APP`, `INTEGRATION`, `OTHER`, `CALENDAR` (en vårdnadshavares kalenderflöde, en rad per flöde och skoldag) | `prisma/schema.prisma:6186-6194`, `src/access-log/access-log.ts:279-318` |
| Skrivs i läsningens egen transaktion | En läsning vars loggrad inte kan skrivas **misslyckas**. Ett svar lämnas därför aldrig ologgat. | `src/access-log/access-log.ts:305-331` |
| Samma läsare, samma sort, samma person inom **15 minuter** skrivs en gång | `readSize` håller det fulla antalet. En lärare som öppnar registret om och om igen under en lektion ger en rad. | `src/access-log/access-log.ts:310`, `docs/manual/anvandarmanual.html` (avsnitt 7.4, "Vem har läst om en person?") |
| Vem läsaren är | Tas ur transaktionens claims (en person), eller integrationsnyckeln, eller huvudmannens läsare eller nyckel. Aldrig ur ett argument. Läsarens egen läsning om sig själv skrivs inte. | `src/access-log/access-log.ts:306-318` |
| Vem som får läsa loggen | Rektor och full administratör, per person, högst 2 000 senaste rader. **Själva uppslaget skrivs i loggen** (sorten `ACCESS_LOG`). Loggen kan hämtas som CSV och ingår i hela skolans export. | `src/access-log/access-log.controller.ts:15-24`, `docs/integration-api.md:1272` |
| Tålighet | Tabellen har RLS med bara SELECT för API-rollen; skrivning sker bara genom en funktion med `SECURITY DEFINER`. **Append-only genom utlösare:** UPDATE, DELETE och TRUNCATE nekas, utom de referensåtgärder som tar bort en skolas rader eller nollar en raderad läsare, och skolans egen gallring. Ingen hashkedja, signatur eller extern kopia finns. | `prisma/migrations/20261026091000_skolan_ser_vem_som_last_om_en_person/migration.sql:162-189`, `:433-464`, `prisma/schema.prisma:6195-6201` |
| Gallring | Bara genom skolans beslut för slaget `ACCESS_LOG`, 1–120 månader. **Standard: ingen.** | `src/gallring/retention.ts:13-27`, `prisma/migrations/20261026090000_lasloggen_ar_ett_slag_av_uppgifter_som_gallras/migration.sql:3-14` |
| När en läsare tas bort | Läsarens id nollas i raderna (rollen står kvar). Ingen kod har hittats som tar bort en raderad persons id ur `subjectIds` hos andra läsare. | `prisma/migrations/20261026091000_skolan_ser_vem_som_last_om_en_person/migration.sql:152` |

### 7.2 Det läsloggen medvetet *inte* tar med

Koden räknar upp vad som inte loggas, med skäl, i `src/access-log/access-log.ts:91-261`. Ett dataskyddsombud bör känna till följande, eftersom det avgör vad frågan "vem har läst om den här eleven" kan svara på:

1. **Schemalagret** läses av all personal direkt mot databasen (PostgREST), inte genom gatewayen: vem som undervisar en lektion och vilka elever som står på den, i kalendern, i huvudlektioner och i sparade schemaversioner. Det skrivs därför inte, och ett skrivet spår från gatewayen skulle inte svara på vem som sett en elevs lektioner. Det som loggas är det som bara går genom gatewayen, till exempel familjens vecka (`SCHEDULE`) (`src/access-log/access-log.ts:94-101`).
2. **Siffror och sammanfattningar som inte nämner någon** (antal, andelar, frånvarostatistik per klass och månad).
3. **En lärares egen** rapporteringsgrad och en vårdnadshavares egna kvittenser, eftersom ingen annans uppgift läses.
4. **Lektionsloggar och vikarieanteckningar.** En anteckning är en kollegas fria text till en kollega och *kan* nämna en elev ("Kalle går ut 10.15"), men inget fält säger vem, så det finns inget ämne att logga läsningen mot. Avgränsningen är i stället vem som alls får läsa den: lektionens egna lärare och dess vikarie, ingen administratör (RLS 232). Anteckningen gallras inte heller än: den är inget slag, "a gap stated in the manual (6.11)" (`src/access-log/access-log.ts:233-251`).
5. **Notiser och e-post** som Rastra skickar. Varje notis finns kvar med mottagare, typ, innehåll och tid till gallring, och är dess egen post.
6. **Realtidsmeddelanden** om ändrade lektioner (id:n, inget register).
7. **Svaret på en skrivning** som personen själv just skrev, och synkens ändring om en person som ännu inte finns.

### 7.3 Applikationsloggar

| Del | Vad som loggas | Vad som inte loggas | Källa |
|---|---|---|---|
| **API:t (NestJS)** | Ett felsvar: `METHOD <webbadress> -> <status> [trace=<uuid>]`, på nivån *warn*, eller *error* med felets stack för 5xx. Start- och driftrader. Jobbens rader med `school=<id>`, antal och felklass. Användar- och skol-id:n, inte namn. Nivåerna är `error`, `warn` och `log`. | **Inga förfrågningskroppar** ("Never log the request body (may contain PII)"). Ingen loggning av varje förfrågan. Ingen e-postadress, inget namn och inget token i någon loggrad hittades vid sökning. En Schemavisar- eller kalendertoken i en adress ersätts av sex tecken ur dess hash. SS12000-adressens frågesträng tas bort. | `src/main.ts:12-16`, `src/common/filters/http-exception.filter.ts:56-91`, `:287-302`, `src/integration/ss12000-v2/errors.ts:83-98`, `src/database/prisma.service.ts:109-111` |
| **Motorn (Python)** | Strukturerad JSON: start, `request_id`, `academic_year_id`, antal krav, rum och begränsningar, tider, status. Vid ett valideringsfel bara antalet fel. | Ingen åtkomstlogg (`uvicorn --no-access-log`). Ingen nyttolast. | `optimization-engine/app/logging_config.py:8-47`, `optimization-engine/app/api/v1/optimize.py:135-160`, `optimization-engine/app/main.py:134`, `optimization-engine/Dockerfile:88-89` |
| **Webben (Next.js)** | Ingenting: inga `console.*` i webbkoden utanför provstubben, och `web/proxy.ts` sätter bara kakor och huvuden. | – | `web/proxy.ts` |
| **Mobilappen** | Innehåller `console.*`-anrop som inte har gåtts igenom (K3). | – | `mobile/src/services/sync/websocket_client.ts` |

Två saker som inte är avgjorda av läsningen:

- **Webbadresser loggas med frågesträng** vid felsvar (`src/common/filters/http-exception.filter.ts:298`). En adress innehåller id:n och sökparametrar. Vilka rutter som tar något annat än id:n i frågesträngen, till exempel en e-postadress, har inte inventerats (K2).
- Några ställen loggar ett felmeddelande som text (`error.message` eller `String(error)`): `src/publication/publications.service.ts:728`, `src/optimization/suggestions.service.ts:158`, `:198`, `src/exams/exam-planner.service.ts:724` och `src/optimization/optimization-proxy.service.ts:5842`. Att meddelandena är fria från personuppgifter är inte granskat (K2).
- Driftboken säger att API-loggarna är "PII-free by design" och att man skickar containrarnas utskrifter till sin loggsamlare (`docs/DEPLOYMENT.md:2900-2902`). Vart de skickas i produktionen, och hur länge Railway sparar dem, står inte i repot (F7).

### 7.4 Historik: vem ändrade vad

| Tabell | Vad den spar | Gallras av | Källa |
|---|---|---|---|
| `ScheduleChangeLogs` | Vem som ändrade schemat: före och efter | `CHANGE_LOGS` | `prisma/schema.prisma:3175-3194` |
| `TeacherEmploymentLogs` | Varje ändring av en tjänst eller ett uppdrag (HR), append-only | `CHANGE_LOGS`, ett helt läsår i taget | `prisma/schema.prisma:4640-4690` |
| `UserRoleChanges` | Ändringar av roll, profil och HR-läs, med vem som gjorde dem | **Inget slag hittat**; följer med personen | `prisma/schema.prisma:561-585` |
| `UserDeactivations` | Perioder en person varit inaktiv | **Inget slag hittat**; följer med personen | `prisma/schema.prisma:597-615` |
| `PersonProtectionEvents` | Vem som satte eller tog bort en markering om skyddad identitet | `CHANGE_LOGS` | `prisma/schema.prisma:900-920` |
| `GuardianStudentHistory` | Varje avslutad länk mellan vårdnadshavare och barn (bara id:n) | `CHANGE_LOGS` | `prisma/schema.prisma:5752-5768` |
| `RetentionDecisions`, `GallringRuns` | Skolans gallringsbeslut (append-only) och nattens räknare | Ingen radering funnen | `prisma/schema.prisma:6151-6161`, `:6240-6256` |
| `AttendanceSharingDecisions`, `LeaveDelegationDecisions`, `HuvudmanSchoolEvents` | Beslut och händelser, append-only | Ingen radering funnen | `prisma/schema.prisma:5989`, `:6018`, `:6380` |
| `JobRuns`, `JobClaims` | Antal per jobb och dag; felklass, aldrig ett felmeddelande | 90 och 35 dagar | `prisma/schema.prisma:5913-5940` |

**Det finns ingen samlad revisionslogg** över alla administratörers ändringar. Driftboken listar en sådan som en framtida förbättring och konstaterar att den ofta är ett upphandlingskrav (`docs/DEPLOYMENT.md:3688-3689`). Det finns i stället ett antal särskilda historiker, ovan.


## 8. Gallring

Rastra Schema raderar ingenting av skolans uppgifter på egen hand. Skolan bestämmer själv hur länge varje slags uppgift ska sparas, och först då börjar en nattlig gallring. Därutöver finns ett antal fasta städningar av teknisk data. Det här avsnittet säger vad som raderas, vad som bara anonymiseras och, lika viktigt, vad ingen kod raderar.

### 8.1 Hur den nattliga gallringen fungerar

| Fråga | Svar i koden | Källa |
|---|---|---|
| **Vem bestämmer?** | Skolans rektor eller full administratör (de som avgör). Alla administratörer läser besluten och körningarna. | `src/gallring/gallring.controller.ts:22-27`, `src/auth/admin-areas.ts:44-50` |
| **Vad är standard?** | **Ingenting gallras.** Varje slag börjar som "ej beslutat", och ett slag som ingen beslutat om rörs aldrig. Ingen beslutsrad läggs in av någon migrering eller något seed. | `prisma/migrations/20261021110000_skolan_bestammer_hur_lange_uppgifter_sparas/migration.sql:5-11`, `docs/manual/anvandarmanual.html` (7.4) |
| **Vilka val finns?** | `PURGE_AFTER` med 1–120 månader (sidan erbjuder 1, 3, 6, 12, 24, 36, 60 och 120), `KEEP` (bevaras, också ett beslut) eller `UNDECIDED`. En referens till dokumenthanteringsplanen kan anges (1–200 tecken). | `src/gallring/retention.ts:32-37`, `web/lib/retention-types.ts:81`, `src/gallring/dto/gallring.dto.ts:31-44` |
| **Hur beräknas gränsdagen?** | Skolans lokala datum när körningen startar minus perioden. | `prisma/migrations/20261021110000_skolan_bestammer_hur_lange_uppgifter_sparas/migration.sql:473-484` |
| **Betänketid** | Ett beslut som gallrar *mer* än det som gäller börjar gälla efter 24 timmar, så att ett felklick går att ångra. En längre period, "bevaras" och "ej beslutat" gäller direkt. Databasen vägrar dessutom en körning vars tidpunkt ligger mer än tio minuter från nu. | `src/gallring/retention.ts:42-43`, `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:767` |
| **När?** | Ett jobb tickar var femte minut. En skola tas när klockan hos skolan är 03 eller senare och den inte har körts den dagen; en misslyckad körning tas om efter två timmar. | `src/gallring/retention.ts:40`, `src/gallring/gallring.job.ts:13`, `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:1218-1249` |
| **Hur mycket per natt?** | Högst 100 000 rader per slag och skola, högst 200 personer. Det som blir kvar tas nästa natt. | `src/gallring/gallring.job.ts:17-21`, `:139-148` |
| **Går det att stänga av?** | `GALLRING_BACKGROUND=off` stoppar jobbet. | `docs/DEPLOYMENT.md:303` |
| **Vad sparas om en körning?** | En rad per skola och natt i `GallringRuns`: perioder, gränsdagar, **antal** per slag, om allt före gränsdagen tagits, och hur många som väntar. En CHECK tillåter bara tal, datum och sanningsvärden: inga id:n, inga namn. | `prisma/migrations/20261021110000_skolan_bestammer_hur_lange_uppgifter_sparas/migration.sql:210-231`, `prisma/schema.prisma:6240-6256` |
| **Går det att ångra?** | **Nej, inte i Rastra.** Ett felaktigt beslut kan bara rättas genom att återställa databasen ur en säkerhetskopia från före natten, inom dess tid. Därför ska säkerhetskopiorna vara på innan en skola sätter en period. Rastra gör ännu ingen uttagning till huvudmannens e-arkiv. | `docs/DEPLOYMENT.md:552-560`, `docs/manual/anvandarmanual.html` (7.4) |
| **Skydd mot felsteg i databasen** | Alla körfunktioner vägrar en session som bär en inloggning. En person som återaktiverats mellan listan och pseudonymiseringen låses och frågas om igen och rörs inte. Den tillämpar tidigare av körningens gränsdag och dagens, och 0 om ingen period gäller. | `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:760`, `:786-828`, `:1020-1025` |

### 8.2 Vad varje slag raderar eller anonymiserar

Tretton slag finns (`src/gallring/retention.ts:13-27`). Villkoret för vad som är "förfallet" står i `app.gallring_due` (`prisma/migrations/20270204091000_en_forening_hyr_en_sal_och_skolan_lanar_ut_mer_an_salar/migration.sql:659-784`) och åtgärden i `app.gallring_purge` (`prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:992-1183`).

| Slag | Åtgärd | Räknas från |
|---|---|---|
| `ATTENDANCE` | **Raderar** närvaromarkeringar, frånvarobevakningens fynd, lärarnas rapporteringsgrad per dag, påminnelser om rapportering och elevbyten | Lektionens datum, fyndets senaste dag, dagen |
| `ABSENCE_REPORTS` | Raderar frånvaroanmälningar (också dagarna i beviljad ledighet) | Anmälans datum |
| `LEAVE_REQUESTS` | Raderar ledighetsansökningar med anledning och beslut | Ansökans sista dag |
| `NOTIFICATIONS` | Raderar notiser och kvittensbegäranden | Skapandet |
| `CHECKLISTS` | Raderar instruktionsbevis och samtycken för en elev som **har slutat**, och tomma samtyckeslistor. En elev som går kvar har aldrig något som gallras. | Elevens avaktivering, listans skapande |
| `CHANGE_LOGS` | Raderar schemats ändringslogg, tjänsternas versioner för ett helt läsår som slutat, historiken över vårdnadshavarlänkar och historiken över markeringar om skyddad identitet | Skapandet, läsårets slut, avlänkningen |
| `ABSENCE_REASONS` | **Anonymiserar, raderar inte:** sätter orsaken på lärarfrånvaron till tom. Frånvaron och vikariebesluten står kvar. | Frånvarons slut |
| `ACCESS_LOG` | Raderar läsloggen | Läsningens tidpunkt |
| `COVER_REQUESTS` | Raderar avslutade vikarieförfrågningar och vikariernas bekräftelser. En fråga som fortfarande är öppen och vars tid inte gått ut gallras aldrig. | Avslutet, bekräftelsen |
| `EXTERNAL_BOOKINGS` | Raderar externa bokningar med hyresgästens namn, telefon och e-post | Seriens slut eller avbokning |
| `CRISIS_DRILLS`, `CRISIS_ALARMS` | Raderar avslutade övningar respektive skarpa larm med allt som hör till. Ett pågående larm gallras aldrig. | Larmets slut |
| `DEPARTED_PEOPLE` | **Pseudonymiserar på plats** (8.4) | Avaktiveringen |

### 8.3 De fasta städningarna

Dessa körs oavsett om skolan beslutat något och rör teknisk data och spår, inte skolans register:

| Vad | När det raderas | Källa |
|---|---|---|
| Schemaförslag (privata kandidater) | Efter 7 dagar | `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:1719` |
| Sökningar efter lärarval | När de avslutats i mer än 24 timmar | `prisma/migrations/20270227090000_en_sokning_efter_lararval_ar_ett_jobb_med_lease/migration.sql:252` |
| Hela skolans export (zip-bitarna) | 72 timmar efter att filen byggts; databasen tillåter högst 14 dagar | `src/school-export/school-export.ts:12-14`, `prisma/migrations/20270114090000_hela_skolans_data_hamtas_som_en_tidsbegransad_fil/migration.sql:161` |
| Exportens beställningsrad ("vem som tog en kopia") | 13 månader efter att den avslutats | `src/school-export/school-export.ts:16-17` |
| Push-kvitton | 24 timmar | `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:1349` |
| Enhetstoken för push | 30 dagar efter att den spärrats, eller 180 dagar utan att ha setts | samma fil, `:1350-1351` |
| SS12000: spår av borttagna ids (gravstenar) | 400 dagar | `prisma/migrations/20261014130000_en_konsument_kan_prenumerera_pa_andringar/migration.sql:1365` |
| SS12000: leveransförsök till prenumeranter (status, ingen kropp) | 30 dagar | samma fil, `:1368` |
| Jobbkörningar och jobbclaims (antal och felklass) | 90 respektive 35 dagar | `prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:1267`, `:1230` |
| Påminnelser om rapportering | 60 dagar | samma fil, `:1629` |
| Frånvarostatistik per klass och månad (inga elevers namn, aldrig en klass med färre än fem elever) | Månader före de tre senaste läsåren, oavsett skolans beslut | `prisma/migrations/20270121090000_franvaron_over_tre_lasar_lagras_per_klass_och_manad_aldrig_per_elev/migration.sql:241-255` |

### 8.4 Personer som slutat: pseudonymisering

När en person har avaktiverats och skolans period för `DEPARTED_PEOPLE` har gått, **pseudonymiseras** personen på plats. Raden finns kvar, så att närvaro, beslut och klasshistorik hänger ihop, men personen kan inte längre kännas igen ur raden (`prisma/migrations/20270224090000_jobbens_ovriga_dorrar_svarar_inte_en_inloggning/migration.sql:902-990`):

- **Ersätts:** förnamn blir "Pseudonym", efternamn sex tecken ur id:t, e-postadressen `pseudonym-<id>@pseudonym.invalid`; telefon och SS12000-id töms; inloggningsid byts mot ett slumpat; inbjudan nollas.
- **Tas bort:** länkar mellan personen och vårdnadshavare eller elever, personens enheter för push och kvitton, val av notiser, alla notiser *till* personen (oavsett skolans beslut för notiser), markeringen om skyddad identitet och därmed löneunderlagets kod.
- **Töms på tjänsterna:** signatur, anteckning och löne-id, också i tjänsternas tidigare versioner. Tidigare versioner behåller signaturen tills `CHANGE_LOGS` tar läsåret.
- **Inloggningen hos Supabase Auth raderas** först, för den som bjudits in, om inte en annan skola eller en huvudmannamedlem håller samma inloggning. Går det inte försöker natten igen, och personen pseudonymiseras först när inloggningen är borta.
- **Väntar:** en lärare med tjänst ett läsår pseudonymiseras tidigast den 1 december det läsåret, så att SCB:s lärarfil kan lämnas med namn (`prisma/migrations/20261021110000_skolan_bestammer_hur_lange_uppgifter_sparas/migration.sql:135-148`).
- **Ändras inte:** personens övriga rader behåller sin egen periods regler (till exempel närvaro). En pseudonymiserad person kan aldrig aktiveras igen (`prisma/schema.prisma:408-411`).

Det finns ingen funktion som pseudonymiserar en person *på begäran*. Funktionen anropas bara av den nattliga körningen (`src/gallring/gallring.job.ts:181-183`). Den enda per-person-radering som finns är att en administratör tar bort personen, vilket raderar raden med de rader som hänger på den och, så gott det går, inloggningen hos Supabase Auth (`src/users/users.controller.ts:114`, `src/users/users.service.ts:792-869`, avsnitt 10).

### 8.5 Det som ingen kod raderar

Följande har inte någon gallring i koden som hittats. Det kan vara avsikten, men ett dataskyddsombud ska veta det:

| Vad | Varför det är intressant | Källa |
|---|---|---|
| **Schemalagret:** lektioner, vem som undervisar och vilka elever som står på dem, i kalendern, huvudlektioner och sparade versioner | Gallring av närvaro lämnar lektionerna. "Undervisningstiden räknas på lektionerna, inte på närvaron." En elev som står på en lektion står kvar så länge lektionen finns. | `docs/manual/anvandarmanual.html` (7.4), `src/access-log/access-log.ts:94-101` |
| Lektionsloggar och vikarieanteckningar | "Nor is it gallrad yet: it is no retention kind", en uttalad lucka | `src/access-log/access-log.ts:246-250` |
| `UserRoleChanges`, `UserDeactivations` | Inget slag hittat; följer med personen | `prisma/schema.prisma:561-615` |
| Genereringskörningar (`OptimizationJobs`) | Ingen raderingsregel hittad; körningar som tappat sin process markeras bara som misslyckade | `prisma/migrations/20270222090000_en_generera_korning_har_en_lease_och_ett_lasar_hogst_en_aktiv/migration.sql:177-215` |
| `RetentionDecisions`, `GallringRuns`, beslutstabeller | Append-only, ingen radering | `prisma/schema.prisma:6151-6161`, `:5989`, `:6018` |
| **Säkerhetskopior hos plattformen** | Det som gallrats ur databasen finns kvar i en säkerhetskopia tills kopians tid går ut. Hur länge är inte belagt (F2). | `docs/DEPLOYMENT.md:552-559` |
| **Loggar hos Railway, Vercel, Supabase, Resend och Expo** | Repot beskriver inte deras innehåll eller tid (F7). | – |
| E-post som skickats | Ligger hos Resend (och hos mottagaren) efter att den lämnat gatewayen; Rastra kan inte radera den. | `src/notifications/notification-delivery.service.ts:470-476` |

En tabell-för-tabell-inventering av alla 183 tabeller mot en gallringsregel har **inte** gjorts för det här dokumentet (K1). Listan ovan är det som hittats när koden lästs, och den är inte ett bevis för att inget annat är kvar.

### 8.6 Avvikelser mellan text och kod

Fyra ställen där en text i repot säger något som inte stämmer helt med SQL-koden. Koden gäller i det här dokumentet:

1. Webbtexten säger att en öppen vikariefråga "gallras aldrig" (`web/messages/sv.json:7344`). SQL-koden tar också en *öppen* fråga vars tid gått ut före gränsdagen (`prisma/migrations/20270204091000_en_forening_hyr_en_sal_och_skolan_lanar_ut_mer_an_salar/migration.sql:754-762`).
2. Kommentaren säger att tolv slag är rader som raderas. `ABSENCE_REASONS` är en uppdatering till tom, inte en radering (`src/gallring/retention.ts:11`).
3. Driftboken sammanfattar färre slag än de tretton som finns (`docs/DEPLOYMENT.md:552-556`).
4. Schemats rubrik säger att `Users` är "the ONLY table that stores PII" (`prisma/schema.prisma:370`); avsnitt 3 listar fler.


## 9. Den anonyma nyttolasten till motorn

Lösaren (motorn) är en egen tjänst som får ett schemaläggningsproblem och svarar med ett förslag. Frågan till ett dataskyddsombud är vilka uppgifter om personer som följer med. Svaret i koden är: **inga namn, inga adresser, inga elev-id och inga verkliga databas-id.** Motorn får slumpade id:n, tal och tider. Det här avsnittet visar var det sker, hur det är provat och vad ordet "anonym" här inte betyder.

### 9.1 Var det sker

Mellan gatewayen och motorn står en "maskerande proxy" (`src/optimization/optimization-proxy.service.ts:199-214`). Dess kontrakt, med egna ord i koden:

1. Raderna hämtas från databasen under den inloggade personens RLS-session.
2. Varje post får **ett nytt anonymt UUID**; verkliga id:n används inte för något som kan kopplas till en person, eftersom lärare är `Users`, "the PII table". En ny id-tabell byggs per anrop och kasseras när svaret har behandlats.
3. Varje textfält (namn, koder, orsaker, anteckningar) lämnas utanför.
4. Nyttolasten skickas till motorn över HTTPS med en delad tjänstenyckel (`X-API-Key`), aldrig med personens JWT (`src/optimization/optimization-proxy.service.ts:4857-4859`). Gatewayen följer ingen omdirigering, så nyckeln inte kan följa med till någon annan adress (`src/optimization/optimization-proxy.service.ts:4860-4867`).
5. Motorns svar översätts tillbaka med den kvarhållna id-tabellen innan något sparas.

Själva avbildningen sker i `fetchAndAnonymize` (`src/optimization/optimization-proxy.service.ts:2685`). Id-tabellerna är `Map`-objekt i processens minne, och en ny id skapas med `randomUUID()` (`:2806-2844`). Läsningarna av raderna är `select`-listor som nämner bara kolumner utan personuppgifter ("no PII fields selected", `:2846-2869`). De namn som gatewayen läser, klassernas, ämnenas och rumstypernas, används bara för att namnge ett avslag på vägen tillbaka och skickas aldrig till motorn (`:3060-3079`). **Ingen persons namn läggs i den kartan,** eftersom kartan hamnar kopierad i `OptimizationJobs.conflicts`, en kopia som varken en namnändring eller en radering skulle nå (`:3071-3075`). Personers namn sätts i stället på först när en sida läses (`src/optimization/optimization-jobs.service.ts:922-957`).

Id-tabellerna sparas inte i databasen: tabellen `OptimizationJobs` har inget fält för dem (`prisma/schema.prisma:3221-3282`), och `AnonMaps` är en processintern struktur (`src/optimization/optimization-proxy.service.ts:218-262`). Id-tabellen för lärare kasseras med flit ("the teacher map is discarded on purpose", `:228-238`).

### 9.2 Vad som faktiskt skickas

Det som följer med är scheman i siffror: antal lektioner per vecka, lektionens längd, grupper och deras storlek, rum och deras kapacitet, tider (ramtider, raster, luncher), lärares tillgänglighet och arbetstidsregler under anonyma id:n. Fältlistan är fast och provad (avsnitt 9.3). Tre saker är värda att peka på:

- **Elever skickas som antal, inte som personer.** Vid regeln om elevers håltimmar skickas "a count and the keys its pupils' lessons are filed under. No pupil id ever leaves the gateway." (`optimization-engine/app/schemas/schedule.py:1359-1370`).
- **Tjänsteuppgifter om en lärare kan följa med under ett anonymt id,** när skolan har satt dem: arbetstidsregler (lunchfönster, vila, tak per dag) och deltid i dagar (`optimization-engine/app/schemas/schedule.py:749`, `:964`). Motorn kan inte se vem det gäller, men uppgiften är en uppgift om ett anonymt id som i skolans egen mapp hör till en person. Se avsnitt 9.4.
- **Två id:n är inte slumpade per anrop:** `academicYearId` (läsårets verkliga id) och i motorns logg `request_id`. Läsårets id är inte en personuppgift, men det är ett verkligt id i skolans databas, och motorn skriver det i sin logg (`optimization-engine/app/api/v1/optimize.py:135-146`). `requestId` skapas nytt per anrop (`src/optimization/optimization-proxy.service.ts:1515`).

Motorn har inget namnfält att ta emot: dess indatamodeller ärver `CamelModel`, som har `extra="forbid"`, så ett fält motorn inte känner till ger 422 för hela anropet (`optimization-engine/app/schemas/schedule.py:103-111`). Det gäller även de andra vägarna till motorn (rumsfördelning, bemanning, provplanering, veckokontroll), som alla bygger på samma klass (`optimization-engine/app/schemas/exams.py:33`, `optimization-engine/app/schemas/staffing.py:41`, `optimization-engine/app/schemas/week_check.py:25`).

### 9.3 Hur det är provat

| Prov | Vad det visar | Källa |
|---|---|---|
| Gatewayens kontraktsprov | Fältlistan som gatewayen skickar är *exakt* den motorn deklarerar. Ett fält för mycket eller för lite fallerar. Provet förklarar varför: ett okänt fält är 422 för hela anropet. | `src/optimization/ai-engine-contract.spec.ts:19-34`, listan `:36-53` |
| Motorns spegelprov | Samma namn, hävdade mot motorns egna modeller, `_field_names(...)`. | `optimization-engine/tests/test_optimize.py:4748-4800` (`test_the_wire_contract_is_exactly_what_the_gateway_sends` på `:4767`) |
| Proxyns prov | "forwards no real database id — every resource is re-keyed anonymously": den serialiserade nyttolasten innehåller inte ett enda av de verkliga id:n provet planterat (krav, ämne, grupp, lärare, rum, begränsning, låst lektion). | `src/optimization/optimization-proxy.service.spec.ts:3188-3211` (under rubriken "PII-stripping pipeline", `:2411`) |
| Rumstyper | En rumstyp, som skolan döper själv ("Trä- och metallslöjd"), skickas som en anonym token, "never the real row id, and never the name". | `src/optimization/optimization-proxy.service.spec.ts:3213-3231` |
| Ett id, en anonym id | Varje verklig resurs får *ett* stabilt anonymt id i hela nyttolasten. | `src/optimization/optimization-proxy.service.spec.ts:3285-3303` |
| Motorns loggar | Motorn loggar strukturerad JSON "without PII fields" och binder bara korrelationsfält; vid ett valideringsfel loggas bara antalet fel, inte innehållet. | `optimization-engine/app/logging_config.py:9`, `:42`; `optimization-engine/app/main.py:134` |
| Motorns auth | Motorn tar bara emot anrop med den delade nyckeln, jämförd i konstant tid. | `optimization-engine/app/dependencies.py:26-39` |

Det finns **inget prov som matar in en riktig persondatamängd och söker igenom hela nyttolasten efter namn och adresser.** Skyddet bärs av tre saker tillsammans: urvalen läser inga personkolumner, motorn vägrar fält den inte känner, och kontraktsprovet fryser fältlistan. Det är en konstruktionsgaranti och inget innehållsprov. En framtida ändring som lade till ett textfält i både gatewayen och motorn skulle få båda sidors prov att fallera först när listan ändrades i båda (provtexten säger "fix the code, not the list", `src/optimization/ai-engine-contract.spec.ts:30-33`).

### 9.4 Vad "anonym" betyder här, och inte betyder

- Anonymiseringen **tar bort namn, kontaktuppgifter och verkliga id:n** och **byter ut id:n mot nya slumpade, per anrop**. Id-tabellen finns bara i gatewayens minne under anropet.
- Den gör **inte** skolans schema anonymt i vidare mening. Ett schema är en struktur (antal lektioner, grupper av en viss storlek, en lärare med en viss arbetstidsregel) som den som känner skolan kan känna igen. Motorn har ingen väg att göra det, eftersom den saknar tabellen, men om motorns indata eller logg läckte vore den inte tom på mening. Om detta är att betrakta som anonymiserade eller pseudonymiserade uppgifter är en rättslig bedömning som hör till juristen och inte avgörs här.
- Motorn har ingen databas och ingen disk som sparar indata: tjänsten "needs no database and no PII ever reaches it" (`docs/DEPLOYMENT.md:259-260`). Det vi kan belägga i koden är att motorn loggar korrelationsfält och antal (avsnitt 7.3). Hur värdplattformen (Railway) behandlar tjänstens processminne och loggar är inte beskrivet i repot (avsnitt 5, F7).
- Fritext hos skolan kan innehålla personuppgifter ("Kalle går ut 10.15") men fritext skickas inte till motorn (steg 3 ovan). Texter skolan skriver i fält som en timplansanteckning följer inte med.


## 10. Registrerades rättigheter, så långt produkten går

En skola som ska svara en person, eller lämna ifrån sig sin data, behöver verktyg. Det här avsnittet säger vilka som finns. **Det säger inte att de räcker.** Vad skolan är skyldig att göra och inom vilken tid är skolans och juristens fråga.

### 10.1 Registerutdrag (art. 15)

`POST /api/v1/school-exports/subject-access` bygger ett zip med **en persons** rader, eventuellt med personens vårdnadshavare eller barn. Det är rektor och full administratör som kan beställa det, och huvudmannens läsare, som bara läser, nekas (`docs/integration-api.md:1253-1255`, `:1295-1297`, `src/school-export/subject-access.service.ts:56-141`). Utdraget byggs i anropet, som administratören och under RLS, och **läsningen skrivs i läsloggen innan svaret lämnar systemet**: ett utdrag som inte kan loggas lämnas inte ut (`src/school-export/subject-access.service.ts:56-70`).

| Egenskap | Vad koden gör | Källa |
|---|---|---|
| Vilka tabeller | Alla tabeller som har rader om en person, enligt inventeringen över vad som tas bort med en person. Ett test fallerar när en tabell läggs till där och ingen har bestämt hur den hanteras. Tabeller som bär en persons id utan nyckel till `Users` är listade för sig, och ett prov mot katalogen fallerar för en kolumn som ser ut som en person och som ingen har tagit ställning till. | `docs/integration-api.md:1297-1305`, `src/school-export/person-tables.ts:6-13`, `:271-288` |
| En persons utdrag, inte omgivningens | I en rad som inte handlar om personen (en ledighet en lärare beslutat, en frånvaro en vårdnadshavare anmält) är elevens id och adress, anledningen, frånvarons art och anteckningarna tomma; kvar står personens egen handling. En anteckning personen skrivit som nämner en annan elev eller vårdnadshavare med fullt namn eller adress töms. | `docs/integration-api.md:1307-1316`, `src/school-export/subject-access.service.ts:56-64` |
| En skyddad persons utdrag | Namnger ingen annan: varje annans id och adress är tom i varje fil, och antalet står i manifestet. Administratören får veta det och ska kontrollera vem som frågar. | `docs/integration-api.md:1316-1324`, `src/school-export/subject-access.service.ts:51-58` |
| Vad som inte når | Det en persons eget konto håller och ingen administratör kan läsa (notisval, enheter för push, kalenderflöden) *namnges* i README men tas inte med. | `docs/integration-api.md:1322-1324` |
| Gräns i fritext | En första namnform ensam, ett smeknamn, en stavning utan diakritiska tecken eller en beskrivning ("mamma") **hittas inte**. Fritext är därför inte garanterat fri från andra personer. | `docs/integration-api.md:1281-1284` |

### 10.2 Hela skolans data

Samma administratörer kan beställa **hela skolans data** som ett tidsbegränsat zip (`POST /api/v1/school-exports`). Det är svaret på frågan "kan vi ta ut allt när vi går" (`docs/integration-api.md:1250-1264`).

- Ett jobb bygger filen som den administratör som beställde, med dennes inloggning och skola, så att RLS håller andra skolors rader utanför filen. Jobbet körs var 30:e sekund (`docs/DEPLOYMENT.md:304`).
- Filen ligger i databasen i bitar och kan hämtas i **72 timmar**, anger sin längd och SHA-256 och skrivs i läsloggen innan första byten. Därefter raderas den. En beställning är aktiv per skola åt gången, och en skola kan beställa tre gånger per dygn (`docs/integration-api.md:1261-1264`, `src/school-export/school-export.ts:12-17`).
- Innehåll: de listor sidorna exporterar (som CSV i samma format som CSV-importen läser, så att en annan skola eller ett annat system kan läsa in dem), grundschemat som tabell, och `data/` med personer, vårdnadshavarlänkar, närvaro, frånvaroanmälningar, ledighetsansökningar, notiser och läsloggen för varje läsår skolan sparar, samt `README.txt`, `FORMAT.md` (varje kolumn) och `manifest.json` med antal, storlek och SHA-256 (`docs/integration-api.md:1264-1276`, `docs/school-export-format.md`).
- **Personer med skyddad identitet finns inte med**, inte heller rader om dem. Manifestet räknar vad som hållits utanför (`docs/integration-api.md:1277-1290`, `src/common/people-files.ts:201-206`).
- Måttet för 1 000 elever med ett års närvaro (1,14 miljoner markeringar): 1,18 miljoner rader, ett zip på 33 MB, byggt på under en minut (`docs/integration-api.md:1291-1293`).
- Beställningsraden ("vem tog en kopia") sparas i 13 månader (`src/school-export/school-export.ts:16-17`).

### 10.3 Radering

| Väg | Vad som händer | Källa |
|---|---|---|
| **Nattlig gallring** | Raderar eller anonymiserar efter skolans beslut (avsnitt 8). | avsnitt 8 |
| **Pseudonymisering av en person som slutat** | Avsnitt 8.4. Sker bara i nattens körning, inte på begäran. | `src/gallring/gallring.job.ts:181-183` |
| **En administratör tar bort en person** | `DELETE /api/v1/users/:id` raderar personens rad med de rader som hänger på den genom främmande nycklar, och tar bort inloggningen hos Supabase Auth så gott det går. Dialogen och en inventering (`src/common/removal-inventory.ts`) säger vad som följer med och vad som stannar. | `src/users/users.controller.ts:114`, `src/users/users.service.ts:792-869`, `src/common/removal-inventory.ts:1-60` |
| Rader med id på en person *utan* främmande nyckel (historik över avlänkade vårdnadshavare, markeringar, integrationers handlingar, ögonblicksbilder) | Följer inte med automatiskt; de är listade för sig i inventeringen. | `src/school-export/person-tables.ts:271-288` |
| **Kopior utanför Rastra** | Skickad e-post (Resend och mottagaren), säkerhetskopior hos plattformen, filer en administratör hämtat. Rastra kan inte radera dem. | avsnitt 5 och 8.5 |

Det finns **ingen** raderingsfunktion för en hel skola i produkten (bara mätskripten under `scripts/bench` tar bort skolor), ingen "radera på begäran"-väg för en pseudonymisering och ingen uttagning till ett e-arkiv (`web/messages/sv.json:7308`).

### 10.4 Rättelse, begränsning, invändning

- **Rättelse:** en administratör ändrar en persons namn, e-post och telefon (`PATCH /api/v1/users/:id`, som läsloggas) och synken mot skolans register kan uppdatera dem (`src/access-log/access-log.ts:204-207`, `docs/integration-api.md:1502-1512`). Att en vårdnadshavare själv kan rätta sina uppgifter är inte belagt här.
- **Begränsning av behandling och invändning:** inget verktyg för det har hittats i produkten. Det betyder inte att det inte går att göra (en administratör kan avaktivera en person), men det finns ingen särskild väg för det.
- **Automatiserade beslut:** se avsnitt 12. Lösaren föreslår, och en person tillämpar.

### 10.5 Information till de registrerade

**Ingen integritetspolicy eller information till registrerade finns i produkten.** Webbtexterna och handboken har ingen sådan sida (sökt i `web/messages/sv.json` och handboken 2026-11-22). Handboken säger bara att Rastra Schema hanterar personuppgifter om barn, att behandlingen omfattas av dataskyddsförordningen och att skolan ska se till att dess personuppgiftsansvarige känner till systemet (`docs/manual/anvandarmanual.html:154-158`). Vad som ska stå i skolans information till elever, vårdnadshavare och personal, och vem som ska skriva den, hör till B1 och B5.


## 11. Tillgänglighet

Tillgänglighetsredogörelsen är en del av det en upphandling brukar fråga efter, så den beskrivs här med vad den säger och vad den vilar på. Den är ingen försäkran om att tjänsten uppfyller lagen, och den är inte skriven av en jurist.

**Vem redogörelsen är till för.** Lagen (2018:1937) om tillgänglighet till digital offentlig service binder skolans huvudman, en kommun eller styrelsen för en fristående skola, och inte Rastra Schema. Huvudmannen publicerar redogörelsen för den tjänst den erbjuder. Därför sätts vem som står bakom och hur man når dem av driftsättningen, genom `ACCESSIBILITY_ORGANISATION`, `ACCESSIBILITY_EMAIL`, `ACCESSIBILITY_PHONE` och `ACCESSIBILITY_RESPONSE_DAYS` (`web/app/[locale]/tillganglighet/statement.ts:1-14`, `docs/DEPLOYMENT.md:372-374`). Tills minst en kontaktuppgift är satt säger sidan att kontaktuppgifterna saknas, och driftboken konstaterar att lagen inte godtar det för en tjänst i drift (`docs/DEPLOYMENT.md:373`).

**Var den finns.**

- Som en publik sida, `/sv/tillganglighet`, utan inloggning (`web/proxy.ts:16`, `web/app/[locale]/tillganglighet/page.tsx`).
- Som mallen `docs/tillganglighetsredogorelse.md`, med Diggs platshållare (`{Huvudmannens namn}`, `{e-postadress}`, `{telefonnummer}`, `{antal}`) som huvudmannen fyller i. Filen genereras ur samma källa som sidan, och ett test håller dem lika (`web/app/[locale]/tillganglighet/statement.ts:16-22`, `web/app/[locale]/tillganglighet/statement.test.ts`).
- Texten är på svenska på båda språken, eftersom lagen kräver svenska (`web/app/[locale]/tillganglighet/statement.ts:19-22`).

**Vad den säger.** Tjänsten är **delvis förenlig** med lagen. Kravnivån är WCAG 2.1 nivå AA, som EN 301 549 hänvisar till (`web/app/[locale]/tillganglighet/statement.ts:156`). Två brister redovisas (`web/app/[locale]/tillganglighet/statement.ts:171`, `:174`):

1. Tjänsten har inte testats av en person som använder skärmläsare. Den automatiska granskningen och ett manus för testet finns, men själva testet med VoiceOver och NVDA återstår (WCAG 1.3.1, 2.4.3, 4.1.2). Manuset är `docs/skarmlasartest.md`.
2. Schemat som administratören exporterar som PDF är inte taggat, så en skärmläsare kan inte läsa ut dess tabell (WCAG 1.3.1). Samma schema går att läsa på webben och att exportera som kalenderfil.

Redogörelsen gäller **webbtjänsten**: inloggningen, alla sidor för administratörer, lärare, elever och vårdnadshavare, och Schemavisaren. Den gäller inte mobilappen, som inte finns i App Store eller Google Play och som får en egen redogörelse när den publiceras (`docs/tillganglighetsredogorelse.md:5`, `docs/DEPLOYMENT.md:21`). Den senaste bedömningen är daterad **14 oktober 2026** och redogörelsen uppdaterades senast **18 oktober 2026** (`web/app/[locale]/tillganglighet/statement.ts:42`, `:44`).

**Vad den vilar på.**

| Underlag | Vad det gör | Källa |
|---|---|---|
| axe-core mot WCAG 2.1 A och AA, varje inloggad sida, för den roll som får se sidan, i dator- och mobilbredd och i ljust och mörkt tema | Körs i CI vid varje ändring (steget "Accessibility (axe-core)"). Listan med tillåtna avvikelser är tom. | `web/e2e/a11y-app.spec.ts:17`, `:39-66`, `.github/workflows/ci.yml:210-211` |
| Täckningsprov: en sida som axe aldrig öppnar eller öppnar tom fallerar provet | Sidorna läses ur filträdet på samma sätt som routern gör, så en ny sida under ett känt område granskas från den dag den läggs till. | `web/e2e/app-routes.ts:1-20`, `web/e2e/a11y-app.spec.ts:33-37` |
| Tillgänglighetsträdets baslinjer (namn, roller, rubriker, meddelanden) för de viktigaste sidorna | Sparade jämförelser som visar varje ändring. 31 filer i dag. | `web/e2e/aria-baselines/` |
| Tangentbord, synligt fokus och kontrast för inloggningen och schemaläggningen | Egna prov. | `docs/tillganglighetsredogorelse.md:41-47` |
| Manus för skärmläsartest | För de fyra rollerna, med vad som ska höras i varje steg. Själva testet är inte gjort. | `docs/skarmlasartest.md` |

**Vad som inte är belagt i repot.**

- Att redogörelsen på produktionens `/sv/tillganglighet` har kontaktuppgifter ifyllda. Variablerna sätts i Vercel, och inget i repot säger om de är satta (F4).
- Att något annat än den automatiska granskningen och de egna proven har gjorts. Redogörelsen kallar det en självskattning (intern testning). Ingen extern granskning är belagd.
- Att datumen 14 och 18 oktober fortfarande beskriver tjänsten. Sidor har tillkommit sedan dess. Axe-provet täcker dem enligt täckningsprovet ovan, men redogörelsens datum är inte flyttade, och hur ofta huvudmannen vill att den ses över är huvudmannens val.


## 12. Lösaren och AI-förordningen

**Det här avsnittet beskriver vad lösaren är och vad den inte är. Den rättsliga slutsatsen, om något av det omfattas av AI-förordningen och i så fall hur, har inte dragits här och ska bekräftas av en jurist (B6).** Inga artiklar i förordningen citeras, eftersom förordningens text inte har lästs för det här arbetet. Det datum då reglerna för högrisksystem inom utbildning börjar gälla har inte heller kontrollerats mot författningstexten och ska juristen kontrollera.

### 12.1 Vad lösaren är

- Lösaren är en Python-tjänst, `optimization-engine/`, som använder **OR-Tools CP-SAT**, en lösare för tvångsvillkorsprogrammering (constraint programming). Den får ett problem med regler och en målfunktion och söker en lösning som håller reglerna och, där skolan har satt vikter, är så bra som möjligt (`optimization-engine/requirements.txt:11`, `optimization-engine/app/solver/scheduler_solver.py:20`, `PRODUCT.md:74`).
- Produktens egen beskrivning, beslutad 2026-10-11, är att motorn är "a constraint solver (OR-Tools CP-SAT), with no ML and no language model" och att den ska beskrivas efter vad den gör (`PRODUCT.md:74`).
- **Inga bibliotek för maskininlärning ingår.** Motorns beroenden är FastAPI, uvicorn, pydantic, OR-Tools, structlog och verktyg för drift (`optimization-engine/requirements.txt`, `optimization-engine/pyproject.toml:6-13`). Sökningen i hela repot (`package.json`, `web/package.json`, `mobile/package.json`, motorns beroendefiler) efter `anthropic`, `openai`, `langchain`, `torch`, `tensorflow`, `sklearn`, `numpy`, `pandas` och `transformers` ger inga träffar. Ingen kod i `src/`, `web/`, `mobile/` eller motorn anropar `api.anthropic.com`, `api.openai.com` eller liknande tjänster (sökt 2026-11-22).
- **Inga modellfiler och ingen träningskod.** Repot innehåller inga filer av typerna `.pkl`, `.onnx`, `.pt`, `.joblib` eller liknande under `optimization-engine/`, och motorns kod skriver inga filer och använder inget `pickle`, `joblib` eller `sqlite`. Motorn har ingen databas (`docs/DEPLOYMENT.md:259`). Orden "train" och "learn" förekommer inte i motorns kod utom i två kommentarer; den ena, "CP-SAT's clause learning" (`optimization-engine/app/solver/scheduler_solver.py:4411`), är CP-SAT:s eget tekniska ord för hur en enskild sökning lär sig av sina återvändsgränder. Det är en teknik inuti ett anrop. Ingenting sparas mellan anropen.
- **Motorn är tillståndslös mellan anrop och har ingen kunskap om skolan utöver nyttolasten** (avsnitt 9).
- Namnet i produktens egna texter är en ojämnhet som ett dataskyddsombud kommer att möta: webbens texter säger "AI-driven schemaläggning & närvaro" och "AI-motorn" (`web/messages/sv.json:14`, `:262`, `:1698`), handboken likaså (`docs/manual/anvandarmanual.html:24`), och koden kallar tjänsten `AI_ENGINE_URL` och `src/optimization/ai-engine-contract.spec.ts` (`docs/DEPLOYMENT.md:283`). `PRODUCT.md:74` konstaterar att texterna ska flyttas till ett enda vanligt namn, som ännu inte är valt. Namnet i koden och i texterna säger alltså inget om hur lösaren fungerar (B7).

### 12.2 Vad motorn gör, väg för väg

| Väg | Vad den gör | Vad som skickas (alltid anonymt, avsnitt 9) | Källa |
|---|---|---|---|
| `POST /api/v1/optimize` | Genererar ett veckoschema som håller skolans regler, eller förklarar varför det inte går. Kan sökas i flera lägen: strikt, bästa möjliga schema, schemaförslag. | Krav, rum, grupper, tider, tillgänglighet, arbetstidsregler | `optimization-engine/app/api/v1/optimize.py:123` |
| `POST /api/v1/optimize-rooms` | Fördelar om rum, allt annat givet. | Anonyma lektioner och rum | `optimization-engine/app/api/v1/rooms.py:50` |
| `POST /api/v1/staff` | Föreslår vilken lärare som leder varje timplanspost ("a tjänstefördelning, solved"). | Lärare som id och minuter (mål, tak, golv, fast belastning), kravens id, vem som får undervisa vad som en mängd av id | `optimization-engine/app/api/v1/staffing.py:44`, `optimization-engine/app/schemas/staffing.py:1-33`, `:110-153` |
| `POST /api/v1/plan-exams` | Planerar prov; bygger på en girig plan som golv. | Prov, rum, tillsynsmän som id | `optimization-engine/app/api/v1/exams.py:46`, `docs/DEPLOYMENT.md:257` |
| `POST /api/v1/suggest-changes` | Åtgärdsförslag när en vecka vägras: vilka ändringar som skulle göra att veckan går att lägga. | Samma anonyma nyttolast | `optimization-engine/app/api/v1/suggest_changes.py:77`, `docs/DEPLOYMENT.md:7113-7137` |
| `POST /api/v1/check-week` och `/week-bounds` | Kontrollerar en vecka och räknar dess exakta gräns. | Samma anonyma nyttolast | `optimization-engine/app/api/v1/week_check.py:36`, `optimization-engine/app/api/v1/week_bounds.py:56` |

Resultaten är **förslag som en person tillämpar**. Ett genererat schema blir ett utkast som publiceras först efter skolans kontroller (`PRODUCT.md`, avsnittet Product Purpose, punkt 4), ett schemaförslag är privat tills det tillämpas (`prisma/migrations/20261125090000_ett_schemaforslag_ar_privat_tills_det_tillampas`, `docs/DEPLOYMENT.md:662-669`), och ett bemanningsförslag tillämpas av en person genom ett eget steg som kräver bekräftelse när en lärare får ett ämne eller en årskurs som den inte undervisar i i dag (`src/optimization/staffing-proposal.service.ts:72-93`, `:194-196`).

### 12.3 Funktioner utanför lösaren som juristen bör se på

AI-förordningens regler för högrisksystem beror på *användningen*. Det är inte lösaren som avgör det, så juristen bör pröva också de funktioner som rör personer och som inte använder lösaren. Det här är en lista över vad funktionerna gör, som underlag, och inget påstående om hur de ska klassas:

| Funktion | Vad den gör med personer | Hur den är byggd | Källa |
|---|---|---|---|
| **Bemanningsförslag** (Föreslå bemanning, lärarvalssökning) | Föreslår vilken lärare som undervisar vad. Det är en fördelning av arbetsuppgifter mellan anställda. | Lösare (CP-SAT). Indata är mängder av id, minuter, mål per lärare och vem som har behörighet. Inte namn, tjänstgöringsgrad eller behörighetens art. Motorn skickar aldrig dessa. | `optimization-engine/app/schemas/staffing.py:1-33` |
| **Vikarieförslag** (rangordnade kandidater) | Rangordnar vilka som kan ringas in. Poäng för behörighet, bekantskap med klassen, närvaro på skolan, antal vikariat i veckan och terminen, belastning mot mål, poolens inställning, önskad ledig dag. | **Ingen lösare.** En dokumenterad viktad poäng i gatewayen. Varje term har en orsakskod och visas för användaren. Vikterna står i koden. | `src/cover/cover-rank.ts:4-70` |
| **Rapporteringsgrad** | Räknar hur stor andel av varje lärares hållna lektioner som har sparad närvaro, per dag, och visar det för rektor och administratörer. Påminner läraren. | Räkning mot en gräns skolan satt. Ingen lösare. En lärares egen siffra läses av läraren själv. Läsningen av andras loggas som `EMPLOYMENT`. | `src/access-log/access-log.ts:25-33`, `src/reporting-rate/reporting-rate-notices.ts`, `docs/DEPLOYMENT.md:306` |
| **Nyckeltal per lärare och löneunderlag** | Visar varje lärares undervisning och belastning mot tjänsten, och sammanställer underlag för lön. | Räkning och summering. Kräver HR-läs för tjänstgöringsgrad. | `src/access-log/access-log.ts:65-74`, `src/common/people-files.ts:111-118` |
| **Frånvarobevakning** | Räknar elever över skolans egna gränser för frånvaro och skickar en sammanfattning till mentor, rektor och vårdnadshavare. | Räkning mot en gräns skolan satt. Pushen säger bara att en sammanfattning finns. | `docs/DEPLOYMENT.md:305`, `src/notifications/push-messages.ts:29-31` |

De två sista raderna är medvetet ofullständiga: det finns fler funktioner som räknar på personer (till exempel frånvarostatistik, som slår ihop till klass och månad och inte visar en klass med färre än fem elever, `prisma/schema.prisma` kommentaren vid `AbsenceStatsMonths`). Listan har inte tagits fram som en uttömmande inventering av alla räkningar. Den visar de funktioner som rör personers arbetsuppgifter och arbetsprestation. Vilken funktion som hör hemma i vilken kategori, och om någon av dem gör det, avgör juristen.

### 12.4 Vad som inte ska utläsas av det här avsnittet

- Att lösaren inte lär sig är en beskrivning av teknik och inte en rättslig slutsats om "AI-system". Om en CP-SAT-lösare faller utanför förordningens definition av AI-system är juristens fråga.


## 13. Öppna punkter

Det här är det som dokumentet **inte** kan säga. Ingenting av det är ifyllt eller gissat. De tre grupperna är:

- **B, beslut.** Någon ska besluta eller skriva något. Användarens beslut, och i B6 en jurists bedömning.
- **F, fakta.** Ett svar finns i produktionsmiljön eller hos en leverantör, och repot kan inte ge det. Svaren kan läggas till här med datum och källa.
- **K, kontroll.** Något som går att kontrollera i repot och som inte har gjorts för det här dokumentet.

### 13.1 Beslut

| # | Punkt | Varför den är öppen | Vad dokumentet gör i väntan |
|---|---|---|---|
| **B1** | **Vem är personuppgiftsansvarig och vem är personuppgiftsbiträde** för Rastra Schema, och för vilka behandlingar. | Repot säger bara att skolan är personuppgiftsansvarig när det beskriver ett avtal för push (`docs/DEPLOYMENT.md:482-483`) och talar om "den som driftar" utan namn. PRODUCT.md anger att inga kunder finns (`PRODUCT.md:202`). | Använder orden *skolan*, *huvudmannen* och *leverantören* och säger inget om roller. |
| **B2** | **SLA**: tillgänglighet, svarstider, återställningstider, supporttider. | PRODUCT.md förbjuder en påhittad SLA (`PRODUCT.md:207`). Driftboken beskriver bara hur driften går till. | Skriver ingen SLA och inga siffror för drifttid. |
| **B3** | **Biträdesavtal (DPA) och underbiträden:** avtalets text, vilka underbiträden som ska anges och på vilka villkor, och grund för tredjelandsöverföring (Expo i USA, och leverantörer som Resend, Supabase, Railway och Vercel beroende på region och bolag). | PRODUCT.md förbjuder en påhittad DPA-mall (`PRODUCT.md:207`). Driftboken kräver ett avtal som täcker Expo innan push slås på (`docs/DEPLOYMENT.md:480-487`). | Anger vilka tjänster koden anropar och vad var och en ser (avsnitt 5), utan att säga om de är underbiträden eller på vilka villkor. |
| **B4** | **Registerförteckning (art. 30)** för behandlingarna. | PRODUCT.md förbjuder en påhittad förteckning (`PRODUCT.md:207`). | Lämnar underlag: kategorier (avsnitt 3), mottagare (avsnitt 4–5), åtkomst (avsnitt 6), gallring (avsnitt 8). Ändamål och rättslig grund är inte skrivna. |
| **B5** | **Rättslig grund och ändamål** per slags uppgift, och vilken information som ska ges till elever, vårdnadshavare och personal. | Skolans val som personuppgiftsansvarig. Ingen sådan text finns i koden (avsnitt 10.5). | Beskriver bara vad som lagras och varför funktionen finns. |
| **B6** | **AI-förordningen.** Att en jurist bekräftar om lösaren och de funktioner som listas i avsnitt 12.3 omfattas, och i så fall vad som följer. | Slutsatsen är juristens. Förordningens text, och datumen för när reglerna för högrisksystem inom utbildning börjar gälla, har inte lästs för det här arbetet. | Beskriver vad lösaren är och inte är och vilka funktioner som rör personers arbetsuppgifter (avsnitt 12). |
| **B7** | **Namnet "AI-motorn"** i webbtexterna och handböckerna. | PRODUCT.md beslutade 2026-10-11 att motorn ska beskrivas efter vad den gör och att texterna ska flyttas till ett enda vanligt namn, som ännu inte är valt (`PRODUCT.md:74`). Texterna säger fortfarande "AI-driven" och "AI-motorn" (`web/messages/sv.json:14`, `:262`, `:1698`, `docs/manual/anvandarmanual.html:24`). | Säger det rakt ut (avsnitt 12.1). |

### 13.2 Fakta som repot inte kan ge

Frågorna är skrivskyddade och gäller konfiguration, inte persondata.

| # | Fråga | Varför repot inte svarar | Påverkar |
|---|---|---|---|
| **F1** | **Region** för Supabase-projektet, för Railways tjänster (API och motor), för Vercels funktioner och för Resend. | Repot rekommenderar Frankfurt för Supabase men säger inte vad produktionen använder (`docs/deployment-walkthrough.md:113-115`). | Avsnitt 5.1, B3 |
| **F2** | Är **säkerhetskopior** (PITR eller dagliga) på i produktionen, hur långt tillbaka når de, och vad gör leverantören med dem när en period gått ut? | Driftboken säger "enable" (`docs/DEPLOYMENT.md:550`). Gallring och säkerhetskopior hänger ihop (avsnitt 8.1, 8.5). | Avsnitt 5.2, 8 |
| **F3** | Står **`PUSH_NOTIFICATIONS` på `off`** i produktionen? | Standardvärdet är `off`, men produktionens värde är inte läst. | Avsnitt 4.4, 5.1 |
| **F4** | Är **tillgänglighetsredogörelsens kontaktuppgifter** (`ACCESSIBILITY_*`) satta i Vercel? (Bara om de är satta.) | Variablerna sätts utanför repot. | Avsnitt 11 |
| **F5** | Vad lagrar **Supabase Auth** om en person, vilka mallar och vilken avsändare används för inbjudan och återställning, och går de genom egen SMTP? | Auth-data ligger utanför Rastras schema, och mallarna ligger i Supabase (`docs/DEPLOYMENT.md:35-37`, `:95-98`). | Avsnitt 3.3, 4.3, 5.1 |
| **F6** | **Hur motorn nås i produktionen** (privat nät eller publik `https`-adress) och om databasanslutningen **verifierar certifikatet** (`verify-full`) eller bara krypterar. | Driftboken beskriver båda (`docs/DEPLOYMENT.md:214-228`, `:259-262`). | Avsnitt 5.2 |
| **F7** | **Plattformarnas egna loggar**: vad Railway, Vercel, Supabase, Resend och Expo loggar och hur länge, och vart containrarnas utskrifter skickas. | Beskrivs inte i repot. Driftboken säger bara att man ska skicka dem till sin loggsamlare (`docs/DEPLOYMENT.md:2900-2902`). | Avsnitt 5.1, 7.3, 8.5 |

### 13.3 Kontroller som återstår i repot

| # | Kontroll | Varför den inte är gjord |
|---|---|---|
| **K1** | En **tabell-för-tabell-inventering** av alla 183 tabeller mot en gallringsregel. | Avsnitt 8.5 bygger på det som hittats; en fullständig genomgång är ett eget arbete. |
| **K2** | En genomgång av **vad som loggas**: vilka rutter som tar annat än id:n i frågesträngen, och om de fem `error.message`-raderna i avsnitt 7.3 kan innehålla personuppgifter. | Ej granskat. |
| **K3** | En genomgång av **mobilappens loggar** (`console.*`). | Ej granskat. |
| **K4** | **Tillgänglighet:** skärmläsartestet (VoiceOver, NVDA) är inte gjort, PDF-exporten är inte taggad, och redogörelsens datum (14 och 18 oktober 2026) är inte flyttade (avsnitt 11). | Beskrivs i redogörelsen själv. |
| **K5** | Ett **prov med en riktig persondatamängd** som söker igenom hela nyttolasten till motorn efter namn och adresser (avsnitt 9.3). | Skyddet är i dag en konstruktionsgaranti, inte ett innehållsprov. |

## 14. Så är dokumentet gjort

**Läst.** `prisma/schema.prisma` och migreringarna under `prisma/migrations/` (som text), gatewayens kod under `src/`, motorns under `optimization-engine/`, webbens under `web/`, mobilappens lokala lager under `mobile/`, `docs/DEPLOYMENT.md`, `docs/integration-api.md`, `docs/tillganglighetsredogorelse.md`, `docs/skarmlasartest.md`, `docs/SECURITY_AUDIT.md`, handboken `docs/manual/anvandarmanual.html` och `PRODUCT.md`. Specifika kontroller gjordes mot källan för det som bär mest vikt: den anonyma nyttolasten, gallringens SQL, läsloggens kontrakt, vad e-posten innehåller, loggningen och sökningen efter spårnings- och analystjänster. En statisk kontroll av migreringarna bekräftade att varje tabell i schemat har `ENABLE ROW LEVEL SECURITY` (avsnitt 6.2). Den första kartläggningen av datamodellen, de utgående flödena och gallringen och loggningen gjordes genom delegerad läsning av koden. Den kontrollerades sedan mot källan på de punkter som bär mest vikt (de ovan nämnda); övriga radnummer i den delen är kontrollerade mot att filen och raden finns, inte mot varje ords innehåll.

**Inte gjort.** Ingenting har körts: inga prov, inga byggen, ingen databas. Ingen produktion har lästs, ingen miljöfil har öppnats, inga leverantörers dokument eller avtal har lästs. Ingen rättskälla har lästs. Inga personer eller skolor är nämnda.

**Där repots egna texter är föråldrade eller säger emot varandra.** Dokumentet följer koden och driftboken, inte dessa:

| Text | Säger | Koden eller driftboken säger |
|---|---|---|
| `PRODUCT.md:131` | Inloggning bara med e-post och lösenord; skolkonto är inte byggt. | Skolkonto (Entra, Google) finns och beskrivs i `docs/DEPLOYMENT.md:2917-3000`. |
| `PRODUCT.md` (avsnittet Accessibility & Inclusion) | axe körs bara på de publika sidorna; inloggade sidor skannas inte. | Sedan 2026-10-15 körs axe på varje inloggad sida (`web/e2e/a11y-app.spec.ts`). |
| `prisma/schema.prisma:370` | `Users` är "the ONLY table that stores PII". | Fler tabeller har namn och kontaktuppgifter (avsnitt 3.1). |
| `prisma/schema.prisma:839-846` | Markeringen anger "never which protection". | Synkens markering kan bära registrets art (`prisma/schema.prisma:873-878`). |
| `src/gallring/retention.ts:11`, `docs/DEPLOYMENT.md:552-556`, `web/messages/sv.json:7344` | Se avsnitt 8.6. | Se avsnitt 8.6. |
| `docs/SECURITY_AUDIT.md:30-36` | Den lokala lagringen är okrypterad. | Det fyndet är åtgärdat (`docs/SECURITY_AUDIT.md:258-275`, `mobile/src/services/database/localDatabase.ts:9-14`). |

