import { useTranslation } from 'react-i18next';
import { Mission } from '../../lib/gamification';

/**
 * Today's missions.
 *
 * Each row is one concrete thing to do, how far along it is, and what it pays.
 * Completed rows stay on the list rather than disappearing — finishing all
 * three and seeing an empty box is a worse ending than seeing three ticks.
 */
export function MissionList({ missions, kind }: { missions: Mission[]; kind: 'DAILY' | 'WEEKLY' }) {
  const { t } = useTranslation();
  const rows = missions.filter((m) => m.kind === kind);
  if (!rows.length) return null;

  const allDone = rows.every((m) => m.completed);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-heading text-lg font-extrabold">
          {kind === 'DAILY' ? t('gamification.missions.title') : t('gamification.missions.weekly')}
        </h2>
        <span className="text-xs text-outline">
          {rows.filter((m) => m.completed).length}/{rows.length}
        </span>
      </div>

      {allDone && kind === 'DAILY' && (
        <p className="mb-3 rounded-lg bg-secondary-container/50 px-3 py-2 text-center text-sm font-bold text-on-secondary-container">
          {t('gamification.missions.allDone')}
        </p>
      )}

      <div className="space-y-2">
        {rows.map((m) => (
          <MissionRow key={m.id} m={m} />
        ))}
      </div>
    </section>
  );
}

function MissionRow({ m }: { m: Mission }) {
  const { t } = useTranslation();
  const pct = Math.min(100, Math.round((m.progress / Math.max(1, m.target)) * 100));
  const label = t([`gamification.missions.templates.${m.template}`, m.template]);

  return (
    <div
      className={`flex items-center gap-3 rounded-xl border p-3 transition ${
        m.completed ? 'border-secondary/40 bg-secondary-container/25' : 'border-outline-variant bg-surface-container-lowest'
      }`}
    >
      <span
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${
          m.completed ? 'bg-secondary text-on-secondary' : 'bg-surface-container-high text-outline'
        }`}
      >
        <span
          className="material-symbols-outlined text-[20px]"
          style={m.completed ? { fontVariationSettings: "'FILL' 1" } : undefined}
        >
          {m.completed ? 'check' : 'target'}
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${m.completed ? 'text-on-surface-variant line-through' : ''}`}>
          {label}
        </p>
        {!m.completed && m.target > 1 && (
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-high">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="shrink-0 text-end">
        {m.completed ? (
          <span className="text-xs font-bold text-secondary">{t('gamification.missions.done')}</span>
        ) : (
          <>
            {m.target > 1 && (
              <span className="block font-mono text-xs text-outline">
                {m.progress}/{m.target}
              </span>
            )}
            <span className="block text-[11px] font-bold text-student-gold-ink">+{m.xpReward}</span>
          </>
        )}
      </div>
    </div>
  );
}
