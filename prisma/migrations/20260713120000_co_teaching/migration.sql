-- Co-teaching in generation: an optional second teacher on a requirement is
-- scheduled together with the lead teacher; the master lesson carries both and
-- publishing creates a LEAD + ASSISTANT assignment pair.

ALTER TABLE "TeachingRequirements" ADD COLUMN "coTeacherId" UUID;
ALTER TABLE "MasterLessons" ADD COLUMN "coTeacherId" UUID;

ALTER TABLE "TeachingRequirements"
    ADD CONSTRAINT "TeachingRequirements_coTeacherId_fkey"
    FOREIGN KEY ("coTeacherId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MasterLessons"
    ADD CONSTRAINT "MasterLessons_coTeacherId_fkey"
    FOREIGN KEY ("coTeacherId") REFERENCES "Users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
