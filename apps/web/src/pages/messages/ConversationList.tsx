import { useMemo, useState } from 'react';
import type { ChatThreadDto, InboxFilter } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import { GroupIcon, TeamIcon } from './ContactPicker';
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
  filter,
  onFilter,
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
  /** Staff only: the inbox view in use (null for students and guardians). */
  filter?: InboxFilter | null;
  onFilter?: (f: InboxFilter) => void;
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
        {filter && onFilter && (
          <div
            className="-mx-1 mb-2.5 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
            role="tablist"
            aria-label={t('messages.inbox')}
          >
            {(['all', 'unread', 'mine', 'unassigned', 'resolved'] as InboxFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                onClick={() => onFilter(f)}
                className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  filter === f
                    ? 'bg-primary text-on-primary'
                    : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                }`}
              >
                {t(`messages.filter.${f}`)}
              </button>
            ))}
          </div>
        )}
        <label className="relative block">
          <span className="material-symbols-outlined pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-[20px] text-outline [direction:inherit]">
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
                  {th.kind === 'GROUP' ? (
                    <GroupIcon name={th.counterpartName} size={48} />
                  ) : th.kind === 'TEAM' && !th.counterpartKind ? (
                    <TeamIcon size={48} />
                  ) : (
                    <Avatar
                      id={th.studentId + th.tenantId}
                      name={th.counterpartName}
                      url={th.counterpartAvatarUrl}
                      size={48}
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <bdi
                        className={`truncate ${unread ? 'font-bold text-on-surface' : 'font-medium text-on-surface'}`}
                      >
                        {th.counterpartName}
                      </bdi>
                      {th.counterpartTitle && (
                        <span className="min-w-0 shrink truncate text-xs text-on-surface-variant">
                          {th.counterpartTitle}
                        </span>
                      )}
                      {th.lastMessageAt && (
                        <span
                          className={`ms-auto shrink-0 text-xs ${unread ? 'font-bold text-primary-text' : 'text-outline'}`}
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
                    <RowChips th={th} t={t} />
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

/** What kind of conversation a row is, in one quiet line: support, group, who it is about. */
function RowChips({ th, t }: { th: ChatThreadDto; t: T }) {
  const chips: { icon: string; text: string; tone?: 'done' | 'warn' }[] = [];
  if (th.kind === 'GROUP') {
    chips.push({ icon: 'groups', text: t('messages.members', { count: th.memberCount ?? 0 }) });
    if (th.groupMode === 'ANNOUNCEMENTS')
      chips.push({ icon: 'campaign', text: t('messages.announcements') });
  }
  if (th.kind === 'TEAM') {
    if (th.counterpartKind) {
      // Staff view: who it is waiting on.
      chips.push(
        th.resolvedAt
          ? { icon: 'check_circle', text: t('messages.resolved'), tone: 'done' }
          : th.assigneeName
            ? { icon: 'person', text: th.assigneeName }
            : { icon: 'inbox', text: t('messages.unassigned'), tone: 'warn' },
      );
    } else {
      chips.push({ icon: 'support_agent', text: t('messages.supportTeam') });
    }
  }
  if (th.learnerKind === 'GUARDIAN' && th.counterpartKind === 'GUARDIAN' && th.studentName) {
    chips.push({
      icon: 'family_restroom',
      text: t('messages.guardianOf', { name: th.studentName }),
    });
  }
  if (!chips.length) return null;
  return (
    <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-on-surface-variant">
      {chips.map((c, i) => (
        <span
          key={i}
          className={`flex min-w-0 items-center gap-0.5 ${
            c.tone === 'warn'
              ? 'font-bold text-primary-text'
              : c.tone === 'done'
                ? 'text-outline'
                : ''
          }`}
        >
          <span className="material-symbols-outlined text-[13px]" aria-hidden>
            {c.icon}
          </span>
          <bdi className="truncate">{c.text}</bdi>
        </span>
      ))}
    </span>
  );
}
