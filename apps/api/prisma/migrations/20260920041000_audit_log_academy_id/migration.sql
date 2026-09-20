-- Additive: nullable academyId on AuditLog, backfilled where derivable from the
-- existing entity/entityId correlation. Old rows for entities that aren't
-- academy-scoped (Subject, GradeLevel catalog edits; a student's own
-- WalletTopup) are intentionally left NULL — there is no academy to attribute
-- them to.
ALTER TABLE "AuditLog" ADD COLUMN "academyId" TEXT;

-- TeacherProfile.id IS the academyId (identity-preserving Academy provisioning),
-- so entityId can be used directly for this entity type.
UPDATE "AuditLog" SET "academyId" = "entityId"
WHERE "entity" = 'TeacherProfile' AND "entityId" IS NOT NULL;

-- tenantId on these models already equals academyId (same identity-preserving
-- convention), so a join back to entityId recovers it.
UPDATE "AuditLog" a SET "academyId" = c."tenantId"
FROM "Course" c WHERE a."entity" = 'Course' AND a."entityId" = c.id;

UPDATE "AuditLog" a SET "academyId" = c."tenantId"
FROM "Coupon" c WHERE a."entity" = 'Coupon' AND a."entityId" = c.id;

UPDATE "AuditLog" a SET "academyId" = e."tenantId"
FROM "Enrollment" e WHERE a."entity" = 'Enrollment' AND a."entityId" = e.id;

UPDATE "AuditLog" a SET "academyId" = p."tenantId"
FROM "Payment" p WHERE a."entity" = 'Payment' AND a."entityId" = p.id;

UPDATE "AuditLog" a SET "academyId" = v."tenantId"
FROM "VideoAsset" v WHERE a."entity" = 'VideoAsset' AND a."entityId" = v.id;

UPDATE "AuditLog" a SET "academyId" = pr."tenantId"
FROM "PayoutRequest" pr WHERE a."entity" = 'PayoutRequest' AND a."entityId" = pr.id;

-- AcademySite carries its own explicit academyId column (not identity-equal to its own id).
UPDATE "AuditLog" a SET "academyId" = s."academyId"
FROM "AcademySite" s WHERE a."entity" = 'AcademySite' AND a."entityId" = s.id;

CREATE INDEX "AuditLog_academyId_createdAt_idx" ON "AuditLog" ("academyId", "createdAt");
