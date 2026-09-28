import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ErrorNote } from '../../components/ui';
import { api } from '../../lib/api';
import { askConfirm } from '../../lib/confirm';

interface ChatStatus {
  threadId: string | null;
  enabled: boolean;
  mode: 'OPEN' | 'ANNOUNCEMENTS';
}

/**
 * The group's chat, managed from the group itself. The group's members and
 * staff ARE the chat's — adding or removing a student here is all it takes;
 * there is no second list to keep in step. One chat per group: enabling twice
 * opens the same conversation.
 */
export default function GroupChatCard({
  groupId,
  archived,
}: {
  groupId: string;
  archived: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const key = ['group-chat', groupId];
  const status = useQuery<ChatStatus>({
    queryKey: key,
    queryFn: async () => (await api.get(`/teacher/groups/${groupId}/chat`)).data,
  });
  const done = (s: ChatStatus) => {
    qc.setQueryData(key, s);
    void qc.invalidateQueries({ queryKey: ['chat-threads'] });
  };
  const enable = useMutation({
    mutationFn: async () => (await api.post<ChatStatus>(`/teacher/groups/${groupId}/chat`)).data,
    onSuccess: done,
  });
  const update = useMutation({
    mutationFn: async (body: { enabled?: boolean; mode?: 'OPEN' | 'ANNOUNCEMENTS' }) =>
      (await api.patch<ChatStatus>(`/teacher/groups/${groupId}/chat`, body)).data,
    onSuccess: done,
  });
  const s = status.data;
  const busy = enable.isPending || update.isPending;

  return (
    <section className="card mb-6 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-secondary-container text-on-secondary-container">
          <span className="material-symbols-outlined">forum</span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-heading font-bold text-on-surface">{t('groupChat.title')}</h2>
          <p className="text-sm text-on-surface-variant">
            {!s?.enabled
              ? t('groupChat.offHint')
              : s.mode === 'ANNOUNCEMENTS'
                ? t('groupChat.announcementsHint')
                : t('groupChat.openHint')}
          </p>
        </div>
        {s?.enabled && s.threadId ? (
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Link
              to={`/messages?t=${s.threadId}`}
              className="btn-primary flex-1 justify-center sm:flex-none"
            >
              <span className="material-symbols-outlined text-[20px]">chat</span>
              {t('groupChat.open')}
            </Link>
            <button
              className="btn-secondary flex-1 justify-center sm:flex-none"
              disabled={busy}
              onClick={() =>
                update.mutate({ mode: s.mode === 'ANNOUNCEMENTS' ? 'OPEN' : 'ANNOUNCEMENTS' })
              }
            >
              <span className="material-symbols-outlined text-[20px]">
                {s.mode === 'ANNOUNCEMENTS' ? 'forum' : 'campaign'}
              </span>
              {s.mode === 'ANNOUNCEMENTS' ? t('groupChat.toOpen') : t('groupChat.toAnnouncements')}
            </button>
            <button
              className="btn-ghost"
              disabled={busy}
              onClick={async () => {
                if (await askConfirm(t('groupChat.disableConfirm')))
                  update.mutate({ enabled: false });
              }}
            >
              {t('groupChat.disable')}
            </button>
          </div>
        ) : (
          <button
            className="btn-primary w-full justify-center sm:w-auto"
            disabled={busy || archived || status.isLoading}
            onClick={() => enable.mutate()}
          >
            <span className="material-symbols-outlined text-[20px]">add_comment</span>
            {t('groupChat.enable')}
          </button>
        )}
      </div>
      {(enable.error || update.error) && <ErrorNote error={enable.error ?? update.error} />}
    </section>
  );
}
