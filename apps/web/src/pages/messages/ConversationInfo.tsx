import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ChatContextDto, ChatThreadDto, GroupChatInfoDto } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import { Badge, ErrorNote, Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { roleKey } from './MessageBubble';

type T = (k: string, o?: any) => string;

/** Refresh everything that shows a conversation's state after a team or group action. */
function useRefresh(threadId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['chat-threads'] });
    void qc.invalidateQueries({ queryKey: ['chat-thread', threadId] });
    void qc.invalidateQueries({ queryKey: ['chat-context', threadId] });
    void qc.invalidateQueries({ queryKey: ['chat-group', threadId] });
  };
}

/**
 * The team inbox's actions for one TEAM conversation, as the server allows
 * them for this viewer: claim, resolve / reopen. Reassigning lives in the
 * context panel. Each is one request; the conversation, its sender identities
 * and its history never change.
 */
export function TeamActions({ thread, t }: { thread: ChatThreadDto; t: T }) {
  const refresh = useRefresh(thread.id);
  const claim = useMutation({
    mutationFn: async () => (await api.post(`/chat/threads/${thread.id}/claim`)).data,
    onSuccess: refresh,
  });
  const resolve = useMutation({
    mutationFn: async (resolved: boolean) =>
      (await api.put(`/chat/threads/${thread.id}/resolved`, { resolved })).data,
    onSuccess: refresh,
  });
  const btn =
    'flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-xs font-bold transition disabled:opacity-50';
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {!thread.assigneeUserId && !thread.resolvedAt && (
        <button
          type="button"
          className={`${btn} bg-primary text-on-primary hover:bg-primary-hover`}
          onClick={() => claim.mutate()}
          disabled={claim.isPending}
        >
          <span className="material-symbols-outlined text-[18px]">front_hand</span>
          <span className="hidden sm:inline">{t('messages.claim')}</span>
        </button>
      )}
      <button
        type="button"
        className={`${btn} ${
          thread.resolvedAt
            ? 'bg-surface-container-high text-on-surface'
            : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
        }`}
        onClick={() => resolve.mutate(!thread.resolvedAt)}
        disabled={resolve.isPending}
        aria-label={thread.resolvedAt ? t('messages.reopen') : t('messages.resolve')}
      >
        <span className="material-symbols-outlined text-[18px]">
          {thread.resolvedAt ? 'undo' : 'task_alt'}
        </span>
        <span className="hidden sm:inline">
          {thread.resolvedAt ? t('messages.reopen') : t('messages.resolve')}
        </span>
      </button>
      {(claim.error || resolve.error) && (
        <span className="sr-only">{t('messages.actionFailed')}</span>
      )}
    </div>
  );
}

/**
 * Beside a conversation with a student or guardian: who the student is, in
 * which academy, their courses that are inside the viewer's scope (never
 * the rest), the guardian writing, and — for TEAM — who has it. A link opens
 * Student 360. No wallet, nothing outside the viewer's slice.
 */
export function StudentContextPanel({
  thread,
  open,
  onClose,
  t,
}: {
  thread: ChatThreadDto;
  open: boolean;
  onClose: () => void;
  t: T;
}) {
  const refresh = useRefresh(thread.id);
  const ctx = useQuery<ChatContextDto>({
    queryKey: ['chat-context', thread.id],
    queryFn: async () => (await api.get(`/chat/threads/${thread.id}/context`)).data,
    enabled: open,
  });
  const assignees = useQuery<
    {
      id: string;
      name: string;
      avatarUrl: string | null;
      title: string | null;
      role: string | null;
    }[]
  >({
    queryKey: ['chat-assignees', thread.id],
    queryFn: async () => (await api.get(`/chat/threads/${thread.id}/assignees`)).data,
    enabled: open && !!ctx.data?.can.assign,
  });
  const assign = useMutation({
    mutationFn: async (userId: string | null) =>
      (await api.put(`/chat/threads/${thread.id}/assignee`, { userId })).data,
    onSuccess: refresh,
  });
  const c = ctx.data;
  return (
    <Modal open={open} title={t('messages.aboutStudent')} onClose={onClose}>
      {ctx.isLoading || !c ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar id={c.student.id} name={c.student.name} url={c.student.avatarUrl} size={52} />
            <div className="min-w-0 flex-1">
              <bdi className="block truncate font-heading text-lg font-bold text-on-surface">
                {c.student.name}
              </bdi>
              <span className="block truncate text-sm text-on-surface-variant">
                {c.academy?.name}
              </span>
            </div>
          </div>
          {c.guardian && (
            <p className="flex items-center gap-2 rounded-sm bg-surface-container-low p-2.5 text-sm">
              <span className="material-symbols-outlined text-[20px] text-primary-text">
                family_restroom
              </span>
              <span>
                {t('messages.writtenByGuardian', {
                  name: c.guardian.name,
                  relation: t(`guardian.rel.${c.guardian.relationship}`),
                })}
              </span>
            </p>
          )}
          <section>
            <h3 className="mb-1.5 text-sm font-bold text-on-surface">
              {t('messages.coursesInScope')}
            </h3>
            {c.courses.length ? (
              <div className="flex flex-wrap gap-1.5">
                {c.courses.map((co) => (
                  <Badge key={co.id} tone={co.status === 'ACTIVE' ? 'primary' : 'neutral'}>
                    {co.title}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-on-surface-variant">—</p>
            )}
          </section>
          <p className="flex items-center gap-2 text-sm text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">family_restroom</span>
            {c.guardians
              ? t('messages.guardiansLinked', { count: c.guardians })
              : t('messages.noGuardians')}
          </p>
          {c.kind === 'TEAM' && (
            <section>
              <h3 className="mb-1.5 text-sm font-bold text-on-surface">{t('messages.assignee')}</h3>
              {c.can.assign ? (
                <select
                  className="input"
                  value={c.assignee?.id ?? ''}
                  disabled={assign.isPending || assignees.isLoading}
                  onChange={(e) => assign.mutate(e.target.value || null)}
                  aria-label={t('messages.assignee')}
                >
                  <option value="">{t('messages.unassigned')}</option>
                  {(assignees.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                      {a.title ? ` · ${a.title}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-on-surface">
                  {c.assignee?.name ?? t('messages.unassigned')}
                </p>
              )}
              {assign.error && <ErrorNote error={assign.error} />}
            </section>
          )}
          {c.academy && (
            <Link
              to={`/staff/students/${c.student.id}?academy=${encodeURIComponent(c.academy.id)}`}
              className="btn-secondary w-full justify-center"
            >
              <span className="material-symbols-outlined text-[20px]">person_search</span>
              {t('messages.openStudent360')}
            </Link>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * A class group's info: its staff (each as themselves), how many students,
 * and — for staff only — who they are. A manager switches Open ↔
 * Announcements here; students see the mode, not the switch.
 */
export function GroupInfoPanel({
  threadId,
  open,
  onClose,
  t,
}: {
  threadId: string;
  open: boolean;
  onClose: () => void;
  t: T;
}) {
  const refresh = useRefresh(threadId);
  const info = useQuery<GroupChatInfoDto>({
    queryKey: ['chat-group', threadId],
    queryFn: async () => (await api.get(`/chat/threads/${threadId}/group`)).data,
    enabled: open,
  });
  const mode = useMutation({
    mutationFn: async (m: 'OPEN' | 'ANNOUNCEMENTS') =>
      (await api.put(`/chat/threads/${threadId}/group/mode`, { mode: m })).data,
    onSuccess: refresh,
  });
  const g = info.data;
  return (
    <Modal open={open} title={t('messages.groupInfo')} onClose={onClose}>
      {info.isLoading || !g ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <bdi className="block break-words font-heading text-lg font-bold text-on-surface">
              {g.name}
            </bdi>
            <p className="text-sm text-on-surface-variant">
              {t('messages.members', { count: g.memberCount })}
              {g.academyName ? ` · ${g.academyName}` : ''}
            </p>
          </div>
          <section className="rounded-sm bg-surface-container-low p-3">
            <p className="flex items-center gap-2 text-sm font-bold text-on-surface">
              <span className="material-symbols-outlined text-[20px]">
                {g.mode === 'ANNOUNCEMENTS' ? 'campaign' : 'forum'}
              </span>
              {g.mode === 'ANNOUNCEMENTS'
                ? t('messages.modeAnnouncements')
                : t('messages.modeOpen')}
            </p>
            <p className="mt-0.5 text-xs text-on-surface-variant">
              {g.mode === 'ANNOUNCEMENTS'
                ? t('messages.modeAnnouncementsHint')
                : t('messages.modeOpenHint')}
            </p>
            {g.can.manage && (
              <button
                type="button"
                className="btn-secondary mt-3 w-full justify-center"
                disabled={mode.isPending}
                onClick={() => mode.mutate(g.mode === 'ANNOUNCEMENTS' ? 'OPEN' : 'ANNOUNCEMENTS')}
              >
                {g.mode === 'ANNOUNCEMENTS'
                  ? t('messages.switchToOpen')
                  : t('messages.switchToAnnouncements')}
              </button>
            )}
          </section>
          <section>
            <h3 className="mb-1.5 text-sm font-bold text-on-surface">{t('messages.groupStaff')}</h3>
            <ul className="space-y-2">
              {g.staff.map((s) => (
                <li key={s.id} className="flex items-center gap-2.5">
                  <Avatar id={s.id} name={s.name} url={s.avatarUrl} size={36} />
                  <span className="min-w-0">
                    <bdi className="block truncate text-sm font-bold text-on-surface">{s.name}</bdi>
                    <span className="block truncate text-xs text-on-surface-variant">
                      {s.title || t(roleKey(s.kind))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
          {g.students && (
            <section>
              <h3 className="mb-1.5 text-sm font-bold text-on-surface">
                {t('messages.groupStudents', { count: g.students.length })}
              </h3>
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {g.students.map((s) => (
                  <li key={s.id} className="flex items-center gap-2.5 py-1">
                    <Avatar id={s.id} name={s.name} url={s.avatarUrl} size={32} />
                    <bdi className="min-w-0 truncate text-sm text-on-surface">{s.name}</bdi>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {mode.error && <ErrorNote error={mode.error} />}
        </div>
      )}
    </Modal>
  );
}
