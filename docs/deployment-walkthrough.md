# Setting up SchemaPro — a step-by-step walkthrough

This guide takes you from nothing to a working SchemaPro installation. It
assumes no prior experience with servers, databases or Docker. Every step says
what you are doing, exactly what to click or paste, and how to check it worked
before you move on.

`DEPLOYMENT.md` in this folder covers the same ground for someone who already
knows the tooling. This one is the slow version.

---

## Read this first

**You will be handling real student data.** Names, email addresses, class
lists, attendance records. In the EU that is personal data covered by GDPR, and
a school is legally responsible for protecting it.

You do not need to be a developer to follow these steps. But you do need to
take two of them seriously, because getting them wrong exposes data rather than
breaking something noisily:

- **Step 4** creates a restricted database account. If you skip it and use the
  admin account instead, the wall between different schools' data comes down
  and every school can read every other school's records. Nothing will look
  broken. This is the one step where a mistake is silent.
- **Step 3** and **Step 6** involve secrets — long random passwords. Anyone who
  gets one can read the whole database. Treat them like the key to a filing
  cabinet of student records, because that is what they are.

If this is going live for a real school with real pupils, have someone
technical review it before you put actual data in. Following a guide correctly
is not the same as being able to tell when something has gone subtly wrong.

---

## What you are building

SchemaPro is four separate pieces that talk to each other. You will set each up
in turn.

| Piece | What it does | Think of it as |
| :--- | :--- | :--- |
| **Database** | Stores everything — people, rooms, lessons, attendance | The filing cabinet |
| **API** | The only thing allowed to change the filing cabinet | The clerk at the desk |
| **Solver** | Works out a conflict-free timetable | The specialist you send a puzzle to |
| **Web app** | What teachers and admins actually look at | The shopfront |

They connect like this: the **web app** talks to the **API**, the API talks to
the **database**, and when someone asks for a new timetable the API sends the
puzzle to the **solver**. The solver never sees any names — only anonymous
codes — so it cannot leak anything even if it were compromised.

You will not build any of these from scratch. You are creating accounts on
services that run them for you, and telling each one where the others live.

---

## Before you start

**Accounts you will need** (all have free tiers; sign up before starting):

| Service | Used for | Cost |
| :--- | :--- | :--- |
| [Supabase](https://supabase.com) | Database + logins | Free to try. **Pro (~$25/month) for a real school** — the free tier has no daily backups. |
| [Railway](https://railway.app) | Running the API and solver | ~$5/month |
| [Vercel](https://vercel.com) | Running the web app | Free for this size |
| [GitHub](https://github.com) | Holds the code | Free |

**Roughly $30/month** for a real deployment. Most of that is the database
backups, and they are not optional for student data.

**Time**: about two hours the first time, most of it waiting for things to
build. Do not start this an hour before you need it working.

**On your computer**: nothing to install. Every step happens in a web browser.

**Have ready**: a text file open where you can paste things. You will collect
about ten values along the way, and steps later need values from steps
earlier. Label them as you go — the guide tells you what to call each one.

> **A note on the boxes of code.** Several steps ask you to paste text into a
> box on a website. You do not need to understand it. You do need to replace
> anything written like `<THIS>` with your own value, including the angle
> brackets. Read each one before pasting — the guide says which parts to
> change.

---

## Step 1 — Get the code onto GitHub

Vercel and Railway install your app by reading it from GitHub, so it needs to
live there first.

1. Sign in to GitHub.
2. If the code is not already in your account, ask whoever gave it to you to
   add you to the repository. If you have the files on your computer instead,
   this is the one step where you will want help from someone technical.
3. Note the repository name — something like `yourname/SchemaPro`.

**Check it worked**: you can open the repository page on github.com and see
folders named `src`, `web`, `optimization-engine`.

---

## Step 2 — Create the database

1. Go to [supabase.com](https://supabase.com) and click **New project**.
2. Name it something recognisable, e.g. `schemapro-production`.
3. **Database password**: click *Generate a password*, then **copy it into
   your notes as `DB_PASSWORD`**. You cannot see it again later, and you will
   need it in Step 3.
4. **Region**: pick the one closest to your school. For Sweden, choose
   Frankfurt (`eu-central-1`). This also keeps the data inside the EU, which
   matters for GDPR.
5. Click **Create new project** and wait — it takes a couple of minutes.

Now collect four values. In the left sidebar go to **Settings → API**:

| Where on the page | Copy it as | Looks like |
| :--- | :--- | :--- |
| Project URL | `SUPABASE_URL` | `https://abcdefgh.supabase.co` |
| Publishable (anon) key | `SUPABASE_ANON_KEY` | a long string starting `eyJ…` |
| Service role key | `SUPABASE_SERVICE_KEY` | another long `eyJ…` string |
| JWT Settings → JWT Secret | `JWT_SECRET` | a long random string |

> **The service role key and the JWT secret are the two most dangerous values
> in this whole guide.** Either one lets someone read and change every record
> in the database. They belong only in the settings pages of Railway (Step 6).
> Never put them in the web app's settings, never email them, never paste them
> into a chat or a support ticket.

The middle one — the publishable key — is fine to expose. It is designed to sit
in a browser where anyone can see it.

**Check it worked**: you have four values saved in your notes, plus the
`DB_PASSWORD` from earlier. Five in total.

---

## Step 3 — Set up logins

Still in Supabase, so that staff can sign in and get invitation emails.

1. Go to **Authentication → URL Configuration**.
   - **Site URL**: put `https://placeholder.example` for now. You will come
     back and fix this in Step 7, once you know your real web address. Set a
     reminder — invitation emails will go to the wrong place until you do.
2. Go to **Authentication → Providers → Email**.
   - Turn **off** "Allow new users to sign up".
   - This matters: SchemaPro has no public registration by design. Staff are
     invited by an administrator. Leaving this on would let anyone on the
     internet create an account.
3. Optional but recommended for a real school: **Authentication → SMTP**.
   Supabase's built-in email sender is limited to a handful of messages per
   hour, which is fine for testing and not fine for inviting forty teachers in
   one afternoon. Connecting your school's own email service removes the limit.

**Check it worked**: on the Providers → Email page, "Allow new users to sign
up" is off.

---

## Step 4 — Create the restricted database account

**This is the step that matters most.** Read the whole thing before doing it.

The database has an all-powerful administrator account. The API must *not* use
it. SchemaPro keeps each school's data separate using database rules that only
apply to restricted accounts — the administrator account is exempt from them,
by design, the way a master key opens every door.

If the API runs as the administrator, every one of those walls disappears.
Nothing errors. Nothing looks wrong. Schools simply see each other's pupils.

So you will create a deliberately limited account for the API to use.

1. In Supabase, open the **SQL Editor** from the left sidebar and click
   **New query**.
2. First, invent a strong password for this new account. Use Supabase's
   password generator, or any password manager. Save it in your notes as
   `APP_PASSWORD`.
3. Paste this in, replacing `<APP_PASSWORD>` with the password you just made
   (keep the single quotes around it):

```sql
create role app_authenticated login password '<APP_PASSWORD>'
  in role authenticated inherit;
```

4. Click **Run**. It should say "Success. No rows returned."

**Check it worked** — this check is worth doing properly. Open a new query and
run:

```sql
select rolname, rolcanlogin from pg_roles where rolname = 'app_authenticated';
```

You should get one row back, with `rolcanlogin` showing `true`. If you get no
rows, the account was not created and you should re-run step 3 above.

---

## Step 5 — Build the database tables

The database is empty. This fills it with the right tables and, importantly,
the rules that keep each school's data separate.

This is the only step that needs a command run against the database, and
Supabase can do it from the browser.

1. Ask whoever set up the code to run this once from their computer:

```bash
npm ci
npm run migrate:deploy
```

with the database connection string set to the **administrator** account (this
is the one time the admin account is correct — creating tables requires it).

2. If you have to do it yourself, the connection string is:

```
postgresql://postgres:<DB_PASSWORD>@db.<PROJECT_REF>.supabase.co:5432/postgres
```

where `<DB_PASSWORD>` is from Step 2 and `<PROJECT_REF>` is the `abcdefgh`
part of your Supabase URL.

**Check it worked**: in Supabase, go to **Table Editor**. You should see a list
of tables including `Schools`, `Users`, `Rooms`, `CalendarLessons`. If the list
is empty, the migration did not run.

Second check, and this one confirms the security rules are live. In the SQL
Editor run:

```sql
select count(*) from pg_policies where schemaname = 'public';
```

You should get a number well above zero. Those are the rules that separate one
school's data from another's. If it returns 0, stop — do not put real data in
until someone works out why.

---

## Step 6 — Put the API and solver online

These are the two pieces that need a server. Railway runs both from your
GitHub repository.

### 6a. The solver

1. Go to [railway.app](https://railway.app), sign in with GitHub, click **New
   Project → Deploy from GitHub repo**, and pick your SchemaPro repository.
2. Railway will ask what to deploy. In the service settings, set the **Root
   Directory** to `optimization-engine`.
3. Go to the **Variables** tab and add these four:

| Name | Value |
| :--- | :--- |
| `APP_ENV` | `production` |
| `API_KEY` | a long random secret you invent now — save it as `SOLVER_SECRET` |
| `ALLOWED_ORIGINS` | `http://localhost` for now; you will correct it in Step 8 |
| `SOLVER_TIMEOUT_SECONDS` | `60` |

> `API_KEY` **must be at least 32 characters.** The solver refuses to start
> with anything shorter and the only sign will be a container that keeps
> restarting. A password manager's "generate password" at maximum length is
> ideal.

4. Under **Settings → Networking**, click **Generate Domain**. Save the address
   as `SOLVER_URL` — **with `https://` in front of it**.

> Railway shows the domain on its own, like
> `solver-prod-a1b2.up.railway.app`, and copying it as it appears is the
> single most common way to break Step 6b. A value with no `https://` is not a
> URL, and the API reports it as **"AI engine unavailable"** — a message that
> sends you to look at a solver which is running perfectly. The same goes for
> quotes: paste the address, not `"the address"`.

> **About the port**: you should not have to set one. Railway hands the
> container a port through a `PORT` variable, and the solver binds whatever it
> is given — `--port ${PORT:-8000}` in its Dockerfile.
>
> If Railway asks for a target port, **read the number out of the Deployments
> log** rather than guessing it. The solver prints it on the line
> `Uvicorn running on http://0.0.0.0:8080`, and that is the number the domain
> must point at.
>
> This advice used to say "set it to 8000, that is what the solver falls back
> to". That is only true when nothing is injected, and Railway always injects —
> in practice `PORT=8080`. So the fallback never applies and 8000 is guaranteed
> to be the wrong number. The result is a domain that answers **502 on every
> path**, including `/health`, while the container log looks perfectly healthy,
> and Railway's own network log says `"error":"connection refused"`. Which is
> the exact symptom this note used to offer 8000 as the cure for.
>
> Do not add a `PORT` variable of your own; Railway sets it, and a second one
> only gives the two ends another way to disagree.

**Check it worked**: open `<SOLVER_URL>/health` in your browser. You should see
a short message saying it is OK. If the page does not load, open the
**Deployments** tab and read the log — a container restarting in a loop almost
always means the `API_KEY` is too short. A page that fails to load while the
log looks *fine* is the port problem described above, not a crash.

### 6b. The API

1. In the same Railway project, click **New → GitHub Repo** and pick the same
   repository again. This time leave the Root Directory as the default (the
   repository root).
2. Add these variables. Most values come from your notes:

| Name | Value |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `DATABASE_URL` | see the box below |
| `DIRECT_URL` | the same value as `DATABASE_URL` |
| `JWT_SECRET` | your `JWT_SECRET` from Step 2 |
| `JWT_ISSUER` | **must be exact** — `<SUPABASE_URL>/auth/v1`, e.g. `https://abcdefgh.supabase.co/auth/v1`. The API downloads Supabase's public signing keys from `<JWT_ISSUER>/.well-known/jwks.json`, so a typo here makes every login fail with 401 |
| `JWT_AUDIENCE` | `authenticated` |
| `SUPABASE_URL` | your `SUPABASE_URL` from Step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | your `SUPABASE_SERVICE_KEY` from Step 2 |
| `AI_ENGINE_URL` | your `SOLVER_URL` from Step 6a — including `https://`, e.g. `https://solver-prod-a1b2.up.railway.app` |
| `AI_ENGINE_API_KEY` | your `SOLVER_SECRET` from Step 6a |
| `AI_ENGINE_TIMEOUT_MS` | `90000` |
| `THROTTLE_TTL_SECONDS` | `60` |
| `THROTTLE_LIMIT` | `120` |
| `CORS_ORIGINS` | `http://localhost:3000` for now; corrected in Step 8 |

> Every row above is needed. The API checks its settings on startup and
> refuses to run if any are missing, rather than starting up half-configured —
> so a missing row shows up as a service that will not start, with the name of
> the offending setting in the log. The last two are easy to skip because they
> sound optional; they are not.

The database connection string is:

```
postgresql://app_authenticated.<PROJECT_REF>:<APP_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
```

Replace `<PROJECT_REF>` (the `abcdefgh` part of your Supabase URL),
`<APP_PASSWORD>` (from Step 4), and `<REGION>` (e.g. `eu-central-1`). Supabase
shows the exact string under **Settings → Database → Connection pooling** —
copy it from there and swap in the `app_authenticated` username and password
rather than typing it by hand.

> Notice this uses `app_authenticated`, not `postgres`. That is Step 4 doing
> its job. If you find yourself pasting `postgres:` here, stop and re-read
> Step 4.

3. Under **Settings → Networking**, click **Generate Domain**. Save it as
   `API_URL`.

**Check it worked** — two checks, and the second is the important one:

- Open `<API_URL>/health` — you should see `{"status":"ok",…}`. This proves the
  API is running.
- Open `<API_URL>/health/ready` — you should see
  `{"status":"ready","database":"up"}`. This proves it can actually reach the
  database. If the first works and the second does not, your `DATABASE_URL` is
  wrong.

---

## Step 7 — Put the web app online

1. Go to [vercel.com](https://vercel.com), sign in with GitHub, and click **Add
   New → Project**. Pick your SchemaPro repository.
2. **Set the Root Directory to `web`.** This is easy to miss and nothing works
   without it — Vercel needs to know the website lives in a subfolder.
3. Add three environment variables:

| Name | Value |
| :--- | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | your `SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | your `SUPABASE_ANON_KEY` |
| `NEXT_PUBLIC_API_BASE_URL` | your `API_URL` from Step 6b |

> Only the publishable key goes here — never the service role key. Anything
> starting with `NEXT_PUBLIC_` is visible to every visitor's browser. That is
> fine for these three and catastrophic for the other two.

4. Click **Deploy** and wait. The first build takes several minutes.
5. When it finishes, Vercel gives you an address. Save it as `WEB_URL`.

**Check it worked**: open `WEB_URL`. You should be redirected to a Swedish
login page. Switching the language shows it in English. You cannot sign in yet
— that is Step 9.

---

## Step 8 — Introduce the pieces to each other

Three of the addresses you entered earlier were placeholders, because the real
values did not exist yet. Fix them now.

1. **Supabase** → Authentication → URL Configuration:
   - Site URL: your `WEB_URL`
   - Redirect URLs: add `<WEB_URL>/**` — the `/**` matters, it lets invitation
     and password-reset links land on the right page.
2. **Railway → the API service** → Variables:
   - `CORS_ORIGINS`: change to your `WEB_URL`
3. **Railway → the solver service** → Variables:
   - `ALLOWED_ORIGINS`: change to your `API_URL`

Railway restarts each service automatically after a variable changes. Give it a
minute.

**Check it worked**: reload your `WEB_URL`. The login page should still appear,
now with no errors. If you press F12 and open the Console tab, there should be
no red messages mentioning CORS.

---

## Step 9 — Create the first school and administrator

There is no sign-up button anywhere in SchemaPro — the first administrator has
to be created by hand, and everyone after that is invited from inside the app.

1. In Supabase, go to **Authentication → Users → Add user**.
   - Enter the administrator's real email address and a temporary password.
   - Tick "Auto Confirm User" so they can sign in immediately.
   - After it is created, click the user and **copy their UUID** — a long
     string of letters, numbers and dashes.
2. Go to the **SQL Editor** and run this, replacing the four marked values:

```sql
insert into "Schools" (name, slug, timezone, "updatedAt")
values ('<SCHOOL NAME>', '<short-name-no-spaces>', 'Europe/Stockholm', now());

insert into "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "updatedAt")
values (
  (select id from "Schools" where slug = '<short-name-no-spaces>'),
  '<THE UUID YOU COPIED>',
  'SCHOOL_ADMIN',
  '<FIRST NAME>', '<LAST NAME>', '<THE SAME EMAIL AS ABOVE>',
  now()
);
```

Replace every `<...>` placeholder, including the short name — leaving one in
literally is a common slip and the error message does not make it obvious.

Three things that will bite you if you retype this by hand:

- **`"updatedAt"` is required and has no database default.** It is maintained
  by Prisma at the application level, so a hand-written `insert` has to supply
  it. Omitting it fails with
  `null value in column "updatedAt" ... violates not-null constraint`.
  `"createdAt"` *does* default, which is why only one of them complains.
- **Keep the double quotes on every camelCase column.** Unquoted, PostgreSQL
  folds `updatedAt` to `updatedat` and you get
  `column "updatedat" of relation "Users" does not exist`.
- **Use the same short name in both statements**, or the sub-select finds no
  school and the second insert fails on a null `"schoolId"`.

The **UUID** is what links the login to the profile — `JwtStrategy` looks the
account up by `authId` and nothing else. If it is wrong or mistyped, sign-in
succeeds and the app then reports *"No active user profile is linked to this
account."* The email is stored for display and notifications; a mismatch there
is untidy but will not break sign-in.

**Check it worked**: go to your `WEB_URL`, sign in with that email and
temporary password. You should land on the admin dashboard. **This is the
moment the whole thing is working end to end.**

---

## Step 10 — Confirm it actually works

Signing in proves a lot, but not everything. Walk through this once before
letting staff in. Each one exercises a different piece.

1. **Invite someone**: Admin → People → invite a colleague. They should receive
   an email. *(Tests: Supabase email, the service role key, the API.)*
2. **Add the basics**: create a subject, a room, and a class.
   *(Tests: the API can write to the database.)*
3. **Generate a timetable**: add a teaching requirement, then Admin → Generate.
   *(Tests: the solver — the piece nothing else has touched yet.)*
4. **Publish it**: publish the generated timetable and open the teacher view.
   *(Tests: the whole loop.)*
5. **Take attendance**: open a lesson and mark a pupil present.
   *(Tests: writes from the teacher-facing side.)*

If step 3 fails, the solver is the thing to look at — check
`<SOLVER_URL>/health` and Railway's logs for that service.

---

## When something goes wrong

| What you see | What it usually means |
| :--- | :--- |
| Login works, then "No active user profile is linked to this account" | The email or UUID in Step 9 does not match the auth user exactly. |
| Login works, but every save returns a bare 401 | `JWT_ISSUER` is missing or misspelled, so the API cannot fetch Supabase's signing keys. It must be `<SUPABASE_URL>/auth/v1`, with no trailing slash. |
| Web app loads but nothing saves; console shows CORS errors | `CORS_ORIGINS` on the API is not exactly your `WEB_URL`. |
| API refuses to start: *"the database role ... has the BYPASSRLS attribute"* | `DATABASE_URL` is using the `postgres` owner instead of `app_authenticated`, which would switch off every privacy rule. Fix the role in `DATABASE_URL`; leave `DIRECT_URL` as the owner. |
| `<API_URL>/health` works, `/health/ready` does not | `DATABASE_URL` is wrong, or the `app_authenticated` password does not match Step 4. |
| Solver keeps restarting | `API_KEY` is shorter than 32 characters. |
| "Generate" fails but everything else works | `AI_ENGINE_URL` or `AI_ENGINE_API_KEY` on the API does not match the solver. |
| "Generate" fails with **"AI engine unavailable"** specifically | `AI_ENGINE_URL` is not a usable URL — almost always a missing `https://`, or quotes left around the value. The solver itself is fine; do not go looking at it. Since the check was added the API refuses to start on this instead, naming `AI_ENGINE_URL`. |
| The solver's domain answers **502 on every path**, `/health` included, while its own log says `Uvicorn running on …` | Railway is routing to a different port than the one the solver bound. Read the port off that log line and set the service's target port to it. The network log confirms it: `"error":"connection refused"`. |
| Invitation emails never arrive | Supabase's built-in sender is rate-limited. Set up SMTP (Step 3). |
| Web app builds but every page 404s | Root Directory on Vercel is not set to `web`. |

**Where to look**: Railway shows logs per service under **Deployments**.
Vercel shows build logs on each deployment. Supabase shows database activity
under **Logs**. The error is almost always in one of those three, and almost
always says what is wrong in plain English near the bottom.

---

## Keeping it running

- **Backups**: Supabase Pro takes daily backups automatically. On the free tier
  there are none, and there is no way to recover a deleted term's attendance.
  This is the main reason to pay for Pro on a real deployment.
- **Updating**: when the code changes on GitHub, Railway and Vercel redeploy on
  their own. If a change touches the database, someone technical needs to run
  `npm run migrate:deploy` again.
- **Adding schools**: repeat Step 9 with a different name and slug. Each school
  is walled off from the others by the rules you set up in Steps 4 and 5.
- **Secrets**: if anyone who had access to the values in your notes leaves,
  rotate them — regenerate in Supabase and Railway, and update everywhere they
  appear.

---

## What this guide does not cover

Honest limits, so you know when to get help:

- **A custom web address** (`schema.yourschool.se` instead of the Vercel one).
  Both Vercel and Railway support it under Settings → Domains, but it needs
  changes to your school's DNS records.
- **The mobile app.** It is distributed through the App Store and Google Play,
  which needs developer accounts and a build process. See `DEPLOYMENT.md`
  section 8.
- **Restoring from a backup.** Straightforward in the Supabase dashboard, but
  if you are doing it under pressure you want someone experienced beside you.
- **Anything that goes wrong in a way this guide does not list.** The
  troubleshooting table covers the common cases. Beyond that, the logs will
  tell someone technical what happened in a minute or two.
