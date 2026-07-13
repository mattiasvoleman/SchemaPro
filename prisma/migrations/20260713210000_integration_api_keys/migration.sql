-- Integration API keys for the SS12000-style external API (hashed at rest).

CREATE TABLE "IntegrationApiKeys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "schoolId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdById" UUID,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IntegrationApiKeys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationApiKeys_keyHash_key" ON "IntegrationApiKeys"("keyHash");
CREATE INDEX "IntegrationApiKeys_schoolId_idx" ON "IntegrationApiKeys"("schoolId");
ALTER TABLE "IntegrationApiKeys"
    ADD CONSTRAINT "IntegrationApiKeys_schoolId_fkey"
    FOREIGN KEY ("schoolId") REFERENCES "Schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IntegrationApiKeys" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "integration_api_keys_admin_all" ON "IntegrationApiKeys"
    FOR ALL TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN')
    WITH CHECK ("schoolId" = (select app.current_school_id()) AND (select app.current_user_role()) = 'SCHOOL_ADMIN');
