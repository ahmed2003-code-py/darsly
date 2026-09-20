import { useTranslation } from 'react-i18next';
import { useMyInvitations, useRespondToInvitation } from '../lib/academy';

/**
 * A center owner inviting someone is not the same as that person joining —
 * see AcademyService.addMember's INVITED-first flow. This is where the
 * invited person actually decides, shown wherever they land (not buried in
 * a settings page) since it's the one thing blocking them from using the
 * academy they were just invited to.
 */
export default function InvitationsBanner() {
  const { t } = useTranslation();
  const { data } = useMyInvitations();
  const respond = useRespondToInvitation();

  if (!data?.length) return null;

  return (
    <div className="mx-4 mt-4 space-y-2 sm:mx-6">
      {data.map((inv) => (
        <div key={inv.id} className="card flex flex-wrap items-center justify-between gap-3 border-s-4 border-s-primary p-4">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-fixed font-heading font-bold text-on-primary-fixed">
              {inv.academy.logoUrl ? <img src={inv.academy.logoUrl} alt="" className="h-full w-full object-cover" /> : inv.academy.name.trim().charAt(0)}
            </span>
            <p className="text-sm">
              {t('invitations.text', { academy: inv.academy.name, role: t(`admin.staffRole.${inv.role}`) })}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-secondary px-4 py-1.5 text-xs"
              disabled={respond.isPending}
              onClick={() => respond.mutate({ id: inv.id, accept: false })}
            >
              {t('invitations.decline')}
            </button>
            <button
              className="btn-primary px-4 py-1.5 text-xs"
              disabled={respond.isPending}
              onClick={() => respond.mutate({ id: inv.id, accept: true })}
            >
              {t('invitations.accept')}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
