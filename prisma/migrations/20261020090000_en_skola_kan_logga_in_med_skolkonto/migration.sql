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
-- schools. app.sign_in_provider_for_domain() answers a provider only when
-- every school naming the domain agrees on one; otherwise /login says it
-- found nothing and the person signs in with a password.
--
-- ## The access-token hook
--
-- Supabase Auth calls app.custom_access_token_hook(event) before it issues
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
--                               ends within the token's lifetime.
--
-- Everything else gets its claims back unchanged, including a person with no
-- Users row (the web's /no-profile handles them).
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
--   * app.custom_access_token_hook(jsonb)  SECURITY INVOKER, as Supabase
--     recommends: it runs as supabase_auth_admin, which owns auth.identities
--     and reads it with its own privileges. EXECUTE for supabase_auth_admin
--     only.
--   * app.sign_in_rules(uuid)  SECURITY DEFINER: the person's role and their
--     school's row, for the hook, so supabase_auth_admin needs no grant on
--     Users or SchoolSignInMethods and neither table gets a policy for it.
--     EXECUTE for supabase_auth_admin only.
--   * app.sign_in_verdict(...)  IMMUTABLE and reads nothing: the decision,
--     from the role, the school's row, the session's methods and the
--     identities. EXECUTE for supabase_auth_admin and for app_authenticated,
--     which the RLS suite runs as (section 73 walks its cases).
--   * app.sign_in_provider_for_domain(text)  SECURITY DEFINER: /login's
--     lookup, the provider and nothing else. The gateway calls it without a
--     principal (PrismaService.withPublicViewer). EXECUTE for
--     app_authenticated only.
--
-- All four live in "app", which PostgREST does not serve. supabase_auth_admin
-- gets USAGE on "app" for the first two; the helpers there that PUBLIC may
-- execute only read transaction-local settings.
--
-- Additive: a new type, a new table and four new functions. Nothing that
-- exists changes, and nothing calls the hook until the dashboard does.
--
-- RLS sections 70 to 74 assert the table's arms and CHECKs, the functions'
-- privileges and settings, the verdict's cases and the lookup.

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

CREATE FUNCTION app.sign_in_verdict(
    p_role                 "UserRole",
    p_provider             "SignInProvider",
    p_entra_tenant_id      uuid,
    p_google_hosted_domain text,
    p_sso_only_for_staff   boolean,
    p_methods              text[],
    p_identities           jsonb
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
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION app.sign_in_verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb) IS
  'Logga in med skolkonto (20261020090000): NULL when a token may be issued, else sso_not_enabled, sso_identity_not_allowed or sso_required.';

-- ---------------------------------------------------------------------------
-- The person's role and their school's row, for the hook.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.sign_in_rules(p_auth_id uuid)
RETURNS TABLE (
    "role"                 "UserRole",
    "provider"             "SignInProvider",
    "entraTenantId"        uuid,
    "googleHostedDomain"   text,
    "ssoOnlyForStaff"      boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT u."role", m."provider", m."entraTenantId", m."googleHostedDomain", m."ssoOnlyForStaff"
    FROM public."Users" u
    LEFT JOIN public."SchoolSignInMethods" m ON m."schoolId" = u."schoolId"
   WHERE u."authId" = p_auth_id
$$;

COMMENT ON FUNCTION app.sign_in_rules(uuid) IS
  'Logga in med skolkonto (20261020090000): the role and the school''s sign-in row of the person with this Auth id; no row when there is no such person. For the access-token hook only.';

-- ---------------------------------------------------------------------------
-- The hook Supabase Auth calls before it issues an access token.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE
  auth_id uuid := (event->>'user_id')::uuid;
  methods text[];
  rules record;
  identities jsonb := '[]'::jsonb;
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

  SELECT * INTO rules FROM app.sign_in_rules(auth_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('claims', event->'claims');
  END IF;

  -- Only a school-account session needs the identities.
  IF 'oauth' = ANY (methods) THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('provider', i.provider, 'identity_data', i.identity_data)), '[]'::jsonb)
      INTO identities
      FROM auth.identities i
     WHERE i.user_id = auth_id;
  END IF;

  verdict := app.sign_in_verdict(rules."role", rules."provider", rules."entraTenantId",
                                 rules."googleHostedDomain", rules."ssoOnlyForStaff", methods, identities);
  IF verdict IS NULL THEN
    RETURN jsonb_build_object('claims', event->'claims');
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', verdict));
END
$$;

COMMENT ON FUNCTION app.custom_access_token_hook(jsonb) IS
  'Logga in med skolkonto (20261020090000): Supabase Auth''s custom access token hook. Returns the claims unchanged, or a 403 whose message is sso_not_enabled, sso_identity_not_allowed or sso_required.';

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
    'app.custom_access_token_hook(jsonb)',
    'app.sign_in_rules(uuid)',
    'app.sign_in_verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb)',
    'app.sign_in_provider_for_domain(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role', 'app_authenticated', 'supabase_auth_admin'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', fn, r);
      END IF;
    END LOOP;
  END LOOP;

  -- Supabase Auth's role: the hook and what it calls.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA app TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION app.custom_access_token_hook(jsonb) TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION app.sign_in_rules(uuid) TO "supabase_auth_admin";
    GRANT EXECUTE ON FUNCTION app.sign_in_verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb) TO "supabase_auth_admin";
  END IF;

  -- The gateway: the lookup; and the verdict, for the RLS suite.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_authenticated') THEN
    GRANT EXECUTE ON FUNCTION app.sign_in_provider_for_domain(text) TO "app_authenticated";
    GRANT EXECUTE ON FUNCTION app.sign_in_verdict("UserRole", "SignInProvider", uuid, text, boolean, text[], jsonb) TO "app_authenticated";
  END IF;
END
$$;
