import { useTranslation } from 'react-i18next';
import { PageHeader } from '../../components/ui';
import { StaffGradingQueue } from '../teacher/GradingPage';

/** The marking queue of the assistant's courses — the teacher's screen, narrowed by the server. */
export default function StaffGradingPage() {
  const { t } = useTranslation();
  return (
    <div className="page">
      <PageHeader title={t('nav.grading')} subtitle={t('staff.gradingSubtitle')} />
      <StaffGradingQueue />
    </div>
  );
}
