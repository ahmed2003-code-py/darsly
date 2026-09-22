-- Center invitation links: an invitee's explicit "no". Additive, nullable only.
ALTER TABLE "AcademyInvitationLink"
  ADD COLUMN "declinedAt" TIMESTAMP(3),
  ADD COLUMN "declinedByUserId" TEXT;
