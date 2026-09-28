import { useQuery } from '@tanstack/react-query';
import type { ChatContactDto, ChatThreadDto } from '@darsly/shared-types';
import Avatar from '../../components/Avatar';
import { Modal, Spinner } from '../../components/ui';
import { api } from '../../lib/api';
import { roleKey } from './MessageBubble';

type T = (k: string, o?: any) => string;

/**
 * Who a student (or guardian) can start a conversation with — in three kinds
 * that never mix:
 *
 *  - People: their teacher, and the assistants the academy made reachable.
 *  - Support: the academy's support team — a destination, not a person.
 *  - My groups: the chats of the class groups they are in (students only).
 *
 * A guardian's contacts are per child, so each child is its own section. The
 * list comes from the server, which refuses anyone not on it — this is a
 * convenience, not the gate. Picking one creates nothing: the first message does.
 */
export default function ContactPicker({
  open,
  onClose,
  onPick,
  groups,
  onOpenGroup,
  childId,
  t,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (c: ChatContactDto) => void;
  groups: ChatThreadDto[];
  onOpenGroup: (threadId: string) => void;
  /** A guardian arriving from a child's page: show that child first. */
  childId?: string | null;
  t: T;
}) {
  const { data, isLoading } = useQuery<ChatContactDto[]>({
    queryKey: ['chat-contacts'],
    queryFn: async () => (await api.get('/chat/contacts')).data,
    enabled: open,
    staleTime: 60_000,
  });
  const contacts = data ?? [];
  // A guardian's contacts carry the child they are about; a student's do not.
  const children = [
    ...new Map(
      contacts.filter((c) => c.studentId).map((c) => [c.studentId!, c.studentName ?? '']),
    ).entries(),
  ];
  if (childId) children.sort(([a], [b]) => (a === childId ? -1 : b === childId ? 1 : 0));

  const section = (list: ChatContactDto[]) => {
    const people = list.filter((c) => c.kind !== 'TEAM');
    const teams = list.filter((c) => c.kind === 'TEAM');
    return (
      <>
        {people.length > 0 && (
          <Group title={t('messages.people')}>
            {people.map((c) => (
              <Item
                key={`${c.kind}-${c.staffUserId ?? c.tenantId}-${c.academyId}-${c.studentId ?? ''}`}
                onClick={() => onPick(c)}
                avatar={
                  <Avatar
                    id={c.staffUserId ?? c.tenantId ?? c.academyId}
                    name={c.name}
                    url={c.avatarUrl}
                    size={44}
                  />
                }
                title={c.name}
                subtitle={`${c.title || t(roleKey(c.kind as 'OWNER' | 'ASSISTANT'))}${c.academyName ? ` · ${c.academyName}` : ''}`}
              />
            ))}
          </Group>
        )}
        {teams.length > 0 && (
          <Group title={t('messages.support')}>
            {teams.map((c) => (
              <Item
                key={`team-${c.academyId}-${c.studentId ?? ''}`}
                onClick={() => onPick(c)}
                avatar={<TeamIcon />}
                title={t('messages.askSupport')}
                subtitle={c.academyName ?? ''}
              />
            ))}
          </Group>
        )}
      </>
    );
  };

  return (
    <Modal open={open} title={t('messages.newConversation')} onClose={onClose}>
      {isLoading ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : !contacts.length && !groups.length ? (
        <p className="py-8 text-center text-sm text-on-surface-variant">
          {t('messages.noContacts')}
        </p>
      ) : (
        <div className="-mx-2 flex flex-col gap-4">
          {children.length
            ? children.map(([id, name]) => (
                <div key={id}>
                  <p className="mb-1 px-2 font-heading font-bold text-on-surface">
                    <bdi>{t('messages.aboutChild', { name })}</bdi>
                  </p>
                  {section(contacts.filter((c) => c.studentId === id))}
                </div>
              ))
            : section(contacts)}
          {groups.length > 0 && (
            <Group title={t('messages.myGroups')}>
              {groups.map((g) => (
                <Item
                  key={g.id}
                  onClick={() => onOpenGroup(g.id)}
                  avatar={<GroupIcon name={g.groupName ?? g.counterpartName} />}
                  title={g.groupName ?? g.counterpartName}
                  subtitle={`${t('messages.members', { count: g.memberCount ?? 0 })}${g.academyName ? ` · ${g.academyName}` : ''}`}
                />
              ))}
            </Group>
          )}
        </div>
      )}
    </Modal>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-1 px-2 text-xs font-bold uppercase tracking-wide text-outline">{title}</p>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Item({
  onClick,
  avatar,
  title,
  subtitle,
}: {
  onClick: () => void;
  avatar: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-sm px-2 py-2.5 text-start transition hover:bg-surface-container-high focus-visible:bg-surface-container-high focus-visible:outline-none"
      >
        {avatar}
        <span className="min-w-0 flex-1">
          <bdi className="block truncate font-bold text-on-surface">{title}</bdi>
          <span className="block truncate text-sm text-on-surface-variant">{subtitle}</span>
        </span>
        <span className="material-symbols-outlined text-[20px] text-outline rtl:-scale-x-100">
          chevron_right
        </span>
      </button>
    </li>
  );
}

/** The support team: a destination, drawn as the team — never as a person. */
export function TeamIcon({ size = 44 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full bg-primary-fixed text-on-primary-fixed"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <span className="material-symbols-outlined" style={{ fontSize: size * 0.5 }}>
        support_agent
      </span>
    </span>
  );
}

/** A class group: a rounded square with the group's initials. */
export function GroupIcon({ name, size = 44 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => [...w][0])
    .join('');
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[12px] bg-secondary-container font-bold text-on-secondary-container"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials || <span className="material-symbols-outlined">groups</span>}
    </span>
  );
}
