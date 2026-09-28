import { useMemo, useState } from 'react';
import type { ChatThreadDto } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import { listTime } from './format';

type T = (k: string, o?: any) => string;

export default function ConversationList({
  threads,
  activeId,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpen,
  lang,
  t,
}: {
  threads: ChatThreadDto[];
  activeId: string | null;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (id: string) => void;
  lang: string;
  t: T;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return needle
      ? threads.filter((th) => th.counterpartName.toLocaleLowerCase().includes(needle))
      : threads;
  }, [threads, q]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-outline-variant/40 p-3">
        <label className="relative block">
          <span className="material-symbols-outlined pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-[20px] text-outline">
            search
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('messages.search')}
            aria-label={t('messages.search')}
            className="h-10 w-full rounded-full border border-outline-variant/60 bg-surface-container-low ps-10 pe-4 text-sm outline-none transition focus:border-primary focus:bg-surface-container-lowest"
          />
        </label>
      </div>

      {loading ? (
        <ul aria-hidden className="flex-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3">
              <span className="h-12 w-12 animate-pulse rounded-full bg-surface-container-high" />
              <span className="flex flex-1 flex-col gap-2">
                <span className="h-3 w-1/2 animate-pulse rounded-full bg-surface-container-high" />
                <span className="h-3 w-3/4 animate-pulse rounded-full bg-surface-container-high" />
              </span>
            </li>
          ))}
        </ul>
      ) : !threads.length ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed">
            <span className="material-symbols-outlined text-3xl">forum</span>
          </span>
          <p className="mt-2 font-heading font-bold text-on-surface">{t('messages.empty')}</p>
          <p className="max-w-xs text-sm text-on-surface-variant">{t('messages.emptyHint')}</p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto" aria-label={t('messages.title')}>
          {shown.map((th) => {
            const unread = th.unread > 0;
            const active = th.id === activeId;
            return (
              <li key={th.id}>
                <button
                  onClick={() => onOpen(th.id)}
                  aria-current={active ? 'true' : undefined}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-start transition focus-visible:bg-surface-container-high focus-visible:outline-none ${
                    active ? 'bg-primary-fixed/50' : 'hover:bg-surface-container-low'
                  }`}
                >
                  <Avatar
                    id={th.studentId + th.tenantId}
                    name={th.counterpartName}
                    url={th.counterpartAvatarUrl}
                    size={48}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <bdi
                        className={`truncate ${unread ? 'font-bold text-on-surface' : 'font-medium text-on-surface'}`}
                      >
                        {th.counterpartName}
                      </bdi>
                      {th.lastMessageAt && (
                        <span
                          className={`shrink-0 text-xs ${unread ? 'font-bold text-primary-text' : 'text-outline'}`}
                        >
                          {listTime(th.lastMessageAt, lang)}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 flex items-center gap-2">
                      <span
                        dir="auto"
                        className={`min-w-0 flex-1 truncate text-sm ${unread ? 'font-medium text-on-surface' : 'text-on-surface-variant'}`}
                      >
                        {th.lastMessageMine && (
                          <span className="text-on-surface-variant">
                            {t('messages.youPrefix')}{' '}
                          </span>
                        )}
                        {th.lastMessage || t('messages.startHint')}
                      </span>
                      {unread && (
                        <span
                          className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-on-primary"
                          aria-label={t('messages.unreadCount', { count: th.unread })}
                        >
                          {th.unread > 99 ? '99+' : th.unread}
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {!shown.length && (
            <li className="p-6 text-center text-sm text-on-surface-variant">
              {t('messages.noMatches', { q })}
            </li>
          )}
          {hasMore && !q && (
            <li className="p-3 text-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="text-sm font-bold text-primary-text disabled:opacity-50"
              >
                {t('messages.moreConversations')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
