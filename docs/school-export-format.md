# Hela skolans data: filformat

Formatet heter `rastra-skolexport`, version 1. Ändras en kolumn höjs versionen.

Filerna i `data/` skrivs för den som vill ha allt. Till skillnad från listorna i `csv/` bär de id:n (nycklarna mellan filerna), e-postadressen bredvid varje id, och varje rad skolan har, aktiv eller inte. Alla är CSV: UTF-8 med BOM, semikolon, CRLF.

## Listorna i `csv/`

Det här är filerna sidorna exporterar. Kolumnerna är de importen läser; se manualen (Importera CSV) för vad varje kolumn betyder.

| Fil | Kolumner |
|---|---|
| `amnen.csv` | `namn`, `kod`, `farg`, `salstyp`, `nationell_kod`, `undervisningstid` |
| `salar.csv` | `namn`, `kod`, `salstyp`, `kapacitet`, `lagsta_arskurs`, `hogsta_arskurs`, `byggnad`, `vaning` |
| `salstyper.csv` | `namn` |
| `klasser.csv` | `namn`, `arskurs`, `typ`, `halvklass_av`, `ersatter_amne` |
| `larare.csv` | `fornamn`, `efternamn`, `epost`, `telefon`, `tjanst_procent`, `nedsattning_procent`, `avtal`, `signatur` |
| `behorigheter.csv` | `larare_epost`, `amne`, `fran_arskurs`, `till_arskurs`, `behorighet` |
| `uppdrag.csv` | `larare_epost`, `typ`, `benamning`, `minuter_per_vecka`, `raknas_som_undervisning`, `amne`, `grupp`, `fran`, `till`, `anteckning` |
| `elever.csv` | `fornamn`, `efternamn`, `epost`, `telefon`, `klass` |
| `undervisningsgrupper.csv` | `grupp`, `epost` |
| `vardnadshavare.csv` | `fornamn`, `efternamn`, `epost`, `telefon`, `elev_epost` |
| `timplansposter.csv` | `grupp`, `amne`, `lektioner_per_vecka`, `minuter_per_lektion`, `minuter_fore`, `minuter_efter`, `larare`, `medlarare`, `veckor`, `fran`, `till`, `larare_procent`, `medlarare_procent` |

## `data/personer.csv`: Personer

Källa: Users, med hemklassens namn ur StudentGroups.

| Kolumn | Innehåll |
|---|---|
| `id` | Personens id. Nyckeln som de andra filerna refererar till. |
| `roll` | STUDENT, GUARDIAN, TEACHER eller SCHOOL_ADMIN. |
| `fornamn` | Förnamn. Tomt hos en person som gallringen har pseudonymiserat. |
| `efternamn` | Efternamn. |
| `epost` | E-postadress. |
| `telefon` | Telefonnummer, om personen har ett. |
| `aktiv` | ja eller nej. En avaktiverad person finns kvar tills gallringen tar bort den. |
| `klass` | Elevens hemklass, om den har en. |
| `skapad` | När raden skapades (UTC, ISO 8601). |
| `avaktiverad` | När personen avaktiverades (UTC), annars tomt. |
| `pseudonymiserad` | När gallringen pseudonymiserade personen (UTC), annars tomt. |
| `administratorsprofil` | För en administratör: FULL, REKTOR, SCHEMALAGGARE, EXPEDITION eller LASARE. |
| `hr_las` | ja om administratören har HR-läs (tjänst och nedsättning i procent). |

## `data/kopplingar.csv`: Kopplingar mellan vårdnadshavare och elever

Källa: GuardianStudents.

| Kolumn | Innehåll |
|---|---|
| `id` | Kopplingens id. |
| `vardnadshavare_id` | Vårdnadshavarens id (personer.csv). |
| `vardnadshavare_epost` | Vårdnadshavarens e-postadress. |
| `elev_id` | Elevens id (personer.csv). |
| `elev_epost` | Elevens e-postadress. |
| `ursprung` | MANUAL (skolan la in kopplingen) eller SS12000 (kommer från skolans register). |
| `skapad` | När kopplingen skapades (UTC). |

## `data/narvaro.csv`: Närvaro

Källa: AttendanceRecords med lektionen ur CalendarLessons.

| Kolumn | Innehåll |
|---|---|
| `datum` | Lektionens datum (ÅÅÅÅ-MM-DD). |
| `start` | Lektionens början, skolans lokala tid (TT:MM). |
| `slut` | Lektionens slut, skolans lokala tid (TT:MM). |
| `amne` | Ämnets namn. |
| `amnes_kod` | Ämnets kod, om det har en. |
| `grupp` | Gruppens eller klassens namn. |
| `lektion_id` | Lektionens id. Raderna med samma lektion hör ihop. |
| `lektionsstatus` | SCHEDULED, CANCELLED, COMPLETED eller RESCHEDULED. |
| `elev_id` | Elevens id (personer.csv). |
| `elev_epost` | Elevens e-postadress. |
| `status` | PRESENT, ABSENT, LATE, EXCUSED eller UNKNOWN (inte registrerad). |
| `registrerad_av_id` | Id på den som registrerade. Tomt om personen är borttagen eller har skyddad identitet. I ett utdrag om en person med skyddad identitet är den alltid tom. |
| `registrerad_av_epost` | E-postadress till den som registrerade. |
| `registrerad` | När registreringen gjordes (UTC). |
| `anteckning` | Anteckning till raden, om det finns en. Tom om den nämner en person med skyddad identitet. |

## `data/franvaroanmalningar.csv`: Frånvaroanmälningar

Källa: AbsenceReports.

| Kolumn | Innehåll |
|---|---|
| `id` | Anmälans id. |
| `datum` | Dagen frånvaron gäller (ÅÅÅÅ-MM-DD). |
| `fran` | Klockslag frånvaron börjar (TT:MM:SS), tomt för hela dagen. |
| `till` | Klockslag frånvaron slutar (TT:MM:SS), tomt för hela dagen. |
| `typ` | Typ av frånvaro: SICK (sjukdom), APPOINTMENT (besök) eller OTHER. Tom i ett registerutdrag om anmälan inte gäller personen utdraget är om. |
| `elev_id` | Elevens id (personer.csv). Tomt i ett registerutdrag om anmälan inte gäller personen utdraget är om. |
| `elev_epost` | Elevens e-postadress. |
| `anmald_av_id` | Id på den som anmälde (vårdnadshavare eller eleven). Tomt om personen har skyddad identitet. I ett utdrag om en person med skyddad identitet är den alltid tom, utom när personen själv anmälde. |
| `anmald_av_epost` | E-postadress till den som anmälde. |
| `anteckning` | Anteckning till anmälan, om det finns en. Tom om den nämner en person med skyddad identitet, och i ett registerutdrag om anmälan inte gäller personen utdraget är om. |
| `beviljad_ledighet` | ja om skolan beviljat frånvaron som ledighet. |
| `skapad` | När anmälan gjordes (UTC). |

## `data/ledigheter.csv`: Ledighetsansökningar

Källa: LeaveRequests.

| Kolumn | Innehåll |
|---|---|
| `id` | Ansökans id. |
| `elev_id` | Elevens id (personer.csv). Tomt i ett registerutdrag om ansökan inte gäller personen utdraget är om (en lärare som beslutat, en vårdnadshavare som ansökt). |
| `elev_epost` | Elevens e-postadress. |
| `begard_av_id` | Id på den som ansökte. Tomt om personen har skyddad identitet. I ett utdrag om en person med skyddad identitet är den alltid tom, utom när personen själv ansökte. |
| `begard_av_epost` | E-postadress till den som ansökte. |
| `fran` | Första dagen (ÅÅÅÅ-MM-DD). |
| `till` | Sista dagen (ÅÅÅÅ-MM-DD). |
| `skal` | Skälet som ansökan gavs. Tomt om det nämner en person med skyddad identitet, och i ett registerutdrag om ansökan inte gäller personen utdraget är om. |
| `status` | PENDING (väntar), APPROVED (beviljad), REJECTED (avslagen) eller GUARDIAN_DECLINED (en vårdnadshavare som skolan bad om samtycke sa nej, och ansökan avslutades; ingen beslutsfattare). |
| `beslut_av_id` | Id på den som beslutade. Tomt om personen är borttagen eller har skyddad identitet. |
| `beslut_av_epost` | E-postadress till den som beslutade. |
| `beslut_tid` | När beslutet fattades (UTC). |
| `beslut_anteckning` | Beslutets anteckning. Tom på samma villkor som skälet. |
| `beslut_som` | I vilken egenskap beslutet fattades: MENTOR eller ADMIN. |
| `hanvisad_av_id` | Id på mentorn som lämnade vidare till rektor. Tomt om ingen, eller skyddad identitet. |
| `hanvisad_tid` | När ansökan lämnades vidare (UTC). |
| `skapad` | När ansökan gjordes (UTC). |
| `samtycke_kravdes` | true om skolan bad om varje vårdnadshavares samtycke när ansökan gjordes (skolans val Ledighetspolicy). Vem som samtyckt lagras som en egen uppgift per vårdnadshavare som ingen roll läser; här står bara att samtycke krävdes och, i status, om en vårdnadshavare sa nej. |
| `kort_varsel` | true om ansökan kom närmare första dagen än skolans minsta antal dagar i förväg (skolans val Ledighetspolicy). |
| `kontakt_namn` | Namn på den tillfälliga kontakten under ledigheten, en tredje parts uppgift som den som ansökte gav. Tomt om ingen gavs. Tomt också i ett registerutdrag om ansökan inte gäller personen utdraget är om, och om namnet är en person med skyddad identitet. |
| `kontakt_telefon` | Kontaktens telefonnummer. Tomt på samma villkor som namnet. |
| `kontakt_relation` | Kontaktens relation till eleven. Tomt på samma villkor som namnet. |

## `data/samtycken.csv`: Vårdnadshavarnas svar på förfrågan om samtycke till ledighet

Källa: LeaveConsents.

| Kolumn | Innehåll |
|---|---|
| `ansokan_id` | Ansökans id (ledigheter.csv). |
| `vardnadshavare_id` | Id på vårdnadshavaren som frågades (personer.csv). Tomt om personen har skyddad identitet. |
| `vardnadshavare_epost` | Vårdnadshavarens e-postadress. |
| `elev_id` | Id på eleven ansökan gäller. Tomt i ett registerutdrag om ansökan inte gäller personen utdraget är om. En ansökan om en elev med skyddad identitet finns inte i filen. |
| `svar` | true om vårdnadshavaren samtyckte, false om hen inte gjorde det (och ansökan avslutades), tomt om hen inte har svarat. |
| `svarade` | När vårdnadshavaren svarade (UTC), tomt om hen inte har svarat. |
| `paminnd` | När den enda påminnelsen skrevs (UTC), tomt om ingen skrevs. |
| `fragad` | När vårdnadshavaren frågades, det vill säga när ansökan gjordes (UTC). |

## `data/notiser.csv`: Notiser

Källa: Notifications.

| Kolumn | Innehåll |
|---|---|
| `id` | Notisens id. |
| `mottagare_id` | Mottagarens id (personer.csv). |
| `mottagare_epost` | Mottagarens e-postadress. |
| `typ` | Notisens typ, till exempel LEAVE_DECIDED eller LESSON_CANCELLED. |
| `innehall` | Notisens innehåll som JSON-text. Tomt om innehållet nämner en person med skyddad identitet. |
| `last` | När mottagaren läste notisen (UTC), tomt om den inte lästs. |
| `epostad` | När notisen skickades som e-post (UTC), tomt om den inte gjorts. |
| `skapad` | När notisen skapades (UTC). |

## `data/laslogg.csv`: Läsloggen

Källa: PersonalDataAccess.

| Kolumn | Innehåll |
|---|---|
| `tid` | När läsningen gjordes (UTC). |
| `kanal` | WEB, APP, OTHER, INTEGRATION eller CALENDAR. |
| `laste_id` | Id på den som läste. Tomt för en integration och för en person med skyddad identitet. I ett utdrag om en person med skyddad identitet är den tom, utom när personen själv läste: det går att se att och när någon läste, inte vem. |
| `laste_epost` | E-postadress till den som läste. |
| `laste_roll` | Läsarens roll när läsningen gjordes. |
| `huvudmannens_medlem` | Huvudmannens medlem som läste, när det var huvudmannens läsare. Tomt i ett utdrag om en person med skyddad identitet. |
| `nyckel` | Id på den integrationsnyckel som läste, när det var en integration. |
| `slag` | Slag av uppgift: PEOPLE, ROSTER, ATTENDANCE, ABSENCE_REPORTS, LEAVE_REQUESTS, GUARDIANS, EMPLOYMENT, STAFF_ABSENCES, ACCESS_LOG, SCHEDULE, TEACHING_TIME. |
| `antal` | Hur många personer läsningen gällde. I ett registerutdrag är det läsningens hela storlek, medan personer bara listar dem utdraget gäller. |
| `personer` | Id på personerna läsningen gällde (personer.csv), åtskilda av blanksteg. Personer med skyddad identitet är inte med. |

## `data/person/`: övriga tabeller

Det Rastra i övrigt har om personen skrivs som en fil per tabell. Kolumnerna är tabellens egna, i tabellens ordning, och id:n är Rastras interna id:n (de som `data/personer.csv` bär). En kolumn som innehåller en nyckel, ett hemligt värde eller en kontrollsumma står som `(dold)`, och det gör också namnet och kontaktuppgifterna hos en extern hyrande i `ExternalBookings` (den som hyr är ingen användare och inte den som utdraget gäller; kvar står att personen registrerat serien). En tabell utan rader för personen skrivs inte. Tabellerna: `AbsenceWatchFindings`, `AckReceipts`, `AckRequests`, `AttendanceSharingDecisions`, `AvailabilityConstraints`, `CalendarLessonStudents`, `CalendarLessonTeachers`, `CancellationBatches`, `ClassTeacherAppointments`, `ClassTeacherChanges`, `ConsentEntries`, `ConsentLists`, `CoverConfirmations`, `CoverRequestLessons`, `CoverRequestRecipients`, `CoverRequests`, `CrisisAlarms`, `CrisisCallTeachers`, `CrisisPupils`, `CrisisReports`, `ExamInvigilators`, `Exams`, `ExternalBookings`, `GuardianStudentHistory`, `HuvudmanSchoolEvents`, `HuvudmanSchools`, `InstructionProofs`, `IntegrationApiKeys`, `LeaveDelegationDecisions`, `LessonLogs`, `LessonPupilMoves`, `LessonSubstituteNotes`, `LocalTimplans`, `MasterLessons`, `MasterLessonStudents`, `OptimizationJobs`, `PersonProtectionEvents`, `PersonProtections`, `PublicTimetableHidden`, `PublicTimetableLinks`, `ResourceBookings`, `RetentionDecisions`, `RoomBookings`, `RoomLoans`, `ScheduleActivities`, `ScheduleActivityTeachers`, `ScheduleCandidateRuns`, `ScheduleChangeLogs`, `ScheduleVersions`, `SchoolExports`, `SharedTeacherMarks`, `Ss12000DutyLinks`, `Ss12000Sources`, `Ss12000SyncRuns`, `StudentEnrollments`, `StudentGroupMembers`, `SubstituteAvailabilities`, `SubstitutePoolMembers`, `SupervisionCovers`, `SupervisionShifts`, `TeacherAbsenceCovers`, `TeacherAbsences`, `TeacherDuties`, `TeacherDutySlots`, `TeacherEmploymentLogs`, `TeacherEmploymentPeriods`, `TeacherEmployments`, `TeacherPublicLabels`, `TeacherReportingDays`, `TeacherSubjectQualifications`, `TeacherWorkRules`, `TeachingRequirements`, `TeachingRequirementShares`, `TimetablePublications`, `TimplanStatementPublications`, `TimplanStatements`, `UserRoleChanges`.
