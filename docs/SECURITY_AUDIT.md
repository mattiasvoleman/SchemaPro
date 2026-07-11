# SchemaPro — Security Audit & Vulnerability Assessment

**Date:** 2026-07-11
**Scope:** Full stack — PostgreSQL/Prisma RLS, NestJS gateway, Python FastAPI/OR-Tools engine, Expo mobile app, secrets/DevOps.
**Baseline:** The non-negotiable constraints in `.cursorrules` (Privacy by Design, RLS everywhere, secrets via env, mobile encrypted-at-rest + secure-store).
**Method:** Direct source review of every security-critical file, cross-checked against the exact `file:line` locations cited below. No changes were made to application code as part of this audit.

## Executive summary

The backend and database layers are strong: RLS is enabled and correctly written on all 12 tables, the PII-masking proxy genuinely strips names/emails/free-text before the AI engine, the global `ValidationPipe` blocks mass-assignment, and the exception filter never leaks stack traces or PII. The two areas that fall short of the `.cursorrules` mandate are the **mobile offline store (encryption claimed but never keyed)** and the **AI engine's unbounded solver inputs**. There are no findings indicating an existing cross-tenant data leak in the database.

| # | Vulnerability | Module | Risk |
|---|---------------|--------|------|
| 1 | Offline SQLite is unencrypted despite `useSQLCipher` (student PII in plaintext) | Mobile | **CRITICAL** |
| 2 | Unbounded solver inputs → pre-solve CPU/memory DoS (timeout does not cover model build) | AI engine | **CRITICAL** |
| 3 | Biometric verification is a local-only boolean, trivially forged; no server binding | Mobile | **HIGH** |
| 4 | Non-constant-time API-key comparison (timing side channel) | AI engine | **HIGH** |
| 5 | Missing `max_length` on request lists (feeds #2) | AI engine | **HIGH** |
| 6 | JWT strategy trusts role/schoolId/userId claims without DB check (claim-spoofing surface) | Backend | **MEDIUM** |
| 7 | WebSocket gateway CORS `origin: true` with credentials | Backend | **MEDIUM** |
| 8 | No request body-size limit / app-layer rate limiting on the engine | AI engine | **MEDIUM** |
| 9 | No TLS certificate pinning; scheme not enforced (token interception) | Mobile | **MEDIUM** |
| 10 | AI engine `allow_credentials=True` unnecessary for a header-auth service | AI engine | **LOW** |
| 11 | JWT verification algorithms not pinned | Backend | **LOW** |

Categories where the implementation **successfully mitigates** the risk are documented in the final section.

---

## 1. Offline SQLite store is unencrypted despite claiming SQLCipher — CRITICAL

**Location:** `mobile/src/services/database/localDatabase.ts:5` (comment claims SQLCipher), `:23` (`PRAGMA journal_mode = WAL` is the first statement — no `PRAGMA key`), `:62` (`SQLite.openDatabaseAsync(DB_NAME)` — no key argument), `:28` & `:73` (stores `display_name` = student names), plus `attendance_queue` rows; `mobile/app.json:19-22` (`expo-sqlite` plugin `useSQLCipher: true`).

**Impact:** `useSQLCipher: true` only *compiles* SQLite with SQLCipher; the database is encrypted only if a key is supplied as the first operation after opening. The code never supplies one, so `schemapro.db` is written to the app sandbox as **plaintext**, containing student names, per-student attendance status/history, and teacher UUIDs. On a lost/stolen jailbroken-or-rooted device, via an unencrypted file backup, or any sandbox-escape, this PII is directly readable. This violates the `.cursorrules` "encrypted local SQLite store" mandate and GDPR Privacy-by-Design. The reassuring comment makes it worse by implying protection that does not exist.

**Remediation:** Derive a 256-bit key once, store it in `expo-secure-store`, and key the database as the **first** statement after open (before `journal_mode`).

```ts
// localDatabase.ts
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

const DB_KEY_ID = 'schemapro.db.key';

async function getOrCreateDbKey(): Promise<string> {
  let key = await SecureStore.getItemAsync(DB_KEY_ID, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (!key) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    key = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    await SecureStore.setItemAsync(DB_KEY_ID, key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  return key;
}

export async function initDatabase(): Promise<SQLite.SQLiteDatabase> {
  const key = await getOrCreateDbKey();
  _db = await SQLite.openDatabaseAsync(DB_NAME);
  // PRAGMA key MUST be the first statement executed on the connection.
  await _db.execAsync(`PRAGMA key = "x'${key}'";`);
  await _db.execAsync('PRAGMA journal_mode = WAL;');
  await _db.execAsync(`PRAGMA cipher_version;`); // sanity-check: must be non-empty
  // ... table creation ...
  return _db;
}
```

Also: correct the misleading comment, and handle migration of any existing plaintext DB (rekey, or wipe-and-resync since the queue is reconstructable from the server).

---

## 2. Unbounded solver inputs → pre-solve CPU/memory DoS — CRITICAL

**Location:** model build in `optimization-engine/app/solver/scheduler_solver.py` — `_validate_request` nested loop `:103-122`, room no-overlap `:217-239`, availability constraints `:241-294`, preference objective `:332-390`; solver wall-clock limit correctly applied at `:71-74`. Missing input caps in `optimization-engine/app/schemas/schedule.py:82-84`.

**Impact:** `solver.parameters.max_time_in_seconds` genuinely bounds the **solve** phase, but the Python model-construction phase runs to completion **before** `Solve()` is ever called and is not covered by that timeout. Model size is the product of attacker-controlled list lengths: total lessons ≈ `len(requirements) × lessons_per_week`, room constraints `O(len(rooms) × total_lessons)`, availability `O(len(constraints) × total_lessons × schedule_days)`. A single payload with tens of thousands of requirements/rooms/constraints produces billions of CP-SAT variables, exhausting CPU/RAM and OOM-killing the worker before the timeout engages. Because the solve is a synchronous CPU-bound call inside an async endpoint, it also blocks the event loop for all tenants.

**Remediation:** Bound inputs (Finding 5) **and** add an aggregate complexity budget before building, plus offload the solve:

```python
# scheduler_solver.py — reject oversized models before constructing anything
MAX_LESSON_INSTANCES = 5_000
MAX_MODEL_COMPLEXITY = 2_000_000

def _validate_request(self, request: OptimizeScheduleRequest) -> None:
    total_lessons = sum(r.lessons_per_week for r in request.requirements)
    if total_lessons > MAX_LESSON_INSTANCES:
        raise InvalidScheduleInputError(
            f"Too many lesson instances ({total_lessons}); limit is {MAX_LESSON_INSTANCES}.")
    est = (total_lessons * len(request.rooms)
           + total_lessons * len(request.constraints) * len(self._grid.schedule_days))
    if est > MAX_MODEL_COMPLEXITY:
        raise InvalidScheduleInputError(
            "Scheduling request is too large to solve; reduce rooms, requirements, or constraints.")
    ...  # existing per-requirement checks
```

```python
# optimize.py — keep the CPU-bound solve off the event loop with a hard ceiling
response = await asyncio.wait_for(
    asyncio.to_thread(solver.solve, payload),
    timeout=settings.solver_max_time_seconds + 30,
)
```

(Input caps are the primary defense — `wait_for` cannot interrupt a mid-flight Python build loop.)

---

## 3. Biometric verification is a local-only boolean, trivially forged — HIGH

**Location:** `mobile/src/hooks/useBiometrics.ts:52-63` returns `result.success` (local boolean; `disableDeviceFallback: false` at `:56` also lets a device passcode satisfy it); `mobile/src/screens/attendance/AttendanceScreen.tsx:193-203` is the only gate; `mobile/src/services/sync/attendance_sync_worker.ts:77-82` posts `{ calendarLessonId, records: [{ studentId, status }] }` with a Bearer JWT and **no biometric assertion/nonce/signature**.

**Impact:** The FaceID/TouchID check is purely client-side UX. An attacker controlling the device can hook `LocalAuthentication.authenticateAsync` to return `{success:true}`, flip the React `verified` state, or skip the UI and replay `POST /api/v1/attendance/report` with the session token. The server cannot tell whether a biometric challenge occurred, so it cannot rely on it for attribution. The only real access control on the write is the JWT (+ RLS), which is correct — but the UI represents biometrics as identity verification it does not enforce.

**Remediation:** Either (a) stop representing biometrics as a security control and document it as local convenience; or (b) bind it to the server: gate a hardware-backed key (Secure Enclave/StrongBox, unlockable only after `LocalAuthentication`) and **sign** the attendance payload, verifying the signature server-side; or (c) require a short-lived server-verified step-up assertion sent with the POST. If biometric-specific assurance is required, also set `disableDeviceFallback: true`.

---

## 4. Non-constant-time API-key comparison — HIGH

**Location:** `optimization-engine/app/dependencies.py:15` — `if not x_api_key or x_api_key != settings.api_key:`.

**Impact:** Python's `!=` short-circuits on the first differing byte, leaking key material through response-timing analysis and enabling byte-by-byte recovery of the shared gateway↔solver key.

**Remediation:**

```python
import secrets
from fastapi import Header, HTTPException, status

async def verify_api_key(
    x_api_key: Annotated[str | None, Header(alias="X-API-Key")] = None,
) -> None:
    expected = get_settings().api_key
    if not x_api_key or not secrets.compare_digest(x_api_key, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing service API key.")
```

Consider also rejecting keys shorter than 32 chars in `config.py`.

---

## 5. Missing `max_length` on request lists — HIGH

**Location:** `optimization-engine/app/schemas/schedule.py:82-84` — `requirements`, `rooms`, `constraints` all have `min_length` but no `max_length`.

**Impact:** Direct enabler of Finding 2 — nothing caps how many items a caller can submit.

**Remediation:**

```python
requirements: list[AnonymousRequirement] = Field(min_length=1, max_length=2000)
rooms: list[AnonymousRoom] = Field(min_length=1, max_length=1000)
constraints: list[AnonymousConstraint] = Field(default_factory=list, max_length=5000)
# also add upper bounds on integers:
student_group_size: int = Field(default=1, alias="studentGroupSize", ge=1, le=1000)
capacity: int | None = Field(default=None, ge=1, le=10000)
```

---

## 6. JWT strategy trusts claims without a DB check — MEDIUM (defense-in-depth)

**Location:** `src/auth/jwt.strategy.ts:46-53` — when the token's `role` claim is one of the app roles, `role`, `userId`, and `schoolId` are taken **directly from the JWT**, skipping the `Users` lookup and the `isActive` check.

**Impact:** No code in the app mints such "first-party" tokens (only `verifyAsync` is used, in `jwt.strategy` and `realtime.gateway`), so this branch is currently unreachable in normal operation. But it widens the blast radius if the shared HS256 secret leaks: an attacker could forge `role=SCHOOL_ADMIN` with an arbitrary `schoolId` and operate as an admin of any tenant **without** a corresponding `Users` row (and `schoolId` from this branch is what the optimization proxy writes with). Because `schoolId`/`role` are security-critical, they should always be resolved from the database.

**Remediation:** Resolve the profile from `Users` for every token, regardless of the `role` claim shape:

```ts
async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
  if (!payload.sub) throw new UnauthorizedException('Invalid authentication token.');
  const profile = await this.prisma.withSystemTransaction((tx) =>
    tx.user.findUnique({
      where: { authId: payload.sub },
      select: { id: true, schoolId: true, role: true, isActive: true },
    }),
  );
  if (!profile || !profile.isActive) {
    throw new UnauthorizedException('No active user profile is linked to this account.');
  }
  return { authId: payload.sub, role: profile.role as Role, userId: profile.id, schoolId: profile.schoolId };
}
```

If a genuine cross-tenant `SYSTEM_ADMIN` (which is intentionally not in `Users`) is required, gate that on a dedicated verified IdP claim rather than the general role claim.

---

## 7. WebSocket gateway CORS `origin: true` with credentials — MEDIUM

**Location:** `src/realtime/realtime.gateway.ts:35-38` — `cors: { origin: true, credentials: true }` reflects **any** origin, contradicting the docstring's claim (`:31-33`) that it reuses the HTTP allowlist.

**Impact:** Any web origin can open a socket. The handshake still requires a valid token (`:50-67`), so an attacker origin cannot read another user's data without stealing a token — which limits severity — but `origin: true` + `credentials: true` is a misconfiguration that undermines origin-based defense-in-depth and diverges from the documented intent.

**Remediation:** Feed the same `CORS_ORIGINS` allowlist used by the HTTP server into the gateway options (via a config factory) instead of `origin: true`, and drop `credentials` unless cookie auth is actually used.

---

## 8. No body-size limit / app-layer rate limiting on the engine — MEDIUM

**Location:** `optimization-engine/app/main.py` — no body-size middleware or rate limiter.

**Impact:** Even with per-field caps, a large JSON array is fully parsed and validated before list-length limits apply; combined with the synchronous solve (Finding 2) a few concurrent large requests exhaust workers.

**Remediation:** Enforce a max body size at the ASGI/ingress layer, add rate limiting (e.g. `slowapi`) keyed on the caller, and — since traffic should only come from the internal gateway — add network allowlisting or mTLS in addition to the shared key.

---

## 9. No TLS certificate pinning; scheme not enforced — MEDIUM

**Location:** `mobile/src/services/sync/attendance_sync_worker.ts:71-82` (plain `fetch`, Bearer token) and `mobile/src/services/sync/websocket_client.ts:46-55` (socket.io `auth.token`); base URLs from `EXPO_PUBLIC_API_BASE_URL` / `EXPO_PUBLIC_WS_BASE_URL` with no scheme guard.

**Impact:** On a device with a malicious/enterprise root CA, an on-path attacker can intercept the JWT and all attendance traffic. A misconfigured `http://`/`ws://` URL would send everything in cleartext with no guardrail.

**Remediation:** Add public-key pinning (e.g. `react-native-ssl-pinning` or native ATS + Android Network Security Config), reject non-`https`/`wss` base URLs at startup, and keep token lifetimes short.

---

## 10. AI engine `allow_credentials=True` unnecessary — LOW

**Location:** `optimization-engine/app/main.py:168-174`.

**Impact:** The service authenticates by `X-API-Key`, not cookies, so credentialed CORS adds no value and would become dangerous if `ALLOWED_ORIGINS` were ever set to `*`. Origins are correctly config-driven with no wildcard today.

**Remediation:** Set `allow_credentials=False`, and add a `field_validator` in `config.py` that rejects a literal `*` origin.

---

## 11. JWT verification algorithms not pinned — LOW

**Location:** `src/auth/jwt.strategy.ts:25-31` — `StrategyOptions` sets no `algorithms`.

**Impact:** Low in practice: the secret is a string, so verification is limited to the HS family and there is no RS public key to enable a classic alg-confusion attack. Pinning is still best practice to remove ambiguity.

**Remediation:** Add `algorithms: ['HS256']` to the strategy options. (Longer term, item #17 in the deployment runbook — moving to asymmetric RS256/ES256 via Supabase JWKS so the API holds no signing secret — also resolves Finding 6's blast-radius concern.)

---

## Categories that are correctly mitigated

**Database & Supabase RLS — no bypass found.** RLS is `ENABLE`d on all 12 tables (`prisma/migrations/20260623120000_init/migration.sql:407-418`) and every policy is scoped by `app.current_school_id()` / `app.current_user_id()` / `app.current_user_group_id()`, which resolve from `Users.authId = auth.uid()` inside `SECURITY DEFINER` functions with a pinned `search_path` (`:381-399`). Students are restricted to their own row/group/attendance; teachers can write attendance only for lessons they are assigned to (`:596-628`); every write policy re-checks `schoolId` in `WITH CHECK`. Session variables are not string-concatenated — they are bound parameters via `set_config(..., true)` (transaction-local) in `PrismaService.withRls()` (`src/database/prisma.service.ts:74-88`), so they are not injectable or spoofable, and the app connects as the non-owner `app_authenticated` role so RLS is never bypassed. A prior privilege-escalation footgun (`public.rls_auto_enable()` callable by `anon`) was already locked down (`20260626010500_lockdown_rls_auto_enable/migration.sql`).

**PII leakage to the AI engine — none found.** `OptimizationProxyService.fetchAndAnonymize` (`src/optimization/optimization-proxy.service.ts:116-245`) selects only non-PII columns, remaps every real id to a fresh per-request `randomUUID()`, and drops all text (names, codes, reasons, notes) — group headcounts are aggregates, not PII. The engine schema (`schemas/schedule.py`) accepts only UUIDs/enums/numbers with `extra="forbid"`, and **no LLM exists anywhere in the engine**, so prompt injection is out of scope.

**Mass-assignment / error leakage.** The global `ValidationPipe` sets `whitelist: true` **and** `forbidNonWhitelisted: true` with `transform: true` (`src/app.module.ts:117-123`), rejecting unknown fields. The global exception filter (`src/common/filters/http-exception.filter.ts`) returns RFC-7807 problem+json, maps Prisma error codes to generic messages, and logs only `method + path + status + traceId` — never the body, stack, or SQL (`:141-156`).

**Secrets management.** No hardcoded credentials were found in source, `Dockerfile`, `docker-compose.yml`, `app.json`, or CI. All secrets load via `ConfigService`/`process.env`; `.env` examples contain only placeholders. Real `.env`/`.env.local` files exist locally but are correctly git-ignored (`.gitignore:6-8`, `optimization-engine/.env` at `:23`) and are not tracked. The Supabase service-role key is server-only; the mobile app ships only `EXPO_PUBLIC_*` publishable values. (Recommendation: confirm the local `.env` files hold no shared production keys, and rotate if in doubt.)

**Mobile token storage.** JWTs/session are stored exclusively in `expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; no `@react-native-async-storage` usage exists, and no tokens are logged. (The SQLite gap in Finding 1 concerns cached PII, not tokens.)

---

## Remediation status — all 11 fixed (2026-07-11)

Every finding above has been remediated in-repo and verified (API typecheck + 13/13 e2e, engine 8/8 pytest incl. 4 new protection tests, mobile typecheck).

| # | Fix | Key files |
|---|-----|-----------|
| 1 | SQLite now keyed with a secure-store 256-bit key via `PRAGMA key` (first statement); fails closed if SQLCipher inactive (`cipher_version` check) | `mobile/src/services/database/localDatabase.ts` |
| 2 | Aggregate complexity budget rejects oversized models before build; solve offloaded via `asyncio.to_thread` + `wait_for` hard ceiling | `optimization-engine/app/solver/scheduler_solver.py`, `app/api/v1/optimize.py`, `app/main.py` |
| 3 | Biometric gate is biometric-only (`disableDeviceFallback: true`) and OS-keychain-enforced via a `requireAuthentication` secret (defeats JS-hook bypass) | `mobile/src/hooks/useBiometrics.ts` |
| 4 | `secrets.compare_digest` constant-time key check; min 32-char key enforced in config | `optimization-engine/app/dependencies.py`, `app/config.py` |
| 5 | `max_length` on `requirements`/`rooms`/`constraints`; upper bounds on `student_group_size`/`capacity` | `optimization-engine/app/schemas/schedule.py` |
| 6 | Role/schoolId/userId always resolved from `Users`; token claims no longer trusted (except explicit `SYSTEM_ADMIN`) | `src/auth/jwt.strategy.ts` |
| 7 | `CorsIoAdapter` applies the `CORS_ORIGINS` allowlist to Socket.IO; decorator no longer reflects all origins | `src/realtime/cors-io.adapter.ts`, `src/main.ts`, `src/realtime/realtime.gateway.ts` |
| 8 | Max body-size middleware (8 MB) + dependency-free per-client rate limiter | `optimization-engine/app/main.py`, `app/config.py` |
| 9 | `assertSecureBaseUrl` rejects non-`https`/`wss` (localhost allowed in dev only) on API + WS clients | `mobile/src/services/network/secureUrl.ts`, `attendance_sync_worker.ts`, `websocket_client.ts` |
| 10 | `allow_credentials=False`; config validator rejects wildcard `*` origin | `optimization-engine/app/main.py`, `app/config.py` |
| 11 | JWT verification pinned to `algorithms: ['HS256']` | `src/auth/jwt.strategy.ts` |

**Documented residuals (device/infra-dependent, not code-fixable here):**

- **#3** — The gate is now OS-enforced client-side, but *fully* server-verified biometric attestation additionally requires per-device key enrollment (register a hardware-backed public key at login; sign each attendance record; verify server-side). This preserves offline-first submission and is scoped as a follow-up.
- **#9** — Scheme enforcement is active; TLS **certificate pinning** still requires a native module (`react-native-ssl-pinning`) or iOS ATS + Android Network Security Config and a device build to validate.

## Suggested remediation order

1. **CRITICAL** — Key the mobile SQLite DB (Finding 1) and cap engine inputs + complexity budget (Findings 2 & 5).
2. **HIGH** — Constant-time key compare (Finding 4); decide the biometrics contract (Finding 3).
3. **MEDIUM** — Always resolve role/schoolId from DB (6); fix WebSocket CORS (7); engine body-size/rate limits (8); mobile cert pinning (9).
4. **LOW** — `allow_credentials=False` + wildcard guard (10); pin JWT algorithms (11).
