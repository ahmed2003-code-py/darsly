import { useQuery } from '@tanstack/react-query';
import type { ChatContactDto } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import { Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { roleKey } from './MessageBubble';

type T = (k: string, o?: any) => string;

/**
 * Who a student can start a conversation with: their teachers, and the
 * assistants those academies made reachable. The list comes from the server,
 * which also refuses anyone not on it — this is a convenience, not the gate.
 */
export default function ContactPicker({
  open,
  onClose,
  onPick,
  t,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (c: ChatContactDto) => void;
  t: T;
}) {
  const { data, isLoading } = useQuery<ChatContactDto[]>({
    queryKey: ['chat-contacts'],
    queryFn: async () => (await api.get('/chat/contacts')).data,
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <Modal open={open} title={t('messages.newConversation')} onClose={onClose}>
      {isLoading ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !data?.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">
          {t('messages.noContacts')}
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {data.map((c) => (
            <li key={`${c.kind}-${c.staffUserId ?? c.tenantId}-${c.academyId}`}>
              <button
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-3 rounded-sm px-2 py-2.5 text-start transition hover:bg-surface-container-high focus-visible:bg-surface-container-high focus-visible:outline-none"
              >
                <Avatar
                  id={c.staffUserId ?? c.tenantId ?? c.academyId}
                  name={c.name}
                  url={c.avatarUrl}
                  size={44}
                />
                <span className="min-w-0 flex-1">
                  <bdi className="block truncate font-bold text-on-surface">{c.name}</bdi>
                  <span className="block truncate text-sm text-on-surface-variant">
                    {c.title || t(roleKey(c.kind))}
                    {c.academyName ? ` · ${c.academyName}` : ''}
                  </span>
                </span>
                <span className="material-symbols-outlined text-[20px] text-outline rtl:-scale-x-100">
                  chevron_right
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
