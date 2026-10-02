-- C5: one additive value for the derived LOW_GRADE signal (C6 owns the grades).
ALTER TYPE "FollowUpReason" ADD VALUE IF NOT EXISTS 'LOW_GRADE';

-- CreateEnum
CREATE TYPE "PaperExamKind" AS ENUM ('REGULAR', 'MAKEUP');

-- CreateEnum
CREATE TYPE "PaperExamStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'VOID');

-- CreateEnum
CREATE TYPE "PaperResultStatus" AS ENUM ('SCORED', 'ABSENT', 'EXCUSED');

-- CreateEnum
CREATE TYPE "PaperRevisionKind" AS ENUM ('ENTRY', 'CLEAR', 'CORRECTION');

-- DropIndex

-- CreateTable
CREATE TABLE "PaperExam" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "groupSessionId" TEXT,
    "subjectId" TEXT,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "examDate" DATE NOT NULL,
    "maxScore" INTEGER NOT NULL,
    "passScore" INTEGER,
    "kind" "PaperExamKind" NOT NULL DEFAULT 'REGULAR',
    "makeupOfExamId" TEXT,
    "status" "PaperExamStatus" NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "requestKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PaperExam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperExamResult" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "status" "PaperResultStatus" NOT NULL,
    "score" INTEGER,
    "guest" BOOLEAN NOT NULL DEFAULT false,
    "makeupKey" TEXT,
    "enteredBy" TEXT NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PaperExamResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperExamRevision" (
    "id" TEXT NOT NULL,
    "academyId" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "academyStudentId" TEXT NOT NULL,
    "kind" "PaperRevisionKind" NOT NULL,
    "fromStatus" "PaperResultStatus",
    "fromScore" INTEGER,
    "toStatus" "PaperResultStatus",
    "toScore" INTEGER,
    "reason" TEXT,
    "actorUserId" TEXT NOT NULL,
    "batchKey" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperExamRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AcademyGradeSettings" (
    "academyId" TEXT NOT NULL,
    "lowGradePercent" INTEGER NOT NULL DEFAULT 50,
    "guardianGradesVisible" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AcademyGradeSettings_pkey" PRIMARY KEY ("academyId")
);

-- CreateIndex
CREATE INDEX "PaperExam_academyId_groupId_examDate_idx" ON "PaperExam"("academyId", "groupId", "examDate");

-- CreateIndex
CREATE INDEX "PaperExam_academyId_status_examDate_idx" ON "PaperExam"("academyId", "status", "examDate");

-- CreateIndex
CREATE INDEX "PaperExam_makeupOfExamId_idx" ON "PaperExam"("makeupOfExamId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperExam_academyId_requestKey_key" ON "PaperExam"("academyId", "requestKey");

-- CreateIndex
CREATE INDEX "PaperExamResult_academyStudentId_idx" ON "PaperExamResult"("academyStudentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperExamResult_examId_academyStudentId_key" ON "PaperExamResult"("examId", "academyStudentId");

-- CreateIndex
CREATE INDEX "PaperExamRevision_examId_academyStudentId_at_idx" ON "PaperExamRevision"("examId", "academyStudentId", "at");

-- CreateIndex
CREATE INDEX "PaperExamRevision_examId_batchKey_idx" ON "PaperExamRevision"("examId", "batchKey");

-- AddForeignKey
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_groupSessionId_fkey" FOREIGN KEY ("groupSessionId") REFERENCES "GroupSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "AcademySubject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_makeupOfExamId_fkey" FOREIGN KEY ("makeupOfExamId") REFERENCES "PaperExam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExamResult" ADD CONSTRAINT "PaperExamResult_examId_fkey" FOREIGN KEY ("examId") REFERENCES "PaperExam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExamResult" ADD CONSTRAINT "PaperExamResult_academyStudentId_fkey" FOREIGN KEY ("academyStudentId") REFERENCES "AcademyStudent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperExamRevision" ADD CONSTRAINT "PaperExamRevision_examId_fkey" FOREIGN KEY ("examId") REFERENCES "PaperExam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AcademyGradeSettings" ADD CONSTRAINT "AcademyGradeSettings_academyId_fkey" FOREIGN KEY ("academyId") REFERENCES "Academy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────────────────
-- C6 guarantees the database keeps by itself (docs/PAPER-EXAMS.md). Each one
-- protects an invariant that service code alone could not hold under
-- concurrency or a stray write; each is tested directly.
-- ─────────────────────────────────────────────────────────────────────────────

-- Shapes and bounds.
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_shape" CHECK (
  "requestKey" ~ '^[A-Za-z0-9_-]{8,64}$'
  AND length("title") BETWEEN 1 AND 120
  AND ("note" IS NULL OR length("note") BETWEEN 1 AND 500)
  AND "maxScore" BETWEEN 1 AND 100000
  AND ("passScore" IS NULL OR "passScore" BETWEEN 0 AND "maxScore")
  AND (("kind" = 'MAKEUP') = ("makeupOfExamId" IS NOT NULL))
);
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_published_whole" CHECK (
  ("publishedAt" IS NULL) = ("publishedBy" IS NULL)
  AND ("status" <> 'PUBLISHED' OR "publishedAt" IS NOT NULL)
  AND ("status" <> 'DRAFT' OR "publishedAt" IS NULL)
);
ALTER TABLE "PaperExam" ADD CONSTRAINT "PaperExam_void_whole" CHECK (
  ("status" = 'VOID') = ("voidedAt" IS NOT NULL)
  AND ("voidedAt" IS NULL) = ("voidedBy" IS NULL)
  AND ("voidedAt" IS NULL) = ("voidReason" IS NULL)
  AND ("voidReason" IS NULL OR length("voidReason") BETWEEN 3 AND 300)
);
ALTER TABLE "PaperExamResult" ADD CONSTRAINT "PaperExamResult_shape" CHECK (
  (("status" = 'SCORED') = ("score" IS NOT NULL)) AND ("score" IS NULL OR "score" >= 0)
);
ALTER TABLE "PaperExamRevision" ADD CONSTRAINT "PaperExamRevision_shape" CHECK (
  ("fromStatus" IS NULL OR (("fromStatus" = 'SCORED') = ("fromScore" IS NOT NULL)))
  AND ("toStatus" IS NULL OR (("toStatus" = 'SCORED') = ("toScore" IS NOT NULL)))
  AND (("kind" = 'CORRECTION') = ("reason" IS NOT NULL))
  AND ("reason" IS NULL OR length("reason") BETWEEN 3 AND 300)
  AND ("kind" <> 'CLEAR' OR "toStatus" IS NULL)
);
ALTER TABLE "AcademyGradeSettings" ADD CONSTRAINT "AcademyGradeSettings_bounds" CHECK ("lowGradePercent" BETWEEN 1 AND 100);

-- One EFFECTIVE makeup per (original exam, learner). A SCORED result of a
-- non-void MAKEUP exam carries the original's id (set by the trigger below).
-- Several learners may share one makeup sitting; one learner cannot hold two
-- effective makeups for the same original.
CREATE UNIQUE INDEX "PaperExamResult_one_effective_makeup" ON "PaperExamResult"("makeupKey", "academyStudentId")
  WHERE "makeupKey" IS NOT NULL;

-- Revisions: append-only.
CREATE FUNCTION paper_revision_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'PaperExamRevision is append-only' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "PaperExamRevision_append_only" BEFORE UPDATE OR DELETE ON "PaperExamRevision"
  FOR EACH ROW EXECUTE FUNCTION paper_revision_frozen();

-- Exams: tenant, makeup integrity, lifecycle, frozen once published,
-- deletable only as an empty draft.
CREATE FUNCTION paper_exam_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' OR EXISTS (SELECT 1 FROM "PaperExamResult" WHERE "examId" = OLD.id) THEN
      RAISE EXCEPTION 'only an empty draft exam may be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "Group" WHERE id = NEW."groupId" AND "academyId" = NEW."academyId")
     OR (NEW."groupSessionId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "GroupSession" WHERE id = NEW."groupSessionId" AND "academyId" = NEW."academyId"
            AND "groupId" = NEW."groupId"))
     OR (NEW."subjectId" IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM "AcademySubject" WHERE id = NEW."subjectId" AND "academyId" = NEW."academyId")) THEN
    RAISE EXCEPTION 'paper exam crosses academies' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."makeupOfExamId" IS NOT NULL THEN
    SELECT "academyId", "kind", "groupId" INTO o FROM "PaperExam" WHERE id = NEW."makeupOfExamId";
    IF o."academyId" IS DISTINCT FROM NEW."academyId" OR o."kind" <> 'REGULAR' OR o."groupId" <> NEW."groupId" THEN
      RAISE EXCEPTION 'a makeup belongs to a regular exam of the same group' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."status" = 'VOID' THEN
      RAISE EXCEPTION 'a void exam is history' USING ERRCODE = 'P0001';
    END IF;
    IF NOT (NEW."status" = OLD."status"
            OR (OLD."status" = 'DRAFT' AND NEW."status" IN ('PUBLISHED', 'VOID'))
            OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'VOID')) THEN
      RAISE EXCEPTION 'illegal exam status change' USING ERRCODE = 'P0001';
    END IF;
    IF NEW."academyId" <> OLD."academyId" OR NEW."kind" <> OLD."kind"
       OR NEW."makeupOfExamId" IS DISTINCT FROM OLD."makeupOfExamId" OR NEW."createdBy" <> OLD."createdBy"
       OR NEW."requestKey" <> OLD."requestKey" THEN
      RAISE EXCEPTION 'a paper exam keeps what it is' USING ERRCODE = 'P0001';
    END IF;
    IF OLD."status" = 'PUBLISHED' AND (NEW."groupId" <> OLD."groupId" OR NEW."examDate" <> OLD."examDate"
       OR NEW."maxScore" <> OLD."maxScore" OR NEW."passScore" IS DISTINCT FROM OLD."passScore"
       OR NEW."groupSessionId" IS DISTINCT FROM OLD."groupSessionId"
       OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt") THEN
      RAISE EXCEPTION 'a published exam keeps its group, date and marks' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaperExam_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaperExam"
  FOR EACH ROW EXECUTE FUNCTION paper_exam_guard();

-- A voided makeup no longer holds anyone's effective-makeup slot.
CREATE FUNCTION paper_exam_void_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'VOID' AND OLD."status" <> 'VOID' THEN
    UPDATE "PaperExamResult" SET "makeupKey" = NULL WHERE "examId" = NEW.id AND "makeupKey" IS NOT NULL;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "PaperExam_void_release" AFTER UPDATE ON "PaperExam"
  FOR EACH ROW EXECUTE FUNCTION paper_exam_void_release();

-- Results: tenant, within the maximum, the effective-makeup key, and no
-- deletion once the exam is no longer a draft.
CREATE FUNCTION paper_result_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (SELECT "status" FROM "PaperExam" WHERE id = OLD."examId") <> 'DRAFT' THEN
      RAISE EXCEPTION 'a published result is never deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  SELECT "academyId", "maxScore", "kind", "status", "makeupOfExamId" INTO e FROM "PaperExam" WHERE id = NEW."examId";
  IF e."academyId" IS DISTINCT FROM NEW."academyId" OR NOT EXISTS (
       SELECT 1 FROM "AcademyStudent" WHERE id = NEW."academyStudentId" AND "academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'paper result crosses academies' USING ERRCODE = 'P0001';
  END IF;
  IF NEW."score" IS NOT NULL AND NEW."score" > e."maxScore" THEN
    RAISE EXCEPTION 'score above the maximum' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."examId" <> OLD."examId" OR NEW."academyStudentId" <> OLD."academyStudentId"
                           OR NEW."academyId" <> OLD."academyId") THEN
    RAISE EXCEPTION 'a result keeps its exam and learner' USING ERRCODE = 'P0001';
  END IF;
  NEW."makeupKey" := CASE WHEN e."kind" = 'MAKEUP' AND e."status" <> 'VOID' AND NEW."status" = 'SCORED'
                          THEN e."makeupOfExamId" ELSE NULL END;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaperExamResult_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PaperExamResult"
  FOR EACH ROW EXECUTE FUNCTION paper_result_guard();

-- A revision belongs to its exam's academy.
CREATE FUNCTION paper_revision_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "PaperExam" WHERE id = NEW."examId" AND "academyId" = NEW."academyId") THEN
    RAISE EXCEPTION 'paper revision crosses academies' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PaperExamRevision_tenant" BEFORE INSERT ON "PaperExamRevision"
  FOR EACH ROW EXECUTE FUNCTION paper_revision_tenant();
