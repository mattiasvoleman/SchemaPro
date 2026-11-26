# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The Next.js web app is the product: every role uses it, and all planning and administration happen only there. The Expo app (`mobile/`) is a companion for teachers', pupils' and guardians' daily jobs. It has one cross-platform look with no per-OS design language, and admin on mobile is deliberately left out: an administrator who signs in to the app gets the Krisläge view (start, watch and end an alarm) and nothing else of the administration.

## Users

**Primary: the schemaläggare at one school.** This is the Administratör of one Swedish grundskola: usually the schemaläggare, rektor or biträdande rektor. They plan the school year and run the school day:
- grunddata;
- the lokal timplan and timplansposter;
- tjänstefördelning;
- generating, reviewing and publishing the schedule;
- every morning: teacher absence, cover, cancellations, leave decisions and reports.

They work at a desktop, in two modes:
- long, careful planning sessions in spring and before summer;
- short, time-pressed sessions every school day, such as a teacher calling in sick at 07.45 with lessons to cover.

Design work optimises for this person first (decided 2026-10-11).

**Secondary users, daily:**
- **Lärare** have their own schedule and record attendance in the first minutes of each lesson, on the web or in the offline app, often on a shared tablet. They also have:
  - room booking;
  - *Min tjänst*, their workload, read-only;
  - their own vikariepass;
  - their own absence report, where the school allows it.
- **Vikarier in the pool** are teachers without a tjänst. They are suggested only within the availability they declared.
- **Vårdnadshavare** are mostly on a phone. Under *Mina barn* they have:
  - each child's published week;
  - a sick report that takes under a minute and needs no phone call;
  - leave applications the school decides;
  - notices;
  - the *Undervisningstid* card.
- **Elever** are children in F–9 and see their own schedule and attendance. Adult students may report their own absence.
- **Anyone with a link or a code** can open *Schemavisaren*, the login-free published week for a class, teaching group, teacher, pupil or room, when the school has chosen so: the viewer is for signed-in staff only until it says otherwise, and each kind of schedule is off, a list, or Fritext-ID (shown only to the holder of the exact code, drawn and handed out by the school). A pupil's schedule is only ever behind a code, and a person with a protected identity is never shown. The school creates the code, and it typically reaches families on a phone.

**What the roles are, and what is not modelled yet:**
- Administratör is one role with five profiles: full administrator, rektor, schemaläggare, expedition and läsare. The profile decides which of six areas a person writes (planering, schemaläggning, publicering, drift, personal, integrationer) and whether they decide (who is administrator, HR-läs, tjänst %, dataskydd): `AdminProfile` in `prisma/schema.prisma` and `src/auth/admin-areas.ts`, held equal to the database's `app.admin_profile_writes()` by tests.
- A huvudman (a kommun or a friskola's owner) owns schools. Its kommunadministratör keeps its members, schools and SS12000 keys, and its planerare read every school it owns as läsare: nothing written, nothing decided, no HR-läs (DEPLOYMENT §14, route `/huvudman`).
- Not modelled: a huvudman's central planners who *write*. Planning several schools from one place is not built; every write is a school's own.

## Product Purpose

Rastra runs a Swedish school's whole planning chain and its school day in one place:
1. The **lokal timplan** in minutes per week, checked against the hours skolförordningen guarantees.
2. **Tjänstefördelning** in minutes against each teacher's riktmärke, with behörighet as data.
3. A **grundschema** that the engine computes to keep every hard rule.
4. **Publishing** with validity dates and a draft layer.
5. The **dated calendar**, where attendance, absence, cover and cancellations live.
6. **Rolling it all forward** into the next läsår every June.

What success means:
- A school can stop using Skola24 and run its whole year on Rastra.
- The schemaläggare trusts the generator, because every refusal names its cause.
- Teachers and families see the published truth without calling the school.

The owner's engineering thresholds (brief of 2026-08-05: LCP, bundle size, solver time, API latency, coverage, WCAG) are measured in `docs/verification-baseline.md`. Several are not met, so no page may claim them.

## Positioning

**Stance:** Rastra replaces Skola24 end to end (decided 2026-10-11). It covers the full chain from timplan to the school day. It is not a scheduling engine that feeds someone else's platform, which was the July stance and is now retired.

**What a neighbouring product could not truthfully claim** (from vendor pages read 2026-10-05/06, see the Gap Analysis & Roadmap document):
- **The generator explains itself.** It never answers just "infeasible". It names the cause in the school's own words with the numbers involved, ends with a remedy, ranks causes and probes which rule to relax. The comparison rates this ahead of Skola24, Untis, aSc and Lectio.
- **The national timplan is data.** Skolförordningen bilaga 1–4 is versioned and scoped by cohort, the 2028 tioårig grundskola included. Teaching time is reconciled in three layers per pupil: planned against the timplan, scheduled against planned, delivered against scheduled. No leader ships the national table.
- **Tjänstefördelning works in minutes.** Behörighet is data, uppdrag count toward load, and a solver proposes a staffing. Skola24 stores no behörighet.
- **Vikarie planning never breaks a hard rule.** It has a cover board, ranked suggestions and *Fördela dagen*. Skola24 has no vikarie module.
- **Privacy is built in.** Row-level security covers every table. The engine sees only anonymous ids and minutes, never names. No personnummer is stored.

**Describe the engine by what it does, not as AI** (decided 2026-10-11). It is a constraint solver (OR-Tools CP-SAT), with no ML and no language model. Copy says what it does: it computes a schedule that keeps every rule, and says why when it can't. Today's copy still says "AI-driven schemaläggning & närvaro", "AI-motorn" and "solvern". All of these must move to one plain name, which is still undecided.

## Operating Context

**The four phases of the year's work** (user manual §2.1):
1. **Kom igång**, once per läsår.
2. **Planering** — "här avgörs schemats kvalitet".
3. **Schemaläggning** — cheap to rerun and throw away.
4. **Daglig drift**.

The *grundschema* is the weekly template. The *kalender* holds dated lessons. Attendance, vikarier and inställda lektioner always belong to the calendar.

**The årscykel:**
- **Vårterminen:** *Rulla vidare*.
- **Försommar:** update grunddata, tjänster and uppdrag.
- **Before summer:** timplan and availability, then generate and review on the projected class lists.
- **After the last school day:** *Aktivera* the new year.
- **Before term starts:** save a version and publish.
- **15 October:** SCB's mätdatum for Pedagogisk personal, with submission due 2 November.
- **Terminsslut:** exports and the samverkansfil.

**Tjänstefördelning is negotiated in steps:** önskemål, preliminary, samverkan with the unions, then the schedule in June. Tjänstgöringsgrad is renegotiated every year.

**The daily rhythm:**
- A teacher reports sick in the morning and is entered in Lärarfrånvaro. Their lessons land on the Vikarietavla as *Behöver vikarie*.
- A guardian's sick report applies at once.
- Teachers mark attendance at the start of each lesson, sometimes offline.

**Documents the product produces or mirrors:**
- The huvudman's timplan decision, with a beslutsnotering and dnr.
- The printable *uppdragsbeskrivning* on Göteborgs Stad's template, with signature lines and a version.
- The samverkansfil.
- The SCB underlag (an underlag, not SCB's file).
- Payroll CSVs of vikarie hours.
- The A4 landscape week that hangs on the classroom door.

**Tenancy and time:** one school per tenant, in the Europe/Stockholm timezone. A login can belong to several schools (a teacher at two schools, a guardian with children at two): each school keeps its own row for the person, and the web switches school (`GET /api/v1/me/schools`, the `X-School-Id` header, DEPLOYMENT §12, user manual 2.3).

**Neighbouring systems:**
- SS12000 2.1: Rastra pulls the roster from IST or Edlevo through a reviewed diff, and provides the published schedule to systems such as Vklass.
- Hosting: Supabase (EU region recommended), with the API and engine on Railway and the web on Vercel.
- E-mail goes through Resend. Push goes through Expo and stays off until the school has a DPA covering it.

## Capabilities and Constraints

**Scope.** Rastra covers:
- grundskola F–9;
- anpassad grundskola, by ämnen and by ämnesområden;
- specialskola F–10;
- sameskola F–6;
- readiness for the 2028 tioårig grundskola.

Out of scope are gymnasium (there is no Course entity), förskola, fritids and grading.

**Shipped** (main at `3838859c6`, 2026-11-25; the first list was written at `bb47a2f` on 2026-10-11): lokal timplan with national checks and coverage, timplansposter with several lesson lengths, tjänstefördelning (Fas 1–5, staffing proposal included), year rollover, the CP-SAT timetable with named refusals, publishing (validity, draft, gates, bulk avbokning, Schemavisaren), the vikarie module, attendance with an offline queue, guardian absence and leave, notices by e-mail and push, and SS12000 both ways.

Added since 2026-10-11:
- the school account for staff (Entra, Google), several schools per login, huvudman with its readers, and the five administrator profiles;
- Generera as a queue entry with one clock per request, Kontrollera veckan before a long run, the explanation of a timed-out run, changes that would let a refused week be laid, and a measuring stick of weeks shaped like real schools (nightly gate);
- the ordinance's teaching time (SFS 2026:1487, in force 2027-07-01) in tjänstefördelning, with the rektor's own level and exception;
- readers for Skola24-shaped student, guardian and staff tables, saved column mappings, and the pseudonymiser (`/pseudonymisera`), where a school makes an example of its own file without names and with nothing leaving the browser;
- the pilot kit: *Vad kom in*, a safe reset of the demo school, and the sakbeskrivning for a school's dataskyddsombud;
- the first parts of manual editing of the grundschema: a judge that names the rule a move breaks, and a board of the week that the arrow keys move around in.

**Constraints that shape design today:**
- Sign-in is by e-mail and password, and for staff a school account (Microsoft Entra ID or Google Workspace) that a school can choose and then require. The school account is built and off until the operator takes the setup steps (DEPLOYMENT §11); guardians and pupils sign in with a password. SSO through Skolfederation, BankID and Freja is not built yet, and municipal procurement expects it.
- The generator models parallel blocks (a språkval can be a block, which lays its posts at the same times), A/B weeks (a post can go odd or even weeks, and the two are planned separately), a teacher's daily cap and days, and *Sprid ämnen över veckan* as a weight (the user manual, chapters 3–5). What it does not do is lay the week of a school of a certain form within its budget: a högstadium with most subjects in groups across the classes, half groups, teachers on long chains of parallel groups and subjects that run one term only gets a TIMEOUT where a school whose subjects are taught class by class gets one within about half a minute (DEPLOYMENT §35, user manual 5.2). A refused or timed-out week says why and offers changes; it does not lay itself.
- The app is in Swedish and English only.
- The mobile apps, Rastra for staff and pupils and Rastra vårdnadshavare for guardians, have no administration beyond Krisläge: an administrator who signs in to Rastra starts, watches and ends an alarm, and one who teaches also gets the roll call (`mobile/src/screens/crisis/`, DEPLOYMENT §25). They have not been distributed: the build profiles and the runbook exist (`mobile/eas.json`, `docs/DEPLOYMENT.md` §15), but there is no EAS project yet, no build of them has reached a tester, and push has never reached a real device.

**Terms.** Keep the Swedish domain words in Swedish copy, without glossing:
- **Timplan** is the school's lokal timplan in minutes per week per subject and årskurs, a huvudman decision.
- **Timplansposter** is the requirements matrix (route `/admin/requirements`). It was renamed from "Timplan" on 2026-10-06.
- **Tjänstefördelning, tjänst, nedsättning, riktmärke, mål, saldo:** who teaches how many minutes, against which target.
- **Behörighet:** legitimation, behörig or tillåten, per subject and grade span.
- **Uppdrag:** mentorskap, rastvakt and the like.
- **Grundschema** is the weekly template; **kalender** holds the dated lessons.
- **Ramtider, raster, lunchsittningar, lov & studiedagar** describe the school day.
- **Avbokning** is a bulk cancellation that stays visible.
- **Vikarietavla** is the cover board.
- **Rulla vidare** and **Aktivera** are the steps of the year rollover.
- **Schemavisaren** is the public viewer.
- **Undervisningstid** is the per-pupil teaching time card.

English labels exist for all of them. A test enforces "Curriculum entries" as the English label for Timplansposter.

**Undecided** (do not invent answers):
- the solver's plain name, and the canonical tagline (web says "AI-driven schemaläggning & närvaro", mobile says "Schema, närvaro och frånvaro");
- who English is for;
- buyer and business model: friskola or kommun, pricing. Multi-school support is built without waiting for a kommun buyer (decided 2026-10-11);
- whether to keep the name *Schemavisaren*, which is also the name of Skola24's viewer;
- the home domain (e-mail is sent as `noreply@schemapro.app`);
- whether biometric-only attendance submission in the app is intended.

## Brand Commitments

**Name.** The product is **Rastra** (decided 2026-10-17; formerly SchemaPro). The web app and every other application but the mobile apps (Schemavisaren, the guardian and pupil web, the admin) is **Rastra Schema** in Swedish, with the genitive *Rastra Schemas*, and **Rastra timetable** in English, the international name. The mobile apps are **Rastra** for staff and pupils and **Rastra vårdnadshavare** for guardians. The repository, packages, code identifiers, database, environment variables, API paths, storage keys and the hosting projects keep the old name, and so does everything a stored id or an integration derives from: the `X-SchemaPro-*` webhook headers, the ICS UIDs and the SS12000 id namespace. No logo, wordmark or favicon exists. The apps' icon, their splash and the tile on their sign-in screen reuse the web's brand tile, lucide's stock CalendarRange glyph in white on #5048e5 (`mobile/scripts/render-brand-assets.mjs`). Like the stock calendar icon on the web they are drawn from, they are placeholders, not a designed mark.

**Voice.** Swedish first, in the du-form: plain, declarative and procedural. The copy:
- explains why a rule exists;
- names a cause with its numbers and ends with a remedy ("Lägg till platser, vidga lunchfönstret, eller korta lunchen.");
- says what did *not* change when something fails;
- is honest about limits ("en mätning, inte ett bevis").

The manuals are ordered by workflow, not by feature, and end steps with *Kontrollera*.

**Wording rules:**
- A timplan shortfall is *under mål*, never *fel*. It is a warning, never a refusal, because the law allows anpassad studiegång and prioriterad timplan.
- A teacher is never named in engine messages, push, the public viewer, notices to substitutes, or family views of a cancelled or covered lesson.
- An absence reason is a category from a fixed list. Only the teacher and school leadership ever see it.
- Push text names no person, subject, group or room, because it shows on a locked screen.
- The engine is not called AI.

## Evidence on Hand

**Real content and proof:**
- **Three Swedish manuals** (HTML source and built PDFs):
  - `docs/manual/anvandarmanual.html` (utgåva 1.1, for rektor and schemaläggare);
  - `docs/manual/lararmanual.html` (1.1);
  - `docs/manual/vardnadshavarmanual.html` (1.2);
  - the PDFs, `docs/Rastra-Schema-*.pdf`.

  They contain no screenshots or images, and no English version exists.
- **Competitive research** with dated sources: the Gap Analysis & Roadmap document of 2026-10-05/06.
- **The measured baseline,** `docs/verification-baseline.md`. Seven of fifteen rows pass, six fail against a measured number and two are not measured (2026-11-25). The solver is validated at 1,300 pupils (about 9.5 min) and times out at 2,000, against a target of 2,000 in under 10 s; for weeks shaped like a real school's, the line between a week it lays and one it does not is measured in DEPLOYMENT §35.
- **The security audit,** `docs/SECURITY_AUDIT.md` (2026-07-11): 11 findings, all recorded as fixed. It has not been done again, and says so.
- **A sakbeskrivning for a school's dataskyddsombud,** `docs/dataskydd-sakbeskrivning.md` (2026-11-23): what the system does with personal data, belagt in the code. It says itself that it is not an avtalsmall, a registerförteckning or a legal assessment, and it lists what only the owner can answer (its section 13).
- **Public reference data:** skolförordningen bilaga 1–4 (grundskola 6 890 h; 7 424 h from HT 2028), seeded in `prisma/migrations/20261006090000_den_nationella_timplanen_ar_referensdata`.

**Demo data, not evidence:** "Demo Skola" in `prisma/seed.ts`, with fictional teachers and 80 fictional pupils.

**Absent, and must never be fabricated:**
- customers or pilot schools (none as of 2026-10-11);
- testimonials, case studies, quotes or press;
- usage figures;
- pricing;
- certifications;
- an SLA, a DPA template or a registerförteckning (the sakbeskrivning above is none of the three);
- a store listing for the app;
- any claim that the brief's numeric targets are met.

## Product Principles

1. **Earn the schemaläggare's trust.** Every refusal names its cause in the school's words, with numbers and a way out. Nothing fails silently, and an empty view says why it is empty.
2. **Warn where the law allows deviation; refuse only where a rule is hard.** Checks default to *Varna*. A shortfall reads *under mål*.
3. **Show each person exactly what their role needs, and no more.** No names to the engine, no reasons to colleagues or families, no personnummer stored.
4. **Follow the Swedish school year and its documents** (timplan decision, tjänstefördelning, samverkan, SCB, the June rollover) rather than generic scheduling abstractions.
5. **One chain, one truth.** Planning, the published schedule and the school day share their data. Families see what was published, and what was delivered is what gets counted.
6. **Each school sets its own rules.** Policies differ between schools, so they are school settings, never product defaults. Examples are who may decide leave (rektor delegates to teachers), a teacher's daily teaching cap (set by the administrator) and Varna or Vägra (decided 2026-10-11).

## Accessibility & Inclusion

**Commitment:** WCAG 2.1 AA on every screen (decided 2026-10-11). That includes the signed-in admin, teacher, pupil and guardian screens, the public viewer and the mobile app, not just login. Kommunal buyers typically ask for EN 301 549, which builds on WCAG 2.1 AA.

**Today's coverage is narrower than the commitment:**
- axe runs on every signed-in page, for every role, in light and dark and at desktop and phone width (290 tests in CI's `a11y` project on 2026-11-25: `web/e2e/a11y-app.spec.ts` for the signed-in pages, `a11y.spec.ts` for the public pages and the keyboard checks, and `aria.spec.ts` for the accessibility trees), and the accessibility tree of the main screens is compared with saved versions (`web/e2e/aria-baselines/`). Lighthouse runs nightly on the public auth pages. No manual keyboard or screen-reader pass with a person has been done: the script is `docs/skarmlasartest.md`, and the accessibility statement says it remains.
- Reduced motion is honoured on the web (`@media (prefers-reduced-motion: reduce)`, `web/app/globals.css`). The app is not checked for it.
- The web's mobile nav drawer closes on Escape and keeps Tab inside it (`web/components/layout/app-shell.tsx`).
- The app is not scanned automatically, it uses accessibility props sparingly, and guardians type dates as text.

**Who the users are:**
- children from förskoleklass to åk 9;
- guardians on phones, with times shown in the school's timezone wherever the reader is;
- teachers acting in the first minutes of a lesson;
- schemaläggare working in dense matrices for hours.

The app is in Swedish and English only. Skola24 offers guardians six languages.
