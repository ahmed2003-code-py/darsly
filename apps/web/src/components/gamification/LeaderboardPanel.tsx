import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { compactNum, LeaderboardBoard, LeaderboardRow } from '../../lib/gamification';
import { Skeleton } from '../ui';

type Period = 'WEEKLY' | 'MONTHLY' | 'ALLTIME';
type Scope = 'GLOBAL' | 'ACADEMY' | 'COURSE';

/**
 * A board a student can actually use.
 *
 * Two things make it usable rather than decorative: the student's own row is
 * always shown, wherever it sits, and the gap to the position above is spelled
 * out in XP. "#47" on its own is a number; "#47, 120 XP from #46" is a goal.
 */
export function LeaderboardPanel({
  scope = 'GLOBAL',
  scopeId = '',
  compact,
}: {
  scope?: Scope;
  scopeId?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>('WEEKLY');

  const { data, isLoading } = useQuery<LeaderboardBoard>({
    queryKey: ['leaderboard', scope, scopeId, period],
    queryFn: async () =>
      (await api.get('/student/gamification/leaderboard', { params: { scope, scopeId, period } }))
        .data,
    staleTime: 30_000,
  });

  const rows = data?.top ?? [];
  const shown = compact ? rows.slice(0, 5) : rows;
  // Only bother with the neighbours block when the student is off the visible
  // part of the board.
  const showAround = !!data?.around?.length && !shown.some((r) => r.isMe);

  return (
    <section className="card">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-extrabold">
          {t('gamification.leaderboard.title')}
        </h2>
        <div className="flex gap-1 rounded-full bg-surface-container-high p-1">
          {(['WEEKLY', 'MONTHLY', 'ALLTIME'] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition ${
                period === p
                  ? 'bg-surface-container-lowest text-primary shadow-hairline'
                  : 'text-on-surface-variant'
              }`}
            >
              {t(`gamification.leaderboard.period.${p}`)}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 rounded-xl" />
          ))}
        </div>
      ) : !rows.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">
          {t('gamification.leaderboard.empty')}
        </p>
      ) : (
        <div className="space-y-1.5">
          {shown.map((r) => (
            <Row key={r.studentId} r={r} />
          ))}

          {showAround && (
            <>
              <p className="py-1 text-center text-outline">···</p>
              {data!.around.map((r) => (
                <Row key={r.studentId} r={r} />
              ))}
            </>
          )}
        </div>
      )}

      {data?.toNextRank != null && data.toNextRank > 0 && (
        <p className="mt-3 rounded-lg bg-primary-fixed/60 px-3 py-2 text-center text-sm font-semibold text-on-primary-fixed">
          {t('gamification.leaderboard.toNext', { count: data.toNextRank })}
        </p>
      )}
      {period === 'WEEKLY' && !compact && (
        <p className="mt-3 text-center text-xs text-outline">
          {t('gamification.leaderboard.resetsWeekly')}
        </p>
      )}
    </section>
  );
}

function Row({ r }: { r: LeaderboardRow }) {
  const { t } = useTranslation();
  const medal = r.rank <= 3;
  return (
    <div
      className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${
        r.isMe
          ? 'border-primary bg-primary-fixed/50'
          : 'border-transparent bg-surface-container-low'
      }`}
    >
      <span
        className={`w-8 shrink-0 text-center font-heading font-extrabold ${
          medal ? 'text-student-gold-ink' : 'text-outline'
        }`}
      >
        {r.rank}
      </span>
      <span className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-container-high font-heading text-sm font-bold text-on-surface-variant">
        {r.avatarUrl ? (
          <img src={r.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          r.name.trim().charAt(0)
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">
          {r.name}
          {r.isMe && (
            <span className="ms-1.5 text-xs font-bold text-primary">
              · {t('gamification.leaderboard.you')}
            </span>
          )}
        </span>
        <span className="block truncate text-[11px] text-outline">
          {t('gamification.levelShort', { n: r.level })}
          {r.title ? ` · ${r.title}` : ''}
        </span>
      </span>
      <span className="shrink-0 font-heading text-sm font-extrabold text-student-gold-ink">
        {compactNum(r.xp)}
      </span>
    </div>
  );
}
