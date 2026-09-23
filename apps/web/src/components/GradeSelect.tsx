import { useTranslation } from 'react-i18next';
import { STAGES, type Grade } from '../lib/stages';

/**
 * Which year a student is in.
 *
 * Grouped by stage rather than listed flat: fifteen years in one run is a
 * scroll on a phone, and the groups are how a student narrows it down — they
 * know they are in secondary before they know which of its three years.
 */
export default function GradeSelect({
  value,
  onChange,
  grades,
}: {
  value: string;
  onChange: (id: string) => void;
  grades?: Grade[];
}) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language !== 'en';
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('auth.gradePh')}</option>
      {STAGES.map((st) => {
        const inStage = (grades ?? []).filter((g) => g.stage === st);
        if (!inStage.length) return null;
        return (
          <optgroup key={st} label={t(`stage.${st}`)}>
            {inStage.map((g) => (
              <option key={g.id} value={g.id}>
                {ar ? g.nameAr : g.nameEn}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
