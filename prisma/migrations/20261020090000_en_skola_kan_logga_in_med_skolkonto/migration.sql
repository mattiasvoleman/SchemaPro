-- En skola kan logga in med skolkonto, och en token till ett skolkonto från
-- någon annan organisation utfärdas aldrig.
--
-- Roadmap: Kommun lane, phase "Personalinloggning". Staff sign in with
-- "Logga in med skolkonto": Entra ID (Supabase's provider "azure") or Google
-- Workspace ("google"), on web and app. Supabase Auth runs the OAuth flow and
-- links the school account to the invited person by verified e-mail address;
-- public signups stay off (docs/DEPLOYMENT.md), so nobody without an
-- invitation gets an account this way. SSO sessions are ordinary Supabase
-- access tokens, so the gateway's JwtStrategy and every RLS policy treat them
-- like any other.
--
-- ## The table
--
-- "SchoolSignInMethods", at most one row per school:
--
--   * provider             'azure' or 'google', Supabase's own names;
--   * domains              the e-mail domains /login looks a typed address up
--                          by, lower case, 1 to 20 of them;
--   * entraTenantId        the school's Entra tenant (tid), for 'azure' only;
--   * googleHostedDomain   the Workspace domain Google sends as hd, for
--                          'google' only;
--   * ssoOnlyForStaff      staff may then sign in with the school account
--                          only. Off by default: a school decides it, not the
--                          product (PRODUCT.md, principle 6).
--
-- No row means passwords only. The school's admin reads and writes the row
-- through the gateway (SCHOOL_ADMIN arms TO authenticated, like
-- Ss12000Sources); nobody else in the school reads it. Deleting the row turns
-- school accounts off.
--
-- A kommun's schools can share a domain, so `domains` is not unique across
-- schools. What /login does with a domain is to ask which provider it signs
-- in with (app.sign_in_provider_for_domain), and that answer must not be
-- something one school can change for another. So a school may name a domain
-- another school already names only with the same provider: the trigger
-- app.sign_in_domain_keeps_its_provider() refuses anything else with SQLSTATE
-- SI409 (the gateway's 409 SIGN_IN_DOMAIN_TAKEN), under one advisory lock so
-- two concurrent saves cannot both pass. Two schools on one provider can
-- share a domain safely: the lookup answers only the provider, and the hook
-- pins each school's people to its own tenant or Workspace. Without the
-- trigger, a school naming another school's domain with the other provider
-- would make the lookup answer nothing for that domain, and staff of an
-- SSO-only school, whose passwords the hook refuses, could not sign in at
-- all. The lookup still answers NULL for a domain whose schools disagree, as
-- a second wall; the trigger keeps that from happening.
--
-- ## The access-token hook
--
-- Supabase Auth calls sign_in.custom_access_token_hook(event) before it issues
-- any access token: at sign-in, at every refresh and after an invitation or
-- recovery link. It runs as supabase_auth_admin, inside Auth's own
-- transaction, with two seconds to answer. The dashboard step that turns it
-- on is in docs/DEPLOYMENT.md; until then nothing here changes a sign-in.
--
-- The hook refuses (HTTP 403, the reason as a code the clients translate):
--
--   * sso_not_enabled           a session signed in with a school account,
--                               for a person whose school has no row. The
--                               providers are enabled for the whole project;
--                               a school that has not chosen school accounts
--                               does not get them;
--   * sso_identity_not_allowed  a session signed in with a school account,
--                               for a person who carries a school-account
--                               identity that is not the school's: an Entra
--                               identity from another tenant, a Google
--                               identity from another Workspace or none, or
--                               a provider the school did not choose;
--   * sso_required              a session that did not sign in with a school
--                               account, for staff (SCHOOL_ADMIN, TEACHER)
--                               of a school with ssoOnlyForStaff. That covers
--                               passwords, recovery and invitation links, and
--                               the refresh of a session started before the
--                               school turned it on, so a password session
--                               ends within the token's lifetime;
--   * sign_in_method_not_allowed  a session that signed in some other way than
--                               a password, an e-mail link or a school account
--                               the hook pins: SAML (sso/saml, which the
--                               Skolfederation phase will pin), a passkey,
--                               web3, an anonymous sign-in, or a method this
--                               hook does not know. Refused until pinned;
--   * sso_reauth_required       a school-account session whose sign-in at the
--                               provider is more than 24 hours old (the amr
--                               entry's timestamp), or has no timestamp.
--                               Auth never asks the provider again at a
--                               refresh, so without this limit someone the
--                               kommun disables in Entra ID or Google
--                               Workspace would keep their session for as
--                               long as the app kept refreshing it. With it,
--                               they are out within a day: the next sign-in
--                               goes through the provider, which refuses them.
--
-- Everything else gets its claims back unchanged, including a person with no
-- Users row (the web's /no-profile handles them). RLS section 76 calls the
-- hook as supabase_auth_admin and asserts both.
--
-- Why EVERY school-account identity, rather than the one this session used:
-- the hook cannot tell which. The claims carry the session's methods ("oauth")
-- but not the identity, and Auth links an identity to the account in the
-- provider callback, before the hook runs, and keeps it after the hook
-- refuses. Judging "the most recently used identity" would let a token
-- through for an identity from another tenant whenever the right one happened
-- to sign in between that identity's callback and its code exchange. Judging
-- all of them fails closed: an identity from elsewhere ends school-account
-- sign-in for that one person until an operator removes it
-- (docs/DEPLOYMENT.md). With the e-mail claim verified as the runbook
-- requires, another tenant's identity cannot be linked at all, so that is a
-- second wall, not the first.
--
-- How the hook knows a tenant: Auth stores the provider's ID-token issuer as
-- identity_data.iss, which for Entra ID is
-- https://login.microsoftonline.com/<tid>/v2.0, and copies the token's other
-- claims into identity_data.custom_claims, tid and Google's hd among them
-- (supabase/auth v2.197.0, internal/api/provider/oidc.go). An identity whose
-- iss is not that shape, or whose custom_claims.tid disagrees with it, or a
-- Google identity without hd, matches nothing.
--
-- ## The functions
--
-- The hook and the two functions it calls live in a schema of their own,
-- "sign_in", which PostgREST does not serve. supabase_auth_admin gets USAGE
-- on it and on nothing of SchemaPro's besides: USAGE on "app" would also let
-- that role run the helpers there that PUBLIC may execute, some of them
-- SECURITY DEFINER readers of any school's settings.
--
--   * sign_in.custom_access_token_hook(jsonb)  SECURITY INVOKER, as Supabase
--     recommends: it runs as supabase_auth_admin, which owns auth.identities
--     and reads it with its own privileges. EXECUTE for supabase_auth_admin
--     only.
--   * sign_in.rules(uuid)  SECURITY DEFINER: the person's role and their
--     school's row, for the hook, so supabase_auth_admin needs no grant on
--     Users or SchoolSignInMethods and neither table gets a policy for it.
--     Its body is SQL-standard (BEGIN ATOMIC), so Postgres records what it
--     reads and refuses to drop or retype a column of it: a later migration
--     cannot break every sign-in at runtime with CI green. EXECUTE for
--     supabase_auth_admin only.
--   * sign_in.verdict(...)  IMMUTABLE and reads nothing: the decision, from
--     the role, the school's row, the session's methods and the identities.
--     EXECUTE for supabase_auth_admin and for app_authenticated, which the
--     RLS suite runs as (section 73 walks its cases); app_authenticated has
--     USAGE on "sign_in" for that and executes nothing else there.
--   * app.sign_in_provider_for_domain(text)  SECURITY DEFINER: /login's
--     lookup, the provider and nothing else. The gateway calls it without a
--     principal (PrismaService.withPublicViewer). EXECUTE for
--     app_authenticated only.
--   * app.sign_in_domain_keeps_its_provider()  SECURITY DEFINER trigger
--     function: it reads the other schools' rows, which the saving admin's
--     RLS hides, and answers only which of the admin's own domains are taken.
--     Nobody executes it but the trigger.
--
-- Additive: a new type, a new table, a new schema and five new functions.
-- Nothing that exists changes, and nothing calls the hook until the
-- dashboard does.
--
-- RLS sections 70 to 76 assert the table's arms and CHECKs, the functions'
-- privileges and settings, the verdict's cases, the lookup, the domain rule
-- and the hook itself, called as supabase_auth_admin (scripts/db-init gives
-- CI's database a stand-in of that role and of auth.identities).

CREATE TYPE "SignInProvider" AS ENUM ('azure', 'google');

CREATE TABLE "SchoolSignInMethods" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId"           UUID NOT NULL,
    "provider"           "SignInProvider" NOT NULL,
    "domains"            TEXT[] NOT NULL,
    "entraTenantId"      UUID,
    "googleHostedDomain" TEXT,
    "ssoOnlyForStaff"    BOOLEAN NOT NULL DEFAULT false,
    "createdAt"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "SchoolSignInMethods_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SchoolSignInMethods_domains_are_few" CHECK (
        cardinality("domains") BETWEEN 1 AND 20 AND array_position("domains", NULL) IS NULL
    ),
    -- Lower-case host names with at least two labels and an alphabetic top
    -- label, joined by spaces, which no host name contains. The gateway's DTO
    -- says the same before anything reaches here.
    CONSTRAINT "SchoolSignInMethods_domains_are_hostnames" CHECK (
        char_length(array_to_string("domains", ' ')) <= 20 * 254
        AND (' ' || array_to_string("domains", ' ')) ~
            '^( [a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63})+$'
    ),
    CONSTRAINT "SchoolSignInMethods_googleHostedDomain_is_a_hostname" CHECK (
        "googleHostedDomain" IS NULL OR (
            char_length("googleHostedDomain") <= 253
            AND "googleHostedDomain" ~
                '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$'
        )
    ),
    -- One pin, and the one that belongs to the provider.
    CONSTRAINT "SchoolSignInMethods_pin_fits_the_provider" CHECK (
        ("provider" = 'azure') = ("entraTenantId" IS NOT NULL)
        AND ("provider" = 'google') = ("googleHostedDomain" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "SchoolSignInMethods_schoolId_key" ON "SchoolSignInMethods"("schoolId");

-- ---------------------------------------------------------------------------
-- A domain keeps its provider: no school changes /login's answer for another.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.sign_in_domain_keeps_its_provider()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  taken text[];
BEGIN
  -- One save at a time across schools. Each statement below then reads what
  -- the save before it committed (READ COMMITTED takes a snapshot per
  -- statement), so two schools cannot claim one domain with two providers
  -- at once.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('SchoolSignInMethods.domains'));
  SELECT array_agg(DISTINCT d ORDER BY d) INTO taken
    FROM public."SchoolSignInMethods" m
   CROSS JOIN LATERAL unnest(m."domains") d
   WHERE m."schoolId" <> NEW."schoolId"
     AND m."provider" <> NEW."provider"
     AND d = ANY (NEW."domains");
  IF taken IS NOT NULL THEN
    -- Names the saving school's own domains, never the other school.
    RAISE EXCEPTION 'SIGN_IN_DOMAIN_TAKEN'
      USING ERRCODE = 'SI409', DETAIL = 'domains=' || array_to_string(taken, ',');
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION app.sign_in_domain_keeps_its_provider() IS
  'Logga in med skolkonto (20261020090000): refuses (SI409) a row naming a domain another school names with another provider.';

CREATE TRIGGER "SchoolSignInMethods_domain_keeps_its_provider"
    BEFORE INSERT OR UPDATE OF "provider", "domains", "schoolId" ON "SchoolSignInMethods"
    FOR EACH ROW EXECUTE FUNCTION app.sign_in_domain_keeps_its_provider();

ALTER TABLE "SchoolSignInMethods"
    ADD CONSTRAINT "SchoolSignInMethods_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security: the school's admin, and nobody else.
-- ---------------------------------------------------------------------------

ALTER TABLE "SchoolSignInMethods" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sign_in_methods_admin_select" ON "SchoolSignInMethods"
    FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "sign_in_methods_admin_insert" ON "SchoolSignInMethods"
    FOR INSERT TO "authenticated"
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "sign_in_methods_admin_update" ON "SchoolSignInMethods"
    FOR UPDATE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
CREATE POLICY "sign_in_methods_admin_delete" ON "SchoolSignInMethods"
    FOR DELETE TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');

-- ---------------------------------------------------------------------------
-- The decision. Reads nothing; every input is an argument.
-- ---------------------------------------------------------------------------

CREATE SCHEMA "sign_in";
REVOKE ALL ON SCHEMA "sign_in" FROM PUBLIC;

CREATE FUNCTION sign_in.verdict(
    p_role                 "UserRole",
    p_provider             "SignInProvider",
    p_entra_tenant_id      uuid,
    p_google_hosted_domain text,
    p_sso_only_for_staff   boolean,
    p_methods              text[],
    p_identities           jsonb,
    p_school_account_age   interval
) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE
  -- The session's first factors: its methods without the second factors
  -- Auth adds on top of one, and without the refresh, which is not a way of
  -- signing in.
  first_factors text[] := ARRAY(
    SELECT DISTINCT m FROM unnest(coalesce(p_methods, '{}')) m
     WHERE m IS NOT NULL
       AND m NOT IN ('token_refresh', 'totp', 'mfa/phone', 'mfa/webauthn', 'mfa/recovery_code')
  );
  school_account boolean;
  identity jsonb;
  issuer text;
  tenant text;
  claimed_tenant text;
  matched boolean;
  seen int := 0;
BEGIN
  -- A way of signing in this hook does not pin is refused until it is:
  -- SAML (sso/saml) until the Skolfederation phase, passkeys, web3,
  -- anonymous sign-ins and anything Auth adds later.
  IF EXISTS (SELECT 1 FROM unnest(first_factors) m
              WHERE m NOT IN ('oauth', 'password', 'otp', 'magiclink', 'recovery', 'invite',
                              'email/signup', 'email_change')) THEN
    RETURN 'sign_in_method_not_allowed';
  END IF;

  school_account := cardinality(first_factors) > 0 AND first_factors <@ ARRAY['oauth'];

  IF NOT school_account THEN
    IF coalesce(p_sso_only_for_staff, false) AND p_role IN ('SCHOOL_ADMIN', 'TEACHER') THEN
      RETURN 'sso_required';
    END IF;
    RETURN NULL;
  END IF;

  IF p_provider IS NULL THEN
    RETURN 'sso_not_enabled';
  END IF;

  -- Every identity that is not the address or the phone number is a way of
  -- signing in from outside, and must be the school's.
  FOR identity IN
    SELECT value FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_identities) = 'array' THEN p_identities ELSE '[]'::jsonb END)
  LOOP
    CONTINUE WHEN identity->>'provider' IN ('email', 'phone');
    seen := seen + 1;
    issuer := identity->'identity_data'->>'iss';
    matched := false;
    IF identity->>'provider' = 'azure' AND p_provider = 'azure' THEN
      tenant := lower(substring(issuer FROM
        '^https://login\.microsoftonline\.com/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/v2\.0/?$'));
      claimed_tenant := lower(identity->'identity_data'->'custom_claims'->>'tid');
      matched := tenant IS NOT NULL
             AND tenant = p_entra_tenant_id::text
             AND (claimed_tenant IS NULL OR claimed_tenant = tenant);
    ELSIF identity->>'provider' = 'google' AND p_provider = 'google' THEN
      matched := issuer IN ('https://accounts.google.com', 'accounts.google.com')
             AND lower(identity->'identity_data'->'custom_claims'->>'hd') = p_google_hosted_domain;
    END IF;
    IF NOT coalesce(matched, false) THEN
      RETURN 'sso_identity_not_allowed';
    END IF;
  END LOOP;

  -- A school-account session with no school-account identity cannot happen
  -- through Auth; if it ever does, it is not one the school vouched for.
  IF seen = 0 THEN
    RETURN 'sso_identity_not_allowed';
  END IF;

  -- The provider was last asked when the session signed in with it. Past a
  -- day, or with no time at all, it is asked again.
  IF p_school_account_age IS NULL OR p_school_account_age > interval '24 hours' THEN
    RETURN 'sso_reauth_required';
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION sign_in.verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb, interval) IS
  'Logga in med skolkonto (20261020090000): NULL when a token may be issued, else sign_in_method_not_allowed, sso_not_enabled, sso_identity_not_allowed, sso_required or sso_reauth_required.';

-- ---------------------------------------------------------------------------
-- The person's role and their school's row, for the hook.
-- ---------------------------------------------------------------------------

CREATE FUNCTION sign_in.rules(p_auth_id uuid)
RETURNS TABLE (
    "role"                 "UserRole",
    "provider"             "SignInProvider",
    "entraTenantId"        uuid,
    "googleHostedDomain"   text,
    "ssoOnlyForStaff"      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
BEGIN ATOMIC
  SELECT u."role", m."provider", m."entraTenantId", m."googleHostedDomain", m."ssoOnlyForStaff"
    FROM public."Users" u
    LEFT JOIN public."SchoolSignInMethods" m ON m."schoolId" = u."schoolId"
   WHERE u."authId" = p_auth_id;
END;

COMMENT ON FUNCTION sign_in.rules(uuid) IS
  'Logga in med skolkonto (20261020090000): the role and the school''s sign-in row of the person with this Auth id; no row when there is no such person. For the access-token hook only.';

-- ---------------------------------------------------------------------------
-- The hook Supabase Auth calls before it issues an access token.
-- ---------------------------------------------------------------------------

CREATE FUNCTION sign_in.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  auth_id uuid := (event->>'user_id')::uuid;
  methods text[];
  rules record;
  identities jsonb := '[]'::jsonb;
  school_account_age interval;
  verdict text;
BEGIN
  -- The session's methods, from the claims Auth is about to sign (objects
  -- {method, timestamp}; plain strings are accepted too), plus the method of
  -- this issuance.
  methods := ARRAY(
    SELECT coalesce(a->>'method', a #>> '{}')
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event->'claims'->'amr') = 'array' THEN event->'claims'->'amr' ELSE '[]'::jsonb END) a
  ) || (event->>'authentication_method');

  SELECT * INTO rules FROM sign_in.rules(auth_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claims', event->'claims');
  END IF;

  -- Only a school-account session needs the identities, and how long ago it
  -- signed in at the provider: the newest oauth entry's timestamp (epoch
  -- seconds), NULL when there is none.
  IF 'oauth' = ANY (methods) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('provider', i.provider, 'identity_data', i.identity_data)), '[]'::jsonb)
      INTO identities
      FROM auth.identities i
     WHERE i.user_id = auth_id;
    SELECT now() - to_timestamp(max((a->>'timestamp')::double precision))
      INTO school_account_age
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event->'claims'->'amr') = 'array' THEN event->'claims'->'amr' ELSE '[]'::jsonb END) a
     WHERE jsonb_typeof(a) = 'object' AND a->>'method' = 'oauth'
       AND jsonb_typeof(a->'timestamp') = 'number';
  END IF;

  verdict := sign_in.verdict(rules."role", rules."provider", rules."entraTenantId",
                             rules."googleHostedDomain", rules."ssoOnlyForStaff", methods, identities,
                             school_account_age);
  IF verdict IS NULL THEN
    RETURN jsonb_build_object('claims', event->'claims');
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', verdict));
END
$$;

COMMENT ON FUNCTION sign_in.custom_access_token_hook(jsonb) IS
  'Logga in med skolkonto (20261020090000): Supabase Auth''s custom access token hook. Returns the claims unchanged, or a 403 whose message is sign_in_method_not_allowed, sso_not_enabled, sso_identity_not_allowed, sso_required or sso_reauth_required.';

-- ---------------------------------------------------------------------------
-- /login's lookup: the provider for an e-mail domain, and nothing else.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.sign_in_provider_for_domain(p_domain text)
RETURNS "SignInProvider"
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN count(DISTINCT m."provider") = 1 THEN min(m."provider"::text)::public."SignInProvider" END
    FROM public."SchoolSignInMethods" m
   WHERE lower(btrim(p_domain)) = ANY (m."domains")
$$;

COMMENT ON FUNCTION app.sign_in_provider_for_domain(text) IS
  'Logga in med skolkonto (20261020090000): the provider every school naming this e-mail domain agrees on, else NULL. Called by the gateway without a principal.';

-- ---------------------------------------------------------------------------
-- Grants, guarded.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  fn text;
  r text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "SchoolSignInMethods" TO "app_authenticated";
    REVOKE TRUNCATE, REFERENCES, TRIGGER ON "SchoolSignInMethods" FROM "app_authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SchoolSignInMethods" FROM "authenticated";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON "SchoolSignInMethods" FROM "anon";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "SchoolSignInMethods" FROM "service_role";
  END IF;

  FOREACH fn IN ARRAY ARRAY[
    'sign_in.custom_access_token_hook(jsonb)',
    'sign_in.rules(uuid)',
    'sign_in.verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb, interval)',
    'app.sign_in_provider_for_domain(text)',
    'app.sign_in_domain_keeps_its_provider()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- Supabase Auth's role: the hook and what it calls, in "sign_in" only.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA "sign_in" TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION sign_in.custom_access_token_hook(jsonb) TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION sign_in.rules(uuid) TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION sign_in.verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb, interval) TO "supabase_auth_admin";
  END IF;

  -- The gateway: the lookup; and the verdict, for the RLS suite.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.sign_in_provider_for_domain(text) TO "app_authenticated";
    GRANT USAGE ON SCHEMA "sign_in" TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION sign_in.verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb, interval) TO "app_authenticated";
  END IF;
END
$$;
