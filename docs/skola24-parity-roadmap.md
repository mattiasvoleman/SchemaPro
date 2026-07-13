# SchemaPro → Skola24 parity roadmap

Date: 2026-07-13 · Basis: current SchemaPro codebase vs the Skola24 platform
(Schema, Frånvaro, Lokal, Förskola, Omdöme modules; skola24.com, July 2026).

## Starting position

SchemaPro's **scheduling core is already competitive with — and in editing UX
ahead of — Skola24 Schema**: CP-SAT generation with tunable objectives and
school rules, drag-and-drop editing with live conflict prevention, locking and
non-destructive regeneration, versions with diff/rollback, smart slot
suggestions and the open-slot finder, co-teaching, multi-class and
individual-student lessons, realtime collaborative editing, audit trail, and
iCal/PDF/print export. The attendance core (teacher recording,
participant-aware rosters, per-class reports) covers basics.

The gap to a **Skola24 platform replacement** is not scheduling — it is the
guardian-facing product, ecosystem integrations, and procurement readiness.
The roadmap below is ordered by deal-blocking severity for a Swedish
school/municipality buyer.

---

## P0 — Deal blockers (cannot sell without these)

**1. Guardian role + absence reporting — ✅ SHIPPED (2026-07-13)**
Implemented: `GUARDIAN` role, `GuardianStudents` links (managed from the
People page), guardian portal (`/guardian`) with absence reporting (full-day
or timed, sick/appointment/other, deletable while future) and leave requests;
admin leave inbox (`/admin/leave`) with approve/reject — approval auto-creates
full-day absence reports for the range; teacher attendance pre-fills reported
students as EXCUSED with a "Reported absent" badge; adult students can report
for themselves. RLS end-to-end (guardians see only their children).
Migrations: `20260713170000_guardian_role_enum`,
`20260713170100_guardians_absence_leave`.

**1 (original scope).** Guardian role + absence reporting — *the* core Frånvaro workflow.
- `GUARDIAN` user role with guardian↔student links (a guardian can have
  several children, a child several guardians).
- Guardian reports full-day or partial absence (sick, appointment) via web;
  absences land on the affected calendar lessons and pre-fill the teacher's
  attendance view as "reported absent".
- Leave requests (ledighetsansökan) with an approval flow (mentor/rektor)
  and a decision trail.
- Effort: ~3–4 weeks. Depends on: nothing — schema, RLS and attendance
  tables are ready to extend.

**2. Notifications — ✅ SHIPPED (2026-07-13)**
Implemented: `Notifications` table (RLS: recipients read/mark-read own rows,
staff insert) + in-app bell inbox in the web header (unread badge, localized
rendering, mark-all-read, 60s polling). Triggers: guardian alert when a
student is marked ABSENT without a covering absence report (email + in-app),
leave-request decision to the requester (email + in-app), lesson
cancelled/substitute to the class's students + guardians (in-app), and
schedule-change notices when a master-lesson edit moves published lessons
(in-app). Email is optional via Resend's HTTP API — set `RESEND_API_KEY` and
`EMAIL_FROM`; recipients are BCC'd; delivery is fire-and-forget and never
blocks a mutation. Migration: `20260713190000_notifications`. Push
notifications remain for the mobile phase (P1.5).

**2 (original scope).** Unreported-absence alerts, schedule-change notices,
leave decisions. Email first, push later via the mobile app.

**3. SS12000 integration API — ✅ SHIPPED v1 (2026-07-13)**
Implemented: per-school API keys (SHA-256 at rest, shown once, revocable —
Admin → Integrations), `X-API-Key`-guarded external API under `/ss12000/v1`:
`organisation`, `persons` (incl. enrolments + guardian relations), `groups`,
`activities` (weekly template incl. co-teachers, extra classes, participants),
`calendarEvents?from&to` (the **lesson export** with cancelled flags, rooms,
teacher assignments) and `POST /import/persons` (update-only roster sync:
names, class membership with auto-created classes, guardian links; unknown
emails returned as `needsProvisioning`). Tenant isolation enforced per key in
code; rate-limited. Docs: `docs/integration-api.md`. Migration:
`20260713210000_integration_api_keys`. Remaining for full SS12000
certification: subscription/webhook deliveries and the complete resource set
(duties, placements, syllabuses) — add when a municipal procurement requires
them.

**3 (original scope).** The Swedish school-IT interoperability
standard. Without it, municipalities cannot connect their student registry
(Ladok/IST/Tieto) and sync rosters automatically.
- Read: expose organisations, persons, groups, activities, calendar events.
- Write/import: consume persons + group memberships from the municipal
  source system (initially CSV/SS12000 import job, then subscription-based
  sync with webhooks).
- Lesson export API (the integration Vklass/StudyBee consume from Skola24)
  falls out of the same model.
- Effort: ~4–6 weeks. Depends on: nothing; unlocks every ecosystem deal.

**4. Procurement readiness (non-code)** — GDPR DPA + registerförteckning,
data residency statement (Supabase EU region), backup/restore and uptime SLA,
pen-test of the RLS surface, offboarding/export commitments.
- Effort: ~2 weeks of focused work + ongoing.

## P1 — Expected by every evaluator (parity table stakes)

**5. Mobile experience — ✅ SHIPPED v1 (2026-07-13)**
The Expo app is no longer teacher-only: the login gate accepts all roles and
`AuthGate` routes by role. New **guardian tab group** — My children (child
chips + one-tap full-day absence reporting with reason, recent reports with
delete), Leave requests (submit + follow decisions with status colors), and
Alerts (notification inbox with mark-all-read). New **student tab group** —
My schedule (next 7 days incl. participant/elective lessons via RLS,
cancelled styling) and Alerts. All data access is direct supabase-js under
the RLS policies from P0.1/P0.2, matching the app's offline-capable
architecture. Still open for full parity: push notifications (Expo push +
device token registry), timed (partial-day) absence reporting on mobile, and
Swedish localization of the app (currently English, like the rest of the app).
- Remaining effort: ~1–2 weeks. Depends on: nothing.

**6. Minute-accurate absence statistics — ✅ SHIPPED v1 (2026-07-13)**
The class report now computes Skola24-style minute-accurate absence per
student from actual lesson durations: excused (giltig) minutes, unexcused
(ogiltig) minutes (ABSENT = full lesson; LATE = 15 min by convention), and
scheduled minutes — shown as table columns and included in the CSV export.
Because records are attributed by the *student's* class, electives and
multi-class lessons count correctly. Still open: saved custom report builder,
trend graphs, per-subject breakdowns.

**6 (original scope).** Minute-accurate absence statistics & report builder — Skola24's
strongest analytics claim: absence per student per minute against their
individualized schedule (participant lessons included — SchemaPro's data
model already supports this better than class-based systems).
- Prebuilt reports: per student/class/subject over period, ogiltig vs giltig
  frånvaro split, trend graphs, CAN-report style exports for orosanmälan.
- Custom report builder: pick dimensions/filters, save, export CSV/PDF.
- Effort: ~3 weeks. Depends on: P0.1 (absence categories).

**7. Substitute & cancellation workflows at scale** — day view exists; add:
teacher-absence entry that lists all affected lessons with one-click
substitute/cancel/room-change per lesson, substitute suggestions (free +
qualified, reusing the open-slot finder logic), and notification fan-out.
- Effort: ~2 weeks. Depends on: P0.2.

## P2 — Competitive differentiation / module parity

**8. Room booking (Skola24 Lokal parity)** — let teachers book free rooms
themselves: room-availability view (data already present), booking entity
that coexists with lessons in conflict checking, approval option for special
rooms, cross-school sharing later.
- Effort: ~2–3 weeks.

**9. Timetable viewer/publication portal** — public read-only schedule links
per class/teacher/room (Skola24's viewer is how most users consume it),
embeddable in school websites, with the existing iCal feeds per viewer.
- Effort: ~1–2 weeks.

**10. Preschool/fritids module** — check-in/check-out times, vistelsetid
(guardian-submitted care schedules), staff planning against child attendance
curves. Separate product surface; only needed for F-6 municipal deals.
- Effort: ~4+ weeks. Defer until pulled by a customer.

## P3 — Later / optional

**11. Omdöme (assessment) module** — or, smarter: integrate with existing
LMS/assessment tools (Vklass, StudyBee) via the P0.3 APIs instead of building
grading. Recommendation: integrate, don't build.

**12. Phone-based absence reporting** — Skola24 sells this as an add-on;
niche. Buy a telephony service (46elks/Twilio) if a deal requires it.

**13. Scale & ops hardening** — load testing at municipality scale (100+
schools), per-tenant metrics, status page, blue/green deploys on the existing
CI/CD.

---

## Suggested sequence and rough calendar

| Phase | Items | Duration (1–2 devs) |
|---|---|---|
| P0 | 1 → 2 → 3 (4 in parallel) | ~2.5 months |
| P1 | 5 ∥ 6 → 7 | ~2 months |
| P2 | 8 → 9 (10 on demand) | ~1 month |

After P0+P1 (~4–5 months) SchemaPro is pitchable as a full Skola24
Schema+Frånvaro replacement with a better scheduling engine; P2 closes the
remaining module gaps.

## Positioning while building

Sell the wedge, not the platform: "AI-generated, minimally-disruptive
timetabling that coexists with Skola24" — the P0.3 lesson-export API lets
SchemaPro *feed* schedules into an existing Skola24/Vklass installation, so
schools can adopt the superior scheduler first and migrate attendance later.
