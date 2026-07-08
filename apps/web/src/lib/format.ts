import i18n from '../i18n';

/** Amounts are integer piasters (1 EGP = 100). */
export function egp(cents: number | null | undefined): string {
  if (cents == null) return '—';
  const v = cents / 100;
  const num = v.toLocaleString(i18n.language === 'ar' ? 'ar-EG' : 'en-EG', {
    maximumFractionDigits: v % 1 ? 2 : 0,
  });
  return i18n.language === 'ar' ? `${num} ج.م` : `EGP ${num}`;
}

export function duration(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.round((totalSec % 3600) / 60);
  if (i18n.language === 'ar') return h > 0 ? `${h} س ${m} د` : `${m} دقيقة`;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
}

export function dateShort(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(i18n.language === 'ar' ? 'ar-EG' : 'en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
